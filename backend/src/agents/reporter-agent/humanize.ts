/**
 * Reporter Agent — decision-ready ENGLISH group messages (2026-07-05, Ridaa).
 *
 * Everything the system posts to MANAGEMENT (the WhatsApp human-action group)
 * goes through this module. Customer-facing sends stay French and never touch
 * this file. Contract with the operators:
 *
 *   1. ENGLISH — Ridaa + Achraf triage in English on the group.
 *   2. No raw UUIDs — short refs (`#8-char`) at most. The short ref at the
 *      bottom doubles as the reply-routing key (the inbound router matches
 *      `#abcdef12` against pending action ids).
 *   3. Plain-language diagnosis — machine error codes are translated to
 *      something a human can act on ("Maxance portal unreachable — closed
 *      nights and weekends…"), with the raw code kept only as a fallback.
 *   4. Customer identification — every alert carries the customer's name
 *      (decryptPII from the customers row), the lead source in plain words,
 *      the product line, and a loud SIMULATION banner for `/sim` test leads.
 *   5. COMPLIANCE_BLOCKED shows the blocked draft text (truncated) — nobody
 *      can decide "send anyway" without reading what would be sent.
 *
 * Context resolution never parses the French summary: the action's
 * `correlationId` is a quote id or a lead id depending on the creation site,
 * so we look up quote → lead → customer (or lead → customer) and degrade
 * gracefully — an unknown correlation simply omits the customer block.
 */
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { customers, leads, quotes } from '../../db/schema/index.js';
import { decryptPII } from '../../db/crypto.js';
import { logger } from '../../logger.js';
import type { HumanAction, HumanActionOption } from '../../db/schema/agent-runtime.js';

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

const UUID_GLOBAL_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const UUID_EXACT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Marker appended to a COMPLIANCE_BLOCKED summary by the two creation sites
 * (sales-agent agent.ts + reply-core.ts) to carry the blocked draft text.
 * human_actions has no payload/meta jsonb column, so the summary carries it
 * (pragmatic, no migration); `splitDraft` peels it back off for rendering.
 */
export const HUMAN_ACTION_DRAFT_MARKER = '\n---DRAFT---\n';

const DRAFT_PREVIEW_CHARS = 400;

/** `#`-prefixed 8-char short ref — the only "id" operators ever see. */
export function shortRef(id: string): string {
  return `#${id.slice(0, 8)}`;
}

/** Replace any embedded UUID with its short ref (for freeform summaries). */
export function stripUuids(text: string): string {
  return text.replace(UUID_GLOBAL_RE, (m) => `#${m.slice(0, 8)}`);
}

/** Peel the blocked-draft payload off a summary (see HUMAN_ACTION_DRAFT_MARKER). */
export function splitDraft(summary: string): { summary: string; draft: string | null } {
  const idx = summary.indexOf(HUMAN_ACTION_DRAFT_MARKER);
  if (idx === -1) return { summary, draft: null };
  return {
    summary: summary.slice(0, idx),
    draft: summary.slice(idx + HUMAN_ACTION_DRAFT_MARKER.length),
  };
}

// ---------------------------------------------------------------------------
// English titles + severity badges
// ---------------------------------------------------------------------------

const INTENT_TITLES_EN: Record<string, string> = {
  QUOTE_FAILED: 'Quote failed',
  QUOTE_STUCK: 'Quote stuck',
  SUBSCRIPTION_FAILED: 'Subscription failed',
  COMPLIANCE_BLOCKED: 'Message blocked — approval needed',
  LEAD_DORMANT: 'Lead gone quiet 7 days',
  DEVIS_RELAY_STUCK: 'Quote PDF relay stuck',
  DEVIS_DELIVERY_FAILED: 'Quote PDF delivery failed',
  DEVIS_DELIVERY_PARTIAL: 'Quote PDF partially delivered',
  INSPECTOR_HANDOFF: 'Contract pending Maxance inspector',
  AGENT_LOOP_DETECTED: 'Agent loop detected',
  CONFIG_CHANGE_PROPOSED: 'Configuration change proposed',
  CAMPAIGN_DRAFT: 'Ad campaign draft — approval needed',
  CAMPAIGN_LAUNCH_FAILED: 'Ad campaign launch failed',
  CAMPAIGN_FATIGUE: 'Ad creative fatigue detected',
  AD_FATIGUE: 'Ad creative fatigue detected',
};

