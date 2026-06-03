/**
 * quote.confirm flow — V1 Chrome-extension Maxance driver.
 *
 * Replicates the M8.T6 Stagehand step planner using vanilla DOM ops +
 * same-origin iframe traversal. The M8.T8 live investigation proved
 * #window_nvCourrier is a same-origin iframe — no coordinate clicks
 * needed.
 *
 * Pre-condition: caller has just received a successful QuotePreviewOk
 * on the same tab. We're sitting on the Garanties tab with a price.
 *
 * Steps:
 *   1. Click "Valider devis".
 *   2. Devis tab fill (Civilité, Nom, Prénom, Profession, CP, Ville,
 *      voie, optional addressComplement, phone widget, email widget).
 *   3. Click "OK".
 *   4. Wait for Edition à imprimer (souscriptionDevisValiderFinaleMoto.do).
 *   5. Extract devisNumber from the page heading.
 *   6. Click "Envoyer par..." next to "Devis moto".
 *   7. Wait for #window_nvCourrier iframe to populate.
 *   8. Inside the iframe: open the mail composer (envelope icon /
 *      template selection), fill Adresse + Objet.
 *   9. If dryRun=false → click Envoyer. Otherwise STOP here.
 *
 * The mail-composer sub-dialog inside the iframe couldn't be fully
 * mapped via DOM during the M8.T8 live investigation (the previous
 * popup was in an error state). We use defensive heuristic selectors
 * with fallbacks, document the unknowns in comments, and rely on phase
 * 2d live verification to surface anything we got wrong.
 */
import {
  CIVILITE_VALUE,
  COURRIER_POPUP_URL_PATH,
  EMAIL_ROLE_GESTION,
  PHONE_COUNTRY_FR,
  PHONE_TYPE_MOBILE,
  PHONE_USAGE_PERSO,
  PROFESSION_VALUE,
  PROXIMEO_URL_SIGNATURES,
} from '@f16/stagehand/maxance/selectors';
import {
  captureScreenshot,
  clickContactWidgetNouveau,
  clickMaxanceButton,
  courrierFillAndSend,
  devisFillAndSubmitMainWorld,
  fillByLabel,
  setSelectByLabel,
  sleep,
  waitFor,
} from '../dom.js';
import { openMdiWindowMainWorld } from '../iframe.js';
import {
  type QuoteConfirmCommandSchema,
  QuoteConfirmResponseSchema,
  QuoteConfirmNavigatingResponseSchema,
  ErrorResponseSchema,
  type Response,
  type Screenshot,
} from '../wire.js';
import { reportProgress } from './progress.js';
import type { z } from 'zod';

type QuoteConfirmCommand = z.infer<typeof QuoteConfirmCommandSchema>;

const SETTLE_MS = 800;

/** devisNumber pattern from M8.T6 live: DRxxxxxxxxxx (10-digit). */
const DEVIS_NUMBER_REGEX = /\b(DR\d{8,12})\b/;

/**
 * Extract devisNumber from the Edition à imprimer page. The number sits
 * inside the line "Votre devis est enregistré sous le numéro : DRxxxxxxxx".
 */
function extractDevisNumber(): string | null {
  const text = document.body.innerText ?? '';
  const m = DEVIS_NUMBER_REGEX.exec(text);
  return m?.[1] ?? null;
}

/**
 * Open the Courrier popup programmatically via mdiWindNet, then wait for
 * its iframe to populate.
 *
 * Phase-2g (Courrier reliability fix): the open now routes through
 * `openMdiWindowMainWorld` (SW → chrome.scripting{world:'MAIN'}) because
 * `mdiWindNet` is a page main-world global the isolated content script
 * can't see. The previous direct `openMdiWindow()` call ALWAYS threw
 * `maxance_iframe_mdiWindNet_unavailable` in the isolated world and fell
 * back to the flaky `clickByText('Envoyer par...')` path — the documented
 * source of the `maxance_iframe_not_ready:courrier_popup_ready` timeouts.
 *
 * Robustness: try the main-world open then wait for readiness; on the
 * first failure, fall back to the Envoyer-par button click and wait again.
 * Each open gets its own readiness wait so a slow first open doesn't eat
 * the fallback's budget.
 *
 * NOTE: NOT yet live-verified (Maxance portal was closed when this landed
 * — see project_m8_t8_progress.md). Confirm against the real portal before
 * flipping dryRun=false.
 */
/**
 * Phase-2g diagnostic: snapshot the live DOM right after a Courrier open
 * attempt so the WS log reveals what `mdiWindNet.window()` actually
 * produced (iframe inventory, candidate IDs, same-origin readability).
 * Runs in the isolated content script — same-origin iframe enumeration +
 * contentDocument reads work cross-world. Cheap; emitted via reportProgress.
 */
