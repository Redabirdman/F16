/**
 * subscription.complete flow — V1 Chrome-extension Maxance driver (M8.T7 B3).
 *
 * Completes the souscription on a devis already resumed to its Garanties tab
 * (devis.resume left it there). Mirrors quote-preview / devis-resume: an
 * advance-loop with `.navigating` responses, URL/marker-based screen
 * detection, and SW-orchestrated re-invocation across top-frame navigations.
 *
 * Pre-condition: the tab is on the Garanties tab of the resumed devis
 * (`#validerSouscription` present) — else `maxance_subscription_wrong_state`.
 *
 * Screens (in nav order):
 *   1. garanties  → the Valider souscription gate. **dryRun (DEFAULT) STOPS
 *                   here** (returns `stoppedBefore:'valider_souscription'` with
 *                   the Garanties comptant breakdown). Real → click
 *                   `#validerSouscription` (the DESTRUCTIVE button) → navigates.
 *   2. infos_compl→ fill `mouvement.numeroSerieVehicule`="1234567" (immat left
 *                   empty) → Suivant (reused `#validerSouscription` container) →
 *                   navigates.
 *   3. bancaires  → lieu de naissance commune search + INSEE select; IBAN split
 *                   across `#ibanPart0..6`; BIC; Titulaire; verify jour=5; check
 *                   "Je dispose du comptant"; parse the Comptant à régler block;
 *                   `ErrorMessage()` gate → Valider (doSubmitConfirm + popin) →
 *                   navigates (real IBAN) OR raises the RIB-test ALERTE in place.
 *   4. paiement   → detect VALIDER_FINALE_DO + "Encaissement … : T…"; extract
 *                   souscripteurRef / montant / email; SCREENSHOT. **NEVER fill
 *                   CB. STOP** (subscription.complete.ok).
 *   ⚠ rib_rejected→ ALERTE "Prélèvement sur RIB de test non autorisé" →
 *                   `maxance_subscription_rib_rejected`.
 *
 * Self-healing (background.ts): on ERROR → reset to accueil.do; on SUCCESS
 * (paiement reached OR dryRun stop) → reset to accueil.do (terminal). IBAN/BIC
 * are NEVER logged — masked to last 4.
 */
import {
  PAIEMENT_EMAIL_RE,
  PAIEMENT_ENCAISSEMENT_RE,
  PAIEMENT_MONTANT_RE,
  RIB_REJECT_RE,
  SERIE_INPUT_NAME,
  SUIVANT_INFOS_COMPL_ID,
  VALIDER_DEVIS_ID,
  VALIDER_FINALE_DO,
  VALIDER_SOUSCRIPTION_ID,
  COMPTANT_COMMISSION_RE,
  COMPTANT_DU_RE,
  COMPTANT_FRAIS_DOSSIER_RE,
  COMPTANT_FRAIS_GESTION_RE,
  parseEurFromRe,
} from '../maxance/selectors.js';
import { captureScreenshot, clickMaxanceButton, sleep } from '../dom.js';
import { extractComptantBreakdown } from './garanties-controls.js';
import {
  ErrorResponseSchema,
  type Response,
  type Screenshot,
  type SubscriptionComptant,
  type SubscriptionCompleteCommandSchema,
  SubscriptionCompleteNavigatingResponseSchema,
  SubscriptionCompleteResponseSchema,
} from '../wire.js';
import { reportProgress } from './progress.js';
import type {
  SubscriptionBancairesRequest,
  SubscriptionBancairesResponse,
  SubscriptionInfosComplResponse,
  SubscriptionValiderFinaleResponse,
} from '../content-protocol.js';
import type { z } from 'zod';

type SubscriptionCommand = z.infer<typeof SubscriptionCompleteCommandSchema>;

/** Best-effort settle pause between framework navigations. */
const SETTLE_MS = 800;

