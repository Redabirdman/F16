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
}

/**
 * Test-only escape hatch — flips the once-guard back off so a test can
 * re-run bootstrap after `__resetKnowledgeSourcesForTests()`.
 */
export function __resetBootstrapForTests(): void {
  _bootstrapped = false;
}
