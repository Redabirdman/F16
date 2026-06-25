# Admin Publish + Simulation Section — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let Achraf (remote) self-serve fake Facebook-ad leads through the real intake pipeline (engaging him on his real WhatsApp/phone), with a reset that purges his contact — via a new admin "Simulation" section, published behind Cloudflare Access.

**Architecture:** A backend Hono router (`/v1/admin/sim/*`) injects leads through the existing `ingestLead()` (source `meta`, flagged `f16_simulation`), purges a contact transactionally (+ archives HubSpot), and reports channel liveness/identity. A new admin React page drives it. Publishing is cloudflared ingress + Cloudflare Access (runbook; no app changes).

**Tech Stack:** TypeScript, Hono, Drizzle (Postgres), Zod, React + react-query (admin), Vitest, cloudflared / Cloudflare Access.

Spec: `docs/superpowers/specs/2026-06-15-admin-publish-and-simulation-design.md`. Live `f16` DB with the `f16_simulation` flag. DB-gated tests run ONLY against `f16_test` (5435). Commits: lowercase subject, scope ∈ {backend,admin,docs}, end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Subagents commit; the lead pushes.

---

## File structure

| File                                                 | Responsibility                                           | New/Mod |
| ---------------------------------------------------- | -------------------------------------------------------- | ------- |
| `backend/src/leads/purge.ts`                         | `purgeContact()` — transactional contact purge by phone  | new     |
| `backend/tests/leads/purge.test.ts`                  | DB-gated purge tests                                     | new     |
| `backend/src/integrations/hubspot/client.ts`         | `archiveContactByPhoneOrEmail()`                         | mod     |
| `backend/tests/integrations/hubspot/archive.test.ts` | archive unit test (mocked fetch)                         | new     |
| `backend/src/admin/sim-control.ts`                   | inject/reset/status router                               | new     |
| `backend/tests/admin/sim-control.test.ts`            | router unit + DB-gated tests                             | new     |
| `backend/src/index.ts`                               | mount sim router                                         | mod     |
| `admin/src/lib/api.ts`                               | `injectSimulatedLead/resetSimulatedContact/getSimStatus` | mod     |
| `admin/src/pages/Simulation.tsx`                     | the Simulation page                                      | new     |
| `admin/src/App.tsx`                                  | nav entry + route                                        | mod     |
| `admin/src/pages/Simulation.test.tsx`                | page smoke test                                          | new     |
| `docs/runbooks/publish-admin.md`                     | cloudflared + Access runbook                             | new     |

---

## Phase 1 — Backend: `purgeContact`

### Task 1: purge lib + DB-gated tests

**Files:**

- Create: `backend/src/leads/purge.ts`
- Test: `backend/tests/leads/purge.test.ts`

Reference column facts (verified against `src/db/schema`): `conversation_turns.customerId` (`customer_id`), `quotes.customerId`, `leads.customerId`, `human_actions.correlationId` (text — holds leadId/customerId/quoteId strings), `customers.id`. `getCustomerByPhone(db, e164)` returns `{ id, ... } | null` (see `src/db/repositories/customers.ts`). `normalizePhone` is exported from `src/leads/intake.ts`.

- [ ] **Step 1: Write the failing DB-gated test**

```ts
// backend/tests/leads/purge.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { customers, leads, quotes, conversationTurns } from '../../src/db/schema/index.js';
import { insertCustomer } from '../../src/db/repositories/customers.js';
import { insertQuote } from '../../src/db/repositories/quotes.js';
import { purgeContact } from '../../src/leads/purge.js';

const liveUrl = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!liveUrl);

let db: Database;
beforeAll(() => {
  if (!process.env.PII_ENCRYPTION_KEY)
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  if (liveUrl) db = createDb(liveUrl);
});
afterAll(async () => {
  if (db) await db.$client.end();
});

d('purgeContact', () => {
  const phone = '+33600000111';
  beforeEach(async () => {
    await purgeContact(db, { phone });
  });

  it('removes the customer + their leads/quotes/conversations and is idempotent', async () => {
    const cust = await insertCustomer(db, { fullName: 'Test Purge', email: null, phone });
    const [lead] = await db
      .insert(leads)
      .values({ customerId: cust.id, source: 'meta', productLine: 'scooter', status: 'new' })
      .returning();
    await insertQuote(db, {
      customerId: cust.id,
      leadId: lead.id,
      product: 'scooter',
      productVariant: 'trottinette',
      sessionId: `sess-${lead.id}`,
    });
    await db
      .insert(conversationTurns)
      .values({ customerId: cust.id, channel: 'whatsapp', direction: 'outbound', body: 'hi' });

    const res = await purgeContact(db, { phone });
    expect(res.customer).toBe(1);
    expect(res.leads).toBeGreaterThanOrEqual(1);
    expect(res.quotes).toBeGreaterThanOrEqual(1);
    expect(res.conversations).toBeGreaterThanOrEqual(1);

    const left = await db.select().from(customers).where(eq(customers.id, cust.id));
    expect(left.length).toBe(0);

    const again = await purgeContact(db, { phone }); // idempotent
    expect(again.customer).toBe(0);
  });
});
```