// @ts-expect-error phase-2h diagnostic retained pending cleanup (now unused — the
// corrected phase-2i send path replaced the probe; delete after live verification)
function _dumpCourrierDom(): string {
  // Recursively walk same-origin frames starting at #window_nvCourrier so we
  // can map the full Courrier frame tree (the content renders several frames
  // deep, not directly in window_nvCourrier as the legacy code assumed).
  type FrameInfo = {
    path: string;
    id: string;
    src: string;
    bodyLen: number;
    tags: string;
    bodyText: string;
  };
  const out: (FrameInfo & { inputs?: string[]; clicks?: string[] })[] = [];
  const root = document.getElementById('window_nvCourrier') as HTMLIFrameElement | null;
  const walk = (frameEl: HTMLIFrameElement, path: string, depth: number): void => {
    if (depth > 4 || out.length > 16) return;
    let idoc: Document | null = null;
    let bodyLen = -1;
    let tags = '';
    let bodyText = '';
    let inputs: string[] | undefined;
    let clicks: string[] | undefined;
    try {
      idoc = frameEl.contentDocument;
      bodyLen = idoc?.body?.innerText?.length ?? -1;
      bodyText = (idoc?.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 160);
      if (idoc) {
        tags = `sel=${idoc.querySelectorAll('select').length} inp=${idoc.querySelectorAll('input').length} a=${idoc.querySelectorAll('a').length} tr=${idoc.querySelectorAll('tr').length} form=${idoc.querySelectorAll('form').length} btn=${idoc.querySelectorAll('button,input[type=submit],input[type=button]').length} ifr=${idoc.querySelectorAll('iframe').length}`;
        // Capture form fields + clickables for frames that have a form/inputs
        // (these are the candidate composer frames).
        const allInputs = Array.from(
          idoc.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
            'input, textarea, select',
          ),
        );
        if (allInputs.length) {
          inputs = allInputs.slice(0, 14).map((el) => {
            const type = el instanceof HTMLInputElement ? el.type : el.tagName.toLowerCase();
            return `${type}:${el.getAttribute('name') ?? '(noname)'}=${String((el as HTMLInputElement).value ?? '').slice(0, 30)}`;
          });
        }
        const clickEls = Array.from(
          idoc.querySelectorAll<HTMLElement>(
            'a, img[onclick], input[type=submit], input[type=button], button, .buttonMiddle, [onclick]',
          ),
        );
        if (clickEls.length) {
          clicks = clickEls.slice(0, 22).map((el) => {
            const txt = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 36);
            const alt = el.getAttribute('alt') ?? '';
            const val = (el as HTMLInputElement).value ?? '';
            const href = el.getAttribute('href') ?? '';
            const oc = (el.getAttribute('onclick') ?? '').slice(0, 220);
            return `<${el.tagName.toLowerCase()}> t="${txt}" alt="${alt}" v="${val}" href="${href.slice(0, 200)}" oc="${oc}"`;
          });
        }
      }
    } catch {
      tags = 'CROSS_ORIGIN_OR_UNREADABLE';
    }
    out.push({
      path,
      id: frameEl.id || '(noid)',
      src: (frameEl.getAttribute('src') ?? '').slice(0, 110),
      bodyLen,
      tags,
      bodyText,
      ...(inputs ? { inputs } : {}),
      ...(clicks ? { clicks } : {}),
    });
    if (idoc) {
      const kids = Array.from(idoc.querySelectorAll('iframe, frame')) as HTMLIFrameElement[];
      kids.forEach((kid, i) => walk(kid, `${path}>${kid.id || `f${i}`}`, depth + 1));
    }
  };
  if (root) walk(root, 'window_nvCourrier', 0);
  return JSON.stringify({
    url: location.href,
    hasWindowNvCourrier: Boolean(root),
    frameTree: out,
  });
}

/**
 * Decision 2026-06-01 (Ridaa): send the devis to the customer via Maxance's
 * OWN Courrier email (BCC Contact@assuryalconseil.fr); Gmail-PDF pull is V2.
 * Open the REAL email-management popup using the edition page's own onclick
 * (id:nvCourrier, listerModeleLettreAutorise.do?TYPE=Devis&PAGE=0000502000 —
 * NOT the impressionDR print button), then map the nested composer frames
 * (template list, recipient/destinataire, Cc/Cci-BCC, objet, Envoyer) via the
 * shared dumpCourrierDom walker so we can build the fill+BCC+send.
 */