/**
 * The bancaires-page comptant breakdown, captured on the advance that fires
 * Valider. It does NOT survive the bancaires→paiement top-frame navigation
 * (Chrome destroys + re-injects the content script, so the module re-inits to
 * null) — in that common case the paiement branch simply omits it (returns
 * null). The montant on the paiement page is the authoritative figure either
 * way. Kept module-level (not a closure) so the SAME-page re-advance path
 * (e.g. RIB ALERTE in place, no nav) can still see it. (See P6 watchout.)
 */
let lastComptantBreakdown: SubscriptionComptant | null = null;

/** Mask an IBAN/BIC for logs — last 4 chars only. */
function maskTail(s: string): string {
  const t = s.replace(/\s+/g, '');
  return t.length <= 4 ? '****' : `…${t.slice(-4)}`;
}

type SubscriptionScreen =
  | 'garanties'
  | 'infos_compl'
  | 'bancaires'
  | 'rib_rejected'
  | 'paiement'
  | 'unknown';

/** Probe which souscription screen we're on. URL + markers, not state. */
function detectSubscriptionScreen(): SubscriptionScreen {
  const body = document.body?.innerText ?? '';

  // RIB-test rejection ALERTE — check first (it pops on the bancaires page in
  // place, no navigation, after Valider).
  if (RIB_REJECT_RE.test(body)) return 'rib_rejected';

  // Paiement page: URL ends with the final-do AND the encaissement marker.
  if (location.href.includes(VALIDER_FINALE_DO) && PAIEMENT_ENCAISSEMENT_RE.test(body)) {
    return 'paiement';
  }

  // Coordonnées + bancaires page: the first IBAN segment input.
  if (document.getElementById('ibanPart0')) return 'bancaires';

  // Infos complémentaires page: the N° de série input.
  if (document.querySelector(`input[name="${SERIE_INPUT_NAME}"]`)) return 'infos_compl';

  // Garanties tab of the resumed devis: BOTH Valider buttons present (the
  // disambiguation devis.resume / quote.confirm rely on).
  if (
    document.getElementById(VALIDER_SOUSCRIPTION_ID) &&
    document.getElementById(VALIDER_DEVIS_ID)
  ) {
    return 'garanties';
  }

  return 'unknown';
}

/** Ask the SW to fill the N° de série on the Infos complémentaires page. */
async function fillInfosCompl(serialNumber: string): Promise<void> {
  const msg = { kind: 'subscription.infos-compl-mw' as const, serialNumber };
  const resp = (await chrome.runtime.sendMessage(msg)) as
    | SubscriptionInfosComplResponse
    | undefined;
  if (!resp) throw new Error('maxance_subscription_infos_failed:no_response');
  if (resp.kind !== 'subscription.infos.ok') {
    throw new Error(`maxance_subscription_infos_failed:${resp.error} [${resp.log.join(',')}]`);
  }
}

/** Ask the SW to fill the Coordonnées + bancaires page. Returns comptant + validation. */
async function fillBancaires(
  cmd: SubscriptionCommand,
): Promise<{ comptantBreakdown: SubscriptionComptant; errorMessage: string }> {
  // Titulaire = the explicit accountHolder; fall back to the subscriber name
  // only if it's somehow empty (the wire schema requires min(1), so rare).
  const accountHolder =
    cmd.bank.accountHolder.trim() ||
    `${cmd.subscriber.firstName} ${cmd.subscriber.lastName}`.trim();
  const payload: SubscriptionBancairesRequest['payload'] = {
    birthPlaceCity: cmd.birthPlaceCity,
    iban: cmd.bank.iban.replace(/\s+/g, '').toUpperCase(),
    bic: cmd.bank.bic.replace(/\s+/g, '').toUpperCase(),
    accountHolder,
  };
  const msg: SubscriptionBancairesRequest = { kind: 'subscription.bancaires-mw', payload };
  const resp = (await chrome.runtime.sendMessage(msg)) as SubscriptionBancairesResponse | undefined;
  if (!resp) throw new Error('maxance_subscription_bancaires_failed:no_response');
  if (resp.kind !== 'subscription.bancaires.ok') {
    throw new Error(`maxance_subscription_bancaires_failed:${resp.error} [${resp.log.join(',')}]`);
  }
  return {
    comptantBreakdown: parseSubscriptionComptant(resp.comptantText),
    errorMessage: resp.errorMessage,
  };
}