(Adjust `conversationTurns`/`insertQuote` field names if the schema differs — confirm against `src/db/schema/conversations.ts` + `src/db/repositories/quotes.ts` before writing.)

- [ ] **Step 2: Run it — verify it fails** (`purgeContact` undefined)

Run: `cd backend && TEST_DATABASE_URL=postgres://f16:<pw>@127.0.0.1:5435/f16_test npx vitest run tests/leads/purge.test.ts`
Expected: FAIL (module/export missing). (Use the same f16_test DB the existing DB-gated tests use; migrate it first if needed: `DATABASE_URL=…/f16_test pnpm db:migrate`.)

- [ ] **Step 3: Implement `purgeContact`**

```ts
// backend/src/leads/purge.ts
/**
 * Transactional purge of one contact (by phone) — customer + every row that
 * carries their memory: leads, quotes, conversation_turns, and the
 * human_actions correlated to those ids. Idempotent: no customer → all zeros.
 * PII discipline: logs ids/counts only, never decrypted values.
 */
import { eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { customers, leads, quotes, conversationTurns, humanActions } from '../db/schema/index.js';
import { getCustomerByPhone } from '../db/repositories/customers.js';
import { normalizePhone } from './intake.js';
import { logger } from '../logger.js';

export interface PurgeResult {
  customer: number;
  leads: number;
  quotes: number;
  conversations: number;
  humanActions: number;
}

export async function purgeContact(db: Database, input: { phone?: string }): Promise<PurgeResult> {
  const e164 = normalizePhone(input.phone);
  const empty: PurgeResult = {
    customer: 0,
    leads: 0,
    quotes: 0,
    conversations: 0,
    humanActions: 0,
  };
  if (!e164) return empty;
  const existing = await getCustomerByPhone(db, e164);
  if (!existing) return empty;
  const customerId = existing.id;

  return db.transaction(async (tx) => {
    const leadRows = await tx
      .select({ id: leads.id })
      .from(leads)
      .where(eq(leads.customerId, customerId));
    const quoteRows = await tx
      .select({ id: quotes.id })
      .from(quotes)
      .where(eq(quotes.customerId, customerId));
    const corr = [customerId, ...leadRows.map((r) => r.id), ...quoteRows.map((r) => r.id)];

    const conv = await tx
      .delete(conversationTurns)
      .where(eq(conversationTurns.customerId, customerId))
      .returning({ id: conversationTurns.id });
    const q = await tx
      .delete(quotes)
      .where(eq(quotes.customerId, customerId))
      .returning({ id: quotes.id });
    const ha = await tx
      .delete(humanActions)
      .where(inArray(humanActions.correlationId, corr))
      .returning({ id: humanActions.id });
    const ld = await tx
      .delete(leads)
      .where(eq(leads.customerId, customerId))
      .returning({ id: leads.id });
    const cust = await tx
      .delete(customers)
      .where(eq(customers.id, customerId))
      .returning({ id: customers.id });

    const result: PurgeResult = {
      customer: cust.length,
      leads: ld.length,
      quotes: q.length,
      conversations: conv.length,
      humanActions: ha.length,
    };
    logger.info({ customerId, ...result }, 'contact purged (simulation reset)');
    return result;
  });
}
```

(Confirm exact exported names `conversationTurns`, `humanActions` in `src/db/schema/index.js`; adjust imports to match. If `humanActions.correlationId` can be null, `inArray` still works.)

- [ ] **Step 4: Run the test — verify it passes**

Run: same command as Step 2. Expected: PASS.

- [ ] **Step 5: typecheck + lint**

