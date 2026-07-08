/**
 * Sales Agent — customer-facing French message formatters (extracted from
 * agent.ts to keep the agent class a thin dispatcher).
 *
 * Every function here is PURE (no DB, no LLM, no I/O) and covered by unit
 * tests. The headline figures must be EXACT and stable — Achraf reviews the
 * wording once, then it's locked, so these are templated rather than
 * synthesised by an LLM.
 *
 * The trailing `(réf #<quoteId>)` lines double as idempotency / lookup
 * markers — invisible enough to read like a normal support reference, and the
 * QUOTE.* / SUBSCRIPTION.* handlers scan recent outbound turns for them to
 * detect "we already sent this".
 *
 * Re-exported from `agent.ts` so existing importers (`from './agent.js'`,
 * including the format unit tests) are unaffected.
 */

/** Capitalize the first letter — customer rows often store lowercase names
 *  ("achraf" → "Achraf" in the greeting; live feedback 2026-07-02). */
function capFirst(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

type Formule = 'tiers_illimite' | 'vol_incendie' | 'dommages_tous_accidents';

const FORMULE_LABEL: Record<Formule, string> = {
  tiers_illimite: 'Tiers Illimité',
  vol_incendie: 'Tiers Illimité + Vol & Incendie',
  dommages_tous_accidents: 'Tous Risques',
};

/** One formule's pricing as extracted live off the Maxance Garanties tab. */
export interface FormulePricingLine {
  formule: Formule;
  /** Formules-table Montant — the ANNUAL premium (NOT a monthly price). */
  annualPremiumEur?: number;
  /** First payment for this formule (fractionnement mensuel). */
  comptantEur?: number;
  /** The customer-facing MONTHLY payment ("Terme suivant"). */
  termeSuivantEur?: number;
  coutAnnuelBrutEur?: number;
}

/** Garanties-additionnelles ANNUAL prices (monthly pitch = annual/12). */
export interface AddOnPricingInfo {
  assistanceAnnualEur?: number;
  garantiePersonnelleAnnualEur?: number;
}

/**
 * Format the customer-facing French price-preview message for a trottinette
 * quote.
 *
 * 2026-07-02 — Achraf's sales method: when the operator supplies the
 * per-formule monthlies (`formulePricing`), present ALL formules as
 * mensualités + the two garanties additionnelles + the recommended pack
 * (Tiers Illimité + both options). ⚠️ The old single-price body printed the
 * formules-table Montant as "Mensuel" — that number is the ANNUAL premium
 * (66,20 € sent as monthly; the real monthly was 6,51 €). The legacy body
 * remains ONLY as a fallback for old extension builds, fed by the corrected
 * `monthly` (= Terme suivant).
 */
export function formatQuotePreviewMessage(opts: {
  firstName?: string;
  monthly?: number;
  annual?: number;
  formule: Formule;
  quoteId: string;
  formulePricing?: FormulePricingLine[];
  addOns?: AddOnPricingInfo;
}): string {
  const greeting = opts.firstName ? `Bonjour ${capFirst(opts.firstName)},` : 'Bonjour,';
  const refLine = `(réf #${opts.quoteId.slice(0, 8)})`;

  // Rich path — Achraf's script. Requires at least one per-formule monthly.
  const priced = (opts.formulePricing ?? []).filter((f) => f.termeSuivantEur !== undefined);
  if (priced.length > 0) {
    const ORDER: Formule[] = ['tiers_illimite', 'vol_incendie', 'dommages_tous_accidents'];
    const byFormule = new Map(priced.map((f) => [f.formule, f]));
    const lines: string[] = [greeting, '', 'Voici vos tarifs trottinette (par mois) :'];
    for (const f of ORDER) {
      const row = byFormule.get(f);
      if (row?.termeSuivantEur === undefined) continue;
      lines.push(`• ${FORMULE_LABEL[f]} : ${formatEur(row.termeSuivantEur)}/mois`);
    }

    const assistanceMonthly =
      opts.addOns?.assistanceAnnualEur !== undefined
        ? opts.addOns.assistanceAnnualEur / 12
        : undefined;
    const gpcMonthly =
      opts.addOns?.garantiePersonnelleAnnualEur !== undefined
        ? opts.addOns.garantiePersonnelleAnnualEur / 12
        : undefined;
    if (assistanceMonthly !== undefined || gpcMonthly !== undefined) {
      lines.push('', 'Options ajoutables à toute formule :');
      if (assistanceMonthly !== undefined) {
        lines.push(
          `• Assistance Mobilité : +${formatEur(assistanceMonthly)}/mois — dépannage pris en charge quoi qu'il arrive`,
        );
      }
      if (gpcMonthly !== undefined) {
        lines.push(
          `• Garantie Personnelle du Conducteur : +${formatEur(gpcMonthly)}/mois — vous couvre (soins, hôpital) même si vous êtes responsable`,
        );
      }
    }

    // Recommended pack: Tiers Illimité + both options (Achraf's pitch).
    const tiers = byFormule.get('tiers_illimite');
    if (
      tiers?.termeSuivantEur !== undefined &&
      assistanceMonthly !== undefined &&
      gpcMonthly !== undefined
    ) {
      const packMonthly = tiers.termeSuivantEur + assistanceMonthly + gpcMonthly;
      lines.push(
        '',
        `💡 Notre conseil : Tiers Illimité + les 2 options, soit environ ${formatEur(packMonthly)}/mois — c'est la protection que choisissent la plupart de nos clients.`,
      );
    }

    // Payment structure (2026-07-08, Achraf's method v2 — mirrors the
    // closing-knowledge frais model): honoraires de gestion = 50/60/65 €
    // (formule-dependent), FIRST YEAR ONLY, paid in two parts — one via the
    // payment link at souscription, the rest inside the first prélèvement
    // (comptant = frais part + 1st mensualité). Both parts are computable
    // from the preview: fraisPart = comptant − mensualité; linkPart =
    // totalHonoraires − fraisPart. Falls back to the simple line when the
    // arithmetic doesn't hold (unexpected Maxance pricing shape).
    const HONORAIRES_TOTAL: Record<Formule, number> = {
      tiers_illimite: 50,
      vol_incendie: 60,
      dommages_tous_accidents: 65,
    };
    const requested = byFormule.get(opts.formule) ?? tiers;
    if (requested?.comptantEur !== undefined) {
      const totalHonoraires = HONORAIRES_TOTAL[requested.formule] ?? 50;
      const fraisPart =
        requested.termeSuivantEur !== undefined
          ? requested.comptantEur - requested.termeSuivantEur
          : undefined;
      const linkPart = fraisPart !== undefined ? totalHonoraires - fraisPart : undefined;
      if (
        fraisPart !== undefined &&
        linkPart !== undefined &&
        fraisPart > 0 &&
        linkPart > 0 &&
        fraisPart < totalHonoraires
      ) {
        lines.push(
          '',
          'Côté paiement :',
          `• À la souscription, par lien de paiement : ${formatEur(linkPart)} — 1re partie des honoraires de gestion du dossier`,
          `• 1er prélèvement le 5 du mois suivant : ${formatEur(requested.comptantEur)} (le reste des honoraires + votre 1re mensualité), puis mensualités normales`,
          `Pour faire simple : les honoraires de gestion s'élèvent à ${formatEur(totalHonoraires)} la première année — ensuite c'est gratuit — payés en deux parties.`,
        );
      } else {
        lines.push('', `Premier paiement : ${formatEur(requested.comptantEur)}, puis mensualités.`);
      }
    }

    lines.push(
      '',
      'Quelle formule vous convient ? Je vous envoie le devis officiel par mail — avec ou sans options, ou les deux pour comparer.',
      '',
      refLine,
    );
    return lines.join('\n');
  }

  // Legacy fallback (old extension builds without formulePricing).
  const lines: string[] = [greeting, '', 'Voici votre devis trottinette :'];
  if (opts.monthly !== undefined) {
    lines.push(`• Mensuel : ${formatEur(opts.monthly)}`);
  }
  if (opts.annual !== undefined) {
    lines.push(`• Annuel : ${formatEur(opts.annual)}`);
  }
  lines.push(`• Formule : ${FORMULE_LABEL[opts.formule]}`);
  lines.push('');
  lines.push('Souhaitez-vous que je vous envoie le devis officiel par mail ?');
  lines.push('');
  lines.push(refLine);
  return lines.join('\n');
}

/**
 * Customer-facing note when the devis was generated and the PDF is in
 * transit through the inbox relay (Maxance → contact@ → WhatsApp/email).
 * The actual document message follows from handleDevisPdfReceived — this
 * one just closes the loop instantly so the customer never wonders.
 */
export function formatQuoteRelayPendingMessage(opts: {
  firstName?: string;
  devisNumber: string;
  quoteId: string;
}): string {
  const greeting = opts.firstName ? `Bonjour ${capFirst(opts.firstName)},` : 'Bonjour,';
  return [
    greeting,
    '',
    `Votre devis est prêt ! 📄 Référence : ${opts.devisNumber}.`,
    "Je vous l'envoie ici même et par email dans un instant.",
    '',
    `(réf #${opts.quoteId.slice(0, 8)} envoyé)`,
  ].join('\n');
}

/**
 * Customer-facing confirmation after Maxance has emailed the quote PDF.
 * Achraf's wording — locked once, templated forever.
 */
/**
 * dryRun confirm (MAXANCE_CONFIRM_FORCE_DRYRUN=1): the devis RECORD exists
 * but NO courrier was sent — claiming "arrivé par mail" would be a lie the
 * customer can check (live 2026-07-06, DR0000984054). Announce the creation
 * only; delivery follows when a real send happens.
 */
export function formatQuoteDryRunReadyMessage(opts: {
  firstName?: string;
  devisNumber: string;
  quoteId: string;
}): string {
  const greeting = opts.firstName ? `Bonjour ${capFirst(opts.firstName)},` : 'Bonjour,';
  return [
    greeting,
    '',
    `Votre devis trottinette est créé ✅ Référence : ${opts.devisNumber}.`,
    `L'envoi du document est en cours de préparation — il vous parvient très vite.`,
    '',
    `(réf #${opts.quoteId.slice(0, 8)} envoyé)`,
  ].join('\n');
}

export function formatQuoteReadyMessage(opts: {
  firstName?: string;
  pdfSentTo: string;
  devisNumber: string;
  quoteId: string;
}): string {
  const greeting = opts.firstName ? `Bonjour ${capFirst(opts.firstName)},` : 'Bonjour,';
  return [
    greeting,
    '',
    `C'est envoyé ! Votre devis trottinette vient d'arriver par mail à ${opts.pdfSentTo}.`,
    `Référence du devis : ${opts.devisNumber}.`,
    '',
    'Vérifiez aussi vos spams si vous ne le voyez pas.',
    '',
    `(réf #${opts.quoteId.slice(0, 8)} envoyé)`,
  ].join('\n');
}

/**
 * Customer-facing message when the Maxance flow blew up. Deliberately vague
 * — the customer doesn't need to know about Cloudflare / Stagehand / Auth0.
 * The real diagnostics are in the HUMAN_ACTION the handler also creates.
 */
export function formatQuoteFailedMessage(opts: { firstName?: string; quoteId: string }): string {
  const greeting = opts.firstName ? `Bonjour ${capFirst(opts.firstName)},` : 'Bonjour,';
  return [
    greeting,
    '',
    "J'ai un petit souci technique pour finaliser votre devis trottinette.",
    'Un conseiller revient vers vous très rapidement.',
    '',
    `(réf #${opts.quoteId.slice(0, 8)})`,
  ].join('\n');
}

/**
 * Customer-facing closing message after the Maxance Operator reached the
 * Paiement page (M8.T7). Templated, no LLM call — the figures must be EXACT
 * and the frais wording COMPLIANT (Ridaa 2026-06-11: never "X € de frais de
 * dossier" bluntly, never "taxe imposée par l'État"; use "honoraires
 * d'accompagnement administratif"). The customer pays the Assuryal frais part
 * via the payment link; the comptant restant is prélevé sur le compte.
 */
export function formatSubscriptionReadyMessage(opts: {
  firstName?: string;
  montantComptantEur?: number;
  fraisDossierTotalEur: number;
  assuryalFraisEur: number;
  paymentLinkUrl: string | null;
  quoteId: string;
}): string {
  const greeting = opts.firstName ? `Bonjour ${capFirst(opts.firstName)},` : 'Bonjour,';
  const lines: string[] = [greeting, '', 'Votre souscription est presque finalisée. 🎉', ''];

  // Compliant frais framing — honoraires d'accompagnement, never "frais de
  // dossier" bluntly, never a "taxe d'État".
  lines.push(
    `Pour activer votre contrat, il reste à régler vos honoraires ` +
      `d'accompagnement administratif : ${formatEur(opts.assuryalFraisEur)}.`,
  );
  if (opts.montantComptantEur !== undefined) {
    lines.push(
      `Le comptant restant (${formatEur(opts.montantComptantEur)}) sera ` +
        'prélevé sur votre compte le 5 du mois prochain.',
    );
  }
  lines.push('');

  if (opts.paymentLinkUrl) {
    lines.push('Réglez en quelques secondes, en toute sécurité, via ce lien :');
    lines.push(opts.paymentLinkUrl);
  } else {
    lines.push('Votre conseiller vous transmet le lien de paiement sécurisé dans un instant.');
  }
  lines.push('');
  lines.push('Dès réception, votre contrat est débloqué et envoyé pour signature.');
  lines.push('');
  lines.push(`(réf #${opts.quoteId.slice(0, 8)} paiement)`);
  return lines.join('\n');
}

/**
 * Customer-facing message when the souscription flow failed. Deliberately
 * vague — the customer doesn't need the Maxance internals; the real
 * diagnostics live in the HUMAN_ACTION the handler also creates.
 */
export function formatSubscriptionFailedMessage(opts: {
  firstName?: string;
  quoteId: string;
}): string {
  const greeting = opts.firstName ? `Bonjour ${capFirst(opts.firstName)},` : 'Bonjour,';
  return [
    greeting,
    '',
    "J'ai un petit souci technique pour finaliser votre souscription.",
    'Un conseiller revient vers vous très rapidement pour la valider avec vous.',
    '',
    `(réf #${opts.quoteId.slice(0, 8)})`,
  ].join('\n');
}

/**
 * Format a EUR number French-style: `18.95€/mois` style numbers stay
 * accurate, but the decimal separator is a comma (`18,95 €`) per French
 * convention. Two decimals always.
 */
export function formatEur(value: number): string {
  // toFixed(2) → "18.95"; swap the dot for a comma.
  return `${value.toFixed(2).replace('.', ',')} €`;
}
