/**
 * San Francisco wall-clock time.
 *
 * The app plans walks in one city, so it should speak that city's time even if
 * the browser is somewhere else: a sunset at 19:42 is 19:42 in San Francisco
 * or the whole feature reads as broken. Everything internal is epoch
 * milliseconds; this module is the only place wall-clock and epoch meet.
 */
const ZONE = "America/Los_Angeles";

const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE,
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export interface WallClock {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  /** 0 = Sunday, matching Date#getDay. */
  weekday: number;
}

export function wallClock(ms: number): WallClock {
  const parts: Record<string, string> = {};
  for (const p of PARTS.formatToParts(new Date(ms))) parts[p.type] = p.value;

  // `hour12: false` still yields 24 for midnight in some engines.
  const hour = Number(parts.hour) % 24;
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);

  // Weekday from the zone-local calendar date, not from the epoch instant.
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

  return { year, month, day, hour, minute: Number(parts.minute), weekday };
}

/** Offset of the zone from UTC at that instant, in milliseconds. */
function zoneOffset(ms: number): number {
  const c = wallClock(ms);
  const asUtc = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute);
  // Round to the minute so the seconds we dropped do not skew the offset.
  return asUtc - Math.floor(ms / 60_000) * 60_000;
}

/**
 * The instant at which San Francisco's clock reads the given wall time.
 *
 * Two passes: the first offset guess is taken at the wrong instant on the two
 * days a year the clocks change, and re-reading it at the corrected instant
 * settles it.
 */
export function fromWallClock(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const first = naive - zoneOffset(naive);
  return naive - zoneOffset(first);
}

/** Replace the time of day on the San Francisco date containing `ms`. */
export function atTimeOfDay(ms: number, hour: number, minute: number): number {
  const c = wallClock(ms);
  return fromWallClock(c.year, c.month, c.day, hour, minute);
}

/** Minutes since midnight, San Francisco time. */
export function minutesOfDay(ms: number): number {
  const c = wallClock(ms);
  return c.hour * 60 + c.minute;
}

/** `19:42`, in San Francisco. */
export function formatClock(ms: number): string {
  const c = wallClock(ms);
  return `${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}`;
}

/** `7:42 pm`, for prose where a 24-hour clock reads stiffly. */
export function formatClockFriendly(ms: number): string {
  const c = wallClock(ms);
  const suffix = c.hour < 12 ? "am" : "pm";
  const hour = c.hour % 12 === 0 ? 12 : c.hour % 12;
  return `${hour}:${String(c.minute).padStart(2, "0")} ${suffix}`;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function weekdayName(ms: number): string {
  return DAY_NAMES[wallClock(ms).weekday] ?? "";
}