Run: `cd backend && pnpm typecheck && pnpm lint`. Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add backend/src/leads/purge.ts backend/tests/leads/purge.test.ts
git commit -m "feat(backend): purgeContact — transactional contact purge by phone

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 — Backend: HubSpot archive

### Task 2: `archiveContactByPhoneOrEmail`

**Files:**

- Modify: `backend/src/integrations/hubspot/client.ts` (add method near `updateContact`, ~line 420)
- Test: `backend/tests/integrations/hubspot/archive.test.ts`

The client has a private `rawRequest(method, path, body)` helper (~line 648) and public methods like `upsertContact`/`updateContact`. Use the CRM v3 search + archive endpoints.

- [ ] **Step 1: Write the failing unit test** (mock `rawRequest` via a fake fetch / inject)

```ts
// backend/tests/integrations/hubspot/archive.test.ts
import { describe, it, expect, vi } from 'vitest';
import { HubSpotClient } from '../../../src/integrations/hubspot/client.js';

function clientWithFetch(fetchImpl: typeof fetch) {
  return new HubSpotClient({ apiKey: 'pat-test', fetchImpl }); // match the ctor's injectable fetch
}

describe('archiveContactByPhoneOrEmail', () => {
  it('searches by phone, archives the contact + its deals, returns archived', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET' });
      if (String(url).includes('/contacts/search')) {
        return new Response(JSON.stringify({ results: [{ id: '111' }] }), { status: 200 });
      }
      if (String(url).includes('/associations/')) {
        return new Response(JSON.stringify({ results: [{ toObjectId: '999' }] }), { status: 200 });
      }
      return new Response('', { status: 204 });
    }) as unknown as typeof fetch;

    const res = await clientWithFetch(fetchImpl).archiveContactByPhoneOrEmail({
      phone: '+33600000111',
    });
    expect(res).toBe('archived');
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('/contacts/111'))).toBe(true);
  });

  it('returns not_found when search has no results', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ results: [] }), { status: 200 }),
    ) as unknown as typeof fetch;
    expect(
      await clientWithFetch(fetchImpl).archiveContactByPhoneOrEmail({ phone: '+33600000111' }),
    ).toBe('not_found');
  });
});
```

(First read the `HubSpotClient` constructor to see how `fetch` is injected — mirror that exact option name. If there's no injectable fetch, add one minimally, matching how other tests in `tests/integrations/hubspot/` mock it.)

- [ ] **Step 2: Run — verify it fails.** Run: `cd backend && npx vitest run tests/integrations/hubspot/archive.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement the method**

```ts
// in client.ts, public method:
/**
 * Best-effort archive of a contact found by phone (or email) + its associated
 * deals. Returns 'archived' | 'not_found' | 'error'. Never throws — the caller
 * (simulation reset) must not fail the F16 purge on a HubSpot hiccup.
 */
async archiveContactByPhoneOrEmail(input: { phone?: string; email?: string }): Promise<'archived' | 'not_found' | 'error'> {
  try {
    const filter = input.phone
      ? { propertyName: 'phone', operator: 'EQ', value: input.phone }
      : input.email
        ? { propertyName: 'email', operator: 'EQ', value: input.email }
        : null;
    if (!filter) return 'not_found';
    const search = await this.rawRequest('POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [filter] }], properties: ['hs_object_id'], limit: 1,
    });
    const body = (await search.json()) as { results?: Array<{ id: string }> };
    const contactId = body.results?.[0]?.id;
    if (!contactId) return 'not_found';
    // Archive associated deals first (best-effort).
    const assoc = await this.rawRequest('GET', `/crm/v4/objects/contacts/${contactId}/associations/deals`, undefined);
    const dealIds = (((await assoc.json()) as { results?: Array<{ toObjectId: string }> }).results ?? []).map((r) => r.toObjectId);
    for (const dealId of dealIds) await this.rawRequest('DELETE', `/crm/v3/objects/deals/${dealId}`, undefined);
    await this.rawRequest('DELETE', `/crm/v3/objects/contacts/${contactId}`, undefined);
    return 'archived';
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'hubspot archive failed');
    return 'error';
  }
}
```

(Confirm `rawRequest` returns a `Response`; if it returns parsed JSON, adapt `.json()` calls. Confirm `logger` import exists in the file.)

- [ ] **Step 4: Run — verify pass.** Same command. Expected: PASS.
- [ ] **Step 5: typecheck + lint.** `cd backend && pnpm typecheck && pnpm lint`.
- [ ] **Step 6: Commit**

```bash
git add backend/src/integrations/hubspot/client.ts backend/tests/integrations/hubspot/archive.test.ts
git commit -m "feat(backend): hubspot archiveContactByPhoneOrEmail for simulation reset

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3 — Backend: sim-control router + mount

