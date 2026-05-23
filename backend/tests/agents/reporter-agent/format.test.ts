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
  updatedAt: new Date('2026-05-23T20:30:00Z'),
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
  it('annotates kind for non-custom options', () => {
    const text = formatOptionsBlock([{ id: 'a', label: 'Approuver', kind: 'approve' }]);
    expect(text).toContain('(approve)');
  });
  it('omits the kind annotation for custom options', () => {
    const text = formatOptionsBlock([{ id: 'choice1', label: 'Option spéciale', kind: 'custom' }]);
    expect(text).toContain('Option spéciale');
    expect(text).not.toContain('(custom)');
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
  it('includes the correlation reference when present', () => {
    const text = formatHumanActionRequest(baseAction);
    expect(text).toContain('Réf : lead-1234');
  });
  it('omits the correlation line when correlationId is null', () => {
    const text = formatHumanActionRequest({ ...baseAction, correlationId: null });
    expect(text).not.toContain('Réf :');
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
  it('renders an admin-source closure', () => {
    const text = formatHumanActionResolved({
      humanActionId: baseAction.id,
      choice: 'approve',
      source: 'admin',
    });
    expect(text).toContain('✅');
    expect(text).toContain(baseAction.id);
    expect(text).toContain('admin');
    expect(text).toContain('approve');
  });
  it('renders a whatsapp-source closure', () => {
    const text = formatHumanActionResolved({
      humanActionId: baseAction.id,
      choice: 'reject',
      source: 'whatsapp',
    });
    expect(text).toContain('WhatsApp');
    expect(text).toContain('reject');
  });
});