/** English title per intent kind — falls back to the raw intent code. */
export function intentTitleEn(intent: string): string {
  return INTENT_TITLES_EN[intent] ?? intent;
}

/** Severity glyph + English label for the header line. */
export function severityBadgeEn(severity: 1 | 2 | 3): { glyph: string; label: string } {
  switch (severity) {
    case 1:
      return { glyph: '🔴', label: 'CRITICAL' };
    case 2:
      return { glyph: '🟡', label: 'ACTION NEEDED' };
    case 3:
      return { glyph: '🟢', label: 'FYI' };
  }
}

// ---------------------------------------------------------------------------
// Error-code → plain English
// ---------------------------------------------------------------------------

/**
 * Translate a machine error code (quote/subscription flows) into a diagnosis
 * a human can act on. Prefix/substring matching so composite codes like
 * `login_failed:maxance_extension_no_active_tab` hit the right bucket.
 * Fallback keeps the raw code in parentheses ONLY when nothing matches.
 */
export function explainErrorCode(code: string): string {
  const c = code.toLowerCase();
  // Checked FIRST: composite codes like `login_failed:maxance_maintenance`
  // must land here, not in the generic login_failed bucket below.
  if (c.includes('maxance_maintenance')) {
    return 'Maxance showed its maintenance page — the system will retry automatically when it reopens';
  }
  if (
    c.startsWith('login_failed') ||
    c.startsWith('subscription_login_failed') ||
    c.includes('no_active_tab')
  ) {
    return (
      'Maxance portal unreachable — it is closed nights (20:00–08:00 Moroccan time) ' +
      'and weekends, or the browser tab is logged out'
    );
  }
  if (c.includes('extension_not_connected') || c.includes('extension_forward_failed')) {
    return 'the Chrome extension driving Maxance is not connected';
  }
  if (c.includes('maxance_garanties')) {
    return 'the Maxance quote form changed or misbehaved on the guarantees step';
  }
  if (c.includes('rib_rejected')) {
    return "Maxance rejected the customer's bank details (RIB)";
  }
  return `technical error (${code})`;
}

/**
 * Pull the machine error code out of a QUOTE_FAILED / SUBSCRIPTION_FAILED
 * summary — the creation sites embed it as the first `(...)` group, e.g.
 * "Quote <uuid> failed (login_failed:maxance_extension_no_active_tab)."
 * Returns null when no slug-shaped code is present.
 */
