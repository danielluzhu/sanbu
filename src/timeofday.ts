/**
 * What the hour does to a walk.
 *
 * The same street is a different proposition at 08:00, at sunset and at
 * midnight: the bakery is open or it is not, the west-facing overlook is
 * ablaze or it is a dark railing, the unlit alley is a shortcut or a bad idea.
 * This module turns a starting time into the numbers the router uses — one
 * multiplier per scenic feature, and a darkness surcharge on hazard.
 *
 * Everything is derived from the moment you would actually *arrive* at a
 * place, not from the moment you set off, so a shop 50 minutes into a walk is
 * judged on whether it is still open when you get there.
 */
import { formatClock, minutesOfDay, wallClock } from "./clock";
import { openStatus, type OpenState, type SolarMinutes } from "./opening";
import type { ScenicFeature } from "./overpass";
import { bearingDelta, sunPosition, sunTimes, type SunPosition, type SunTimes } from "./sun";
import type { LatLon } from "./geo";

export type Phase = "night" | "dawn" | "goldenMorning" | "day" | "goldenEvening" | "dusk";

export interface Moment {
  /** Epoch milliseconds. */
  at: number;
  phase: Phase;
  /** 0 = full dark, 1 = broad daylight. */
  light: number;
  /** 0..1 — how golden the light is, peaking just above the horizon. */
  golden: number;
  sun: SunPosition;
}

export const PHASE_LABEL: Record<Phase, string> = {
  night: "After dark",
  dawn: "First light",
  goldenMorning: "Morning gold",
  day: "Daylight",
  goldenEvening: "Golden hour",
  dusk: "Dusk",
};

/**
 * Usable light as a function of the sun's altitude. Not physical illuminance —
 * a curve chosen so that "can I see the bay from up here" lands where a person
 * would put it, with a floor for a city that is never truly dark.
 */
function lightFor(altitude: number): number {
  if (altitude >= 6) return 1;
  if (altitude >= -0.833) return 0.78 + (0.22 * (altitude + 0.833)) / 6.833;
  if (altitude >= -6) return 0.34 + (0.44 * (altitude + 6)) / 5.167;
  if (altitude >= -12) return 0.12 + (0.22 * (altitude + 12)) / 6;
  return 0.1;
}

/** Warm, raking light: strongest with the sun a couple of degrees up. */
function goldenFor(altitude: number): number {
  const from = Math.abs(altitude - 2);
  return Math.max(0, Math.min(1, 1 - from / 6));
}

function phaseFor(at: number, times: SunTimes): Phase {
  if (at < times.dawn || at >= times.dusk) return "night";
  if (at < times.sunrise) return "dawn";
  if (at < times.goldenMorningEnd) return "goldenMorning";
  if (at < times.goldenEveningStart) return "day";
  if (at < times.sunset) return "goldenEvening";
  return "dusk";
}

/** How much a kind of place wants to be visited at this hour, by wall clock. */
function hourAffinity(kind: string, hour: number): number {
  switch (kind) {
    case "cafe":
      // Coffee and pastry are a morning errand; by evening they are a detour.
      return hour < 11 ? 1.3 : hour < 15 ? 1.0 : 0.75;
    case "bar":
      return hour >= 17 || hour < 2 ? 1.35 : 0.55;
    case "market":
      return hour < 14 ? 1.2 : 0.85;
    case "culture":
      return hour >= 10 && hour < 18 ? 1.15 : 0.8;
    default:
      return 1;
  }
}

const VENUE_KINDS = new Set(["cafe", "bar", "market", "shop", "culture"]);

export function isVenue(kind: string): boolean {
  return VENUE_KINDS.has(kind);
}

/** Minutes of grace before closing time that still count as worth stopping. */
const CLOSING_SOON = 15;

export class DayContext {
  readonly start: number;
  readonly place: LatLon;
  readonly times: SunTimes;
  /** The day's sun times as minutes of day, for `sunrise-sunset` opening specs. */
  readonly solar: SolarMinutes;

