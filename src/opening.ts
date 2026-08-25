/**
 * A working subset of OSM's `opening_hours` syntax.
 *
 * The full grammar is enormous and mostly concerns things a walk planner will
 * never ask about — school holidays, week parities, "Easter +2 days". What is
 * handled here is what San Francisco's cafés, bookshops and parks actually
 * carry: weekday ranges, several spans a day, spans crossing midnight,
 * `24/7`, `off` exceptions, and the `sunrise-sunset` that parks are tagged
 * with.
 *
 * Anything unrecognised yields `unknown` rather than a guess. A shop we cannot
 * read is not the same as a shop that is shut, and the router treats the two
 * differently.
 */
import { fromWallClock, minutesOfDay, wallClock } from "./clock";

export type OpenState = "open" | "closed" | "unknown";

export interface OpenStatus {
  state: OpenState;
  /** When it shuts, if we are inside a span with a known end. */
  closesAt?: number;
  /** The next time it opens, if we can see one within a day. */
  opensAt?: number;
}

/** Sun-relative times used by `sunrise-sunset` style specs, in minutes of day. */
export interface SolarMinutes {
  dawn: number;
  sunrise: number;
  sunset: number;
  dusk: number;
}

type Anchor = "clock" | "dawn" | "sunrise" | "sunset" | "dusk";

interface TimePoint {
  anchor: Anchor;
  /** Minutes of day for a clock time, or the offset from the solar event. */
  minutes: number;
}

interface Span {
  from: TimePoint;
  to: TimePoint | null; // null = open-ended, e.g. "08:00+"
}

interface Rule {
  /** Weekdays it applies to (0 = Sunday), or null for every day. */
  days: Set<number> | null;
  spans: Span[];
  off: boolean;
}

const DAY_INDEX: Record<string, number> = {
  su: 0, mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6,
};

