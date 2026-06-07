/**
 * Meta lead-form → F16 intake mapping (M12).
 *
 * Translates a normalized `LeadgenData` (from the Graph client) into the
 * `LeadIntakePayload` the existing `ingestLead` flow consumes, plus the M12
 * extras: the contact preferences and the full attribution chain.
 *
 * Field matching is deliberately tolerant. Meta instant-form field `name`s are
 * either the standard keys (`full_name`, `email`, `phone_number`) or the
 * custom keys we set when building the form (`preferred_channel`,
 * `preferred_time`). To survive a hand-edited form we ALSO fuzzy-match on
 * French/English substrings, so a question keyed `canal_de_contact` still maps.
 *
 * No network, no DB — pure transformation, exhaustively unit-testable.
 */
import type { LeadgenData } from '../integrations/meta/client.js';
import type { LeadIntakePayload } from './intake.js';

export type PreferredChannel = 'whatsapp' | 'call';
export type PreferredTime = 'maintenant' | 'matin' | 'apres_midi' | 'soir';

/** Local hour (Europe/Paris) each non-"maintenant" window maps to. */
const WINDOW_HOUR: Record<Exclude<PreferredTime, 'maintenant'>, number> = {
  matin: 9,
  apres_midi: 14,
  soir: 18,
};

const PARIS_TZ = 'Europe/Paris';

/** Normalize a field name/value for substring matching (lowercase, no accents). */
function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

function findField(lead: LeadgenData, matchers: ((name: string) => boolean)[]): string | null {
  for (const entry of lead.fieldData) {
    const n = norm(entry.name);
    if (matchers.some((m) => m(n))) {
      const v = entry.values.find((x) => x && x.trim().length > 0);
      if (v) return v.trim();
    }
  }
  return null;
}

export function parsePreferredChannel(value: string | null): PreferredChannel | null {
  if (!value) return null;
  const v = norm(value);
  if (v.includes('whatsapp') || v.includes('wa') || v.includes('message')) return 'whatsapp';
  if (v.includes('appel') || v.includes('call') || v.includes('telephone') || v.includes('phone'))
    return 'call';
  return null;
}

export function parsePreferredTime(value: string | null): PreferredTime | null {
  if (!value) return null;
  const v = norm(value);
  if (v.includes('maintenant') || v.includes('now') || v.includes('immediat')) return 'maintenant';
  if (v.includes('matin') || v.includes('morning')) return 'matin';
  // "après-midi" normalizes to "apres-midi" / "apres midi".
  if (v.includes('apres') || v.includes('midi') || v.includes('afternoon')) return 'apres_midi';
  if (v.includes('soir') || v.includes('evening')) return 'soir';
  return null;
}

/** Wall-clock parts of `date` in a given IANA timezone. */
function zonedParts(
  date: Date,
  tz: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) map[p.type] = p.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    // Intl can emit hour '24' at midnight in some engines — coerce to 0.
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/** Offset (ms) of `tz` vs UTC at the instant `date`. */
function tzOffsetMs(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - date.getTime();
}

/** UTC `Date` for a Europe/Paris wall-clock time (DST-correct to the minute). */
function parisWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  now: Date,
): Date {
  const guessUtc = Date.UTC(year, month - 1, day, hour, 0, 0);
  // Use the offset near the target instant (one correction step is enough for
  // hour-granularity scheduling; sub-minute DST edges don't matter here).
  const offset = tzOffsetMs(new Date(guessUtc), PARIS_TZ) || tzOffsetMs(now, PARIS_TZ);
  return new Date(guessUtc - offset);
}

/**
 * Compute when to place the callback for a `call` lead.
 *   - 'maintenant'  → `now` (the scheduler dials on its next tick, ~1 min).
 *   - matin/apres_midi/soir → the NEXT occurrence of that Europe/Paris slot
 *     start (today if still ahead, otherwise tomorrow).
 *
 * `now` is injectable for deterministic tests.
 */
export function computeCallbackDueAt(window: PreferredTime, now: Date = new Date()): Date {
  if (window === 'maintenant') return new Date(now.getTime());
  const targetHour = WINDOW_HOUR[window];
  const p = zonedParts(now, PARIS_TZ);
  let candidate = parisWallTimeToUtc(p.year, p.month, p.day, targetHour, now);
  if (candidate.getTime() <= now.getTime()) {
    // Slot already passed today → roll to tomorrow (UTC-day add is safe; we
    // re-derive the Paris wall time from the rolled date).
    const tomorrow = new Date(now.getTime() + 24 * 3600_000);
    const tp = zonedParts(tomorrow, PARIS_TZ);
    candidate = parisWallTimeToUtc(tp.year, tp.month, tp.day, targetHour, tomorrow);
  }
  return candidate;
}

export interface MapLeadgenOptions {
  /** Product line the campaign targets. V1: 'scooter' (trottinette). */
  productLine: 'scooter' | 'car';
}

/**
 * Map a Meta lead submission to the intake payload. Pulls name/email/phone +
 * the two preference questions, and records the full attribution chain so the
 * funnel can tie spend → revenue later.
 */
export function mapLeadgenToIntake(lead: LeadgenData, opts: MapLeadgenOptions): LeadIntakePayload {
  const fullName =
    findField(lead, [
      (n) => n === 'full_name' || n.includes('full name') || n.includes('nom complet'),
    ]) ??
    joinName(
      findField(lead, [(n) => n.includes('first') || n.includes('prenom')]),
      findField(lead, [(n) => n.includes('last') || (n.includes('nom') && !n.includes('prenom'))]),
    );

  const email = findField(lead, [
    (n) => n.includes('email') || n.includes('courriel') || n.includes('mail'),
  ]);
  const phone = findField(lead, [
    (n) =>
      n.includes('phone') || n.includes('telephone') || n.includes('tel') || n.includes('mobile'),
  ]);

  const channelRaw = findField(lead, [
    (n) =>
      n.includes('channel') ||
      n.includes('canal') ||
      n.includes('contact') ||
      n.includes('joindre'),
  ]);
  const timeRaw = findField(lead, [
    (n) =>
      n.includes('time') ||
      n.includes('moment') ||
      n.includes('heure') ||
      n.includes('creneau') ||
      n.includes('disponib') ||
      n.includes('quand'),
  ]);

  const preferredChannel = parsePreferredChannel(channelRaw);
  const preferredTime = parsePreferredTime(timeRaw);

  const attribution: Record<string, unknown> = {
    campaignId: lead.campaignId,
    campaignName: lead.campaignName,
    adsetId: lead.adsetId,
    adsetName: lead.adsetName,
    adId: lead.adId,
    adName: lead.adName,
    formId: lead.formId,
    platform: lead.platform,
    leadgenId: lead.id,
    createdTime: lead.createdTime,
  };

  return {
    source: 'meta',
    sourceId: lead.formId ?? lead.id,
    productLine: opts.productLine,
    ...(fullName ? { fullName } : {}),
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    metaLeadgenId: lead.id,
    attribution,
    ...(preferredChannel ? { preferredChannel } : {}),
    ...(preferredTime ? { preferredTime } : {}),
    // Keep the raw answers for audit + the Lead Scorer's context.
    formAnswers: Object.fromEntries(lead.fieldData.map((f) => [f.name, f.values])),
    raw: lead.raw,
  };
}

function joinName(first: string | null, last: string | null): string | null {
  const parts = [first, last].filter((p): p is string => Boolean(p && p.trim()));
  return parts.length > 0 ? parts.join(' ') : null;
}
