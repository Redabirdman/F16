/**
 * Dev seed CLI for the F16 backend (M2.T8).
 *
 * What it does:
 *   1. Refuses to touch a database whose URL looks like production.
 *   2. TRUNCATEs every business + runtime table in dependency-safe order.
 *   3. Seeds a deterministic fixture set:
 *        - 2 customers (scooter rider + car driver with malus)
 *        - 3 leads (qualifying / quoting / unmatched-new)
 *        - 1 quote with 3 maxance_actions
 *        - 8 conversation turns (mixed channels + directions)
 *        - 4 customer_facts
 *        - 1 campaign tree (1 adset, 2 ads, 2 creatives, 3h metrics each)
 *        - 1 pending human_action (APPROVE_CREATIVE, severity=2)
 *        - 1 knowledge_chunk with a deterministic test embedding
 *        - 1 agent_message (LEAD.NEW for the unmatched lead)
 *   4. Logs per-table insert counts.
 *
 * Safety gate:
 *   Refuses to run if DATABASE_URL contains `prod`, `production`, or
 *   `assuryalconseil.fr`. Requires `--yes` flag or `F16_SEED_CONFIRM=yes`.
 *
 * Why a script (not a vitest helper): this is used by humans to bootstrap a
 * dev DB, by the admin UI smoke flow (M5+), and by the e2e test
 * (`tests/e2e/seed.test.ts`) via `execSync`. Keeping it CLI-shaped means all
 * three call sites share one code path.
 */
import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../src/db/index.js';
import { logger } from '../src/logger.js';
import { insertCustomer } from '../src/db/repositories/customers.js';
import { insertQuote, markQuoteReady, appendMaxanceAction } from '../src/db/repositories/quotes.js';
import {
  upsertCampaign,
  upsertAdset,
  upsertAd,
  insertCreative,
  recordHourlyMetrics,
} from '../src/db/repositories/ads.js';
import { enqueue } from '../src/db/repositories/agent-messages.js';
import { createAction } from '../src/db/repositories/human-actions.js';
import { upsertChunk } from '../src/db/repositories/knowledge.js';
import { leads, conversationTurns, customerFacts } from '../src/db/schema/index.js';

const PROD_MARKERS = ['prod', 'production', 'assuryalconseil.fr'];

// Tables to wipe, in dependency-safe order. CASCADE means we technically only
// need to TRUNCATE the parents, but listing every table makes the intent
// explicit and the script self-documenting.
const TABLES_TO_TRUNCATE: readonly string[] = [
  'agent_messages',
  'human_actions',
  'audit_log',
  'agent_patterns',
  'knowledge_chunks',
  'maxance_actions',
  'quotes',
  'conversation_turns',
  'customer_facts',
  'leads',
  'customers',
  'ad_metrics_hourly',
  'ads',
  'creatives',
  'adsets',
  'campaigns',
];

interface SeedCounts {
  customers: number;
  leads: number;
  quotes: number;
  maxanceActions: number;
  conversationTurns: number;
  customerFacts: number;
  campaigns: number;
  adsets: number;
  ads: number;
  creatives: number;
  adMetricsHourly: number;
  humanActions: number;
  knowledgeChunks: number;
  agentMessages: number;
}

function assertSafe(databaseUrl: string): void {
  const lower = databaseUrl.toLowerCase();
  const hit = PROD_MARKERS.find((m) => lower.includes(m));
  if (hit) {
    throw new Error(`Refusing to seed: DATABASE_URL contains "${hit}". This script is dev-only.`);
  }
}

function assertConfirmed(argv: readonly string[]): void {
  const flag = argv.includes('--yes');
  const envFlag = process.env.F16_SEED_CONFIRM === 'yes';
  if (!flag && !envFlag) {
    throw new Error(
      'Refusing to seed without explicit confirmation. Pass --yes or set F16_SEED_CONFIRM=yes.',
    );
  }
}

