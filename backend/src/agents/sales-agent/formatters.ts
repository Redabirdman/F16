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

/**
 * Format the customer-facing French price-preview message for a trottinette
 * quote.
 */
export function formatQuotePreviewMessage(opts: {
  firstName?: string;
  monthly?: number;
  annual?: number;
  formule: 'tiers_illimite' | 'vol_incendie' | 'dommages_tous_accidents';
  quoteId: string;
}): string {
  const greeting = opts.firstName ? `Bonjour ${opts.firstName},` : 'Bonjour,';
  const formuleLabel =
    opts.formule === 'tiers_illimite'
      ? 'Tiers Illimité'
      : opts.formule === 'vol_incendie'
        ? 'Tiers Illimité + Vol & Incendie'
        : 'Tous Risques';

  const lines: string[] = [greeting, '', 'Voici votre devis trottinette :'];
  if (opts.monthly !== undefined) {
    lines.push(`• Mensuel : ${formatEur(opts.monthly)}`);
  }
  if (opts.annual !== undefined) {
    lines.push(`• Annuel : ${formatEur(opts.annual)}`);
  }
  lines.push(`• Formule : ${formuleLabel}`);
  lines.push('');
  lines.push('Souhaitez-vous que je vous envoie le devis officiel par mail ?');
  lines.push('');
  lines.push(`(réf #${opts.quoteId.slice(0, 8)})`);
  return lines.join('\n');
}

/**
 * Customer-facing confirmation after Maxance has emailed the quote PDF.
 * Achraf's wording — locked once, templated forever.
 */
export function formatQuoteReadyMessage(opts: {
  firstName?: string;
  pdfSentTo: string;
  devisNumber: string;
  quoteId: string;
}): string {
  const greeting = opts.firstName ? `Bonjour ${opts.firstName},` : 'Bonjour,';
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
  const greeting = opts.firstName ? `Bonjour ${opts.firstName},` : 'Bonjour,';
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
  const greeting = opts.firstName ? `Bonjour ${opts.firstName},` : 'Bonjour,';
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
  const greeting = opts.firstName ? `Bonjour ${opts.firstName},` : 'Bonjour,';
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
