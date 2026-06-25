/**
 * Phase-2d live verification HTTP control plane (M8.T8).
 *
 * Tiny Hono router wrapping the `ExtensionClient` so an operator can fire
 * `login.ensure`, `quote.preview`, or `quote.confirm` against the live
 * Chrome extension via curl. Bundled into `pnpm extension:ws` (the
 * standalone WS bootstrap script — Postgres/Redis-free), not the full
 * backend, because phase 2d is meant to verify the extension link in
 * isolation before the BullMQ-driven flow takes over.
 *
 *   POST /health           → client.health() — verifies the extension is connected
 *   POST /login            → client.ensureLoggedIn() — login.ensure round trip
 *   POST /quote-preview    → client.runQuote(...) — body = ExtensionQuoteParams JSON
 *   POST /quote-confirm    → client.confirmQuote(...) — body = ExtensionSubscriberInfo JSON;
 *                            dryRun defaults to TRUE (no real email send) — pass
 *                            `{"_dryRun": false}` in the body to flip
 *
 * Bind posture: localhost-only. The default port (9224) is one above the
 * WS server (9223). Both bind to 127.0.0.1 — the OS firewall enforces the
 * trust boundary. Optional `EXTENSION_WS_TRIGGER_TOKEN` env adds a Bearer
 * gate on top so accidental triggers from a stale tab can't fire a real
 * Maxance flow.
 *
 * NOT a production surface — phase 2d only. Once the full backend is up
 * and BullMQ drives QUOTE.REQUESTED → MaxanceOperator → client, this
 * control plane goes unused. Kept as a debugging seam.
 */
import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Context, Next } from 'hono';
import type {
  ExtensionClient,
  ExtensionQuoteParams,
  ExtensionSubscriberInfo,
  ResumeDevisParams,
} from './extension-client.js';

/** Default port for the HTTP control plane. WS server uses 9223. */
export const DEFAULT_CONTROL_PLANE_PORT = 9224;

export interface BuildControlPlaneOptions {
  client: ExtensionClient;
  /**
   * Optional Bearer token. When set, every request needs
   * `Authorization: Bearer <token>`. When unset, the gate is a no-op (dev
   * loopback only). Constant-time compared.
   */
  triggerToken?: string;
}

// Zod schemas — we deliberately drop the explicit `z.ZodType<Extension...>`
// annotation. The project runs `exactOptionalPropertyTypes: true`, which
// makes `T?: X` mean `T?: X` (key absent) NOT `T?: X | undefined` (key
// present, value undefined). Zod's `optional()` infers as the latter, so
// a direct assignment trips TS. We parse with inferred types and then
// conditionally spread the optional keys when forwarding to the client.
const QuoteParamsSchema = z.object({
  vehicleKind: z.literal('trottinette'),
  purchasePriceEur: z.number().positive(),
  // Accept ISO string OR a date-castable string; client.toIso normalises.
  purchaseDate: z.union([z.string(), z.date()]),
  postalCode: z.string().min(4),
  city: z.string().optional(),
  stationnement: z.enum(['garage_box', 'parking_prive_clos', 'parking_prive_non_clos', 'rue']),
  clientDateOfBirth: z.union([z.string(), z.date()]),
  formule: z.enum(['tiers_illimite', 'vol_incendie', 'dommages_tous_accidents']).optional(),
  commissionPct: z.number().min(0).max(100).optional(),
  fractionnement: z.enum(['mensuel', 'annuel']).optional(),
});

const SubscriberSchema = z.object({
  civilite: z.enum(['monsieur', 'madame']),
  lastName: z.string().min(1),
  firstName: z.string().min(1),
  addressLine: z.string().min(1),
  addressComplement: z.string().optional(),
  postalCode: z.string().min(4),
  city: z.string().min(1),
  phoneMobile: z.string().min(6),
  email: z.string().email(),
  profession: z
    .enum(['employe_prive', 'employe_public', 'etudiant', 'retraite', 'sans_profession'])
    .optional(),
});

const ConfirmBodySchema = SubscriberSchema.and(
  z.object({ _dryRun: z.boolean().optional(), _exerciseCourrier: z.boolean().optional() }),
);

// M8.T7 B2 — devis.resume body. devisNumber required; the Garanties closing
// overrides are optional (commission defaults to 22 in the extension).
const ResumeBodySchema = z.object({
  devisNumber: z.string().min(3),
  formule: z.enum(['tiers_illimite', 'vol_incendie', 'dommages_tous_accidents']).optional(),
  commissionPct: z.number().min(0).max(100).optional(),
  fractionnement: z.enum(['mensuel', 'annuel']).optional(),
});

/** Build ResumeDevisParams from the parsed body, omitting undefined optionals. */
function toResumeParams(parsed: z.infer<typeof ResumeBodySchema>): ResumeDevisParams {
  return {
    ...(parsed.formule !== undefined ? { formule: parsed.formule } : {}),
    ...(parsed.commissionPct !== undefined ? { commissionPct: parsed.commissionPct } : {}),
    ...(parsed.fractionnement !== undefined ? { fractionnement: parsed.fractionnement } : {}),
  };
}

