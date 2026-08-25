/**
 * Solar geometry for a place and a day.
 *
 * What makes a viewpoint worth walking to at 19:30 and not at 13:00 is where
 * the sun is, so it is computed rather than guessed. This is the standard
 * low-precision solar model (Meeus, in the arrangement popularised by
 * SunCalc): well under a minute of error at our latitude, and cheap enough to
 * call for every route candidate.
 *
 * All returned instants are epoch milliseconds — absolute, so nothing here has
 * to care which time zone the browser thinks it is in.
 */
import type { LatLon } from "./geo";

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;
const J1970 = 2440588;
const J2000 = 2451545;
/** Obliquity of the ecliptic. */
const E = RAD * 23.4397;

/** Days since J2000, the epoch every term below is written against. */
function toDays(ms: number): number {
  return ms / DAY_MS - 0.5 + J1970 - J2000;
}

function fromJulian(j: number): number {
  return (j + 0.5 - J1970) * DAY_MS;
}

function solarMeanAnomaly(d: number): number {
  return RAD * (357.5291 + 0.98560028 * d);
}

/** Apparent ecliptic longitude of the sun. */
function eclipticLongitude(m: number): number {
  const centre =
    RAD * (1.9148 * Math.sin(m) + 0.02 * Math.sin(2 * m) + 0.0003 * Math.sin(3 * m));
  const perihelion = RAD * 102.9372;
  return m + centre + perihelion + Math.PI;
}

function declination(l: number): number {
  return Math.asin(Math.sin(E) * Math.sin(l));
}

function rightAscension(l: number): number {
  return Math.atan2(Math.sin(l) * Math.cos(E), Math.cos(l));
}

function siderealTime(d: number, lw: number): number {
  return RAD * (280.16 + 360.9856235 * d) - lw;
}

export interface SunPosition {
  /** Compass bearing of the sun, degrees clockwise from north. */
  azimuth: number;
  /** Degrees above the horizon; negative once the sun has set. */
  altitude: number;
}

export function sunPosition(ms: number, p: LatLon): SunPosition {
  const lw = RAD * -p.lon;
  const phi = RAD * p.lat;
  const d = toDays(ms);

  const m = solarMeanAnomaly(d);
  const l = eclipticLongitude(m);
  const dec = declination(l);
  const ra = rightAscension(l);
  const h = siderealTime(d, lw) - ra;

  // atan2 here measures from south towards west; shift to a compass bearing.
  const azimuth = Math.atan2(
    Math.sin(h),
    Math.cos(h) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi),
  );
  const altitude = Math.asin(
    Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(h),
  );

  return {
    azimuth: (azimuth / RAD + 180 + 360) % 360,
    altitude: altitude / RAD,
  };
}

/** Sun altitudes, in degrees, that mark the moments we care about. */
const HORIZON = -0.833; // upper limb, refracted
const CIVIL = -6;
const GOLDEN = 6;

export interface SunTimes {
  dawn: number;
  sunrise: number;
  /** Warm low light lasts until here in the morning… */
  goldenMorningEnd: number;
  noon: number;
  /** …and starts again here in the evening. */
  goldenEveningStart: number;
  sunset: number;
  dusk: number;
}

/**
 * The day's solar milestones for the day containing `ms` at that place.
 *
 * Near the poles the sun may never reach a given altitude; rather than hand
 * back NaN, such a moment collapses onto solar noon, which keeps every
 * downstream comparison well-ordered.
 */
export function sunTimes(ms: number, p: LatLon): SunTimes {
  const lw = RAD * -p.lon;
  const phi = RAD * p.lat;
  const d = toDays(ms);

  // Which solar day we are in, counted from the meridian passage.
  const J0 = 0.0009;
  const n = Math.round(d - J0 - lw / (2 * Math.PI));
  const ds = J0 + lw / (2 * Math.PI) + n;

  const m = solarMeanAnomaly(ds);
  const l = eclipticLongitude(m);
  const dec = declination(l);

  const transit = J2000 + ds + 0.0053 * Math.sin(m) - 0.0069 * Math.sin(2 * l);
  const noon = fromJulian(transit);

  /** The instant the sun passes altitude `h`, setting (+1) or rising (-1). */
  const cross = (h: number, dir: 1 | -1): number => {
    const cosW =
      (Math.sin(h * RAD) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
    if (cosW < -1 || cosW > 1) return noon;
    const w = Math.acos(cosW);
    const set = fromJulian(
      J2000 + (J0 + (w + lw) / (2 * Math.PI) + n) + 0.0053 * Math.sin(m) - 0.0069 * Math.sin(2 * l),
    );
    return dir === 1 ? set : noon - (set - noon);
  };

  return {
    dawn: cross(CIVIL, -1),
    sunrise: cross(HORIZON, -1),
    goldenMorningEnd: cross(GOLDEN, -1),
    noon,
    goldenEveningStart: cross(GOLDEN, 1),
    sunset: cross(HORIZON, 1),
    dusk: cross(CIVIL, 1),
  };
}

/** Smallest angle between two compass bearings, in degrees (0..180). */
export function bearingDelta(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

const COMPASS: Record<string, number> = {
  n: 0, nne: 22.5, ne: 45, ene: 67.5,
  e: 90, ese: 112.5, se: 135, sse: 157.5,
  s: 180, ssw: 202.5, sw: 225, wsw: 247.5,
  w: 270, wnw: 292.5, nw: 315, nnw: 337.5,
};

/**
 * OSM's `direction` tag, which is either degrees or a compass point, and on a
 * viewpoint means the way you are looking. A range like `120-240` is given as
 * its midpoint.
 */
export function parseDirection(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const text = value.trim().toLowerCase();

  const range = text.match(/^(-?[\d.]+)\s*-\s*(-?[\d.]+)$/);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      // Take the shorter way round, so 350-10 reads as due north.
      const span = ((b - a + 540) % 360) - 180;
      return (((a + span / 2) % 360) + 360) % 360;
    }
  }

  const degrees = Number(text);
  if (Number.isFinite(degrees)) return ((degrees % 360) + 360) % 360;

  return COMPASS[text.replace(/[^a-z]/g, "")];
}
