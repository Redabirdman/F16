/**
 * Pure-parser tests for the inbound human-action router (option G follow-up).
 *
 * No DB, no WAHA. ~10ms.
 */
import { describe, expect, it } from 'vitest';
import {
  parseAuthorisedResolvers,
  parseHumanActionResolution,
  isMatch,
  type ResolutionMatch,
} from '../../../src/channels/whatsapp/human-action-router.js';
import type { HumanAction } from '../../../src/db/schema/agent-runtime.js';

const GROUP_ID = '120363012345@g.us';
const RIDAA = '+33611111111';
const ACHRAF = '+33622222222';
const RANDOM = '+33699999999';
const ALLOWLIST = new Set([RIDAA, ACHRAF]);

const sampleAction1: HumanAction = {
  id: '11111111-1111-4111-8111-111111111111',
  createdByAgent: 'sales-agent#lead-1',
  intent: 'APPROVE_REFUND',
  severity: 2,
  summary: 'Refund for 49 EUR',
  options: [
    { id: 'approve', label: 'Approuver', kind: 'approve' },
    { id: 'reject', label: 'Refuser', kind: 'reject' },
  ],
  correlationId: 'lead-1',
  status: 'pending',
  dueAt: null,
  resolvedBy: null,
  resolvedSource: null,
  resolution: null,
  createdAt: new Date('2026-05-24T08:00:00Z'),
  resolvedAt: null,
  escalatedAt: null,
};

const sampleAction2: HumanAction = {
  ...sampleAction1,
  id: '22222222-2222-4222-8222-222222222222',
  intent: 'APPROVE_CALLBACK',
  options: [
    { id: 'callback', label: 'Rappeler', kind: 'callback' },
    { id: 'skip', label: 'Ignorer', kind: 'custom' },
  ],
};

function ridaaMsg(body: string): { body: string; from: string; author: string } {
  return { body, from: GROUP_ID, author: '33611111111@c.us' };
}

describe('parseAuthorisedResolvers', () => {
  it('returns empty Set on undefined / empty string', () => {
    expect(parseAuthorisedResolvers(undefined).size).toBe(0);
    expect(parseAuthorisedResolvers('').size).toBe(0);
  });
  it('parses a comma-separated list and prepends + when missing', () => {
    const set = parseAuthorisedResolvers('33611111111, +33622222222');
    expect(set.has('+33611111111')).toBe(true);
    expect(set.has('+33622222222')).toBe(true);
  });
  it('tolerates surrounding whitespace + empty entries', () => {
    const set = parseAuthorisedResolvers(' +33611111111 , , +33622222222 ,');
    expect(set.size).toBe(2);
  });
});

describe('parseHumanActionResolution — gates', () => {
  it('returns not_human_action_group when `from` is not the configured chat', () => {
    const o = parseHumanActionResolution({
      body: '1',
      from: 'someone-else@c.us',
      author: '33611111111@c.us',
      groupChatId: GROUP_ID,
      authorisedResolvers: ALLOWLIST,
      pendingActions: [sampleAction1],
    });
    expect(isMatch(o)).toBe(false);
    if (!isMatch(o)) expect(o.reason).toBe('not_human_action_group');
  });

  it('returns sender_not_authorised when author is missing', () => {
    const o = parseHumanActionResolution({
      body: '1',
      from: GROUP_ID,
      author: undefined,
      groupChatId: GROUP_ID,
      authorisedResolvers: ALLOWLIST,
      pendingActions: [sampleAction1],
    });
    if (!isMatch(o)) expect(o.reason).toBe('sender_not_authorised');
  });

  it('returns sender_not_authorised when author is not on the allowlist', () => {
    const o = parseHumanActionResolution({
      body: '1',
      from: GROUP_ID,
      author: '33699999999@c.us',
      groupChatId: GROUP_ID,
      authorisedResolvers: ALLOWLIST,
      pendingActions: [sampleAction1],
    });
    if (!isMatch(o)) {
      expect(o.reason).toBe('sender_not_authorised');
      expect(o.detail).toBe(RANDOM);
    }
  });

  it('returns empty_body on whitespace-only body', () => {
    const o = parseHumanActionResolution({
      ...ridaaMsg('   \n  '),
      groupChatId: GROUP_ID,
      authorisedResolvers: ALLOWLIST,
      pendingActions: [sampleAction1],
    });
    if (!isMatch(o)) expect(o.reason).toBe('empty_body');
  });

  it('returns no_pending_actions when there is nothing pending and no UUID in body', () => {
    const o = parseHumanActionResolution({
      ...ridaaMsg('1'),
      groupChatId: GROUP_ID,
      authorisedResolvers: ALLOWLIST,
      pendingActions: [],
    });
    if (!isMatch(o)) expect(o.reason).toBe('no_pending_actions');
  });

  it('returns action_ambiguous when 2+ pending without UUID hint', () => {
    const o = parseHumanActionResolution({
      ...ridaaMsg('1'),
      groupChatId: GROUP_ID,
      authorisedResolvers: ALLOWLIST,
      pendingActions: [sampleAction1, sampleAction2],
    });
    if (!isMatch(o)) {
      expect(o.reason).toBe('action_ambiguous');
      expect(o.detail).toBe('2_pending');
    }
  });

  it('returns action_not_found when the UUID in the body matches no pending row', () => {
    const o = parseHumanActionResolution({
      ...ridaaMsg('1 33333333-3333-4333-8333-333333333333'),
      groupChatId: GROUP_ID,
      authorisedResolvers: ALLOWLIST,
      pendingActions: [sampleAction1],
    });
    if (!isMatch(o)) expect(o.reason).toBe('action_not_found');
  });
});

