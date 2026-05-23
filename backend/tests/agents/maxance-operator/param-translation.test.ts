/**
 * Param-translation tests for MaxanceOperatorAgent (M8.T4).
 *
 * Pure unit tests on the `toQuoteParams` private — we expose it via a test
 * subclass since it's the most fail-prone piece of the agent and the
 * dispatcher-wired integration test path is expensive (needs DB).
 *
 * No DB, no Redis, no Stagehand, no fetch. Each case asserts the
 * formData → MaxanceQuoteParams translation surface.
 */
import { describe, expect, it } from 'vitest';
import { MaxanceOperatorAgent } from '../../../src/agents/maxance-operator/agent.js';
import { StagehandClient } from '../../../src/agents/maxance-operator/stagehand-client.js';
import type { Database } from '../../../src/db/index.js';

/** Test subclass that exposes the protected `toQuoteParams` helper. */
class TestableOperator extends MaxanceOperatorAgent {
  /** Bridge to the otherwise-private helper. */
  public translate(
    formData: Record<string, unknown>,
  ): ReturnType<MaxanceOperatorAgent['onMessage']> {
    // Note: this is a tiny wrapper; the actual helper is on `this`.
    // We're forced through `unknown` because the helper is private.
    const self = this as unknown as { toQuoteParams: (f: Record<string, unknown>) => unknown };
    return self.toQuoteParams(formData) as never;
  }
}

function newAgent(): TestableOperator {
  // db is unused for toQuoteParams; cast to satisfy BaseAgent's constructor.
  return new TestableOperator(
    {
      role: 'maxance-operator',
      instanceId: 'test',
      model: 'sonnet',
      queues: ['quote'],
      db: {} as unknown as Database,
    },
    { client: new StagehandClient({ baseUrl: 'http://stagehand.test' }) },
  );
}

describe('MaxanceOperatorAgent.toQuoteParams — happy path', () => {
  it('translates a minimal valid formData', () => {
    const op = newAgent();
    const params = op.translate({
      purchasePriceEur: 350,
      purchaseDate: '2026-01-15T00:00:00Z',
      postalCode: '75001',
      stationnement: 'garage_box',
      clientDateOfBirth: '1990-06-12T00:00:00Z',
    });
    expect(params).toMatchObject({
      vehicleKind: 'trottinette',
      purchasePriceEur: 350,
      postalCode: '75001',
      stationnement: 'garage_box',
    });
  });

  it('passes through optional fields when present', () => {
    const op = newAgent();
    const params = op.translate({
      purchasePriceEur: 600,
      purchaseDate: '2026-01-15',
      postalCode: '75001',
      stationnement: 'parking_prive_clos',
      clientDateOfBirth: '1990-06-12',
      city: 'PARIS 01',
      formule: 'vol_incendie',
      commissionPct: 15,
      fractionnement: 'annuel',
    });
    expect(params).toMatchObject({
      city: 'PARIS 01',
      formule: 'vol_incendie',
      commissionPct: 15,
      fractionnement: 'annuel',
    });
  });

  it('drops optional fields that are wrong-shape (e.g. unknown formule)', () => {
    const op = newAgent();
    const params = op.translate({
      purchasePriceEur: 350,
      purchaseDate: '2026-01-15',
      postalCode: '75001',
      stationnement: 'rue',
      clientDateOfBirth: '1990-06-12',
      formule: 'gibberish',
      fractionnement: 'weekly', // not in enum
      commissionPct: 'high', // not a number
    });
    expect((params as { formule?: string }).formule).toBeUndefined();
    expect((params as { fractionnement?: string }).fractionnement).toBeUndefined();
    expect((params as { commissionPct?: number }).commissionPct).toBeUndefined();
  });
});

describe('MaxanceOperatorAgent.toQuoteParams — validation failures', () => {
  const valid = {
    purchasePriceEur: 350,
    purchaseDate: '2026-01-15',
    postalCode: '75001',
    stationnement: 'garage_box',
    clientDateOfBirth: '1990-06-12',
  };

  it.each([
    ['purchasePriceEur missing', { ...valid, purchasePriceEur: undefined }],
    ['purchasePriceEur not a number', { ...valid, purchasePriceEur: 'foo' }],
    ['purchaseDate missing', { ...valid, purchaseDate: undefined }],
    ['postalCode empty string', { ...valid, postalCode: '' }],
    ['clientDateOfBirth missing', { ...valid, clientDateOfBirth: undefined }],
    ['stationnement out-of-enum', { ...valid, stationnement: 'rooftop' }],
  ])('throws on %s', (_label, bad) => {
    const op = newAgent();
    expect(() => op.translate(bad as Record<string, unknown>)).toThrow();
  });
});