### Task 3: `buildAdminSimRouter` (inject / reset / status)

**Files:**

- Create: `backend/src/admin/sim-control.ts`
- Test: `backend/tests/admin/sim-control.test.ts`
- Modify: `backend/src/index.ts` (mount, after `adminPromptsApp` ~line 247)

Mirror the Hono pattern in `src/admin/leads-list.ts` (`buildAdminXRouter(opts): Hono`, `app.post('/v1/admin/...')`, Zod body parse, JSON responses). Auth is already applied by the `app.use('/v1/admin/*', requireAdminAuth())` middleware.

- [ ] **Step 1: Write the router unit test** (inject mapping + status; reset covered DB-gated)

```ts
// backend/tests/admin/sim-control.test.ts
import { describe, it, expect, vi } from 'vitest';
import { buildAdminSimRouter } from '../../src/admin/sim-control.js';

describe('admin sim-control', () => {
  it('inject-lead maps to ingestLead with source=meta + simulation flag', async () => {
    const ingestLead = vi.fn(async () => ({
      leadId: 'L1',
      customerId: 'C1',
      dedup: 'new_customer',
      source: 'meta',
      productLine: 'scooter',
    }));
    const app = buildAdminSimRouter({ db: {} as never, deps: { ingestLead } });
    const res = await app.request('/v1/admin/sim/inject-lead', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fullName: 'Achraf',
        phone: '+33600000111',
        preferredChannel: 'whatsapp',
        productLine: 'scooter',
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ leadId: 'L1', dedup: 'new_customer' });
    const payload = ingestLead.mock.calls[0][1];
    expect(payload.source).toBe('meta');
    expect(payload.attribution.f16_simulation).toBe('true');
    expect(payload.preferredChannel).toBe('whatsapp');
  });

  it('inject-lead rejects an unnormalizable phone', async () => {
    const app = buildAdminSimRouter({ db: {} as never, deps: { ingestLead: vi.fn() } });
    const res = await app.request('/v1/admin/sim/inject-lead', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fullName: 'x',
        phone: '123',
        preferredChannel: 'whatsapp',
        productLine: 'scooter',
      }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run — verify fail.** `cd backend && npx vitest run tests/admin/sim-control.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement the router**

