/**
 * Admin human-action endpoints (M14.T5).
 *
 *   GET /v1/admin/human-actions
 *     Pending list, severity-first then oldest-first (same order as the
 *     repository's `listPending`). Returns the full row shape minus PII.
 *     Optional `?severity=1|2|3` filter.
 *
 *   POST /v1/admin/human-actions/:id/resolve
 *     Body: `{chosenOptionId: string, notes?: string, by?: string}`
 *     - Looks up the action, validates chosenOptionId is one of its options.
 *     - Calls the idempotent `resolveAction(...)` (already shipped, M13).
 *     - Dispatches `HUMAN_ACTION.RESOLVED` so the Reporter Agent posts
 *       the closure message in the WhatsApp group — same emit pattern the
 *       WhatsApp inbound resolver uses (src/channels/whatsapp/webhook.ts).
 *     - Appends an `audit_log` row capturing actor + before/after status.
 *     - 200 with the updated row on success. 404 on unknown id, 400 on
 *       invalid option id, 409 if the action was already resolved (the
 *       row is still returned so the UI can refresh).
 *
 *     The default `by` is 'admin-ui' — the V1 admin doesn't have auth yet
 *     (M14.T1 is future work). Once auth lands, the route hands the
 *     resolver's user id through.
 *
 * Auth: open-on-LAN, same as the rest of /v1/admin/*. The dispatcher emit
 * means an unauthenticated admin can trigger an outbound WAHA message —
 * mitigated by the F16 PC not being internet-exposed; M14.T1 + Cloudflare
 * Access close this fully.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { getActionById, listPending, resolveAction } from '../db/repositories/human-actions.js';
import type { HumanAction, HumanActionOption } from '../db/schema/agent-runtime.js';
import { leads } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { sendMessage } from '../messaging/dispatcher.js';
import { appendAudit } from '../db/repositories/audit-log.js';
import { logger } from '../logger.js';
import { emitHubSpotActivity } from '../integrations/hubspot/activity-worker.js';
import {
  resolveActionContext,
  extractErrorCode,
  splitDraft,
  stripUuids,
} from '../agents/reporter-agent/humanize.js';

export interface AdminHumanActionsRouterOptions {
  db: Database;
}

/** Wire shape for the admin UI — mirrors HumanAction but with ISO timestamps. */
export interface HumanActionRow {
  id: string;
  createdByAgent: string;
  intent: string;
  severity: number;
  status: string;
  summary: string;
  options: HumanActionOption[];
  correlationId: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolvedSource: string | null;
  resolution: HumanAction['resolution'];
  // ----- Redesign 2026-07-08 (Ridaa: "not some numbers I don't understand") -
  /** French intent title, e.g. "Devis échoué". */
  titleFr: string;
  /** Plain-French problem explanation (from the machine error code). */
  problemFr: string | null;
  /** UUID-free version of the summary (short #refs instead). */
  summaryClean: string;
  /** Blocked message draft (compliance holds) — shown verbatim. */
  draft: string | null;
  /** Who this is about, resolved from correlationId → quote → lead. */
  customer: {
    name: string | null;
    sourceFr: string | null;
    productFr: string | null;
    simulation: boolean;
    leadId: string | null;
  } | null;
}

const INTENT_TITLES_FR: Record<string, string> = {
  QUOTE_FAILED: 'Devis échoué',
  QUOTE_STUCK: 'Devis bloqué',
  COMPLIANCE_BLOCKED: 'Message retenu (conformité)',
  DEVIS_DELIVERY_FAILED: 'Envoi du devis échoué',
  DEVIS_DELIVERY_PARTIAL: 'Devis envoyé partiellement',
  DEVIS_RELAY_STUCK: 'Relai du devis bloqué',
  SUBSCRIPTION_FAILED: 'Souscription échouée',
  PAYMENT_PENDING_HUMAN: 'Paiement — relais humain',
  CONTRACT_PENDING_HUMAN: 'Contrat — relais humain',
  AGENT_LOOP_DETECTED: "Boucle d'agents détectée",
  MAXANCE_LOGIN_REQUIRED: 'Connexion Maxance requise',
  VOICE_CALL_FAILED: 'Appel sortant échoué',
};