  /**
   * Feature values are looked up once per edge relaxation, which for a
   * city-sized search is hundreds of thousands of times. Both the sun position
   * and the opening-hours verdict are therefore memoised on a five-minute
   * bucket — finer than that is below the resolution of anything here.
   */
  private moments = new Map<number, Moment>();
  private values = new Map<string, number>();

  constructor(startMs: number, place: LatLon) {
    this.start = startMs;
    this.place = place;
    this.times = sunTimes(startMs, place);
    this.solar = {
      dawn: minutesOfDay(this.times.dawn),
      sunrise: minutesOfDay(this.times.sunrise),
      sunset: minutesOfDay(this.times.sunset),
      dusk: minutesOfDay(this.times.dusk),
    };
  }

  private bucket(elapsedSeconds: number): number {
    return Math.max(0, Math.round(elapsedSeconds / 300));
  }

  momentAt(elapsedSeconds: number): Moment {
    const bucket = this.bucket(elapsedSeconds);
    const cached = this.moments.get(bucket);
    if (cached) return cached;

    const at = this.start + bucket * 300_000;
    const sun = sunPosition(at, this.place);
    const moment: Moment = {
      at,
      sun,
      light: lightFor(sun.altitude),
      golden: goldenFor(sun.altitude),
      phase: phaseFor(at, this.times),
    };
    this.moments.set(bucket, moment);
    return moment;
  }

  /** Open, shut, or untagged — at the moment you would reach it. */
  stateOf(feature: ScenicFeature, elapsedSeconds: number): OpenState {
    const moment = this.momentAt(elapsedSeconds);
    return openStatus(feature.opening, moment.at, this.solar).state;
  }

  /**
   * How much this feature is worth right now, as a multiplier on the score it
   * would earn at its best. Near zero means "do not bother routing past it".
   *
   * Deliberately not called `valueOf`: that name is JavaScript's coercion hook,
   * and shadowing it with a two-argument method is a trap waiting to spring.
   */
  valueAt(feature: ScenicFeature, elapsedSeconds: number): number {
    const bucket = this.bucket(elapsedSeconds);
    const key = `${feature.id}|${bucket}`;
    const cached = this.values.get(key);
    if (cached !== undefined) return cached;

    const value = this.computeValue(feature, this.momentAt(elapsedSeconds));
    if (this.values.size < 200_000) this.values.set(key, value);
    return value;
  }

  private computeValue(feature: ScenicFeature, moment: Moment): number {
    if (isVenue(feature.kind)) return this.venueValue(feature, moment);

    const { light, golden } = moment;

    switch (feature.kind) {
      case "viewpoint": {
        let v = 0.28 + 0.72 * light;
        // Looking into low sun is the whole reason to be up there at 19:30.
        if (golden > 0.05) {
          const align =
            feature.facing === undefined
              ? 0.45 // unknown aspect: assume it is as likely to face the sun as not
              : Math.max(0, Math.cos(bearingDelta(feature.facing, moment.sun.azimuth) * (Math.PI / 180)));
          v *= 1 + 1.7 * golden * align;
        }
        // After dark a high overlook keeps its value: the city becomes the view.
        if (light < 0.34 && (feature.prominence ?? 0) > 40) {
          v = Math.max(v, 0.5 + Math.min(0.5, (feature.prominence ?? 0) / 160));
        }
        return v;
      }
      case "beach":
        // The Pacific is due west of everything here; sunset is the event.
        return (0.3 + 0.7 * light) * (1 + 1.2 * golden);
      case "water":
        return (0.36 + 0.64 * light) * (1 + 0.6 * golden);
      case "park":
      case "garden": {
        // Many San Francisco parks are tagged with real gate hours, and the
        // ones that are not still stop being a pleasure to cross after dusk.
        if (feature.opening) {
          const state = openStatus(feature.opening, moment.at, this.solar).state;
          if (state === "closed") return 0.08;
        }
        return (0.22 + 0.78 * light) * (1 + 0.25 * golden);
      }
      case "historic":
      case "artwork":
      case "attraction":
        return 0.3 + 0.7 * light;
      default:
        return 0.35 + 0.65 * light;
    }
  }