```ts
// backend/src/admin/sim-control.ts
/**
 * Admin Simulation control — inject a fake Facebook lead through the REAL
 * intake pipeline, reset (purge) a contact, and report channel/identity
 * status. Lets a remote tester (Achraf) run agent scenarios on his real
 * WhatsApp/phone. Sim leads are source='meta' + attribution.f16_simulation
 * so the agents treat them identically while analytics can exclude them.
 */
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { leads } from '../db/schema/index.js';
import {
  ingestLead as realIngestLead,
  normalizePhone,
  type LeadIntakePayload,
  type IngestedLead,
} from '../leads/intake.js';
import { purgeContact as realPurgeContact } from '../leads/purge.js';
import { getCustomerByPhone } from '../db/repositories/customers.js';
import type { HubSpotClient } from '../integrations/hubspot/client.js';
import { logger } from '../logger.js';

export interface AdminSimRouterOptions {
  db: Database;
  hubspot?: HubSpotClient;
  // Injectable for tests:
  deps?: {
    ingestLead?: (db: Database, p: LeadIntakePayload) => Promise<IngestedLead>;
    purgeContact?: typeof realPurgeContact;
  };
}

const InjectSchema = z.object({
  fullName: z.string().min(1),
  phone: z.string().min(1),
  email: z.string().email().optional(),
  preferredChannel: z.enum(['whatsapp', 'call']),
  preferredTime: z.enum(['maintenant', 'matin', 'apres_midi', 'soir']).optional(),
  productLine: z.enum(['scooter', 'car']).default('scooter'),
  quote: z
    .object({
      purchasePriceEur: z.number().positive(),
      purchaseDate: z.string(),
      postalCode: z.string(),
      stationnement: z.string(),
      dateOfBirth: z.string(),
      city: z.string().optional(),
    })
    .optional(),
});
const PhoneBody = z.object({ phone: z.string().optional(), email: z.string().email().optional() });

export function buildAdminSimRouter(opts: AdminSimRouterOptions): Hono {
  const app = new Hono();
  const ingestLead = opts.deps?.ingestLead ?? realIngestLead;
  const purgeContact = opts.deps?.purgeContact ?? realPurgeContact;

  app.post('/v1/admin/sim/inject-lead', async (c) => {
    const parse = InjectSchema.safeParse(await c.req.json().catch(() => null));
    if (!parse.success) return c.json({ error: 'invalid_body', issues: parse.error.issues }, 400);
    const b = parse.data;
    if (!normalizePhone(b.phone)) return c.json({ error: 'invalid_phone' }, 400);
    const runId = randomUUID();
    const payload: LeadIntakePayload = {
      source: 'meta',
      sourceId: `sim-${runId}`,
      productLine: b.productLine,
      fullName: b.fullName,
      ...(b.email ? { email: b.email } : {}),
      phone: b.phone,
      preferredChannel: b.preferredChannel,
      ...(b.preferredTime ? { preferredTime: b.preferredTime } : {}),
      attribution: { f16_simulation: 'true', sim_run_id: runId, utm_source: 'simulation' },
      ...(b.quote ? { formAnswers: b.quote as Record<string, unknown> } : {}),
      raw: { simulation: true, sim_run_id: runId },
    };
    const res = await ingestLead(opts.db, payload);
    logger.info(
      { leadId: res.leadId, dedup: res.dedup, simRunId: runId },
      'simulation lead injected',
    );
    return c.json(res, 200);
  });

  app.post('/v1/admin/sim/reset', async (c) => {
    const parse = PhoneBody.safeParse(await c.req.json().catch(() => null));
    if (!parse.success || (!parse.data.phone && !parse.data.email))
      return c.json({ error: 'phone_or_email_required' }, 400);
    const purged = await purgeContact(opts.db, { phone: parse.data.phone });
    let hubspot: 'archived' | 'not_found' | 'error' | 'skipped' = 'skipped';
    if (opts.hubspot)
      hubspot = await opts.hubspot.archiveContactByPhoneOrEmail({
        phone: parse.data.phone,
        email: parse.data.email,
      });
    return c.json({ purged, hubspot }, 200);
  });

  app.post('/v1/admin/sim/status', async (c) => {
    const parse = PhoneBody.safeParse(await c.req.json().catch(() => ({})));
    const phone = parse.success ? parse.data.phone : undefined;
    const channels = { whatsapp: !!process.env.WAHA_BASE_URL, voice: !!process.env.OPENAI_API_KEY };
    let contact: { exists: boolean; leadCount: number; lastLeadStatus: string | null } | null =
      null;
    const e164 = normalizePhone(phone);
    if (e164) {
      const cust = await getCustomerByPhone(opts.db, e164);
      if (cust) {
        const rows = await opts.db
          .select({ id: leads.id, status: leads.status, createdAt: leads.createdAt })
          .from(leads)
          .where(eq(leads.customerId, cust.id));
        const last = rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
        contact = { exists: true, leadCount: rows.length, lastLeadStatus: last?.status ?? null };
      } else contact = { exists: false, leadCount: 0, lastLeadStatus: null };
    }
    return c.json({ channels, contact }, 200);
  });

  return app;
}
```