async function truncateAll(db: Database): Promise<void> {
  // Single statement with CASCADE — fewer round trips, atomic across all
  // tables (no half-wiped state if one fails). `RESTART IDENTITY` resets
  // any serial counters (no-op for our uuid PKs, kept for future-proofing).
  const list = TABLES_TO_TRUNCATE.join(', ');
  await db.execute(sql.raw(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`));
}

async function seedAll(db: Database): Promise<SeedCounts> {
  // ---- Customers ----------------------------------------------------------
  const marie = await insertCustomer(db, {
    fullName: 'Marie Dupont',
    email: 'marie.dupont@example.fr',
    phone: '+33612345678',
    address: {
      street: '14 rue du Faubourg',
      city: 'Lyon',
      postcode: '69003',
      country: 'France',
    },
    vehicle: { type: 'trottinette', brand: 'Xiaomi', model: 'Pro 2', year: 2024 },
    driver: { licence_required: false },
    iban: 'FR7630006000011234567890189',
    preferences: { channel: 'whatsapp', lang: 'fr' },
    consent: { marketing: true, ts: '2026-05-16T09:00:00Z' },
  });

  const pierre = await insertCustomer(db, {
    fullName: 'Pierre Martin',
    email: 'pierre.martin@example.fr',
    phone: '+33687654321',
    address: {
      street: '7 avenue Jean Jaurès',
      city: 'Marseille',
      postcode: '13001',
      country: 'France',
    },
    vehicle: {
      type: 'voiture',
      brand: 'Renault',
      model: 'Clio',
      year: 2018,
      plate: 'AA-123-BB',
    },
    driver: {
      licence_class: 'B',
      held_since: '2010-05-12',
      malus: 1.2,
      alcohol_history: true,
    },
    iban: 'FR1420041010050500013M02606',
    preferences: { channel: 'whatsapp', lang: 'fr' },
    consent: { marketing: true, ts: '2026-05-16T10:00:00Z' },
  });

  // ---- Leads --------------------------------------------------------------
  const insertedLeads = await db
    .insert(leads)
    .values([
      {
        source: 'website',
        productLine: 'scooter',
        status: 'qualifying',
        customerId: marie.id,
        score: 72,
        scoredAt: new Date(),
      },
      {
        source: 'meta',
        productLine: 'car',
        status: 'quoting',
        customerId: pierre.id,
        score: 85,
        scoredAt: new Date(),
        sourceId: 'meta-leadgen-9988',
      },
      {
        source: 'website',
        productLine: 'car',
        status: 'new',
        // Unmatched submission — customer_id and score remain null.
        customerId: null,
        score: null,
        rawPayload: { meta: { utm_source: 'organic' } },
      },
    ])
    .returning();
  // Defensive: drizzle's typed select doesn't narrow array length.
  const [lead1, lead2, lead3] = insertedLeads;
  if (!lead1 || !lead2 || !lead3) {
    throw new Error(`seed: expected 3 leads, got ${insertedLeads.length}`);
  }

  // ---- Quote + Maxance actions for Pierre (car / alcoolemie) -------------
  const quoteSessionId = 'seed-session-001';
  const quote = await insertQuote(db, {
    customerId: pierre.id,
    leadId: lead2.id,
    product: 'car',
    productVariant: 'alcoolemie',
    sessionId: quoteSessionId,
  });

  await markQuoteReady(db, quote.id, {
    monthlyPremium: '37.50',
    comptantDue: '58.20',
    devisNumber: 'DR0000000001',
    pdfUrl: 'https://seed.invalid/quote-DR0000000001.pdf',
    rawResponse: { engine: 'maxance', source: 'seed-fixture' },
  });

  const maxanceSteps = [
    { actionText: 'Open Maxance login form', stepName: 'login' },
    { actionText: 'Fill driver profile', stepName: 'profile' },
    { actionText: 'Submit quote request', stepName: 'submit' },
  ];
  for (const step of maxanceSteps) {
    await appendMaxanceAction(db, quote.id, quoteSessionId, step);
  }

  // ---- Conversation turns (4 inbound + 4 outbound, mix wa + voice) -------
  const now = Date.now();
  // Helper: minutes ago → Date.
  const mAgo = (mins: number): Date => new Date(now - mins * 60_000);

  const turnRows = [
    {
      customerId: marie.id,
      leadId: lead1.id,
      channel: 'whatsapp' as const,
      direction: 'inbound' as const,
      content:
        "Bonjour, je viens d'acheter une trottinette Xiaomi Pro 2 neuve et je cherche une assurance vol et responsabilité civile. Pouvez-vous me dire combien ça coûte par mois ?",
      occurredAt: mAgo(1430),
    },
    {
      customerId: marie.id,
      leadId: lead1.id,
      channel: 'whatsapp' as const,
      direction: 'outbound' as const,
      agentRole: 'sales-agent',
      agentInstance: 'sales-1',
      content:
        'Bonjour Marie, avec plaisir. Pour une Xiaomi Pro 2 neuve à Lyon, comptez environ 9 € par mois avec vol et RC inclus. Souhaitez-vous que je vous prépare un devis détaillé maintenant ?',
      occurredAt: mAgo(1425),
    },
    {
      customerId: marie.id,
      leadId: lead1.id,
      channel: 'voice' as const,
      direction: 'inbound' as const,
      content:
        "Oui je veux bien le devis, mais j'aimerais aussi comprendre la franchise vol et savoir si elle bouge selon mon code postal à Lyon trois.",
      occurredAt: mAgo(720),
    },
    {
      customerId: marie.id,
      leadId: lead1.id,
      channel: 'voice' as const,
      direction: 'outbound' as const,
      agentRole: 'sales-agent',
      agentInstance: 'sales-1',
      content:
        'Parfait, la franchise vol est fixe à 150 € quel que soit le code postal. Je vous envoie le devis par WhatsApp dans la minute, vous pourrez signer en ligne.',
      occurredAt: mAgo(715),
    },
    {
      customerId: pierre.id,
      leadId: lead2.id,
      channel: 'whatsapp' as const,
      direction: 'inbound' as const,
      content:
        "Bonjour, j'ai un malus de 1.2 et un antécédent alcool il y a 4 ans. Est-ce que vous acceptez quand même de m'assurer pour ma Clio de 2018 ?",
      occurredAt: mAgo(360),
    },
    {
      customerId: pierre.id,
      leadId: lead2.id,
      channel: 'whatsapp' as const,
      direction: 'outbound' as const,
      agentRole: 'sales-agent',
      agentInstance: 'sales-1',
      content:
        'Bonjour Pierre, oui nous gérons ce type de profil via notre offre alcoolémie. Je vous prépare un devis tout de suite, le tarif tient compte de votre malus et de votre historique.',
      occurredAt: mAgo(355),
    },
    {
      customerId: pierre.id,
      leadId: lead2.id,
      channel: 'voice' as const,
      direction: 'inbound' as const,
      content:
        "D'accord merci. Je peux payer en plusieurs fois ou je dois tout régler en une seule fois au comptant à la signature ?",
      occurredAt: mAgo(120),
    },
    {
      customerId: pierre.id,
      leadId: lead2.id,
      channel: 'voice' as const,
      direction: 'outbound' as const,
      agentRole: 'sales-agent',
      agentInstance: 'sales-1',
      content:
        'Le devis prévoit 37.50 € par mois avec un comptant de 58.20 € à la signature, prélevé sur votre IBAN. Vous restez libre de résilier à tout moment après un an.',
      occurredAt: mAgo(115),
    },
  ];
  const insertedTurns = await db.insert(conversationTurns).values(turnRows).returning({
    id: conversationTurns.id,
  });

  // ---- Customer facts (2 per customer) -----------------------------------
  const insertedFacts = await db
    .insert(customerFacts)
    .values([
      {
        customerId: marie.id,
        factType: 'preference',
        content: 'Prefers WhatsApp evenings (after 19h)',
        confidence: 0.82,
        recordedBy: 'sales-agent',
      },
      {
        customerId: marie.id,
        factType: 'observation',
        content: 'Asked specifically about theft deductible — price-sensitive',
        confidence: 0.7,
        recordedBy: 'sales-agent',
      },
      {
        customerId: pierre.id,
        factType: 'preference',
        content: 'Prefers monthly payment over comptant',
        confidence: 0.75,
        recordedBy: 'sales-agent',
      },
      {
        customerId: pierre.id,
        factType: 'observation',
        content: 'Alcohol history disclosed upfront — honest, low-friction lead',
        confidence: 0.85,
        recordedBy: 'sales-agent',
      },
    ])
    .returning({ id: customerFacts.id });

  // ---- Campaign tree -----------------------------------------------------
  const campaign = await upsertCampaign(db, 'seed-meta-campaign-1', {
    name: 'Seed — Scooter Acquisition',
    objective: 'OUTCOME_LEADS',
    status: 'ACTIVE',
    productLine: 'scooter',
    dailyBudgetCents: 5000n,
    currency: 'EUR',
  });

  const adset = await upsertAdset(db, 'seed-meta-adset-1', {
    campaignId: campaign.id,
    name: 'Seed — Lyon 25-45',
    status: 'ACTIVE',
    targeting: { geo: ['FR-69'], ageMin: 25, ageMax: 45 },
    optimizationGoal: 'LEAD_GENERATION',
    billingEvent: 'IMPRESSIONS',
  });

  const fearCreative = await insertCreative(db, {
    name: 'seed-scooter-fear-9x16',
    angle: 'Fear',
    productLine: 'scooter',
    format: '9:16',
    headline: 'Et si on volait votre trottinette cette nuit ?',
    ctaText: 'Obtenir un devis',
    fileUrl: 's3://seed/scooter-fear-9x16.png',
    // Stable, recognizable shas keep e2e assertions deterministic.
    fileSha256: 'fear'.padEnd(64, 'a'),
    generatedBy: 'ai-nano-banana',
  });

  const legalCreative = await insertCreative(db, {
    name: 'seed-scooter-legal-9x16',
    angle: 'Legal',
    productLine: 'scooter',
    format: '9:16',
    headline: "L'assurance trottinette est obligatoire — êtes-vous couvert ?",
    ctaText: 'Vérifier ma couverture',
    fileUrl: 's3://seed/scooter-legal-9x16.png',
    fileSha256: 'legal'.padEnd(64, 'b'),
    generatedBy: 'ai-nano-banana',
  });

  const ad1 = await upsertAd(db, 'seed-meta-ad-1', {
    adsetId: adset.id,
    creativeId: fearCreative.id,
    name: 'seed-scooter-fear',
    status: 'ACTIVE',
    primaryText: 'Assurance trottinette en 2 minutes',
    headline: 'Vol couvert dès le 1er jour',
    ctaType: 'LEARN_MORE',
  });

  const ad2 = await upsertAd(db, 'seed-meta-ad-2', {
    adsetId: adset.id,
    creativeId: legalCreative.id,
    name: 'seed-scooter-legal',
    status: 'ACTIVE',
    primaryText: 'Obligation légale depuis 2019',
    headline: 'Roulez en règle pour 9 €/mois',
    ctaType: 'GET_QUOTE',
  });

  // 3 hours of metrics per ad — most recent first (h0), oldest last (h2).
  // `date_trunc('hour', now())` semantics: align to wall-clock hour.
  const truncHour = (d: Date): Date => {
    const c = new Date(d);
    c.setMinutes(0, 0, 0);
    return c;
  };
  const h0 = truncHour(new Date());
  let metricsInserted = 0;
  for (const ad of [ad1, ad2]) {
    for (let hourBack = 0; hourBack < 3; hourBack++) {
      const bucket = new Date(h0.getTime() - hourBack * 3_600_000);
      await recordHourlyMetrics(db, ad.id, bucket, {
        impressions: 1200 - hourBack * 100,
        clicks: 40 - hourBack * 4,
        conversions: 3 - hourBack,
        spendCents: BigInt(900 - hourBack * 80),
        frequency: 1.3 + hourBack * 0.1,
        reach: 900 - hourBack * 70,
      });
      metricsInserted++;
    }
  }

  // ---- Pending human action ---------------------------------------------
  await createAction(db, {
    createdByAgent: 'creative-curator',
    intent: 'APPROVE_CREATIVE',
    severity: 2,
    summary: "Nouvelle créative à valider pour l'angle Légal",
    options: [
      { id: 'approve', label: 'Approuver', kind: 'approve' },
      { id: 'revise', label: 'Demander révision', kind: 'revise' },
      { id: 'reject', label: 'Refuser', kind: 'reject' },
    ],
    correlationId: legalCreative.id,
  });

  // ---- Knowledge chunk --------------------------------------------------
  // Synthetic deterministic embedding — never used in real flows, lets the
  // e2e test do an exact kNN query without OpenAI in the loop.
  const testEmbedding = Array<number>(1536).fill(0.01);
  await upsertChunk(db, {
    source: 'assuryalconseil.fr',
    sourceUrl: 'https://assuryalconseil.fr/scooter',
    sourcePath: '/scooter',
    chunkText:
      "Assuryal Conseil propose une assurance trottinette électrique conforme à l'obligation légale française. Vol, RC, dommages corporels — souscription en ligne en 2 minutes.",
    chunkSha256: 'seed-knowledge-chunk-1'.padEnd(64, 'c'),
    tokenCount: 64,
    embedding: testEmbedding,
    meta: { test: true, pageTitle: 'Assurance trottinette', lang: 'fr' },
  });

  // ---- Agent message ----------------------------------------------------
  await enqueue(db, {
    fromRole: 'lead-intake',
    toRole: 'lead-scorer',
    intent: 'LEAD.NEW',
    payload: { leadId: lead3.id, source: 'website' },
    correlationId: lead3.id,
    priority: 5,
  });

  return {
    customers: 2,
    leads: insertedLeads.length,
    quotes: 1,
    maxanceActions: maxanceSteps.length,
    conversationTurns: insertedTurns.length,
    customerFacts: insertedFacts.length,
    campaigns: 1,
    adsets: 1,
    ads: 2,
    creatives: 2,
    adMetricsHourly: metricsInserted,
    humanActions: 1,
    knowledgeChunks: 1,
    agentMessages: 1,
  };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  if (!process.env.PII_ENCRYPTION_KEY) {
    throw new Error('PII_ENCRYPTION_KEY not set — required for customer PII encryption');
  }

  assertSafe(url);
  assertConfirmed(process.argv.slice(2));

  const db = createDb(url);

  logger.info({ url: url.replace(/:[^:@]*@/, ':***@') }, 'seed-dev: starting');

  await truncateAll(db);
  logger.info({ tables: TABLES_TO_TRUNCATE.length }, 'seed-dev: tables truncated');

  const counts = await seedAll(db);
  logger.info({ counts }, 'seed-dev: fixtures inserted');

  logger.info('seed-dev: done');
}

main().then(
  () => {
    // postgres-js holds a pool of sockets open; close them so the CLI exits
    // promptly instead of lingering until idle_timeout.
    process.exit(0);
  },
  (err: unknown) => {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'seed-dev: failed');
    process.exit(1);
  },
);