// @ts-expect-error phase-2h diagnostic retained pending cleanup (now unused — the
// corrected phase-2i send path replaced the probe; delete after live verification)
async function _probeEmailComposer(cmd: QuoteConfirmCommand): Promise<string> {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('[onclick]')).filter((el) =>
    /listerModeleLettreAutorise|nvCourrier|courrier/i.test(el.getAttribute('onclick') ?? ''),
  );
  const ctrl =
    candidates.find((el) => {
      const oc = el.getAttribute('onclick') ?? '';
      return /id:\s*nvCourrier/i.test(oc) && /PAGE=0000502000|TYPE=Devis/i.test(oc);
    }) ?? candidates[0];
  if (!ctrl) {
    return JSON.stringify({ error: 'no_nvCourrier_email_control' });
  }
  const oc = ctrl.getAttribute('onclick') ?? '';
  const m = /mdiWindNet\.window\(\s*'([^']+)'\s*,\s*[^,]+,\s*'([^']*)'/.exec(oc);
  if (!m || !m[1]) return JSON.stringify({ error: 'onclick_parse_failed', oc: oc.slice(0, 200) });
  const url = m[1];
  const opts = m[2] ?? '';
  try {
    await openMdiWindowMainWorld(url, opts);
  } catch (e) {
    return JSON.stringify({
      error: 'open_failed',
      detail: e instanceof Error ? e.message : String(e),
      url,
      opts,
    });
  }
  await sleep(7_000); // let the courrier list frameset load
  // Step 2: open the AD (Accompagnement Devis) compose window — this is where
  // the recipient/email/BCC/objet/Envoyer fields live. The list page links
  // use openWindows('preparerLettre.do?ligneSelected=AD', label); we replay
  // the underlying mdiWindNet open from the top main world (same session).
  let adOpen = 'not_attempted';
  try {
    await openMdiWindowMainWorld(
      'preparerLettre.do?ligneSelected=AD',
      'id:preparerAD; title: Courrier; width: 700; height: 750;',
    );
    adOpen = 'ok';
  } catch (e) {
    adOpen = `err:${e instanceof Error ? e.message : String(e)}`;
  }
  await sleep(10_000); // let the compose window + its frameset load
  // Walk ALL popup frames (window_*) so we capture both the list popup and
  // the AD compose window, with inputs + clickables per frame.
  type FI = {
    path: string;
    src: string;
    bodyLen: number;
    tags: string;
    bodyText: string;
    inputs?: string[];
    clicks?: string[];
  };
  const frames: FI[] = [];
  const walkAll = (doc: Document, path: string, depth: number): void => {
    if (depth > 6 || frames.length > 24) return;
    Array.from(doc.querySelectorAll('iframe, frame')).forEach((f, i) => {
      const fe = f as HTMLIFrameElement;
      const fp = `${path}>${fe.id || `f${i}`}`;
      let idoc: Document | null = null;
      let bodyLen = -1;
      let tags = '';
      let bodyText = '';
      let inputs: string[] | undefined;
      let clicks: string[] | undefined;
      try {
        idoc = fe.contentDocument;
        bodyLen = idoc?.body?.innerText?.length ?? -1;
        bodyText = (idoc?.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 140);
        if (idoc) {
          tags = `sel=${idoc.querySelectorAll('select').length} inp=${idoc.querySelectorAll('input').length} a=${idoc.querySelectorAll('a').length} ta=${idoc.querySelectorAll('textarea').length} form=${idoc.querySelectorAll('form').length} ifr=${idoc.querySelectorAll('iframe').length}`;
          // Selective: drop the ~190 hidden template tags. Keep selects,
          // textareas, and inputs whose name hints at recipient/channel/BCC/
          // subject (email, courriel, mail, cci, copie, destinat, objet,
          // envoi, canal, mode, choix, adr).
          const relevant =
            /mail|courriel|cci|copie|destinat|objet|envoi|canal|mode|choix|adr|email|telecopie|fax/i;
          const fields = Array.from(
            idoc.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
              'input, textarea, select',
            ),
          ).filter((el) => {
            const tag = el.tagName.toLowerCase();
            if (tag === 'select' || tag === 'textarea') return true;
            if ((el as HTMLInputElement).type === 'hidden') {
              return relevant.test(el.getAttribute('name') ?? '');
            }
            return true;
          });
          if (fields.length) {
            inputs = fields.slice(0, 30).map((el) => {
              const tag = el.tagName.toLowerCase();
              const type = el instanceof HTMLInputElement ? el.type : tag;
              let extra = '';
              if (el instanceof HTMLSelectElement) {
                extra = `[${Array.from(el.options)
                  .slice(0, 6)
                  .map((o) => o.value)
                  .join('|')}]`;
              }
              return `${type}:${el.getAttribute('name') ?? '(noname)'}=${String((el as HTMLInputElement).value ?? '').slice(0, 40)}${extra}`;
            });
          }
          // Clickables that look like send/channel/print actions.
          const sendRe =
            /envoy|valid|email|courriel|imprim|envoi|annul|fermer|suivant|\bok\b|mail|post/i;
          const cl = Array.from(
            idoc.querySelectorAll<HTMLElement>(
              'a, button, input[type=submit], input[type=button], .buttonMiddle, [onclick]',
            ),
          ).filter((el) => {
            const t = `${el.textContent ?? ''} ${(el as HTMLInputElement).value ?? ''} ${el.getAttribute('onclick') ?? ''} ${el.getAttribute('title') ?? ''} ${el.getAttribute('alt') ?? ''}`;
            return sendRe.test(t);
          });
          if (cl.length) {
            clicks = cl.slice(0, 16).map((el) => {
              const txt = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 30);
              const v = (el as HTMLInputElement).value ?? '';
              return `<${el.tagName.toLowerCase()}> t="${txt}" v="${v}" oc="${(el.getAttribute('onclick') ?? '').slice(0, 90)}"`;
            });
          }
        }
      } catch {
        tags = 'CROSS_ORIGIN';
      }
      frames.push({
        path: fp,
        src: (fe.getAttribute('src') ?? '').slice(0, 110),
        bodyLen,
        tags,
        bodyText,
        ...(inputs ? { inputs } : {}),
        ...(clicks ? { clicks } : {}),
      });
      if (idoc) walkAll(idoc, fp, depth + 1);
    });
  };
  walkAll(document, 'top', 0);
  const popupIds = Array.from(document.querySelectorAll('iframe[id^="window_"]')).map(
    (f) => (f as HTMLElement).id,
  );
  const adFrames = frames.filter((f) => /preparerAD/i.test(f.path));
  const composeFrame = adFrames.find((f) => /preparerAD>preparerAD/.test(f.path)) ?? adFrames[1];
  // Emit fields + buttons as SEPARATE small events (the combined dump exceeds
  // the WS log line cap and truncates).
  await reportProgress(cmd.id, 'ad_fields', JSON.stringify(composeFrame?.inputs ?? []));
  await reportProgress(cmd.id, 'ad_buttons', JSON.stringify(composeFrame?.clicks ?? []));
  // Map each mail input to its row LABEL so we learn the To/CC/Cci(BCC) field
  // names (the inputs themselves aren't named cc/cci; labels live in sibling
  // <td>s like "A :", "CC :", "Cci :"). Deep-walk the preparerAD frame doc.
  let mailFields: string[] = [];
  try {
    const cw = document.getElementById('window_preparerAD') as HTMLIFrameElement | null;
    const collectInputs = (doc: Document | null | undefined, depth: number): HTMLElement[] => {
      if (!doc || depth > 4) return [];
      let acc = Array.from(
        doc.querySelectorAll<HTMLElement>(
          'input[type=text],input[type=email],input:not([type]),textarea',
        ),
      );
      for (const fr of Array.from(doc.querySelectorAll('iframe,frame'))) {
        try {
          acc = acc.concat(collectInputs((fr as HTMLIFrameElement).contentDocument, depth + 1));
        } catch {
          /* skip */
        }
      }
      return acc;
    };
    const labelOf = (el: HTMLElement): string => {
      // nearest enclosing <tr>'s first cell text, else previous cell, else
      // labelled-by, else placeholder/title.
      const tr = el.closest('tr');
      const rowTxt = tr ? (tr.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) : '';
      const td = el.closest('td');
      const prev =
        td?.previousElementSibling?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 24) ?? '';
      return prev || rowTxt || el.getAttribute('placeholder') || el.getAttribute('title') || '';
    };
    mailFields = collectInputs(cw?.contentDocument, 0)
      .slice(0, 40)
      .map((el) => {
        const name = el.getAttribute('name') ?? '(noname)';
        const val = String((el as HTMLInputElement).value ?? '').slice(0, 30);
        const vis =
          el.offsetParent === null && getComputedStyle(el).display === 'none' ? 'hidden' : 'vis';
        return `[${vis}] "${labelOf(el)}" => ${name}=${val}`;
      })
      // keep the mail-relevant ones + anything labelled A/CC/Cci/objet/mail
      .filter((s) => /mail|courriel|\bA\b|cc|cci|copie|objet|destinat|@/i.test(s));
  } catch {
    /* skip */
  }
  await reportProgress(cmd.id, 'ad_mail_fields', JSON.stringify(mailFields));
  return JSON.stringify({
    listUrl: url,
    adOpen,
    popupIds,
    composeTags: adFrames.map((f) => `${f.path} ${f.tags}`),
    composeText: composeFrame?.bodyText ?? '',
  });
}

