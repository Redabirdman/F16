/**
 * Pure-function tests for the Reporter Agent formatters (option G).
 *
 * No DB, no WAHA, no network. ~10ms.
 */
import { describe, expect, it } from 'vitest';
import {
  formatHumanActionRequest,
  formatHumanActionResolved,
  formatOptionsBlock,
  intentLabel,
  severityBadge,
} from '../../../src/agents/reporter-agent/format.js';
import type { HumanAction } from '../../../src/db/schema/agent-runtime.js';

const baseAction: HumanAction = {
  id: '11111111-1111-4111-8111-111111111111',
  createdByAgent: 'sales-agent#lead-1234',
  intent: 'APPROVE_REFUND',
  severity: 2,
  summary: 'Le client demande un remboursement complet de 49 €.',
  options: [
    { id: 'approve', label: 'Approuver', kind: 'approve' },
    { id: 'reject', label: 'Refuser', kind: 'reject' },
  ],
  correlationId: 'lead-1234',
  status: 'pending',
  dueAt: null,
  resolvedBy: null,
  resolvedSource: null,
  resolution: null,
  createdAt: new Date('2026-05-23T20:30:00Z'),
  resolvedAt: null,
  escalatedAt: null,
};

describe('severityBadge', () => {
  it('returns red for critical (1)', () => {
    const b = severityBadge(1);
    expect(b.glyph).toBe('🔴');
    expect(b.label).toBe('CRITIQUE');
  });
  it('returns yellow for standard (2)', () => {
    expect(severityBadge(2).glyph).toBe('🟡');
  });
  it('returns green for info (3)', () => {
    expect(severityBadge(3).glyph).toBe('🟢');
  });
});

describe('formatOptionsBlock', () => {
  it('numbers the options 1-indexed', () => {
    const text = formatOptionsBlock([
      { id: 'approve', label: 'Approuver', kind: 'approve' },
      { id: 'reject', label: 'Refuser', kind: 'reject' },
    ]);
    expect(text).toContain('1. Approuver');
    expect(text).toContain('2. Refuser');
  });
  it('returns null when options are empty', () => {
    expect(formatOptionsBlock([])).toBeNull();
  });
  it('renders only the human label — never the raw kind', () => {
    const text = formatOptionsBlock([
      { id: 'a', label: 'Approuver', kind: 'approve' },
      { id: 'r', label: 'Refuser', kind: 'reject' },
    ]);
    expect(text).toContain('1. Approuver');
    expect(text).toContain('2. Refuser');
    // The internal kind must NOT leak into the operator message (it confused
    // operators — a list could even show "(approve)" twice).
    expect(text).not.toContain('(approve)');
    expect(text).not.toContain('(reject)');
  });
});

describe('formatHumanActionRequest', () => {
  it('renders the severity badge + intent in the header', () => {
    const text = formatHumanActionRequest(baseAction);
    expect(text).toMatch(/^🟡 \*À VALIDER\* — APPROVE_REFUND/);
  });
  it('includes the summary verbatim', () => {
    const text = formatHumanActionRequest(baseAction);
    expect(text).toContain('Le client demande un remboursement complet de 49 €.');
  });
  it('renders the numbered options block', () => {
    const text = formatHumanActionRequest(baseAction);
    expect(text).toContain('Réponds avec le numéro');
    expect(text).toContain('1. Approuver');
    expect(text).toContain('2. Refuser');
  });
  it('does NOT leak the correlation id (lead/campaign UUID) into the message', () => {
    // The old "Réf : <correlationId>" line was dropped — it was a confusing
    // second UUID and a reply-routing hazard (the parser grabs the first UUID).
    const text = formatHumanActionRequest(baseAction);
    expect(text).not.toContain('lead-1234');
    expect(text).not.toContain('Réf : ');
  });
  it('always includes the action ID at the bottom for parser fallback', () => {
    const text = formatHumanActionRequest(baseAction);
    expect(text).toContain(`ID : ${baseAction.id}`);
  });
  it('skips the options block when options array is empty', () => {
    const text = formatHumanActionRequest({ ...baseAction, options: [] });
    expect(text).not.toContain('Réponds avec le numéro');
    // Header + summary + ID still rendered.
    expect(text).toContain('À VALIDER');
    expect(text).toContain(baseAction.summary);
    expect(text).toContain(`ID : ${baseAction.id}`);
  });
  it('uses the red glyph for severity 1', () => {
    const text = formatHumanActionRequest({ ...baseAction, severity: 1 });
    expect(text).toContain('🔴');
    expect(text).toContain('CRITIQUE');
  });
});

describe('formatHumanActionResolved', () => {
  it('renders a human admin-source closure — option label + French intent, no UUID/kind', () => {
    const text = formatHumanActionResolved({
      intent: 'LEAD_DORMANT',
      optionLabel: 'Reprendre contact manuellement',
      kind: 'approve',
      source: 'admin',
    });
    expect(text).toContain('✅');
    expect(text).toContain('Lead en sommeil'); // French intent label, not the raw code
    expect(text).toContain('Validé');
    expect(text).toContain("l'admin");
    expect(text).toContain('Reprendre contact manuellement'); // the human option label
    // No raw UUID, no raw kind word.
    expect(text).not.toContain(baseAction.id);
    expect(text).not.toContain('approve');
  });
  it('renders a whatsapp-source rejection with the right verb', () => {
    const text = formatHumanActionResolved({
      intent: 'LEAD_DORMANT',
      optionLabel: 'Clôturer (lead perdu)',
      kind: 'reject',
      source: 'whatsapp',
    });
    expect(text).toContain('WhatsApp');
    expect(text).toContain('Refusé');
    expect(text).toContain('Clôturer (lead perdu)');
    expect(text).not.toContain('reject');
  });
});

describe('intentLabel', () => {
  it('maps known intent codes to French labels', () => {
    expect(intentLabel('LEAD_DORMANT')).toBe('Lead en sommeil');
    expect(intentLabel('CAMPAIGN_LAUNCH_FAILED')).toBe('Lancement de campagne échoué');
  });
  it('falls back to the raw code for unknown intents', () => {
    expect(intentLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
});