/** French twin of humanize.ts explainErrorCode (EN stays for the WA group). */
function explainErrorCodeFr(code: string): string {
  const c = code.toLowerCase();
  if (c.includes('maxance_invalid_postal_code')) {
    return "Le code postal donné par le client ne correspond à aucune commune — l'agent lui demande de le vérifier.";
  }
  if (c.includes('maxance_maintenance')) {
    return 'Maxance affiche sa page de maintenance — nouvelle tentative automatique à la réouverture.';
  }
  if (c.includes('maxance_login_required')) {
    return 'La session Maxance a expiré — connectez-vous dans Chrome ; les devis en attente repartiront tout seuls.';
  }
  if (c.startsWith('login_failed') || c.includes('no_active_tab')) {
    return 'Portail Maxance injoignable — fermé la nuit (20h-08h) et le week-end, ou onglet déconnecté.';
  }
  if (
    c.includes('extension_disconnected') ||
    c.includes('extension_not_connected') ||
    c.includes('extension_forward_failed')
  ) {
    return "L'extension Chrome qui pilote Maxance s'est déconnectée (rechargement ou Chrome fermé).";
  }
  if (c.includes('hard_timeout') || c.includes('flow_timeout')) {
    return 'Le formulaire Maxance a tourné en boucle sans aboutir (4 min) — souvent une donnée que Maxance refuse (ex. code postal) ou une page bloquée.';
  }
  if (c.includes('maxance_garanties')) {
    return "Le formulaire Maxance a changé ou s'est mal comporté à l'étape des garanties.";
  }
  if (c.includes('rib_rejected')) {
    return 'Maxance a refusé les coordonnées bancaires (RIB) du client.';
  }
  if (c.includes('asterisk_originate_no_channel') || c.includes('asterisk_originate_rejected')) {
    return "L'appel n'a pas pu être lancé — le numéro est probablement invalide ou injoignable depuis notre ligne.";
  }
  if (c.includes('no_phone_for_customer')) {
    return 'Aucun numéro de téléphone au dossier pour ce client.';
  }
  return `Erreur technique (${code}).`;
}

const SOURCE_LABELS_FR: Record<string, string> = {
  website: 'Site web',
  meta: 'Pub Facebook/Instagram',
  organic: 'Organique',
  referral: 'Parrainage',
  other: 'Autre',
};

const PRODUCT_LABELS_FR: Record<string, string> = {
  scooter: 'Trottinette',
  car: 'Auto',
};

const ListQuerySchema = z.object({
  severity: z
    .union([z.literal('1'), z.literal('2'), z.literal('3')])
    .optional()
    .transform((v) => (v === undefined ? undefined : (Number.parseInt(v, 10) as 1 | 2 | 3))),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const ResolveBodySchema = z.object({
  chosenOptionId: z.string().min(1),
  notes: z.string().optional(),
  /** Resolver identifier; defaults to 'admin-ui' when omitted. */
  by: z.string().optional(),
});

export function buildAdminHumanActionsRouter(opts: AdminHumanActionsRouterOptions): Hono {
  const app = new Hono();

  app.get('/v1/admin/human-actions', async (c) => {
    const parse = ListQuerySchema.safeParse({
      severity: c.req.query('severity'),
      limit: c.req.query('limit'),
    });
    if (!parse.success) {
      return c.json({ error: 'invalid_query', issues: parse.error.issues }, 400);
    }
    const listOpts: Parameters<typeof listPending>[1] = { limit: parse.data.limit };
    if (parse.data.severity !== undefined) listOpts.severity = parse.data.severity;
    const rows = await listPending(opts.db, listOpts);
    const enriched = await Promise.all(rows.map((r) => toRow(opts.db, r)));
    return c.json({ rows: enriched }, 200);
  });

  app.post('/v1/admin/human-actions/:id/resolve', async (c) => {
    const actionId = c.req.param('id');
    if (!/^[0-9a-f-]{36}$/i.test(actionId)) {
      return c.json({ error: 'invalid_action_id' }, 400);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json_body' }, 400);
    }
    const parse = ResolveBodySchema.safeParse(body);
    if (!parse.success) {
      return c.json({ error: 'invalid_body', issues: parse.error.issues }, 400);
    }

    const action = await getActionById(opts.db, actionId);
    if (!action) {
      return c.json({ error: 'action_not_found' }, 404);
    }
    const options = action.options as readonly HumanActionOption[];
    const chosen = options.find((o) => o.id === parse.data.chosenOptionId);
    if (!chosen) {
      return c.json(
        {
          error: 'invalid_option_id',
          detail: `option ${parse.data.chosenOptionId} not in [${options.map((o) => o.id).join(', ')}]`,
        },
        400,
      );
    }

    const wasResolved = action.status === 'resolved';
    const resolverBy = parse.data.by ?? 'admin-ui';

    // resolveAction is idempotent (M13.T4) — a second call on an already-
    // resolved row returns the existing row, so we don't need to gate here.
    const resolveOpts: Parameters<typeof resolveAction>[2] = {
      chosenOption: chosen,
      by: resolverBy,
      source: 'admin',
    };
    if (parse.data.notes !== undefined) resolveOpts.notes = parse.data.notes;
    const updated = await resolveAction(opts.db, actionId, resolveOpts);

    if (!wasResolved) {
      // Emit HUMAN_ACTION.RESOLVED → Reporter Agent posts a closure
      // message in the WA group. Same shape the WAHA inbound resolver uses
      // (src/channels/whatsapp/webhook.ts:318).
      try {
        await sendMessage(
          { db: opts.db },
          {
            fromRole: 'admin-ui',
            toRole: 'human-router',
            toInstance: 'singleton',
            intent: 'HUMAN_ACTION.RESOLVED',
            payload: {
              humanActionId: actionId,
              choice: chosen.id,
              source: 'admin',
            },
            correlationId: actionId,
          },
        );
      } catch (err) {
        // Best-effort: the row IS resolved; failing the emit shouldn't
        // 500 the resolve. The admin UI shows resolved; the WA closure
        // post is what's missing. Log loudly.
        logger.error(
          {
            err: err instanceof Error ? err.message : String(err),
            humanActionId: actionId,
          },
          'admin/human-actions: HUMAN_ACTION.RESOLVED emit failed — WA closure not posted',
        );
      }

      // Phase 3: emit HubSpot note for human-action resolve (gated, best-effort).
      // Try to resolve customerId via the correlationId (often a leadId).
      try {
        const corrId = action.correlationId;
        if (corrId) {
          const [leadRow] = await opts.db
            .select({ id: leads.id, customerId: leads.customerId })
            .from(leads)
            .where(eq(leads.id, corrId))
            .limit(1);
          if (leadRow?.customerId) {
            await emitHubSpotActivity(opts.db, {
              customerId: leadRow.customerId,
              leadId: leadRow.id,
              activity: {
                kind: 'human-action-resolved',
                customerId: leadRow.customerId,
                leadId: leadRow.id,
                humanActionId: actionId,
                chosenOptionId: chosen.id,
                source: 'admin',
                timestamp: new Date(),
              },
            });
          }
        }
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), humanActionId: actionId },
          'admin/human-actions: HubSpot activity emit failed (non-fatal)',
        );
      }

      // Audit row — primary action of an operator resolving from admin.
      try {
        await appendAudit(opts.db, {
          actorType: 'human',
          actorId: resolverBy,
          action: 'human_action.resolve',
          targetType: 'human_action',
          targetId: actionId,
          before: { status: 'pending' },
          after: {
            status: 'resolved',
            chosenOptionId: chosen.id,
            source: 'admin',
          },
          ...(parse.data.notes ? { meta: { notes: parse.data.notes } } : {}),
        });
      } catch (err) {
        logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            humanActionId: actionId,
          },
          'admin/human-actions: audit append failed — continuing',
        );
      }
    }

    const status = wasResolved ? 409 : 200;
    return c.json(
      {
        row: await toRow(opts.db, updated),
        alreadyResolved: wasResolved,
      },
      status,
    );
  });

  return app;
}