/**
 * Phase-2i (2026-06-03, corrected path per Ridaa's screenshots): open the
 * Devis-moto "Envoyer par…" Courrier popup (`id:impressionDR`). This popup
 * has the devis PDF auto-attached + a Mail toolbar (Adresse=To / CC / Objet)
 * with EMPTY fields + an Envoyer button. We replay the edition page button's
 * OWN mdiWindNet onclick (faithful params) via main world, then wait for the
 * Mail toolbar (`input[name=mailAdresse]`) to appear in any nested frame.
 */
async function openDevisMotoCourrier(cmd: QuoteConfirmCommand): Promise<void> {
  await reportProgress(cmd.id, 'courrier_open');
  // Find the Devis-moto "Envoyer par..." control on the edition page; its
  // onclick is mdiWindNet.window('listerModeleLettreAutorise.do?PAGE=0000501000
  // &FORWARD=/preparerLettre.do?ligneSelected=DR', null, 'id:impressionDR;…').
  let url = `${COURRIER_POPUP_URL_PATH}?PAGE=0000501000&FORWARD=/preparerLettre.do?ligneSelected=DR`;
  let opts = 'id:impressionDR; title: Courrier; width: 700; height: 750;';
  const ctrl = Array.from(document.querySelectorAll<HTMLElement>('[onclick]')).find((el) => {
    const oc = el.getAttribute('onclick') ?? '';
    return /impressionDR/.test(oc) && /ligneSelected=DR\b/.test(oc);
  });
  if (ctrl) {
    const oc = ctrl.getAttribute('onclick') ?? '';
    const m = /mdiWindNet\.window\(\s*'([^']+)'\s*,\s*[^,]+,\s*'([^']*)'/.exec(oc);
    if (m?.[1]) {
      url = m[1];
      opts = m[2] ?? opts;
    }
  }
  await openMdiWindowMainWorld(url, opts);
  await waitForMailToolbar(20_000);
  await reportProgress(cmd.id, 'courrier_mail_toolbar_ready');
}

/** True if any same-origin frame (from `doc` down) has the Mail toolbar. */
function hasMailToolbar(doc: Document | null | undefined, depth: number): boolean {
  if (!doc || depth > 5) return false;
  if (doc.querySelector('input[name="mailAdresse"]')) return true;
  for (const f of Array.from(doc.querySelectorAll('iframe, frame'))) {
    try {
      if (hasMailToolbar((f as HTMLIFrameElement).contentDocument, depth + 1)) return true;
    } catch {
      /* cross-origin — skip */
    }
  }
  return false;
}

/** Poll for the Courrier Mail toolbar (`input[name=mailAdresse]`) to render. */
async function waitForMailToolbar(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasMailToolbar(document, 0)) return;
    await sleep(400);
  }
  throw new Error('maxance_courrier_mail_toolbar_timeout');
}

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  input.focus();
  const desc = Object.getOwnPropertyDescriptor(
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype,
    'value',
  );
  desc?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new Event('blur', { bubbles: true }));
}

