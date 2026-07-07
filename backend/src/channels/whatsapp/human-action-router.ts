/**
 * WhatsApp inbound parser for HUMAN_ACTION resolutions (option G follow-up).
 *
 * When Ridaa or Achraf reply in the configured WhatsApp group thread, this
 * module decides:
 *   1. Is this message in the human-action group? (group chat id match)
 *   2. Is the sender authorised? (phone in allowlist)
 *   3. Which action are they resolving? (UUID in body OR latest-pending fallback)
 *   4. Which option did they pick? (numeric "1"/"2" OR text "approve"/"reject"
 *      with French aliases)
 *
 * Pure functions — no DB, no WAHA, no env. The webhook handler wires this
 * to chrome.runtime.* state and persistence. Returns either a resolution
 * intent (action id + chosen option) or null if nothing matched.
 *
 * Design notes:
 *   - We DO NOT require the action ID to be in the body — operators
 *     replying "1" inline in the WhatsApp thread is the common case. We
 *     fall back to "latest pending" when there's no UUID match. If
 *     multiple actions are pending, requiring an ID is the safer policy
 *     (we return action_ambiguous so the operator gets nudged to include
 *     the ID).
 *   - Authorisation list lives in HUMAN_ACTION_AUTHORISED_RESOLVERS env
 *     (comma-separated E.164 phones). Anyone else in the group is
 *     ignored — per project_human_action_channel.md, only Ridaa + Achraf
 *     count as authoritative.
 */
import type { HumanAction, HumanActionOption } from '../../db/schema/agent-runtime.js';
import { chatIdToE164 } from './webhook-types.js';

/** UUID v4 regex — matches the action ID format we emit in the formatter. */
const UUID_REGEX = /\b([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\b/i;

/**
 * Short-ref regex — the group messages now end with `Ref: #abcdef12` (the
 * first 8 chars of the action id — see reporter-agent/humanize.ts). A quoted
 * reply carries that ref instead of a full UUID, so we match it against the
 * pending ids by prefix.
 */
const SHORT_REF_REGEX = /#([0-9a-f]{8})\b/i;

/**
 * French + English aliases mapped to canonical option `kind` values. Used
 * when the body is text rather than a number. Match is lower-cased + word-
 * boundary so "approuver le devis" still resolves to "approve".
 */
const KIND_ALIASES: ReadonlyArray<{ words: readonly RegExp[]; kind: HumanActionOption['kind'] }> = [
  {
    kind: 'approve',
    words: [/\bapprove\b/, /\bapprouver?\b/, /\boui\b/, /\byes\b/, /\bok\b/, /\bok\.?\b/],
  },
  {
    kind: 'reject',
    words: [/\breject\b/, /\brefuser?\b/, /\bnon\b/, /\bno\b/],
  },
  {
    kind: 'revise',
    words: [/\brevise\b/, /\bréviser?\b/, /\brevoir\b/, /\bedit\b/],
  },
  {
    kind: 'callback',
    words: [/\bcallback\b/, /\brappel(er)?\b/, /\bcall\b/],
  },
];

/**
 * Deterministic text→option match for auto-targeting. Given one action's
 * options and the (id-stripped) reply body, decide whether the reply clearly
 * NAMES one of the options — either by the option's own label ("Retry the
 * quote") or by a French/English kind alias ("approve"/"refuser"). Numeric is
 * deliberately excluded here: a bare "1" can't disambiguate between actions
 * whose option lists differ. Returns the matched option + how it matched, or
 * undefined when the reply doesn't clearly name any of these options.
 */
function matchOptionByText(
  options: readonly HumanActionOption[],
  strippedLower: string,
): { option: HumanActionOption; via: 'label' | 'kind_alias' } | undefined {
  // Strongest signal: the reply contains an option's exact label text. Skip
  // very short labels (< 3 chars, e.g. "OK") to avoid accidental substring hits.
  const byLabel = options.find(
    (o) => o.label && o.label.trim().length >= 3 && strippedLower.includes(o.label.toLowerCase()),
  );
  if (byLabel) return { option: byLabel, via: 'label' };
  for (const alias of KIND_ALIASES) {
    if (alias.words.some((rx) => rx.test(strippedLower))) {
      const chosen = options.find((o) => o.kind === alias.kind);
      if (chosen) return { option: chosen, via: 'kind_alias' };
    }
  }
  return undefined;
}

/** Result of a successful parse — the webhook applies this. */
export interface ResolutionMatch {
  actionId: string;
  option: HumanActionOption;
  /**
   * "uuid" | "short_ref" | "latest_pending" | "auto_target" — useful for audit
   * logs. `auto_target` = several actions were pending with no id in the body,
   * but the reply named one action's option ("Retry the quote"), so we targeted
   * the NEWEST pending action that matched instead of giving up as ambiguous.
   */
  matchedActionVia: 'uuid' | 'short_ref' | 'latest_pending' | 'auto_target';
  /** "numeric" | "kind_alias" | "label" | "freeform_revise" — same. */
  matchedOptionVia: 'numeric' | 'kind_alias' | 'label' | 'freeform_revise';
  /** Author chat id we extracted, in E.164 (e.g. "+33612345678"). */
  resolverPhone: string;
  /** Free-text feedback (the operator's own words) — set on a revise match. */
  notes?: string;
}

/** Result when the message looks like a resolution but doesn't fully match. */
export interface ResolutionFailure {
  reason:
    | 'not_human_action_group'
    | 'sender_not_authorised'
    | 'no_pending_actions'
    | 'action_not_found'
    | 'action_ambiguous'
    | 'option_not_recognised'
    | 'empty_body';
  /** Extra detail for log fields. */
  detail?: string;
  /** On 'option_not_recognised' for an authorised resolver: the resolved
   *  phone + target action id, so the caller can fall back to the LLM. */
  resolverPhone?: string;
  actionId?: string;
}

/** Either a successful match or a tagged failure. */
export type ResolutionOutcome = ResolutionMatch | ResolutionFailure;

/** Type guard: distinguish a successful match from a failure. A match always
 *  carries a chosen `option`; failures never do (even though some now carry
 *  `actionId`/`resolverPhone` for the LLM fallback). */
export function isMatch(o: ResolutionOutcome): o is ResolutionMatch {
  return (o as ResolutionMatch).option !== undefined;
}

/**
 * Parse the comma-separated `HUMAN_ACTION_AUTHORISED_RESOLVERS` env into a
 * Set<E.164>. Tolerant of whitespace + missing leading + signs ("33612…" →
 * "+33612…"). Empty string → empty Set (no one authorised — V0 / dev mode).
 */
export function parseAuthorisedResolvers(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s.startsWith('+') ? s : `+${s}`)),
  );
}

