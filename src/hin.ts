/**
 * San Francisco's Vision Zero High Injury Network.
 *
 * Roughly 12% of SF street segments account for the large majority of severe
 * and fatal traffic injuries. It is pedestrian-relevant and objective, which is
 * why it is the safety layer here rather than crime data.
 *
 * The geometry ships as a static asset baked by `scripts/build-hin.ts` from
 * DataSF dataset `enwt-3u8m`, rather than being pulled from DataSF at runtime:
 * it is ~6,000 segments across several paginated requests, which no visitor
 * should have to wait for.
 */
import { SpatialGrid, pointToSegment, type LatLon } from "./geo";

/** A HIN street segment reduced to its polyline. */
export interface HinSegment {
  pts: LatLon[];
}

interface HinAsset {
  segments: number[][];
}

/** Where the baked asset lives, relative to the page. */
let assetUrl = "./data/hin.json";

export function setHinAssetUrl(url: string): void {
  assetUrl = url;
}

let loading: Promise<HinSegment[]> | null = null;

export function loadHin(): Promise<HinSegment[]> {
  // One in-flight request shared by every caller, and the parsed result is kept
  // for the life of the page — it is the same few hundred KB every time.
  loading ??= (async () => {
    const res = await fetch(assetUrl, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`High Injury Network asset ${res.status}`);
    const data = (await res.json()) as HinAsset;

    const segments: HinSegment[] = [];
    for (const flat of data.segments ?? []) {
      const pts: LatLon[] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) {
        pts.push({ lat: flat[i]!, lon: flat[i + 1]! });
      }
      if (pts.length >= 2) segments.push({ pts });
    }
    return segments;
  })().catch((err) => {
    // Allow a later attempt rather than caching the failure forever.
    loading = null;
    throw err;
  });

  return loading;
}

interface GridEntry extends LatLon {
  seg: HinSegment;
  i: number;
}

/**
 * Answers "is this bit of street on the High Injury Network?". Every HIN vertex
 * goes into a grid; a query point is on the network if it lies within
 * `toleranceM` of any HIN sub-segment near it.
 *
 * The tolerance is set so that a separately-mapped sidewalk is recognised as
 * belonging to the corridor it runs beside, which is the common case in SF.
 */
export class HinIndex {
  private grid: SpatialGrid<GridEntry>;

  constructor(segments: HinSegment[], refLat: number) {
    this.grid = new SpatialGrid<GridEntry>(120, refLat);
    for (const seg of segments) {
      for (let i = 0; i < seg.pts.length; i++) {
        this.grid.insert({ ...seg.pts[i]!, seg, i });
      }
    }
  }

  isHighInjury(p: LatLon, toleranceM = 25): boolean {
    for (const entry of this.grid.near(p.lat, p.lon, toleranceM + 60)) {
      const { seg, i } = entry;
      if (i + 1 < seg.pts.length) {
        if (pointToSegment(p, seg.pts[i]!, seg.pts[i + 1]!) <= toleranceM) return true;
      }
      if (i > 0) {
        if (pointToSegment(p, seg.pts[i - 1]!, seg.pts[i]!) <= toleranceM) return true;
      }
    }
    return false;
  }
}
