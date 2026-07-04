/**
 * Bootstrap the registry with F16's known knowledge sources (M7.T3).
 *
 * Called once at app start (after `knowledge-curator` is spun up). Idempotent
 * — calling twice is a no-op, so test setup that double-registers via boot
 * + an explicit add doesn't explode.
 *
 * Paths default to repo-relative defaults but can be overridden by env vars
 * so a deployed VPS doesn't have to match the local dev layout:
 *   - F16_KNOWLEDGE_MD_PATH    — the Assuryal markdown knowledge base
 *   - F16_WEBSITE_SOURCE_PATH  — the conversion-machine React source tree
 *   - F16_MAXANCE_CATALOG_PATH — the Maxance product-fiche catalogue (M9)
 *   - F16_CLOSING_RULES_PATH   — the Assuryal closing/souscription rules (M8.T7)
 *   - F16_OBJECTIONS_PATH      — the Assuryal objection-handling playbook
 */
import { registerKnowledgeSource } from './source-registry.js';

let _bootstrapped = false;

export function bootstrapKnowledgeSources(): void {
  if (_bootstrapped) return;
  _bootstrapped = true;

  registerKnowledgeSource({
    name: 'assuryal_knowledge_md',
    adapter: 'markdown-file',
    path: process.env['F16_KNOWLEDGE_MD_PATH'] ?? '../ASSURYAL base connaissance agent.md',
    intervalHours: 24,
    scheduled: true,
  });

  registerKnowledgeSource({
    name: 'assuryal_website_source',
    adapter: 'react-source',
    path: process.env['F16_WEBSITE_SOURCE_PATH'] ?? '../../conversion-machine-main/src',
    intervalHours: 6,
    scheduled: true,
  });

  // M9 — Maxance product catalogue (15 product fiches curated into one
  // markdown file, one H2 per product). Gives the Sales Agent RAG knowledge
  // of every Maxance product even though only the trottinette/NVEI is
  // auto-quotable today. Product fiches are stable, so a daily re-ingest is
  // plenty (re-curate the MD when Maxance updates a fiche).
  registerKnowledgeSource({
    name: 'maxance_product_catalog',
    adapter: 'markdown-file',
    path: process.env['F16_MAXANCE_CATALOG_PATH'] ?? '../MAXANCE catalogue produits agent.md',
    intervalHours: 24,
    scheduled: true,
  });

  // M8.T7 — Assuryal closing/souscription rules (Achraf's doc, compliant
  // version): formules + garanties additionnelles, fractionnement and first
  // prélèvement mechanics, frais d'inscription au contrat (approved wording
  // only), closing process (IBAN/BIC/titulaire/ville de naissance), escalation
  // triggers. Retrieved by the Sales Agent via `knowledge.search` during the
  // closing phase. Stable hand-curated rules → daily re-ingest is plenty.
  registerKnowledgeSource({
    name: 'assuryal_closing_rules',
    adapter: 'markdown-file',
    path: process.env['F16_CLOSING_RULES_PATH'] ?? '../ASSURYAL closing souscription agent.md',
    intervalHours: 24,
    scheduled: true,
  });

  // Assuryal objection-handling playbook (cleaned from Ridaa's 31-objection
  // sales-training doc): objection → technique → ready-made French response,
  // adapted for the WhatsApp NVEI context (real monthly prices only, no delay
  // promises, no coverage-active claims, [bracketed] placeholders the LLM must
  // substitute — never send literally). Retrieved by the Sales Agent via
  // `knowledge.search` when a lead pushes back. Hand-curated → daily is plenty.
  registerKnowledgeSource({
    name: 'assuryal_objections',
    adapter: 'markdown-file',
    path: process.env['F16_OBJECTIONS_PATH'] ?? '../ASSURYAL objections agent.md',
    intervalHours: 24,
    scheduled: true,
  });
}

/**
 * Test-only escape hatch — flips the once-guard back off so a test can
 * re-run bootstrap after `__resetKnowledgeSourcesForTests()`.
 */
export function __resetBootstrapForTests(): void {
  _bootstrapped = false;
}