  private venueValue(feature: ScenicFeature, moment: Moment): number {
    const hour = wallClock(moment.at).hour;
    const affinity = hourAffinity(feature.kind, hour);
    const status = openStatus(feature.opening, moment.at, this.solar);

    if (status.state === "closed") {
      // A shut shop is not scenery, but a handsome shopfront is not nothing.
      return 0.06;
    }

    if (status.state === "unknown") {
      // No hours tagged. Assume ordinary trading hours rather than pretending
      // to know, and discount accordingly.
      const plausible = hour >= 8 && hour < 20 ? 0.5 : 0.12;
      return plausible * affinity;
    }

    let value = affinity;
    if (status.closesAt !== undefined) {
      const minutesLeft = (status.closesAt - moment.at) / 60_000;
      // Arriving as the shutters come down is barely better than arriving late.
      if (minutesLeft < CLOSING_SOON) value *= 0.25 + (0.75 * minutesLeft) / CLOSING_SOON;
    }
    return value;
  }

  /**
   * Extra hazard from darkness. Traffic risk does not sleep, and an unlit
   * stretch is a different street once the light goes.
   */
  darknessHazard(unlit: boolean, elapsedSeconds: number): number {
    const dark = 1 - this.momentAt(elapsedSeconds).light;
    if (dark < 0.35) return 0;
    return (unlit ? 0.24 : 0.05) * dark;
  }

  /** How much heavier safety should weigh, as a factor, once the light goes. */
  cautionFactor(elapsedSeconds: number): number {
    return 1 + 0.55 * (1 - this.momentAt(elapsedSeconds).light);
  }
}

/**
 * A sentence explaining what the clock is doing to this plan. Shown in the
 * panel so the routing is legible rather than mysterious.
 */
export function planningNote(ctx: DayContext, minutes: number): string {
  const t = ctx.times;
  const start = ctx.start;
  const end = start + minutes * 60_000;
  const startPhase = ctx.momentAt(0).phase;
  const endPhase = ctx.momentAt(minutes * 60).phase;

  const sunrise = formatClock(t.sunrise);
  const sunset = formatClock(t.sunset);
  const goldenFrom = formatClock(t.goldenEveningStart);
  const endsDark = endPhase === "dusk" || endPhase === "night";

  // Evening gold, whether you set off into it or walk into it. Tested against
  // the whole window rather than the starting instant: a walk beginning six
  // minutes before golden hour is a golden hour walk.
  if (end >= t.goldenEveningStart && start <= t.sunset) {
    return (
      `Golden hour ${goldenFrom}–${sunset} falls inside this walk — favouring ` +
      `overlooks that face the light.` +
      (endsDark ? " You finish after dark, so the way back leans safer." : "")
    );
  }

  if (startPhase === "night" && endPhase === "night") {
    return (
      `Dark the whole way — leaning on lit streets and whatever is still open. ` +
      `First light ${formatClock(t.dawn)}.`
    );
  }

  if (start <= t.goldenMorningEnd && end >= t.sunrise) {
    return `Sunrise ${sunrise} — chasing early light and the places that open first.`;
  }

  if (endsDark) {
    return `Sunset is ${sunset}; you finish in the dark, so the route leans safer as the light goes.`;
  }

  if (t.goldenEveningStart > end && t.goldenEveningStart - end < 90 * 60_000) {
    return `Golden hour starts ${goldenFrom} — setting off a little later would catch it.`;
  }

  return `Full daylight until ${goldenFrom}, sunset ${sunset}. Open shops and parks count for more than shut ones.`;
}
