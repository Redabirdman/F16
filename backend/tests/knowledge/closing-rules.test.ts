/**
 * Assuryal closing/souscription rules — ingestion smoke test (M8.T7).
 *
 * Drives the REAL curated closing-rules file through the markdown adapter (no
 * DB, no embeddings) and asserts it chunks into the sections the Sales Agent
 * must be able to retrieve during the closing phase: formules + garanties
 * additionnelles, fractionnement mechanics, frais d'inscription (approved
 * wording ONLY), closing process, escalation. Guards against the file being
 * moved/renamed/garbled or the bootstrap path drifting — same pattern as
 * maxance-catalog.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { markdownFileAdapter } from '../../src/knowledge/adapters/markdown-file.js';
import {
  bootstrapKnowledgeSources,
  __resetBootstrapForTests,
} from '../../src/knowledge/bootstrap.js';
import {
  getKnowledgeSource,
  __resetKnowledgeSourcesForTests,
} from '../../src/knowledge/source-registry.js';
import type { IngestableChunk } from '../../src/knowledge/types.js';

const here = dirname(fileURLToPath(import.meta.url));
// tests/knowledge → backend → F16 root, where the rules doc lives.
const rulesPath = resolve(here, '../../../ASSURYAL closing souscription agent.md');

async function collect(path: string): Promise<IngestableChunk[]> {
  const out: IngestableChunk[] = [];
  for await (const c of markdownFileAdapter.ingest({ name: 'assuryal_closing_rules', path })) {
    out.push(c);
  }
  return out;
}

describe('assuryal closing rules', () => {
  it('exists on disk at the F16-root path', () => {
    expect(existsSync(rulesPath)).toBe(true);
  });

  it('bootstrap registers it with the markdown adapter', () => {
    __resetKnowledgeSourcesForTests();
    __resetBootstrapForTests();
    bootstrapKnowledgeSources();
    const src = getKnowledgeSource('assuryal_closing_rules');
    expect(src).toBeDefined();
    expect(src!.adapter).toBe('markdown-file');
    __resetKnowledgeSourcesForTests();
    __resetBootstrapForTests();
  });

  it('chunks into the closing-phase sections (one H2 each)', async () => {
    const chunks = await collect(rulesPath);
    const titles = chunks.map((c) => String(c.meta?.sectionTitle ?? ''));
    expect(titles.some((t) => /Formules NVEI/i.test(t))).toBe(true);
    expect(titles.some((t) => /Fractionnement/i.test(t))).toBe(true);
    expect(titles.some((t) => /Frais d'inscription/i.test(t))).toBe(true);
    expect(titles.some((t) => /Processus de closing/i.test(t))).toBe(true);
    expect(titles.some((t) => /Escalade/i.test(t))).toBe(true);
  });

  it('preserves the compliance-sensitive figures verbatim', async () => {
    const chunks = await collect(rulesPath);
    const blob = chunks.map((c) => c.text).join('\n');
    // Frais totals per formule + garanties additionnelles + prélèvement day.
    expect(blob).toContain('50 €');
    expect(blob).toContain('60 €');
    expect(blob).toContain('65 €');
    expect(blob).toContain('12,54 €');
    expect(blob).toContain('17,72 €');
    expect(blob).toContain('le 5 du mois');
  });

  it('carries the approved frais formulations and flags the tax framing as forbidden', async () => {
    const chunks = await collect(rulesPath);
    const frais = chunks.find((c) =>
      /Frais d'inscription/i.test(String(c.meta?.sectionTitle ?? '')),
    );
    expect(frais).toBeDefined();
    expect(frais!.text).toContain("frais d'inscription au contrat");
    expect(frais!.text).toContain('honoraires de gestion du dossier');
    expect(frais!.text).toContain('accompagnement administratif personnalisé');
    // The state-tax framing appears ONLY as an explicit prohibition.
    expect(frais!.text).toMatch(/JAMAIS.*taxe imposée par l'État/);
    expect(frais!.text).toMatch(/compagnie et le courtier/);
  });

  it('describes the closing process: IBAN FR + BIC + titulaire + ville de naissance, payment link, e-signature', async () => {
    const chunks = await collect(rulesPath);
    const process = chunks.find((c) =>
      /Processus de closing/i.test(String(c.meta?.sectionTitle ?? '')),
    );
    expect(process).toBeDefined();
    expect(process!.text).toContain('IBAN');
    expect(process!.text).toContain('FR');
    expect(process!.text).toContain('BIC');
    expect(process!.text).toContain('Titulaire du compte');
    expect(process!.text).toContain('Ville de naissance');
    expect(process!.text).toContain('Paris');
    expect(process!.text).toContain('lien de paiement');
    expect(process!.text).toContain('signer électroniquement');
    expect(process!.text).toContain('memo provisoire');
    expect(process!.text).toContain('Numéro de série');
  });
});