/** Constructs we deliberately refuse to interpret rather than get wrong. */
const UNSUPPORTED =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|week|easter)\b|\[|"/;

/**
 * Public and school holiday rules. Skipped rather than treated as a failure:
 * `Mo-Fr 08:00-17:00; PH off` is a very common tagging, and ignoring the
 * holiday clause only misleads on the handful of days it applies.
 */
const HOLIDAY_RULE = /\b(ph|sh)\b/;

const CACHE = new Map<string, Rule[] | null>();

function parse(spec: string): Rule[] | null {
  const cached = CACHE.get(spec);
  if (cached !== undefined) return cached;
  const parsed = parseUncached(spec);
  // Specs repeat heavily across a city; parsing each one once is worth it.
  if (CACHE.size < 4000) CACHE.set(spec, parsed);
  return parsed;
}

function parseUncached(spec: string): Rule[] | null {
  const text = spec.trim().toLowerCase();
  if (!text) return null;
  if (text === "24/7" || text === "24 hours" || text === "open") {
    return [{ days: null, spans: [{ from: clock(0), to: clock(1440) }], off: false }];
  }

  const rules: Rule[] = [];
  for (const chunk of text.split(/;|\|\|/)) {
    const rule = chunk.trim();
    if (!rule) continue;
    // A rule we cannot read poisons the whole spec: silently dropping, say,
    // "Dec 25 off" would have us send someone to a shut door on Christmas.
    if (UNSUPPORTED.test(rule)) return null;
    if (HOLIDAY_RULE.test(rule)) continue;

    const off = /\b(off|closed)\b\s*$/.test(rule);
    const body = rule.replace(/\b(off|closed|open)\b\s*$/, "").trim();

    if (body === "24/7") {
      rules.push({ days: null, spans: [{ from: clock(0), to: clock(1440) }], off });
      continue;
    }

    // Weekdays come first, times after; either half may be absent.
    const match = body.match(/^([a-z,\- ]*?)\s*((?:\d|sunrise|sunset|dawn|dusk|\().*)?$/);
    if (!match) return null;

    const days = match[1]?.trim() ? parseDays(match[1]) : null;
    if (days === undefined) return null;

    const timesText = match[2]?.trim() ?? "";
    let spans: Span[] = [];
    if (timesText) {
      const parsed = parseSpans(timesText);
      if (!parsed) return null;
      spans = parsed;
    } else if (!off) {
      // "Mo-Fr" alone means all day on those days.
      spans = [{ from: clock(0), to: clock(1440) }];
    }

    rules.push({ days, spans, off });
  }

  return rules.length > 0 ? rules : null;
}

function clock(minutes: number): TimePoint {
  return { anchor: "clock", minutes };
}

/** `mo-fr`, `sa,su`, `mo-we,fr` → the set of weekday numbers. */
function parseDays(text: string): Set<number> | undefined {
  const days = new Set<number>();
  for (const part of text.split(",")) {
    const item = part.trim().replace(/\s+/g, "");
    if (!item) continue;
    const range = item.match(/^([a-z]{2})-([a-z]{2})$/);
    if (range) {
      const from = DAY_INDEX[range[1]!];
      const to = DAY_INDEX[range[2]!];
      if (from === undefined || to === undefined) return undefined;
      for (let i = 0; i < 7; i++) {
        const d = (from + i) % 7;
        days.add(d);
        if (d === to) break;
      }
      continue;
    }
    const single = DAY_INDEX[item];
    if (single === undefined) return undefined;
    days.add(single);
  }
  return days.size > 0 ? days : undefined;
}

function parseSpans(text: string): Span[] | null {
  const spans: Span[] = [];
  for (const part of text.split(",")) {
    const item = part.trim();
    if (!item) continue;

    if (/\+$/.test(item)) {
      const from = parsePoint(item.slice(0, -1));
      if (!from) return null;
      spans.push({ from, to: null });
      continue;
    }

    // Split on the hyphen that separates the two ends, not on the one inside
    // an offset like "sunset-00:30".
    const cut = findSeparator(item);
    if (cut < 0) return null;
    const from = parsePoint(item.slice(0, cut));
    const to = parsePoint(item.slice(cut + 1));
    if (!from || !to) return null;
    spans.push({ from, to });
  }
  return spans.length > 0 ? spans : null;
}

function findSeparator(item: string): number {
  let depth = 0;
  for (let i = 0; i < item.length; i++) {
    const c = item[i]!;
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "-" && depth === 0 && i > 0) return i;
  }
  return -1;
}

function parsePoint(raw: string): TimePoint | null {
  const text = raw.trim().replace(/[()]/g, "");
  if (!text) return null;

  const solar = text.match(/^(sunrise|sunset|dawn|dusk)(?:\s*([+-])\s*(\d{1,2}):(\d{2}))?$/);
  if (solar) {
    const sign = solar[2] === "-" ? -1 : 1;
    const offset = solar[3] ? sign * (Number(solar[3]) * 60 + Number(solar[4])) : 0;
    return { anchor: solar[1] as Anchor, minutes: offset };
  }

  const hhmm = text.match(/^(\d{1,2}):(\d{2})$/);
  if (hhmm) {
    const minutes = Number(hhmm[1]) * 60 + Number(hhmm[2]);
    return minutes <= 1440 ? clock(minutes) : null;
  }

  // Bare hours turn up often enough to be worth accepting.
  const hh = text.match(/^(\d{1,2})$/);
  if (hh) {
    const minutes = Number(hh[1]) * 60;
    return minutes <= 1440 ? clock(minutes) : null;
  }

  return null;
}

function resolve(point: TimePoint, solar: SolarMinutes | undefined): number | null {
  if (point.anchor === "clock") return point.minutes;
  if (!solar) return null;
  return solar[point.anchor] + point.minutes;
}

type Interval = [number, number];

/**
 * The day's open intervals in minutes from its own midnight. An interval may
 * run past 1440 where a bar shuts at 02:00.
 */
function intervalsFor(
  rules: Rule[],
  weekday: number,
  solar: SolarMinutes | undefined,
): Interval[] | null {
  let intervals: Interval[] = [];

  for (const rule of rules) {
    if (rule.days && !rule.days.has(weekday)) continue;

    const resolved: Interval[] = [];
    for (const span of rule.spans) {
      const from = resolve(span.from, solar);
      if (from === null) return null;
      let to = span.to ? resolve(span.to, solar) : 1440;
      if (to === null) return null;
      // "20:00-02:00" runs into the next day.
      if (to <= from) to += 1440;
      resolved.push([from, to]);
    }

    if (rule.off) {
      // An `off` rule with times carves a hole; without them it shuts the day.
      intervals = rule.spans.length === 0 ? [] : subtract(intervals, resolved);
    } else {
      // A later rule for the same day replaces the earlier one, which is how
      // "Mo-Fr 09:00-17:00; Sa 10:00-14:00" is meant to read.
      intervals = rule.days ? resolved : [...intervals, ...resolved];
    }
  }

  return intervals;
}

function subtract(from: Interval[], holes: Interval[]): Interval[] {
  let out = from;
  for (const [hs, he] of holes) {
    const next: Interval[] = [];
    for (const [s, e] of out) {
      if (he <= s || hs >= e) next.push([s, e]);
      else {
        if (s < hs) next.push([s, hs]);
        if (he < e) next.push([he, e]);
      }
    }
    out = next;
  }
  return out;
}

/**
 * The closing instant for an interval — or nothing at all for a place that is
 * open round the clock, where "closes at 00:00" would be a lie of arithmetic.
 */
function closingAt(dayStart: number, from: number, to: number): number | undefined {
  return to - from >= 1440 ? undefined : dayStart + to * 60_000;
}

/** Midnight, San Francisco time, on the day containing `ms`, offset by `days`. */
function midnight(ms: number, days: number): number {
  const c = wallClock(ms);
  const shifted = new Date(Date.UTC(c.year, c.month - 1, c.day + days));
  return fromWallClock(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    0,
    0,
  );
}

function weekdayOf(ms: number, days: number): number {
  const c = wallClock(ms);
  return (((c.weekday + days) % 7) + 7) % 7;
}

/**
 * Is this place open at that instant, and for how much longer?
 *
 * `solar` is the day's sun times as minutes of day — parks tagged
 * `sunrise-sunset` are common enough in San Francisco to be worth resolving
 * properly rather than dropping to `unknown`.
 */
export function openStatus(
  spec: string | undefined,
  ms: number,
  solar?: SolarMinutes,
): OpenStatus {
  if (!spec) return { state: "unknown" };
  const rules = parse(spec);
  if (!rules) return { state: "unknown" };

  const now = minutesOfDay(ms);

  // Yesterday first: a span that crossed midnight may still be running.
  const yesterday = intervalsFor(rules, weekdayOf(ms, -1), solar);
  if (yesterday === null) return { state: "unknown" };
  for (const [s, e] of yesterday) {
    if (e > 1440 && now + 1440 >= s && now + 1440 < e) {
      return { state: "open", closesAt: closingAt(midnight(ms, -1), s, e) };
    }
  }

  const today = intervalsFor(rules, weekdayOf(ms, 0), solar);
  if (today === null) return { state: "unknown" };
  for (const [s, e] of today) {
    if (now >= s && now < e) {
      return { state: "open", closesAt: closingAt(midnight(ms, 0), s, e) };
    }
  }

  // Shut — say when it opens again, if that is within the next day.
  let opensAt: number | undefined;
  const upcoming = today.filter(([s]) => s > now).map(([s]) => s);
  if (upcoming.length > 0) {
    opensAt = midnight(ms, 0) + Math.min(...upcoming) * 60_000;
  } else {
    const tomorrow = intervalsFor(rules, weekdayOf(ms, 1), solar);
    if (tomorrow && tomorrow.length > 0) {
      opensAt = midnight(ms, 1) + Math.min(...tomorrow.map(([s]) => s)) * 60_000;
    }
  }

  return { state: "closed", opensAt };
}