(Confirm `leads.createdAt` column name; adjust ordering if it's `requestedAt`/`created_at`. Confirm `HubSpotClient` export path.)

- [ ] **Step 4: Run — verify pass.** Same command. Expected: PASS (2 tests).

- [ ] **Step 5: DB-gated reset test** — append to the same file under a `describe.skipIf(!process.env.TEST_DATABASE_URL)` block: inject the same phone twice (second → `matched_existing`), then `POST /sim/reset`, then `POST /sim/status` shows `contact.exists=false`. Build the router with a real `createDb(TEST_DATABASE_URL)` and no `deps` override.

Run: `cd backend && TEST_DATABASE_URL=…/f16_test npx vitest run tests/admin/sim-control.test.ts`. Expected: PASS.

- [ ] **Step 6: Mount in `index.ts`** (after the `adminPromptsApp` block, ~line 247)

```ts
// M8-sim — simulation control (inject fake FB lead / reset / status).
const simHubspot = process.env.HUBSPOT_API_KEY
  ? new HubSpotClient({ apiKey: process.env.HUBSPOT_API_KEY })
  : undefined;
const adminSimApp = buildAdminSimRouter({
  db: opts.db,
  ...(simHubspot ? { hubspot: simHubspot } : {}),
});
app.route('/', adminSimApp);
```

Add the imports at the top of `index.ts`: `buildAdminSimRouter` from `./admin/sim-control.js` and `HubSpotClient` from `./integrations/hubspot/client.js` (check if already imported). Confirm the HubSpot ctor option name matches existing usage.

- [ ] **Step 7: typecheck + lint + full sim test.** `cd backend && pnpm typecheck && pnpm lint`. Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add backend/src/admin/sim-control.ts backend/tests/admin/sim-control.test.ts backend/src/index.ts
git commit -m "feat(backend): admin simulation control (inject/reset/status)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 4 — Admin frontend

### Task 4: API wrappers + Simulation page + nav/route

**Files:**

- Modify: `admin/src/lib/api.ts` (add 3 wrappers, mirror `apiPost<T>` usage)
- Create: `admin/src/pages/Simulation.tsx`
- Modify: `admin/src/App.tsx` (import + `<Route path="/sim">` + `<NavLink to="/sim">Simulation</NavLink>`)
- Test: `admin/src/pages/Simulation.test.tsx`

`apiPost<T>(path, body)` exists at `admin/src/lib/api.ts:63`. NavLink/Route patterns at `App.tsx:35-67` and `:146-169`.

- [ ] **Step 1: Add API wrappers** to `admin/src/lib/api.ts`

```ts
export interface SimInjectResult {
  leadId: string;
  customerId: string;
  dedup: 'new_customer' | 'matched_existing';
}
export function injectSimulatedLead(body: {
  fullName: string;
  phone: string;
  email?: string;
  preferredChannel: 'whatsapp' | 'call';
  preferredTime?: string;
  productLine: 'scooter';
  quote?: {
    purchasePriceEur: number;
    purchaseDate: string;
    postalCode: string;
    stationnement: string;
    dateOfBirth: string;
    city?: string;
  };
}): Promise<SimInjectResult> {
  return apiPost('/v1/admin/sim/inject-lead', body);
}

export interface SimStatus {
  channels: { whatsapp: boolean; voice: boolean };
  contact: { exists: boolean; leadCount: number; lastLeadStatus: string | null } | null;
}
export function getSimStatus(phone?: string): Promise<SimStatus> {
  return apiPost('/v1/admin/sim/status', { phone });
}

export interface SimResetResult {
  purged: {
    customer: number;
    leads: number;
    quotes: number;
    conversations: number;
    humanActions: number;
  };
  hubspot: string;
}
export function resetSimulatedContact(phone: string): Promise<SimResetResult> {
  return apiPost('/v1/admin/sim/reset', { phone });
}
```

- [ ] **Step 2: Write the page** `admin/src/pages/Simulation.tsx` — a form (fullName, phone, email, channel radio whatsapp/call, preferredTime select, product fixed scooter, collapsible quote inputs), Submit (`useMutation(injectSimulatedLead)`), Reset (confirm dialog → `useMutation(resetSimulatedContact)`), and a status panel (`useQuery(['sim-status', phone], () => getSimStatus(phone))`) showing the live/not-live banner + new-vs-returning + last result with a link to `/leads/<leadId>`. Mirror form/styling from an existing page (e.g. `admin/src/pages/Prompts.tsx`). Keep it under 300 lines; French labels. Banner copy when `!channels.whatsapp`: "Mode hors-ligne — le backend n'est pas en mode live, l'agent ne pourra pas envoyer de message." Reset confirm text must name the phone and that HubSpot will be archived.

- [ ] **Step 3: Wire nav + route in `App.tsx`**

```tsx
import SimulationPage from '@/pages/Simulation';
// in <Nav>: <NavLink to="/sim" className={navItemClass}>Simulation</NavLink>
// in <Routes>: <Route path="/sim" element={<SimulationPage />} />
```

- [ ] **Step 4: Page smoke test** `admin/src/pages/Simulation.test.tsx` — render within the app's QueryClient/test wrapper (mirror an existing page test), assert the form renders (name/phone fields, channel radios, Submit + Reset buttons). Mock the api module.

- [ ] **Step 5: typecheck + lint + test + build (admin)**

Run: `cd admin && pnpm typecheck && pnpm lint && pnpm test && pnpm build`. Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add admin/src/lib/api.ts admin/src/pages/Simulation.tsx admin/src/pages/Simulation.test.tsx admin/src/App.tsx
git commit -m "feat(admin): simulation section — inject lead, reset, status

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 5 — Publish runbook

### Task 5: cloudflared + Cloudflare Access runbook

**Files:** Create `docs/runbooks/publish-admin.md`.

- [ ] **Step 1: Find the current cloudflared config** — `grep -rEl "hooks.assuryalconseil.fr|ingress|tunnel" ~/.cloudflared /c/Users/Rlefr 2>/dev/null` and check how the existing voice tunnel is defined (named tunnel config.yml vs dashboard-managed). Document whichever is in use.

- [ ] **Step 2: Write the runbook** with:
  1. Build + serve the admin static: `pnpm --filter @f16/admin build` then `cd admin && npx vite preview --host --port 5173` (or document the dev-server alternative with `server.allowedHosts` including `admin.assuryalconseil.fr`).
  2. cloudflared ingress for `admin.assuryalconseil.fr` (same-hostname, path-ordered): `/v1/admin/*` + `/ws/*` → `http://localhost:3001`; `/*` → `http://localhost:5173`. Provide the exact YAML snippet (config-file tunnels) or the dashboard public-hostname steps (managed tunnels).
  3. DNS: CNAME `admin` → `<tunnel-id>.cfargotunnel.com` (proxied).
  4. Cloudflare Access: create a self-hosted Access application for `admin.assuryalconseil.fr`, policy = allow emails {achraf, ridaa}, one-time PIN. Note that this gates the whole hostname incl. `/v1/admin` + `/ws`; the `requireAdminAuth` bearer token stays as defense-in-depth.
  5. Session checklist: boot backend **full-live** (`pnpm extension:ws` + the backend WITH `WAHA_BASE_URL` set) so the agents can actually message Achraf; the Simulation page banner confirms live.

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/publish-admin.md
git commit -m "docs: runbook for publishing the admin via cloudflare access

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 6 — Integrate, verify, push

### Task 6: full verification + push + live smoke

- [ ] **Step 1: Full repo checks** — `cd backend && pnpm typecheck && pnpm lint`; `cd ../admin && pnpm typecheck && pnpm lint && pnpm build`. Backend unit tests: `cd backend && npx vitest run tests/admin/sim-control.test.ts tests/integrations/hubspot/archive.test.ts`. DB-gated against f16_test: `TEST_DATABASE_URL=…/f16_test npx vitest run tests/leads/purge.test.ts tests/admin/sim-control.test.ts`.
- [ ] **Step 2: Lead pushes** all commits to `main`.
- [ ] **Step 3: Local smoke (lead, not yet published)** — boot backend + admin; in the admin Simulation page submit a lead with a test phone (safe mode → banner shows offline, lead still created); verify it appears on the lead board; reset it; verify it's gone. (Live WhatsApp messaging smoke happens with Achraf after publish.)
- [ ] **Step 4: Publish** per the runbook (Ridaa does the Cloudflare Access dashboard step); confirm Achraf can reach `admin.assuryalconseil.fr` behind the email gate.
- [ ] **Step 5: Live run with Achraf (full-live boot)** — Achraf submits a WhatsApp lead with his number, receives the agent's first message, converses, resets, re-tests as new. Capture feedback.

---

## Self-review notes

- Spec coverage: publish (Task 5), inject through real `ingestLead` (Task 3), reset incl. HubSpot (Tasks 1+2+3), full form incl. quote inputs (Task 4), live-db-with-flag (`attribution.f16_simulation`, Task 3), status/liveness banner (Tasks 3+4), DB-gated f16_test only (Tasks 1,3,6). ✓
- Reset is **phone-keyed** (no `email_hash` column exists for lookup — confirmed in `intake.ts` header); email is forwarded only to the HubSpot archive. Documented so it isn't assumed bidirectional.
- Open confirmations for the implementer (verify against code before writing): exact schema export names (`conversationTurns`, `humanActions`), `leads.createdAt` vs `requestedAt`, `insertQuote` field names, `HubSpotClient` ctor fetch-injection + option names, `rawRequest` return type.
