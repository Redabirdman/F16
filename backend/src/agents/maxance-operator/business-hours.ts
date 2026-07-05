/**
 * Maxance portal business window (2026-07-05, Ridaa's heads-up).
 *
 * The Proximéo extranet is SHUT DOWN outside business hours: closed every
 * day 20:00–08:00 Moroccan time, and closed all Saturday + Sunday. Any
 * quote/confirm flow launched in the closed window fails fast with
 * `login_failed:maxance_extension_no_active_tab` — so the tools park the
 * work as a DELAYED job until the next opening and tell the customer the
 * honest window ("votre devis arrive lundi matin"), per Ridaa's call.
 *
 * Timezone: Africa/Casablanca (UTC+1 year-round save Ramadan shifts — we
 * read wall-clock hour via Intl, so DST games are Morocco's problem, not
 * ours). Same Intl approach as the engagement quiet-hours helper.
 *
 * Env overrides (integers, wall-clock hours in the portal TZ):
 *   MAXANCE_HOURS_OPEN  (default 8)   MAXANCE_HOURS_CLOSE (default 20)
 *   MAXANCE_HOURS_TZ    (default Africa/Casablanca)
 *   MAXANCE_HOURS_247=1 disables the gate entirely (harness/testing).
 */

const DEFAULT_TZ = 'Africa/Casablanca';

function openHour(): number {
  const v = Number(process.env.MAXANCE_HOURS_OPEN);
  return Number.isInteger(v) && v >= 0 && v < 24 ? v : 8;
}

function closeHour(): number {
  const v = Number(process.env.MAXANCE_HOURS_CLOSE);
  return Number.isInteger(v) && v > 0 && v <= 24 ? v : 20;
}

function tz(): string {
  return process.env.MAXANCE_HOURS_TZ || DEFAULT_TZ;
}

interface WallClock {
  /** 1 = Monday … 7 = Sunday (ISO). */
  isoWeekday: number;
  hour: number;
  minute: number;
}

function wallClock(now: Date): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz(),
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const dayMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    isoWeekday: dayMap[get('weekday')] ?? 1,
    // Intl can emit "24" for midnight with hour12:false in some engines.
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
  };
}

/** Is the Maxance portal reachable right now? */
export function isMaxanceOpen(now: Date = new Date()): boolean {
  if (process.env.MAXANCE_HOURS_247 === '1') return true;
  const wc = wallClock(now);
  if (wc.isoWeekday >= 6) return false; // Sat/Sun
  return wc.hour >= openHour() && wc.hour < closeHour();
}

/**
 * Milliseconds until the next portal opening (0 when open now). Walks
 * hour-by-hour from `now` — at most 60h of steps (Fri 20:00 → Mon 08:00),
 * trivially cheap and immune to TZ-offset arithmetic mistakes.
 */
export function msUntilMaxanceOpen(now: Date = new Date()): number {
  if (isMaxanceOpen(now)) return 0;
  // Jump to the top of the next hour, then hour-step until open.
  let t = new Date(now);
  t.setMinutes(0, 0, 0);
  for (let i = 0; i < 96; i += 1) {
    t = new Date(t.getTime() + 3_600_000);
    if (isMaxanceOpen(t)) return t.getTime() - now.getTime();
  }
  // Unreachable with sane env values; fail open with a 1h delay.
  return 3_600_000;
}

/**
 * Customer-facing French phrase for when the quote will arrive. Approved
 * wording (2026-07-05): honest window, no hard time promise beyond the
 * opening. Examples: "demain matin (à partir de 8h)", "lundi matin
 * (à partir de 8h)", "ce soir" never happens (portal opens mornings only).
 */
export function describeMaxanceReopening(now: Date = new Date()): string {
  const opening = new Date(now.getTime() + msUntilMaxanceOpen(now));
  const nowDay = wallClock(now).isoWeekday;
  const openDay = wallClock(opening).isoWeekday;
  const h = `${openHour()}h`;
  if (nowDay === openDay) return `ce matin à partir de ${h}`;
  const dayNames: Record<number, string> = {
    1: 'lundi',
    2: 'mardi',
    3: 'mercredi',
    4: 'jeudi',
    5: 'vendredi',
    6: 'samedi',
    7: 'dimanche',
  };
  const tomorrow = nowDay === 7 ? 1 : nowDay + 1;
  if (openDay === tomorrow) return `demain matin (à partir de ${h})`;
  return `${dayNames[openDay]} matin (à partir de ${h})`;
}