/** Ask the SW to fire the destructive final Valider (doSubmitConfirm + popin). */
async function validerFinale(): Promise<void> {
  const msg = {
    kind: 'subscription.valider-finale-mw' as const,
    validerFinaleDo: VALIDER_FINALE_DO,
  };
  const resp = (await chrome.runtime.sendMessage(msg)) as
    | SubscriptionValiderFinaleResponse
    | undefined;
  if (!resp) throw new Error('maxance_subscription_valider_failed:no_response');
  if (resp.kind !== 'subscription.valider.ok') {
    throw new Error(`maxance_subscription_valider_failed:${resp.error} [${resp.log.join(',')}]`);
  }
}

/** Parse the "Comptant à régler" block from the bancaires page body text. */
export function parseSubscriptionComptant(
  bodyText: string | null | undefined,
): SubscriptionComptant {
  return {
    fraisGestionEur: parseEurFromRe(COMPTANT_FRAIS_GESTION_RE, bodyText),
    commissionEur: parseEurFromRe(COMPTANT_COMMISSION_RE, bodyText),
    fraisDossierEur: parseEurFromRe(COMPTANT_FRAIS_DOSSIER_RE, bodyText),
    comptantDuEur: parseEurFromRe(COMPTANT_DU_RE, bodyText),
  };
}

/**
 * Single-screen advance of the subscription flow. The SW orchestrator calls
 * this repeatedly across top-frame navigations: returns
 * `subscription.complete.navigating` after triggering a navigation,
 * `subscription.complete.ok` on completion, or `error`.
 */
