/**
 * Quiet-hours helper for the Customer Engagement Agent (M11).
 *
 * Locked design: no outbound between 21:00 and 08:00 Europe/Paris, and no
 * outbound on Saturdays or Sundays Europe/Paris. The engagement scheduler
 * + agent both consult this — the scheduler so we don't churn enqueuing
 * ticks that the agent will immediately skip, the agent as the actual gate.
 *
 * We use `Intl.DateTimeFormat('fr-FR', {timeZone: 'Europe/Paris'})` to read
 * the local hour + weekday — sidesteps DST math (CET/CEST) and avoids
 * pulling in a heavyweight tz library for one timezone.
 */

/** Locked policy constants. Change here, not at call sites. */
export const QUIET_START_HOUR_PARIS = 21; // 21:00 inclusive (no sends from 21:00)
export const QUIET_END_HOUR_PARIS = 8; // 08:00 exclusive (sends resume at 08:00)
const PARIS_TZ = 'Europe/Paris';

/** Components extracted in Europe/Paris. Exported for testability. */
export interface ParisDateParts {
  /** 0–23 hour in Europe/Paris. */
  hour: number;
  /** ISO weekday 1 (Monday) … 7 (Sunday). */
  isoWeekday: number;
}

/**
 * Extract the hour + ISO weekday of `at` in Europe/Paris. Uses a single
 * `Intl.DateTimeFormat` configured for the right fields; cheap enough to
 * call once per scheduler tick / per candidate.
 */
export function parisParts(at: Date): ParisDateParts {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: PARIS_TZ,
    hour: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = fmt.formatToParts(at);
  const hourStr = parts.find((p) => p.type === 'hour')?.value ?? '0';
  // `hour: '2-digit'` returns '24' at midnight in some Node versions instead
  // of '00'. Normalize so downstream comparisons stay sane.
  const hourRaw = Number.parseInt(hourStr, 10);
  const hour = hourRaw === 24 ? 0 : hourRaw;
  const weekdayShort = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  // 'en-GB' short weekdays: 'Mon','Tue','Wed','Thu','Fri','Sat','Sun'.
  const isoWeekday = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[weekdayShort] ?? 1;
  return { hour, isoWeekday };
}

/**
 * Return true when `at` falls inside a quiet window — either weekend
 * (Saturday/Sunday Europe/Paris) or weeknight (21:00–08:00 Europe/Paris).
 *
 * Boundary discipline:
 *   - 21:00 IS quiet (>=21).
 *   - 08:00 is NOT quiet (>=8 OK).
 *   - 07:59 IS quiet.
 *   The "no sends after 21:00 until 08:00 the next day" wording matches.
 */
export function isQuietNow(at: Date = new Date()): boolean {
  const { hour, isoWeekday } = parisParts(at);
  // Weekend: ISO 6 = Saturday, 7 = Sunday — both quiet all day.
  if (isoWeekday === 6 || isoWeekday === 7) return true;
  // Weeknight quiet window: hour ∈ [21,24) ∪ [0,8).
  if (hour >= QUIET_START_HOUR_PARIS) return true;
  if (hour < QUIET_END_HOUR_PARIS) return true;
  return false;
}