function extractErrorCode(summary: string): string | null {
  const m = /\(([a-z][a-z0-9_:.-]*)\)/.exec(summary);
  return m?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Customer context (correlationId → quote/lead → customer)
// ---------------------------------------------------------------------------

export interface ActionContext {
  /** Decrypted full name, e.g. "Karim Testeur". */
  customerName?: string;
  /** leads.source, e.g. 'website' | 'meta'. */
  source?: string;
  /** leads.product_line, e.g. 'scooter' | 'car'. */
  productLine?: string;
  /** attribution.f16_simulation === 'true' → /sim test lead, not a customer. */
  simulation?: boolean;
}

const SOURCE_LABELS_EN: Record<string, string> = {
  website: 'website lead',
  meta: 'Facebook/Instagram lead',
  organic: 'organic lead',
  referral: 'referral lead',
  other: 'lead',
};

const PRODUCT_LABELS_EN: Record<string, string> = {
  scooter: 'scooter/trottinette',
  car: 'car',
};

/**
 * Resolve who this action is about from what it carries. correlationId is a
 * quote id, a lead id, or something action-specific ("strategy:...")
 * depending on the creation site — try quote first, then lead, and NEVER
 * throw: any miss/failure just omits the customer block from the message.
 */
export async function resolveActionContext(
  db: Database,
  action: Pick<HumanAction, 'correlationId'>,
): Promise<ActionContext> {
  const corr = action.correlationId;
  if (!corr || !UUID_EXACT_RE.test(corr)) return {};
  try {
    let leadId: string | null = null;
    let customerId: string | null = null;

    const [quote] = await db
      .select({ leadId: quotes.leadId, customerId: quotes.customerId })
      .from(quotes)
      .where(eq(quotes.id, corr))
      .limit(1);
    if (quote) {
      leadId = quote.leadId;
      customerId = quote.customerId;
    } else {
      leadId = corr;
    }

    const ctx: ActionContext = {};
    if (leadId) {
      const [lead] = await db
        .select({
          customerId: leads.customerId,
          source: leads.source,
          productLine: leads.productLine,
          attribution: leads.attribution,
        })
        .from(leads)
        .where(eq(leads.id, leadId))
        .limit(1);
      if (lead) {
        ctx.source = lead.source;
        ctx.productLine = lead.productLine;
        const attr = (lead.attribution ?? null) as Record<string, unknown> | null;
        if (attr?.['f16_simulation'] === 'true') ctx.simulation = true;
        customerId = customerId ?? lead.customerId;
      }
    }
    if (customerId) {
      const [cust] = await db
        .select({ fullName: customers.fullName })
        .from(customers)
        .where(eq(customers.id, customerId))
        .limit(1);
      if (cust) {
        try {
          const name = decryptPII(cust.fullName);
          if (name) ctx.customerName = name;
        } catch {
          // PII key unavailable / rotated — skip the name, keep the rest.
        }
      }
    }
    return ctx;
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), correlationId: corr },
      'humanize: context resolution failed — omitting customer block',
    );
    return {};
  }
}

/** "Customer: Karim Testeur — website lead — scooter/trottinette" or null. */
function customerLine(ctx: ActionContext): string | null {
  const parts: string[] = [];
  if (ctx.customerName) parts.push(ctx.customerName);
  if (ctx.source) parts.push(SOURCE_LABELS_EN[ctx.source] ?? `${ctx.source} lead`);
  if (ctx.productLine) parts.push(PRODUCT_LABELS_EN[ctx.productLine] ?? ctx.productLine);
  if (parts.length === 0) return null;
  return `Customer: ${parts.join(' — ')}`;
}

// ---------------------------------------------------------------------------
// Per-intent plain-English problem line
// ---------------------------------------------------------------------------

/**
 * The "what happened" line. Mapped intents get a hand-written English
 * diagnosis (with error-code translation where the flow reports one);
 * unknown intents fall back to the stored summary with UUIDs shortened.
 */
