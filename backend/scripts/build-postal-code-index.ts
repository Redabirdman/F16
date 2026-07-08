/**
 * Build the French postal-code index (2026-07-08, Ridaa: "download the zip
 * codes of whole France and verify before quoting").
 *
 * Source: La Poste « base officielle des codes postaux » (open data,
 * licence ODbL) — https://datanova.laposte.fr, dataset laposte-hexasmal.
 * CSV columns: Code_commune_INSEE;Nom_de_la_commune;Code_postal;Libellé;Ligne_5
 *
 * Output: src/data/french-postal-codes.json — { [cp]: string[] } mapping
 * every valid postal code to its commune names (uppercase, deduped). The
 * runtime helper (src/leads/postal-codes.ts) loads it once.
 *
 * Usage (from backend/):
 *   curl -sL -o /tmp/laposte_cp.csv \
 *     "https://datanova.laposte.fr/data-fair/api/v1/datasets/laposte-hexasmal/raw"
 *   npx tsx scripts/build-postal-code-index.ts /tmp/laposte_cp.csv
 *
 * Re-run only when La Poste updates the base (a few communes per year).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const csvPath = process.argv[2];
if (!csvPath) {
  console.error('usage: tsx scripts/build-postal-code-index.ts <laposte_hexasmal.csv>');
  process.exit(1);
}

const raw = readFileSync(csvPath, 'latin1');
const index = new Map<string, Set<string>>();
let rows = 0;
for (const line of raw.split(/\r?\n/)) {
  if (!line || line.startsWith('#')) continue;
  const cols = line.split(';');
  const commune = (cols[1] ?? '').trim().toUpperCase();
  const cp = (cols[2] ?? '').trim();
  if (!/^\d{5}$/.test(cp) || commune.length === 0) continue;
  rows += 1;
  const set = index.get(cp) ?? new Set<string>();
  set.add(commune);
  index.set(cp, set);
}

const out: Record<string, string[]> = {};
for (const cp of [...index.keys()].sort()) {
  out[cp] = [...(index.get(cp) ?? [])].sort();
}

const outPath = resolve(here, '..', 'src', 'data', 'french-postal-codes.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(out));
console.log(
  `postal-code index written: ${outPath} — ${index.size} codes, ${rows} (cp, commune) rows`,
);