/** Fill the Devis tab once the Valider devis click has settled.
 *  Phase-2d-confirm-6: superseded by devisFillAndSubmitMainWorld (the
 *  isolated-world version below produced "Un problème technique" on
 *  OK submit; routing all field-setting through main world fixed it).
 *  Kept here as documentation of the original M8.T6 approach and as a
 *  fallback if main-world dispatch ever breaks. */
// @ts-expect-error — intentionally retained but unused
async function _fillDevisTab_LEGACY(cmd: QuoteConfirmCommand): Promise<void> {
  const { subscriber } = cmd;
  await reportProgress(cmd.id, 'devis_tab_filling');
  await setSelectByLabel('Civilité', CIVILITE_VALUE[subscriber.civilite], { label: 'civilite' });
  await fillByLabel('Nom', subscriber.lastName, { label: 'nom' });
  await fillByLabel('Prénom', subscriber.firstName, { label: 'prenom' });
  await setSelectByLabel('Profession', PROFESSION_VALUE[subscriber.profession ?? 'employe_prive'], {
    label: 'profession',
  });
  await fillByLabel('Code postal', subscriber.postalCode, { label: 'cp' });
  await sleep(400);
  await setSelectByLabel('Ville', subscriber.city, { label: 'ville', timeoutMs: 5_000 }).catch(
    () => undefined,
  );
  await fillByLabel('N° et nom de voie', subscriber.addressLine, { label: 'voie' });
  if (subscriber.addressComplement) {
    await fillByLabel('Bâtiment, Résidence', subscriber.addressComplement, {
      label: 'batiment',
      timeoutMs: 3_000,
    }).catch(() => undefined);
  }
  // Phone widget — three labelless dropdowns + a textbox. Maxance
  // doesn't expose stable <label> tags for these, so we set them by
  // <select name=> heuristic.
  setSelectByNameLike('telephone-type', PHONE_TYPE_MOBILE);
  setSelectByNameLike('telephone-usage', PHONE_USAGE_PERSO);
  setSelectByNameLike('telephone-pays', PHONE_COUNTRY_FR);
  fillInputByNameLike('telephone-numero', subscriber.phoneMobile);
  // Phase-2d-confirm (2026-05-25 PM live diag): Maxance keeps phone
  // input row as `currentContact.*` — a draft. The OK submit validator
  // (ErrorMessage()) checks for at least one entry in
  // `telephoneListBean.contactList[]`, NOT in the draft. So the draft
  // MUST be committed first via the green "Nouveau" img which fires
  // ajouterContactBean.do (AJAX) → promotes currentContact to
  // contactList[0] + clears the draft inputs. Without this commit, OK
  // shows "La valeur du champ 'Téléphone' est obligatoire" alerte and
  // submit is blocked. Verified live via Chrome MCP: with Nouveau
  // click added, OK created devis DR0000973630 cleanly.
  await sleep(400);
  try {
    await clickContactWidgetNouveau('telephoneListBean.currentContact.type', {
      label: 'commit_phone_entry',
    });
    await reportProgress(cmd.id, 'commit_phone_ok');
  } catch (e) {
    await reportProgress(cmd.id, 'commit_phone_err', e instanceof Error ? e.message : String(e));
  }
  await sleep(1200); // wait for AJAX response + DOM repopulation

  // Email widget — same pattern. Phase-2d-confirm live (2026-05-25): the
  // Maxance field is `emailListBean.currentContact.usage` (NOT `.type`
  // like the phone widget), so the substring needle must be 'email-usage'.
  setSelectByNameLike('email-usage', EMAIL_ROLE_GESTION);
  fillInputByNameLike('email-adresse', subscriber.email);
  await sleep(500);
  try {
    await clickContactWidgetNouveau('emailListBean.currentContact.usage', {
      label: 'commit_email_entry',
    });
    await reportProgress(cmd.id, 'commit_email_ok');
  } catch (e) {
    await reportProgress(cmd.id, 'commit_email_err', e instanceof Error ? e.message : String(e));
  }
  // Phase-2d-confirm-5 (2026-05-25 PM): bigger wait + wait-for-no-loading
  // poll. The "Un problème technique" page renders when OK is clicked
  // while Maxance is still processing background AJAX from the Nouveau
  // commits — the live screenshot showed "Chargement..." indicator
  // active. Poll until any visible loading indicator clears (or 15s
  // cap), then add 1s safety buffer. Same MCP-driven flow with similar
  // total wait succeeded (DR0000973635) — so this should equalize.
  await sleep(2000);
  await waitFor(
    () => {
      const t = (document.body.innerText ?? '').toLowerCase();
      return /chargement/i.test(t) ? null : true;
    },
    { label: 'await_chargement_clear', timeoutMs: 15_000 },
  ).catch(() => null);
  await sleep(1500);

  // Phase-2d-confirm-diag: dump devis form state RIGHT BEFORE the OK
  // click so the backend log shows exactly what Maxance sees. Mirrors the
  // vehicule_form_dump + conducteur_form_dump pattern from phase 2f.
  // Caller (runQuoteConfirm) emits this — keeping the dump close to the
  // submit so it captures the final state after any cascade settlements.
}

/** Snapshot the visible Devis form values and emit them as a progress
 *  event. Used pre-OK click to diagnose required-field rejections.
 *  Phase-2d-confirm-6: superseded by the main-world bundle which emits
 *  its own log via reportProgress 'devis_mw_result'. Kept as legacy. */