/**
 * Wire row + plain-French enrichment (2026-07-08 — Ridaa: the queue showed
 * "some numbers I don't understand"). Resolves who the action is about via
 * the same correlation→quote→lead→customer walk the WA-group formatter uses,
 * translates the machine error code to French, strips UUIDs from the summary
 * and splits out a blocked draft. All best-effort: enrichment failure still
 * returns the base row.
 */
async function toRow(db: Database, r: HumanAction): Promise<HumanActionRow> {
  const { summary, draft } = splitDraft(r.summary);
  const errorCode = extractErrorCode(summary);
  let customer: HumanActionRow['customer'] = null;
  try {
    const ctx = await resolveActionContext(db, r);
    if (ctx.customerName || ctx.source || ctx.productLine || ctx.leadId) {
      customer = {
        name: ctx.customerName ?? null,
        sourceFr: ctx.source ? (SOURCE_LABELS_FR[ctx.source] ?? ctx.source) : null,
        productFr: ctx.productLine ? (PRODUCT_LABELS_FR[ctx.productLine] ?? ctx.productLine) : null,
        simulation: ctx.simulation === true,
        leadId: ctx.leadId ?? null,
      };
    }
  } catch {
    // enrichment is cosmetic — never fail the endpoint on it
  }
  return {
    id: r.id,
    createdByAgent: r.createdByAgent,
    intent: r.intent,
    severity: r.severity,
    status: r.status,
    summary: r.summary,
    options: r.options as HumanActionOption[],
    correlationId: r.correlationId,
    createdAt: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
    resolvedBy: r.resolvedBy ?? null,
    resolvedSource: r.resolvedSource ?? null,
    resolution: r.resolution,
    titleFr: INTENT_TITLES_FR[r.intent] ?? r.intent,
    problemFr: errorCode ? explainErrorCodeFr(errorCode) : null,
    summaryClean: stripUuids(summary),
    draft,
    customer,
  };
}