export async function runSubscriptionComplete(cmd: SubscriptionCommand): Promise<Response> {
  const t0 = Date.now();
  const screenshots: Screenshot[] = [];
  const shoot = async (step: string): Promise<void> => {
    try {
      screenshots.push(await captureScreenshot(step));
    } catch {
      /* best-effort */
    }
  };
  const navigating = (fromScreen: string, expectedScreen: string): Response =>
    SubscriptionCompleteNavigatingResponseSchema.parse({
      id: cmd.id,
      kind: 'subscription.complete.navigating',
      fromScreen,
      expectedScreen,
      screenshots,
    });
  const fail = (errorCode: string, detail: string): Response =>
    ErrorResponseSchema.parse({
      id: cmd.id,
      kind: 'error',
      errorCode,
      detail: detail.slice(0, 240),
      screenshots,
    });

  try {
    await sleep(SETTLE_MS);

    // Pre-check: we MUST start on the Garanties tab of the resumed devis.
    const firstScreen = detectSubscriptionScreen();
    if (firstScreen !== 'garanties') {
      return fail(
        'maxance_subscription_wrong_state',
        `expected garanties tab, found screen=${firstScreen} url=${location.href}`,
      );
    }

    for (let iter = 0; iter < 8; iter += 1) {
      const screen = detectSubscriptionScreen();
      await reportProgress(cmd.id, 'subscription_advance_iter', `screen=${screen}`);

      if (screen === 'rib_rejected') {
        await shoot('subscription_rib_rejected');
        return fail(
          'maxance_subscription_rib_rejected',
          'ALERTE: Prélèvement sur RIB de test non autorisé',
        );
      }

      if (screen === 'garanties') {
        await shoot('subscription_garanties_pre');
        if (cmd.dryRun) {
          // DRYRUN GATE: STOP before the destructive Valider souscription click.
          // Capture the Garanties comptant breakdown (we're still on that tab).
          const garantiesComptant = extractComptantBreakdown();
          await reportProgress(cmd.id, 'subscription_dryrun_stop', 'before valider_souscription');
          return SubscriptionCompleteResponseSchema.parse({
            id: cmd.id,
            kind: 'subscription.complete.ok',
            dryRun: true,
            stoppedBefore: 'valider_souscription',
            comptantBreakdown: null,
            garantiesComptant,
            screenshots,
            finalUrl: location.href,
            durationMs: Date.now() - t0,
          });
        }
        // REAL: click the DESTRUCTIVE Valider souscription button.
        await reportProgress(cmd.id, 'subscription_valider_souscription');
        await clickMaxanceButton(VALIDER_SOUSCRIPTION_ID, { label: 'valider_souscription' });
        await shoot('subscription_after_valider_souscription');
        return navigating('garanties', 'infos_compl');
      }

      if (screen === 'infos_compl') {
        await shoot('subscription_infos_compl_pre');
        await reportProgress(cmd.id, 'subscription_infos_compl', `serie=${cmd.serialNumber}`);
        await fillInfosCompl(cmd.serialNumber);
        await reportProgress(cmd.id, 'subscription_infos_suivant');
        await clickMaxanceButton(SUIVANT_INFOS_COMPL_ID, { label: 'infos_compl_suivant' });
        await shoot('subscription_infos_compl_after_suivant');
        return navigating('infos_compl', 'bancaires');
      }

      if (screen === 'bancaires') {
        await shoot('subscription_bancaires_pre');
        await reportProgress(
          cmd.id,
          'subscription_bancaires_fill',
          `iban=${maskTail(cmd.bank.iban)} bic=${maskTail(cmd.bank.bic)}`,
        );
        const { comptantBreakdown, errorMessage } = await fillBancaires(cmd);
        if (errorMessage) {
          await shoot('subscription_bancaires_validation_error');
          return fail('maxance_subscription_validation_failed', errorMessage);
        }
        await shoot('subscription_bancaires_filled');
        await reportProgress(cmd.id, 'subscription_valider_finale');
        // Stash the bancaires comptant on the flow's closure for the paiement
        // success (the paiement page re-reads montant; comptantBreakdown is the
        // bancaires figure). We carry it via the navigating screenshots step —
        // re-parse not needed because the success below re-derives montant from
        // the paiement page. Persist comptant in module-less way: return it on
        // the paiement branch by re-reading? The bancaires page is gone after
        // nav, so capture it here on the response trail via a closure variable.
        lastComptantBreakdown = comptantBreakdown;
        await validerFinale();
        await shoot('subscription_after_valider_finale');
        // Either navigates to Paiement (real IBAN) or raises the RIB ALERTE in
        // place — the orchestrator re-advances and detection picks the branch.
        return navigating('bancaires', 'paiement');
      }

      if (screen === 'paiement') {
        await shoot('subscription_paiement');
        const body = document.body?.innerText ?? '';
        const refMatch = PAIEMENT_ENCAISSEMENT_RE.exec(body);
        const souscripteurRef = refMatch?.[1];
        const montant = parseEurFromRe(PAIEMENT_MONTANT_RE, body);
        const emailMatch = PAIEMENT_EMAIL_RE.exec(body);
        await reportProgress(
          cmd.id,
          'subscription_paiement_reached',
          `ref=${souscripteurRef ?? '?'} montant=${montant ?? '?'}`,
        );
        // NEVER fill the CB form. STOP.
        return SubscriptionCompleteResponseSchema.parse({
          id: cmd.id,
          kind: 'subscription.complete.ok',
          dryRun: false,
          comptantBreakdown: lastComptantBreakdown,
          ...(souscripteurRef !== undefined ? { souscripteurRef } : {}),
          ...(montant != null ? { montantComptantEur: montant } : {}),
          ...(emailMatch?.[1] ? { souscripteurEmail: emailMatch[1] } : {}),
          screenshots,
          finalUrl: location.href,
          durationMs: Date.now() - t0,
        });
      }

      // unknown — settle and retry detection once.
      await sleep(SETTLE_MS);
    }

    return fail(
      'maxance_subscription_unknown_screen',
      `advance loop exhausted on screen=${detectSubscriptionScreen()} url=${location.href}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(
      msg.startsWith('maxance_')
        ? (msg.split(':')[0] ?? 'maxance_subscription_unknown')
        : 'maxance_subscription_unknown',
      msg,
    );
  }
}