// @ts-expect-error — intentionally retained but unused
async function _dumpDevisForm_LEGACY(cmd: QuoteConfirmCommand): Promise<void> {
  const dump: Record<string, unknown> = {};
  document.querySelectorAll<HTMLInputElement>('input').forEach((el) => {
    if (!el.name || el.type === 'hidden') return;
    const r = el.getBoundingClientRect();
    if (r.width < 5 || r.height < 5) return;
    if (el.type === 'checkbox' || el.type === 'radio') {
      if (el.checked) dump[`${el.type}:${el.name}=${el.value}`] = 'checked';
    } else {
      dump[`inp:${el.name}`] = el.value.slice(0, 60);
    }
  });
  document.querySelectorAll<HTMLSelectElement>('select').forEach((el) => {
    if (!el.name) return;
    const r = el.getBoundingClientRect();
    if (r.width < 5 || r.height < 5) return;
    dump[`sel:${el.name}`] = { v: el.value, opt: el.options.length };
  });
  await reportProgress(cmd.id, 'devis_form_dump', JSON.stringify(dump));
}

/**
 * Set the value of the first <select> whose name attribute contains
 * the given substring (case-insensitive). No-op if not found. Used
 * for the labelless phone + email widgets where heuristic name match
 * is the only signal we have.
 */
function setSelectByNameLike(nameSubstring: string, value: string): void {
  const sels = Array.from(
    document.querySelectorAll<HTMLSelectElement>(
      `select[name*="${nameSubstring.split('-')[0]}" i]`,
    ),
  );
  const picked = sels.find((s) =>
    nameSubstring
      .split('-')
      .every((part) => (s.name ?? '').toLowerCase().includes(part.toLowerCase())),
  );
  if (!picked) return;
  picked.value = value;
  picked.dispatchEvent(new Event('input', { bubbles: true }));
  picked.dispatchEvent(new Event('change', { bubbles: true }));
}

function fillInputByNameLike(nameSubstring: string, value: string): void {
  const inputs = Array.from(
    document.querySelectorAll<HTMLInputElement>(`input[name*="${nameSubstring.split('-')[0]}" i]`),
  );
  const picked = inputs.find((i) =>
    nameSubstring
      .split('-')
      .every((part) => (i.name ?? '').toLowerCase().includes(part.toLowerCase())),
  );
  if (!picked) return;
  setInputValue(picked, value);
}

/**
 * Probe which confirm screen we're currently on.
 *
 *   - 'edition_imprimer' — final page after the Devis OK click navigated;
 *     URL ends in /souscriptionDevisValiderFinaleMoto.do. Has the devis
 *     number rendered in the page body.
 *   - 'devis_tab_pre' — we just landed after the preview flow; "Valider
 *     devis" button is visible in the document. The devis form fields
 *     (Civilité, Nom, ...) may not be visible YET because Maxance opens
 *     them after the Valider click.
 *   - 'unknown' — neither marker seen; advance loop waits a settle + retries.
 */
function detectConfirmScreen():
  | 'devis_tab_pre'
  | 'devis_form_open'
  | 'edition_imprimer'
  | 'unknown' {
  // Phase-2d-confirm (2026-05-25 PM): three distinct states the flow
  // crosses, identified live via Chrome MCP.
  //   1. devis_tab_pre — Garanties tab (price preview rendered).
  //      `#validerDevis` button visible. URL: ...souscriptionNaviguerOngletVehicule.do
  //      (no `?ONGLET_REQUEST_KEY=...` query OR with a different key).
  //   2. devis_form_open — Devis subscriber-info form rendered after
  //      Valider devis click. Same path but `?ONGLET_REQUEST_KEY=ongletDevis`.
  //      `#validerSouscription` button is now the "OK" submit (the same
  //      container ID is repurposed on this tab).
  //   3. edition_imprimer — final page after the Devis OK click navigated;
  //      URL ends in /souscriptionDevisValiderFinaleMoto.do, body contains
  //      DRxxxxxxxx devis number.
  if (location.pathname.endsWith(PROXIMEO_URL_SIGNATURES.editionImprimer)) {
    return 'edition_imprimer';
  }
  // Heuristic: presence of devisNumber in body also signals edition page.
  if (extractDevisNumber() !== null) return 'edition_imprimer';
  // Devis form open: identified by the URL's onglet query param (set by
  // Maxance after the Valider devis click) OR by the souscripteur fields
  // being present (the form rendered).
  if (/[?&]ONGLET_REQUEST_KEY=ongletDevis(\b|&)/.test(location.search)) {
    return 'devis_form_open';
  }
  if (document.querySelector('input[name="souscripteur.nom"]')) {
    return 'devis_form_open';
  }
  // Garanties with the Valider devis button visible = pre-state. Use the
  // container ID (stable) instead of body text to avoid the same false
  // positive that bit phase 2f (text from menu strip leaking into matches).
  if (document.getElementById('validerDevis')) {
    return 'devis_tab_pre';
  }
  return 'unknown';
}

/**
 * Single-screen advance of the quote.confirm flow (M8.T8 phase 2e).
 *
 * Mirrors `runQuotePreview` — the SW orchestrator may call this multiple
 * times across top-frame navigations. Returns `quote.confirm.navigating`
 * after triggering the Devis OK click (which navigates to the Edition à
 * imprimer page), or `quote.confirm.ok` when the mail composer is fully
 * handled.
 *
 * Note: the Courrier popup opens in a same-origin IFRAME, not a new
 * top-frame page, so the popup + composer work stays inside ONE
 * content-script run. The only top-frame navigation is the Devis OK
 * click.
 */
