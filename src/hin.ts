/**
 * San Francisco's Vision Zero High Injury Network.
 *
 * DataSF dataset `enwt-3u8m` ("2024 High Injury Network", refreshed 2026-03-23):
 * roughly 12% of SF street segments that together account for the large
 * majority of severe and fatal traffic injuries. It is pedestrian-relevant and
 * objective, which is why it is the safety layer here rather than crime data.
 */
import { cached } from "./db";
import { SpatialGrid, pointToSegment, type LatLon } from "./geo";

const DATASET = "enwt-3u8m";
const MONTH = 30 * 24 * 60 * 60 * 1000;

/** A HIN street segment reduced to its polyline. */
export interface HinSegment {
  street: string;
  pts: LatLon[];
}

interface SodaRow {
  full_street_name?: string;
  street_name?: string;
  geom?: {
    type: string;
    coordinates: number[][] | number[][][];
  };
}

async function download(): Promise<HinSegment[]> {
  const segments: HinSegment[] = [];
  const limit = 2000;

  for (let offset = 0; ; offset += limit) {
    const url =
      `https://data.sfgov.org/resource/${DATASET}.json` +
      `?$select=full_street_name,street_name,geom&$limit=${limit}&$offset=${offset}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`DataSF ${res.status} for ${DATASET}`);
    const rows = (await res.json()) as SodaRow[];
    if (rows.length === 0) break;

    for (const row of rows) {
      const geom = row.geom;
      if (!geom) continue;
      const name = row.full_street_name ?? row.street_name ?? "";
      // The dataset mixes LineString and MultiLineString across revisions.
      const lines: number[][][] =
        geom.type === "MultiLineString"
          ? (geom.coordinates as number[][][])
          : [geom.coordinates as number[][]];
      for (const line of lines) {
        const pts = line
          .filter((c) => Array.isArray(c) && c.length >= 2)
          .map((c) => ({ lat: c[1]!, lon: c[0]! }));
        if (pts.length >= 2) segments.push({ street: name, pts });
      }
    }
    if (rows.length < limit) break;
  }
  return segments;
}

export async function loadHin(): Promise<HinSegment[]> {
  return cached<HinSegment[]>(`hin:${DATASET}`, MONTH, download);
}

interface GridEntry extends LatLon {
  seg: HinSegment;
  i: number;
}

/**
 * Answers "is this bit of street on the High Injury Network?". Every HIN
 * vertex goes into a grid; a query point is on the network if it lies within
 * `toleranceM` of any HIN sub-segment near it.
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
