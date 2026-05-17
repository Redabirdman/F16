/**
 * Tool: `customer.remember_fact` — record a long-term fact about a customer.
 *
 * The Sales/Service agents use this when they learn something that should
 * inform FUTURE conversations (objection raised, preference stated, event
 * observed) — Mem0-style write side of the memory facade.
 *
 * Side effect:
 *   Embeds `content` via the OpenRouter embeddings client and inserts a row
 *   into `customer_facts`. The next recall (same customer + semantically
 *   similar query) surfaces it back into the prompt.
 *
 * Caller identity:
 *   `recorded_by` is composed as `<agentRole>#<agentInstance>` so the admin
 *   UI can attribute facts to the spawning agent — same shape as
 *   `created_by_agent` on `human_actions` (see `human.escalate`).
 *
 * Out of scope:
 *   - Per-fact TTL / auto-expiration (M16).
 *   - Dedup against existing similar facts (M16; we accept some redundancy
 *     and lean on the recall path's top-K cap to keep the prompt terse).
 *   - PII detection on `content` — `aidefence_scan` is the right hook, lands
 *     when the agent SDK plugs into the AIDefence MCP.
 */
import { z } from 'zod';
import { registerTool } from '../registry.js';
import { recordCustomerFact } from '../../memory/index.js';

export const customerRememberFactToolName = 'customer.remember_fact';

const inputSchema = z.object({
  customerId: z.string().uuid(),
  factType: z.enum(['observation', 'preference', 'objection', 'event']),
  /** The fact itself — keep it terse and self-contained (a future agent
   *  will read this with no surrounding context). */
  content: z.string().min(1).max(2000),
  /** 0..1 self-rated confidence. Default 0.5 when omitted. */
  confidence: z.number().min(0).max(1).optional(),
});

const outputSchema = z.object({
  factId: z.string().uuid(),
});

registerTool({
  name: customerRememberFactToolName,
  description:
    'Record a learned fact about a customer for future recall. Use sparingly ' +
    'for genuinely useful long-term context (objections raised, preferences ' +
    'stated, events observed). Do NOT record PII redundantly — name/phone/' +
    'email already live on the customer row. factType: observation | ' +
    'preference | objection | event. confidence 0..1.',
  inputSchema,
  outputSchema,
  handler: async (ctx, input) => {
    const fact = await recordCustomerFact(ctx.db, {
      customerId: input.customerId,
      factType: input.factType,
      content: input.content,
      // Omit `confidence` rather than passing `undefined` — keeps
      // exactOptionalPropertyTypes happy.
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      recordedBy: `${ctx.agentRole}#${ctx.agentInstance}`,
    });
    return { factId: fact.id };
  },
});
