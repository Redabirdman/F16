/**
 * Frais de dossier business rules (M8.T7 closing — design §5.4 / Achraf).
 *
 * Per formule, the customer owes a TOTAL frais de dossier. Maxance collects
 * its own "frais comptant" portion through the prélèvement (read live from
 * the portal's Comptant à régler block — e.g. 17 €); the customer pays
 * Assuryal the remainder via the Stripe payment link (e.g. 50 − 17 = 33 €).
 *
 * Pure functions — no I/O. Customer-facing wording for these frais lives in
 * the sales playbook (compliant reformulations only), NOT here.
 */

export const FRAIS_DOSSIER_TOTAL_EUR = {
  tiers_illimite: 50,
  vol_incendie: 60,
  dommages_tous_accidents: 65,
} as const;

export type Formule = keyof typeof FRAIS_DOSSIER_TOTAL_EUR;

/**
 * Assuryal's share of the frais de dossier = total for the formule − the
 * portion Maxance already collects in the comptant. Floored at 0 (a portal
 * frais larger than our total must never produce a negative payment link)
 * and rounded to the cent.
 *
 * Throws on a non-finite or negative `fraisComptantEur` — that's a scrape
 * bug upstream, not a payable amount.
 */
export function computeAssuryalFrais(formule: Formule, fraisComptantEur: number): number {
  const total = FRAIS_DOSSIER_TOTAL_EUR[formule];
  if (total === undefined) {
    throw new Error(`computeAssuryalFrais: unknown formule '${String(formule)}'`);
  }
  if (!Number.isFinite(fraisComptantEur) || fraisComptantEur < 0) {
    throw new Error(`computeAssuryalFrais: invalid fraisComptantEur (${String(fraisComptantEur)})`);
  }
  return Math.round(Math.max(0, total - fraisComptantEur) * 100) / 100;
}