/** Build an ExtensionQuoteParams from the parsed body, omitting undefined optionals. */
function toQuoteParams(parsed: z.infer<typeof QuoteParamsSchema>): ExtensionQuoteParams {
  return {
    vehicleKind: parsed.vehicleKind,
    purchasePriceEur: parsed.purchasePriceEur,
    purchaseDate: parsed.purchaseDate,
    postalCode: parsed.postalCode,
    stationnement: parsed.stationnement,
    clientDateOfBirth: parsed.clientDateOfBirth,
    ...(parsed.city !== undefined ? { city: parsed.city } : {}),
    ...(parsed.formule !== undefined ? { formule: parsed.formule } : {}),
    ...(parsed.commissionPct !== undefined ? { commissionPct: parsed.commissionPct } : {}),
    ...(parsed.fractionnement !== undefined ? { fractionnement: parsed.fractionnement } : {}),
  };
}

/** Build an ExtensionSubscriberInfo from the parsed body, omitting undefined optionals. */
function toSubscriber(parsed: z.infer<typeof SubscriberSchema>): ExtensionSubscriberInfo {
  return {
    civilite: parsed.civilite,
    lastName: parsed.lastName,
    firstName: parsed.firstName,
    addressLine: parsed.addressLine,
    postalCode: parsed.postalCode,
    city: parsed.city,
    phoneMobile: parsed.phoneMobile,
    email: parsed.email,
    ...(parsed.addressComplement !== undefined
      ? { addressComplement: parsed.addressComplement }
      : {}),
    ...(parsed.profession !== undefined ? { profession: parsed.profession } : {}),
  };
}

function requireToken(expected: string | undefined) {
  return async (c: Context, next: Next): Promise<Response | undefined> => {
    if (!expected) {
      await next();
      return undefined;
    }
    const header = c.req.header('Authorization');
    const BEARER = 'Bearer ';
    if (!header || !header.startsWith(BEARER)) {
      return c.json({ error: 'unauthorized', detail: 'missing_bearer' }, 401);
    }
    const provided = header.slice(BEARER.length).trim();
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return c.json({ error: 'unauthorized', detail: 'invalid_token' }, 401);
    }
    await next();
    return undefined;
  };
}

async function parseJsonBody(
  c: Context,
): Promise<{ ok: true; value: unknown } | { ok: false; res: Response }> {
  try {
    const value = (await c.req.json()) as unknown;
    return { ok: true, value };
  } catch {
    return { ok: false, res: c.json({ error: 'invalid_json_body' }, 400) };
  }
}

export function buildExtensionControlPlane(opts: BuildControlPlaneOptions): Hono {
  const app = new Hono();
  app.use('*', requireToken(opts.triggerToken));

  app.post('/health', async (c) => {
    const res = await opts.client.health();
    return c.json(res, res.status === 'ok' ? 200 : 503);
  });

  app.post('/login', async (c) => {
    try {
      const res = await opts.client.ensureLoggedIn();
      return c.json(res, 200);
    } catch (err) {
      return c.json(
        { error: 'login_failed', detail: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });

  app.post('/quote-preview', async (c) => {
    const body = await parseJsonBody(c);
    if (!body.ok) return body.res;
    const parse = QuoteParamsSchema.safeParse(body.value);
    if (!parse.success) {
      return c.json({ error: 'invalid_body', issues: parse.error.issues }, 400);
    }
    try {
      // sessionName is ignored in V1 (single-session); reserve a placeholder.
      const res = await opts.client.runQuote('maxance-default', toQuoteParams(parse.data), {
        dryRun: true,
      });
      return c.json(res, 200);
    } catch (err) {
      return c.json(
        {
          error: 'quote_preview_failed',
          detail: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
  });

  app.post('/quote-confirm', async (c) => {
    const body = await parseJsonBody(c);
    if (!body.ok) return body.res;
    const parse = ConfirmBodySchema.safeParse(body.value);
    if (!parse.success) {
      return c.json({ error: 'invalid_body', issues: parse.error.issues }, 400);
    }
    // Default dryRun TRUE — flipping requires explicit `_dryRun: false` in the
    // body. The extension itself stops one click before "Envoyer" when
    // dryRun=true (M8.T6 contract), so this is the second safety on top.
    const dryRun = parse.data._dryRun ?? true;
    const exerciseCourrier = parse.data._exerciseCourrier ?? false;
    try {
      const res = await opts.client.confirmQuote('maxance-default', toSubscriber(parse.data), {
        dryRun,
        exerciseCourrier,
      });
      return c.json(res, 200);
    } catch (err) {
      return c.json(
        {
          error: 'quote_confirm_failed',
          detail: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
  });

  app.post('/devis-resume', async (c) => {
    const body = await parseJsonBody(c);
    if (!body.ok) return body.res;
    const parse = ResumeBodySchema.safeParse(body.value);
    if (!parse.success) {
      return c.json({ error: 'invalid_body', issues: parse.error.issues }, 400);
    }
    try {
      const res = await opts.client.resumeDevis('maxance-default', {
        devisNumber: parse.data.devisNumber,
        ...toResumeParams(parse.data),
      });
      return c.json(res, 200);
    } catch (err) {
      return c.json(
        {
          error: 'devis_resume_failed',
          detail: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
  });

  return app;
}