function problemLine(intent: string, summaryBody: string): string {
  switch (intent) {
    case 'QUOTE_FAILED': {
      const code = extractErrorCode(summaryBody);
      return `The quote run failed: ${code ? explainErrorCode(code) : 'technical error'}.`;
    }
    case 'SUBSCRIPTION_FAILED': {
      const code = extractErrorCode(summaryBody);
      return `The subscription (closing) failed: ${
        code ? explainErrorCode(code) : 'technical error'
      }.`;
    }
    case 'QUOTE_STUCK':
      return (
        'The quote has been in preparation too long with no result — the Maxance flow ' +
        'looks blocked (check the extension / backend).'
      );
    case 'DEVIS_RELAY_STUCK':
      return (
        'The quote was confirmed on Maxance but the PDF never arrived on the contact@ ' +
        'inbox (mail relay). Check the inbox or resend from Maxance.'
      );
    case 'DEVIS_DELIVERY_FAILED':
      return (
        'Maxance produced the quote PDF but it could not be delivered to the customer ' +
        'on any channel — it must be sent manually.'
      );
    case 'DEVIS_DELIVERY_PARTIAL':
      return (
        'The quote PDF reached the customer on one channel but failed on the other — ' +
        'complete manually if the missing channel matters (email copy counts for ACPR).'
      );
    case 'LEAD_DORMANT':
      return (
        'No reply for 7 days despite 2 follow-ups — the lead was put to sleep. ' +
        'Follow up manually or close it?'
      );
    case 'COMPLIANCE_BLOCKED': {
      if (/not parseable/i.test(summaryBody)) {
        return (
          'The compliance checker had a technical glitch (not a customer problem) — ' +
          'the reply was withheld to be safe.'
        );
      }
      const reasons = /Raisons\s*:\s*(.+)$/s.exec(summaryBody)?.[1]?.trim();
      return (
        'The compliance checker blocked this reply before sending.' +
        (reasons ? ` Checker said: ${stripUuids(reasons)}` : '')
      );
    }
    case 'INSPECTOR_HANDOFF':
      return (
        'The subscription went through but Maxance routed the contract to their ' +
        'inspector — send them the souscription/paiement screenshot to unblock it.'
      );
    case 'AGENT_LOOP_DETECTED':
      return (
        'Two agents were caught messaging each other in a loop. No automatic action ' +
        'was taken — please check and arbitrate.'
      );
    default:
      // CONFIG_CHANGE_PROPOSED, CAMPAIGN_*, and anything new: the summary is
      // the substance (rationale / draft description) — show it, sans UUIDs.
      return stripUuids(summaryBody);
  }
}

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

/** Numbered options block, English lead-in. Null when there are no options. */
export function optionsBlockEn(options: readonly HumanActionOption[]): string | null {
  if (options.length === 0) return null;
  const lines = options.map((o, i) => `${i + 1}. ${o.label}`);
  return `Reply with the number:\n${lines.join('\n')}`;
}

/**
 * Build the full English WA-group message for a HUMAN_ACTION.REQUESTED event.
 * Layout: badge header → customer block (+ SIMULATION banner) → problem →
 * blocked draft (compliance only) → numbered options → short ref footer.
 */
export async function buildHumanActionRequestMessage(
  db: Database,
  action: HumanAction,
): Promise<string> {
  const sev = severityBadgeEn(action.severity as 1 | 2 | 3);
  const { summary, draft } = splitDraft(action.summary);
  const ctx = await resolveActionContext(db, action);

  const sections: string[] = [`${sev.glyph} *${sev.label}* — ${intentTitleEn(action.intent)}`];

  const cust = customerLine(ctx);
  const custBlock = [
    ...(cust ? [cust] : []),
    ...(ctx.simulation ? ['⚠️ SIMULATION test lead — not a real customer.'] : []),
  ];
  if (custBlock.length > 0) sections.push(custBlock.join('\n'));

  sections.push(problemLine(action.intent, summary));

  if (draft) {
    const preview =
      draft.length > DRAFT_PREVIEW_CHARS ? `${draft.slice(0, DRAFT_PREVIEW_CHARS)}…` : draft;
    sections.push(`Blocked draft (what the agent wanted to send):\n"${preview}"`);
  }

  const opts = optionsBlockEn(action.options as readonly HumanActionOption[]);
  if (opts) sections.push(opts);

  sections.push(`Ref: ${shortRef(action.id)}`);
  return sections.join('\n\n');
}

/**
 * English closure line posted when a HUMAN_ACTION is resolved (either
 * surface). E.g. `✅ Quote failed — resolved via WhatsApp: *Retry the quote*`.
 */
export function buildHumanActionResolvedMessage(input: {
  intent: string;
  optionLabel: string;
  kind: HumanActionOption['kind'];
  source: 'admin' | 'whatsapp';
}): string {
  const src = input.source === 'admin' ? 'the admin' : 'WhatsApp';
  const verb =
    input.kind === 'reject'
      ? 'rejected'
      : input.kind === 'revise'
        ? 'revision requested'
        : 'resolved';
  return `✅ ${intentTitleEn(input.intent)} — ${verb} via ${src}: *${input.optionLabel}*`;
}