/** Inputs for the parser. Pure — no I/O. */
export interface ParseInput {
  /** The WAHA message body — what the operator typed in the group. */
  body: string;
  /** The WAHA `from` field — for group messages this is the group chat id. */
  from: string;
  /** The WAHA `author` field — individual sender's chat id, or undefined for personal chats. */
  author: string | undefined;
  /** Configured human-action group chat id (e.g. "120363012345@g.us"). */
  groupChatId: string;
  /** Configured allowlist of resolver phones in E.164 (e.g. {"+33612345678"}). */
  authorisedResolvers: Set<string>;
  /**
   * All currently-pending human_action rows (most-recent first). The parser
   * picks one based on UUID-in-body or falls back to the head of this list
   * when there's exactly one.
   */
  pendingActions: readonly HumanAction[];
}

/**
 * Decide whether this WAHA message is a human-action resolution.
 *
 * Returns:
 *   - ResolutionMatch — apply via resolveAction + emit HUMAN_ACTION.RESOLVED
 *   - ResolutionFailure — log + optionally reply in the group ("je n'ai pas
 *     compris ; réponds 1, 2, ou inclus l'ID de l'action").
 *
 * The webhook handler always returns 200 to WAHA either way — we don't want
 * WAHA retrying a malformed operator reply.
 */
