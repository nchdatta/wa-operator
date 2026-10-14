/**
 * Schedule times in the business time zone. Every rule is "at HH:MM local time" on matching days,
 * so daylight-saving changes keep the wall-clock time.
 */

export type Repeat = 'once' | 'daily' | 'weekly' | 'monthly';

export interface Rule {
  repeat: Repeat;
  /** HH:MM, 24-hour. */
  time: string;
  /** once: YYYY-MM-DD. weekly: "0,3" (Sunday = 0). monthly: "15" (31 means the last day). */
  on?: string | null;
}

const DAY = 86_400_000;

/** Offset of `timeZone` from UTC at instant `ts`, in ms. */
function offsetMs(ts: number, timeZone: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(new Date(ts))
      .map((x) => [x.type, Number(x.value)]),
  ) as Record<string, number>;
  const local = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return local - Math.floor(ts / 1000) * 1000;
}

/** The instant of local wall-clock time y-m-d hh:mm in `timeZone`. */
export function zonedTime(y: number, m: number, d: number, hh: number, mm: number, timeZone: string): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - offsetMs(guess, timeZone);
  const second = guess - offsetMs(first, timeZone);
  return second;
}

/** Local calendar date at `ts`. */
export function localDate(ts: number, timeZone: string): { y: number; m: number; d: number } {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(ts))
    .split('-')
    .map(Number);
  return { y: y!, m: m!, d: d! };
}

export function parseTime(time: string): { hh: number; mm: number } | null {
  const t = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!t) return null;
  const hh = Number(t[1]);
  const mm = Number(t[2]);
  return hh < 24 && mm < 60 ? { hh, mm } : null;
}

/** Why a rule is invalid, or null if it is fine. */
export function checkRule(r: Rule): string | null {
  if (!parseTime(r.time)) return 'time must be HH:MM (24-hour)';
  const on = (r.on ?? '').trim();
  switch (r.repeat) {
    case 'once':
      return /^\d{4}-\d{2}-\d{2}$/.test(on) ? null : 'a one-time schedule needs a date (YYYY-MM-DD)';
    case 'weekly':
      return on && on.split(',').every((x) => /^[0-6]$/.test(x.trim()))
        ? null
        : 'weekly needs days as numbers 0-6 (Sunday = 0), e.g. "0,3"';
    case 'monthly':
      return /^\d{1,2}$/.test(on) && Number(on) >= 1 && Number(on) <= 31 ? null : 'monthly needs a day 1-31';
    case 'daily':
      return null;
  }
}

/** The next time the rule fires strictly after `after`, or null (a one-time rule in the past). */
export function nextRun(r: Rule, after: number, timeZone: string): number | null {
  const t = parseTime(r.time);
  if (!t || checkRule(r)) return null;
  const on = (r.on ?? '').trim();
  if (r.repeat === 'once') {
    const [y, m, d] = on.split('-').map(Number);
    const at = zonedTime(y!, m!, d!, t.hh, t.mm, timeZone);
    return at > after ? at : null;
  }
  const start = localDate(after, timeZone);
  const base = Date.UTC(start.y, start.m - 1, start.d);
  const days = new Set(on.split(',').map((x) => Number(x.trim())));
  for (let i = 0; i <= 400; i++) {
    const day = new Date(base + i * DAY);
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    if (r.repeat === 'weekly' && !days.has(day.getUTCDay())) continue;
    if (r.repeat === 'monthly') {
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      if (d !== Math.min(Number(on), last)) continue;
    }
    const at = zonedTime(y, m, d, t.hh, t.mm, timeZone);
    if (at > after) return at;
  }
  return null;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "every day at 08:00", "every Fri at 21:00", "on 2026-10-20 at 10:00". */
export function describeRule(r: Rule): string {
  const on = (r.on ?? '').trim();
  switch (r.repeat) {
    case 'once':
      return `on ${on} at ${r.time}`;
    case 'daily':
      return `every day at ${r.time}`;
    case 'weekly':
      return `every ${on
        .split(',')
        .map((x) => WEEKDAYS[Number(x.trim())])
        .join(', ')} at ${r.time}`;
    case 'monthly':
      return `every month on day ${on} at ${r.time}`;
  }
}

/** Short local date-time for messages: "Tue 14 Oct, 08:00". */
export function formatWhen(ts: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ts));
}