export async function runQuoteConfirm(cmd: QuoteConfirmCommand): Promise<Response> {
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
    QuoteConfirmNavigatingResponseSchema.parse({
      id: cmd.id,
      kind: 'quote.confirm.navigating',
      fromScreen,
      expectedScreen,
      screenshots,
    });

  try {
    await sleep(SETTLE_MS);

    for (let iter = 0; iter < 6; iter += 1) {
      const screen = detectConfirmScreen();
      await reportProgress(cmd.id, 'confirm_advance_iter', `screen=${screen}`);

      if (screen === 'devis_tab_pre') {
        // 1. Click Valider devis via main-world mouse-event dispatch on
        //    `#validerDevis .buttonMiddle` — same proven pattern as phase
        //    2f's validerVehicule/validerConducteur. The previous
        //    clickByText('Valider devis') used plain .click() which
        //    doesn't fire Maxance's onmouseup-bound framework handler.
        await reportProgress(cmd.id, 'valider_devis');
        await clickMaxanceButton('validerDevis', { label: 'valider_devis' });
        await shoot('valider_devis_clicked');
        // Maxance reloads the page with ?ONGLET_REQUEST_KEY=ongletDevis —
        // treat as a navigation. SW orchestrator re-invokes; next iter
        // detects 'devis_form_open'.
        return navigating('devis_tab_pre', 'devis_form_open');
      }

      if (screen === 'devis_form_open') {
        // Phase-2d-confirm-6 (2026-05-25 PM): route the ENTIRE Devis form
        // fill + Nouveau commits + OK click through ONE main-world script
        // via SW chrome.scripting. The isolated-world content-script
        // fillDevisTab path consistently produced "Un problème technique"
        // on OK submit even with form_dump showing every field correct
        // AND contactList[0] populated. The same operations driven
        // directly from main world (Chrome MCP javascript_tool) created
        // DR0000973635 successfully. We pre-fill pre-populated fields
        // (Civilité, Profession, Ville, CP) via existing setSelectByLabel
        // calls — these were already pre-set from Conducteur and just
        // need a final confirmation. Then call the main-world bundle.
        const { subscriber } = cmd;
        await setSelectByLabel('Civilité', CIVILITE_VALUE[subscriber.civilite], {
          label: 'civilite',
        });
        await setSelectByLabel(
          'Profession',
          PROFESSION_VALUE[subscriber.profession ?? 'employe_prive'],
          { label: 'profession' },
        );
        await fillByLabel('Code postal', subscriber.postalCode, { label: 'cp' });
        await sleep(400);

        await reportProgress(cmd.id, 'devis_tab_filling');
        const devisResult = await devisFillAndSubmitMainWorld({
          lastName: subscriber.lastName,
          firstName: subscriber.firstName,
          addressLine: subscriber.addressLine,
          ...(subscriber.addressComplement
            ? { addressComplement: subscriber.addressComplement }
            : {}),
          phoneType: PHONE_TYPE_MOBILE,
          phoneUsage: PHONE_USAGE_PERSO,
          phoneNumero: subscriber.phoneMobile,
          emailUsage: EMAIL_ROLE_GESTION,
          email: subscriber.email,
        });
        await reportProgress(
          cmd.id,
          'devis_mw_result',
          JSON.stringify({
            ok: devisResult.ok,
            log: devisResult.log,
            ...(devisResult.ok ? {} : { error: devisResult.error, errorMsg: devisResult.errorMsg }),
          }),
        );
        if (!devisResult.ok) {
          return ErrorResponseSchema.parse({
            id: cmd.id,
            kind: 'error',
            errorCode: 'maxance_confirm_devis_fill_failed',
            detail: `${devisResult.error}${devisResult.errorMsg ? ': ' + devisResult.errorMsg : ''}`,
            screenshots,
          });
        }
        await shoot('devis_tab_filled');
        await reportProgress(cmd.id, 'devis_tab_submit');
        return navigating('devis_form_open', 'edition_imprimer');
      }

      if (screen === 'edition_imprimer') {
        await shoot('edition_imprimer');

        // Phase-2d-confirm-diag: dump the edition page state on arrival
        // so when extractDevisNumber fails we know whether (a) the DR
        // number is rendered with a different format/separator, (b) it's
        // on a different page that we'd misread as edition_imprimer, or
        // (c) Maxance returned an error in the body text.
        const bodyText = (document.body.innerText ?? '').replace(/\s+/g, ' ').slice(0, 800);
        const headings = Array.from(document.querySelectorAll('h1, h2, h3, .titre, .titrePage'))
          .map((h) => (h.textContent ?? '').trim())
          .filter(Boolean)
          .slice(0, 8);
        await reportProgress(
          cmd.id,
          'edition_page_dump',
          JSON.stringify({ bodyText, headings, search: location.search }),
        );

        // Phase-2d-confirm-4 (2026-05-25 PM): the editionImprimer URL
        // /souscriptionDevisValiderFinaleMoto.do can render TRANSIENTLY
        // as a "Un problème technique" page while Maxance's backend is
        // still creating the devis. A direct main-world MCP-driven run
        // showed exactly this: ~4s after OK click the body said "problème
        // technique"; ~8s after, the body had transitioned to the real
        // edition page with the DR number rendered. So we DO NOT
        // short-circuit on the "problème technique" body — instead we
        // poll extractDevisNumber for 20s, which covers both the
        // transient case (success) and the true-error case (clean timeout
        // → tagged error below). Removes the eager error gate that was
        // catching the transient page in phase 2d-confirm-3.
        const devisNumber = await waitFor(() => extractDevisNumber(), {
          label: 'extract_devis_number',
          timeoutMs: 20_000,
        }).catch(() => null);
        if (!devisNumber) {
          const finalBody = (document.body.innerText ?? '').replace(/\s+/g, ' ').slice(0, 240);
          return ErrorResponseSchema.parse({
            id: cmd.id,
            kind: 'error',
            errorCode: 'maxance_confirm_no_devis_number',
            detail: `editionImprimer rendered but DR number never appeared after 20s. Body: "${finalBody}"`,
            screenshots,
          });
        }
        await reportProgress(cmd.id, 'devis_number_extracted', devisNumber);

        // Phase-2g (Courrier reliability): restore the M8.T6 dryRun
        // contract — open the Courrier popup + fill the mail composer, then
        // STOP one click before Envoyer. Phase-2d-confirm-9 had skipped the
        // popup in dryRun because it was flaky; the root cause (mdiWindNet
        // read from the isolated world) is now fixed (commit e203edd), so we
        // exercise it again to verify the open without ever sending an email.
        // BEST-EFFORT: the devis is already created, so a popup failure must
        // NOT fail the dryRun — we record the outcome in courrierDryRunStatus
        // and still return ok. This both verifies the fix AND preserves the
        // robust "devis created" success path.
        if (cmd.dryRun) {
          // Default fast path: devis created, return immediately. Only
          // exercise the Courrier popup when explicitly opted-in via
          // exerciseCourrier (the composer is a multi-stage Struts frameset
          // still being reverse-engineered — keep normal dryRun fast).
          let courrierDryRunStatus = 'skipped';
          if (cmd.exerciseCourrier) {
            // Phase-2i: exercise the CORRECT send path — open the Devis-moto
            // "Envoyer par…" Courrier popup, fill the Mail toolbar (To/Objet),
            // and STOP before Envoyer (send:false). Verifies the fill works
            // without sending an email. Best-effort: devis already created.
            courrierDryRunStatus = 'not_attempted';
            try {
              await openDevisMotoCourrier(cmd);
              await shoot('courrier_opened');
              const res = await courrierFillAndSend({
                to: cmd.subscriber.email,
                objet: `Votre devis assurance trottinette Assuryal - ${devisNumber}`,
                send: false, // dryRun: fill + STOP before Envoyer
              });
              await reportProgress(cmd.id, 'courrier_fill_result', JSON.stringify(res));
              await shoot('courrier_filled');
              courrierDryRunStatus = res.filledFrame
                ? `filled_no_send (${res.log.join(',')})`
                : `fill_no_frame (${res.log.join(',')})`;
            } catch (e) {
              courrierDryRunStatus = `courrier_failed:${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`;
            }
            await reportProgress(cmd.id, 'dryrun_courrier_status', courrierDryRunStatus);
          }
          await reportProgress(cmd.id, 'dryrun_stopped_after_devis_created', devisNumber);
          return QuoteConfirmResponseSchema.parse({
            id: cmd.id,
            kind: 'quote.confirm.ok',
            devisNumber,
            pdfSentTo: cmd.subscriber.email,
            screenshots,
            finalUrl: location.href,
            durationMs: Date.now() - t0,
            courrierDryRunStatus,
          });
        }

        // 6. Open the Devis-moto "Envoyer par…" Courrier popup (devis PDF
        //    auto-attached + Mail toolbar). 7. Fill To/Objet. 8. Envoyer.
        await openDevisMotoCourrier(cmd);
        await shoot('courrier_opened');
        const sendRes = await courrierFillAndSend({
          to: cmd.subscriber.email,
          objet: `Votre devis assurance trottinette Assuryal - ${devisNumber}`,
          send: true, // real-mode: fill + click Envoyer (checkMail)
        });
        await reportProgress(cmd.id, 'courrier_send_result', JSON.stringify(sendRes));
        if (!sendRes.ok || !sendRes.filledFrame || !sendRes.sent) {
          return ErrorResponseSchema.parse({
            id: cmd.id,
            kind: 'error',
            errorCode: 'maxance_courrier_send_failed',
            detail: `courrier fill/send incomplete: ${JSON.stringify(sendRes).slice(0, 200)}`,
            screenshots,
          });
        }
        await sleep(2_500);
        await shoot('post_envoyer');

        return QuoteConfirmResponseSchema.parse({
          id: cmd.id,
          kind: 'quote.confirm.ok',
          devisNumber,
          pdfSentTo: cmd.subscriber.email,
          screenshots,
          finalUrl: location.href,
          durationMs: Date.now() - t0,
        });
      }

      // unknown — settle and retry detection once
      await sleep(SETTLE_MS);
    }

    return ErrorResponseSchema.parse({
      id: cmd.id,
      kind: 'error',
      errorCode: 'maxance_confirm_unknown_screen',
      detail: `advance loop exhausted on screen=${detectConfirmScreen()} url=${location.href}`,
      screenshots,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return ErrorResponseSchema.parse({
      id: cmd.id,
      kind: 'error',
      errorCode: msg.startsWith('maxance_') ? msg.split(':')[0] : 'maxance_confirm_unknown',
      detail: msg.slice(0, 240),
      screenshots,
    });
  }
}