describe('parseHumanActionResolution — numeric matches', () => {
  it('matches "1" to the first option when exactly one pending', () => {
    const o = parseHumanActionResolution({
      ...ridaaMsg('1'),
      groupChatId: GROUP_ID,
      authorisedResolvers: ALLOWLIST,
      pendingActions: [sampleAction1],
    }) as ResolutionMatch;
    expect(isMatch(o)).toBe(true);
    expect(o.actionId).toBe(sampleAction1.id);
    expect(o.option.id).toBe('approve');
    expect(o.matchedActionVia).toBe('latest_pending');
    expect(o.matchedOptionVia).toBe('numeric');
    expect(o.resolverPhone).toBe(RIDAA);
  });

  it('matches "2" to the second option', () => {
    const o = parseHumanActionResolution({
      ...ridaaMsg('2'),
      groupChatId: GROUP_ID,
      authorisedResolvers: ALLOWLIST,
      pendingActions: [sampleAction1],
    }) as ResolutionMatch;
    expect(o.option.id).toBe('reject');
  });

  it('matches a numeric reply preceded by a UUID — disambiguates among multiple pending', () => {
    const o = parseHumanActionResolution({
      ...ridaaMsg(`${sampleAction2.id} 1`),
      groupChatId: GROUP_ID,
      authorisedResolvers: ALLOWLIST,
      pendingActions: [sampleAction1, sampleAction2],
    }) as ResolutionMatch;
    expect(o.actionId).toBe(sampleAction2.id);
    expect(o.option.id).toBe('callback');
    expect(o.matchedActionVia).toBe('uuid');
  });

  it('returns option_not_recognised when numeric is out of bounds', () => {
    const o = parseHumanActionResolution({
      ...ridaaMsg('9'),
      groupChatId: GROUP_ID,
      authorisedResolvers: ALLOWLIST,
      pendingActions: [sampleAction1],
    });
    if (!isMatch(o)) {
      expect(o.reason).toBe('option_not_recognised');
      expect(o.detail).toBe('numeric:9');
    }
  });
});

describe('parseHumanActionResolution — kind aliases', () => {
  it('matches "approuver" → approve', () => {
    const o = parseHumanActionResolution({
      ...ridaaMsg('approuver'),
      groupChatId: GROUP_ID,
      authorisedResolvers: ALLOWLIST,
      pendingActions: [sampleAction1],
    }) as ResolutionMatch;
    expect(o.option.id).toBe('approve');
    expect(o.matchedOptionVia).toBe('kind_alias');
  });

  it('matches "oui" → approve', () => {
    const o = parseHumanActionResolution({
      ...ridaaMsg('oui'),
      groupChatId: GROUP_ID,
      authorisedResolvers: ALLOWLIST,
      pendingActions: [sampleAction1],
    }) as ResolutionMatch;
    expect(o.option.kind).toBe('approve');
  });

  it('matches "non" → reject', () => {
    const o = parseHumanActionResolution({
      ...ridaaMsg('non'),
      groupChatId: GROUP_ID,
      authorisedResolvers: ALLOWLIST,
      pendingActions: [sampleAction1],
    }) as ResolutionMatch;
    expect(o.option.kind).toBe('reject');
  });

  it('matches "rappeler" → callback on the callback-kinded action', () => {
    const o = parseHumanActionResolution({
      ...ridaaMsg(`rappeler ${sampleAction2.id}`),
      groupChatId: GROUP_ID,
      authorisedResolvers: ALLOWLIST,
      pendingActions: [sampleAction1, sampleAction2],
    }) as ResolutionMatch;
    expect(o.actionId).toBe(sampleAction2.id);
    expect(o.option.kind).toBe('callback');
  });

  it("returns option_not_recognised when the body doesn't match any alias", () => {
    const o = parseHumanActionResolution({
      ...ridaaMsg('peut-être plus tard'),
      groupChatId: GROUP_ID,
      authorisedResolvers: ALLOWLIST,
      pendingActions: [sampleAction1],
    });
    if (!isMatch(o)) expect(o.reason).toBe('option_not_recognised');
  });
});

describe('parseHumanActionResolution — Achraf as resolver', () => {
  it('accepts Achraf and reports his phone as resolver', () => {
    const o = parseHumanActionResolution({
      body: '1',
      from: GROUP_ID,
      author: '33622222222@c.us',
      groupChatId: GROUP_ID,
      authorisedResolvers: ALLOWLIST,
      pendingActions: [sampleAction1],
    }) as ResolutionMatch;
    expect(o.resolverPhone).toBe(ACHRAF);
  });
});
