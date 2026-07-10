/**
 * Per-call voice context block tests (2026-07-10).
 *
 * DB-gated (TEST_DATABASE_URL + PII key). Covers: outbound framing + customer
 * name + product label, form facts surfaced when the sim/Meta form carried
 * them (and omitted when not), prior-conversation snippet, newest-lead
 * fallback when no leadId rides the session, and the never-throws contract on
 * an unknown customer.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { leads } from '../../src/db/schema/index.js';
import { insertCustomer } from '../../src/db/repositories/customers.js';
import { insertTurn } from '../../src/db/repositories/conversation-turns.js';
import { buildVoiceCallContext } from '../../src/http/voice-call-context.js';

const pgUrl = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!pgUrl);

let savedPiiKey: string | undefined;
beforeAll(() => {
  savedPiiKey = process.env.PII_ENCRYPTION_KEY;
  if (!process.env.PII_ENCRYPTION_KEY) {
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  }
});
afterAll(() => {
  if (savedPiiKey === undefined) delete process.env.PII_ENCRYPTION_KEY;
  else process.env.PII_ENCRYPTION_KEY = savedPiiKey;
});

d('buildVoiceCallContext', () => {
  let db: Database;

  beforeEach(async () => {
    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE customers RESTART IDENTITY CASCADE`);
  });

  async function seed(opts: {
    rawPayload?: Record<string, unknown> | null;
    preferredTime?: 'maintenant' | 'matin' | 'apres_midi' | 'soir' | null;
  }): Promise<{ customerId: string; leadId: string }> {
    const c = await insertCustomer(db, {
      fullName: 'Nor Lara',
      phone: '+33757818787',
      email: null,
      civility: 'Mme',
    });
    const [lead] = await db
      .insert(leads)
      .values({
        customerId: c.id,
        source: 'meta',
        productLine: 'scooter',
        status: 'qualifying',
        preferredChannel: 'call',
        preferredTime: opts.preferredTime ?? 'maintenant',
        rawPayload: opts.rawPayload ?? null,
      })
      .returning();
    return { customerId: c.id, leadId: lead!.id };
  }

  it('frames the call as OUTBOUND with name + product', async () => {
    const { customerId, leadId } = await seed({});
    const block = await buildVoiceCallContext(db, { customerId, leadId });

    expect(block).toContain('CONTEXTE DE CET APPEL');
    expect(block).toContain("C'EST TOI QUI APPELLES");
    expect(block).toContain('Nor Lara');
    expect(block).toContain('trottinette électrique');
    expect(block).toContain('Bonjour, Nor ?');
    // No form facts seeded → the facts line must be absent.
    expect(block).not.toContain('Infos déjà données');
  });

  it('surfaces the form facts so the bot does not re-ask them', async () => {
    const { customerId, leadId } = await seed({
      rawPayload: {
        purchasePriceEur: 800,
        purchaseDate: '2026-01-15',
        postalCode: '75011',
        stationnement: 'garage_box',
        dateOfBirth: '1995-03-20',
        simulation: true,
      },
    });
    const block = await buildVoiceCallContext(db, { customerId, leadId });

    expect(block).toContain('Infos déjà données au formulaire');
    expect(block).toContain("prix d'achat 800 €");
    expect(block).toContain('achetée le 2026-01-15');
    expect(block).toContain('code postal 75011');
    expect(block).toContain('stationnement la nuit garage_box');
    expect(block).toContain('date de naissance 1995-03-20');
    // Non-form keys never leak into the prompt.
    expect(block).not.toContain('simulation');
  });

  it('falls back to the newest lead when the session carried no lead id', async () => {
    const { customerId } = await seed({});
    const block = await buildVoiceCallContext(db, { customerId, leadId: customerId });
    // leadId == customerId (voice-operator fallback) is not a lead row —
    // resolves via newest-lead-for-customer instead.
    expect(block).toContain('trottinette électrique');
  });

  it('mentions the prior conversation with the last inbound message', async () => {
    const { customerId, leadId } = await seed({});
    await insertTurn(db, {
      customerId,
      leadId,
      channel: 'whatsapp',
      direction: 'inbound',
      content: 'Je veux assurer ma trottinette, rappelez-moi',
    });
    const block = await buildVoiceCallContext(db, { customerId, leadId });
    expect(block).toContain('déjà échangé');
    expect(block).toContain('Je veux assurer ma trottinette');
  });

  it('returns an empty string for an unknown customer (never throws)', async () => {
    const block = await buildVoiceCallContext(db, { customerId: randomUUID() });
    expect(block).toBe('');
  });
});