export function parseHumanActionResolution(input: ParseInput): ResolutionOutcome {
  // 1. Group-membership gate.
  if (input.from !== input.groupChatId) {
    return { reason: 'not_human_action_group' };
  }

  // 2. Authorisation. `author` carries the individual sender's chat id in
  //    group messages. Convert to E.164 via the shared helper.
  if (!input.author) {
    return { reason: 'sender_not_authorised', detail: 'no_author_field' };
  }
  const resolverPhone = chatIdToE164(input.author);
  if (!resolverPhone || !input.authorisedResolvers.has(resolverPhone)) {
    return {
      reason: 'sender_not_authorised',
      detail: resolverPhone ?? input.author,
    };
  }

  // 3. Empty body — nothing to parse.
  const body = input.body.trim();
  if (body.length === 0) {
    return { reason: 'empty_body' };
  }

  // 4. Find the target action. UUID-in-body wins; then a short ref
  //    ("#abcdef12", as emitted in the group message footer) matched by id
  //    prefix; otherwise fall back to "latest pending" but only if there's
  //    exactly one.
  const uuidMatch = UUID_REGEX.exec(body);
  const shortRefMatch = SHORT_REF_REGEX.exec(body);
  let action: HumanAction | undefined;
  let matchedActionVia: 'uuid' | 'short_ref' | 'latest_pending' = 'latest_pending';
  if (uuidMatch) {
    const captured = uuidMatch[1];
    const targetId = (captured ?? '').toLowerCase();
    action = input.pendingActions.find((a) => a.id.toLowerCase() === targetId);
    if (!action) {
      return { reason: 'action_not_found', detail: targetId };
    }
    matchedActionVia = 'uuid';
  } else if (shortRefMatch) {
    const prefix = (shortRefMatch[1] ?? '').toLowerCase();
    const hits = input.pendingActions.filter((a) => a.id.toLowerCase().startsWith(prefix));
    if (hits.length === 0) {
      return { reason: 'action_not_found', detail: `#${prefix}` };
    }
    if (hits.length > 1) {
      // Freak 8-hex-char collision between two pending actions.
      return { reason: 'action_ambiguous', detail: `short_ref_collision:#${prefix}` };
    }
    const hit = hits[0];
    if (!hit) return { reason: 'action_not_found', detail: `#${prefix}` };
    action = hit;
    matchedActionVia = 'short_ref';
  } else {
    if (input.pendingActions.length === 0) {
      return { reason: 'no_pending_actions' };
    }
    if (input.pendingActions.length > 1) {
      // Several actions pending, no id in the body. Before giving up as
      // ambiguous (which drops the reply — on the sim number it even fell
      // through into the customer conversation, 07-06), try to auto-target:
      // if the reply NAMES an option ("Retry the quote"), pick the NEWEST
      // pending action that offers it. pendingActions is most-recent-first.
      const strippedLower = body
        .replace(UUID_REGEX, '')
        .replace(SHORT_REF_REGEX, '')
        .trim()
        .toLowerCase();
      for (const candidate of input.pendingActions) {
        const hit = matchOptionByText(
          candidate.options as readonly HumanActionOption[],
          strippedLower,
        );
        if (hit) {
          return {
            actionId: candidate.id,
            option: hit.option,
            matchedActionVia: 'auto_target',
            matchedOptionVia: hit.via,
            resolverPhone,
          };
        }
      }
      // Genuinely can't tell which action — surface resolverPhone so the caller
      // can log it / hand to the LLM rather than silently dropping the reply.
      return {
        reason: 'action_ambiguous',
        detail: `${input.pendingActions.length}_pending`,
        resolverPhone,
      };
    }
    const head = input.pendingActions[0];
    if (!head) return { reason: 'no_pending_actions' };
    action = head;
  }

  // 5. Match the option. Numeric first (1-indexed against the action's options).
  const options = action.options as readonly HumanActionOption[];
  const stripped = body.replace(UUID_REGEX, '').replace(SHORT_REF_REGEX, '').trim();
  const numericMatch = /^\s*(\d+)\b/.exec(stripped);
  if (numericMatch) {
    const capturedNumeric = numericMatch[1] ?? '0';
    const idx = Number.parseInt(capturedNumeric, 10) - 1;
    if (idx >= 0 && idx < options.length) {
      const chosen = options[idx];
      if (!chosen) return { reason: 'option_not_recognised', detail: `numeric:${capturedNumeric}` };
      return {
        actionId: action.id,
        option: chosen,
        matchedActionVia,
        matchedOptionVia: 'numeric',
        resolverPhone,
      };
    }
    return { reason: 'option_not_recognised', detail: `numeric:${numericMatch[1]}` };
  }

  // 6. Text — prefer an exact option-LABEL name ("Retry the quote" vs
  //    "Do it manually", both kind:approve, so the kind alias alone can't tell
  //    them apart), then fall back to French/English kind aliases.
  const lower = stripped.toLowerCase();
  const byText = matchOptionByText(options, lower);
  if (byText) {
    return {
      actionId: action.id,
      option: byText.option,
      matchedActionVia,
      matchedOptionVia: byText.via,
      resolverPhone,
    };
  }

  // 7. No deterministic match. Free-form replies ("approved", "redo the speed
  //    one…") are handled by the LLM interpreter in the webhook — the regex
  //    layer is only the fast path for "1"/"approve". We surface the
  //    authorised resolver phone so the caller can hand the message to the LLM.
  return {
    reason: 'option_not_recognised',
    detail: stripped.slice(0, 40),
    resolverPhone,
    actionId: action.id,
  };
}
