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

  it('matches a numeric reply preceded by a SHORT REF (#8-char) — the English group format', () => {
    // The group message footer is now "Ref: #22222222" (no full UUIDs) —
    // quoting it + "1" must disambiguate among multiple pending actions.
    const o = parseHumanActionResolution({
      ...ridaaMsg(`#22222222 1`),
      groupChatId: GROUP_ID,
      authorisedResolvers: ALLOWLIST,
      pendingActions: [sampleAction1, sampleAction2],
    }) as ResolutionMatch;
    expect(isMatch(o)).toBe(true);
    expect(o.actionId).toBe(sampleAction2.id);
    expect(o.option.id).toBe('callback');
    expect(o.matchedActionVia).toBe('short_ref');
    expect(o.matchedOptionVia).toBe('numeric');
  });

  it('returns action_not_found when the short ref matches no pending action', () => {
    const o = parseHumanActionResolution({
      ...ridaaMsg('#deadbeef 1'),
      groupChatId: GROUP_ID,
      authorisedResolvers: ALLOWLIST,
      pendingActions: [sampleAction1, sampleAction2],
    });
    if (!isMatch(o)) expect(o.reason).toBe('action_not_found');
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
    // "approuver" is the exact option label ("Approuver") → label match takes
    // precedence over the kind alias (both resolve to the same approve option).
    expect(o.matchedOptionVia).toBe('label');
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

// QUOTE_FAILED/QUOTE_STUCK-style action: two approve-kinded options whose
// labels are the only thing distinguishing them ("Retry the quote" vs "Do it
// manually"), plus a reject. Mirrors followthrough/watchdog.ts + choice-executors.
const quoteFailedAction: HumanAction = {
  ...sampleAction1,
  id: '33333333-3333-4333-8333-333333333333',
  intent: 'QUOTE_FAILED',
  options: [
    { id: 'retry', label: 'Retry the quote', kind: 'approve' },
    { id: 'manual', label: 'Do it manually', kind: 'approve' },
    { id: 'abandon', label: 'Abandon', kind: 'reject' },
  ],
  createdAt: new Date('2026-07-06T18:00:00Z'),
};

describe('parseHumanActionResolution — option-label matching (single action)', () => {
  it('matches "Retry the quote" to the retry option, not the first approve', () => {
    const o = parseHumanActionResolution({
      ...ridaaMsg('Retry the quote'),
      groupChatId: GROUP_ID,
      authorisedResolvers: ALLOWLIST,
      pendingActions: [quoteFailedAction],
    }) as ResolutionMatch;
    expect(isMatch(o)).toBe(true);
    expect(o.option.id).toBe('retry');
    expect(o.matchedOptionVia).toBe('label');
  });

  it('matches "Do it manually" to the manual option (same kind as retry)', () => {
    const o = parseHumanActionResolution({
      ...ridaaMsg('Do it manually please'),
      groupChatId: GROUP_ID,
      authorisedResolvers: ALLOWLIST,
      pendingActions: [quoteFailedAction],
    }) as ResolutionMatch;
    expect(o.option.id).toBe('manual');
    expect(o.matchedOptionVia).toBe('label');
  });
});

describe('parseHumanActionResolution — auto-target newest matching action', () => {
  it('auto-targets the QUOTE_FAILED action when the reply names its option, despite 2+ pending', () => {
    // sampleAction1 (approve/reject) + quoteFailedAction both pending, no id in
    // body. "Retry the quote" names only the QUOTE_FAILED action's option → we
    // target it instead of returning action_ambiguous (the 07-06 fall-through).
    const o = parseHumanActionResolution({
      ...ridaaMsg('Retry the quote'),
      groupChatId: GROUP_ID,
      authorisedResolvers: ALLOWLIST,
      pendingActions: [quoteFailedAction, sampleAction1],
    }) as ResolutionMatch;
    expect(isMatch(o)).toBe(true);
    expect(o.actionId).toBe(quoteFailedAction.id);
    expect(o.option.id).toBe('retry');
    expect(o.matchedActionVia).toBe('auto_target');
  });

  it('picks the NEWEST matching action when several match', () => {
    // Two QUOTE_FAILED actions, most-recent-first. "abandon" names an option in
    // both; the newest (head of the list) wins.
    const newer = { ...quoteFailedAction, id: '44444444-4444-4444-8444-444444444444' };
    const older = { ...quoteFailedAction, id: '55555555-5555-4555-8555-555555555555' };
    const o = parseHumanActionResolution({
      ...ridaaMsg('abandon'),
      groupChatId: GROUP_ID,
      authorisedResolvers: ALLOWLIST,
      pendingActions: [newer, older],
    }) as ResolutionMatch;
    expect(o.actionId).toBe(newer.id);
    expect(o.option.id).toBe('abandon');
  });

  it('still returns action_ambiguous when no pending option is named (bare "1")', () => {
    const o = parseHumanActionResolution({
      ...ridaaMsg('1'),
      groupChatId: GROUP_ID,
      authorisedResolvers: ALLOWLIST,
      pendingActions: [quoteFailedAction, sampleAction1],
    });
    if (!isMatch(o)) {
      expect(o.reason).toBe('action_ambiguous');
      expect(o.resolverPhone).toBe(RIDAA);
    }
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
