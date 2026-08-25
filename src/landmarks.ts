/**
 * San Francisco's designated landmarks and its historic and cultural districts.
 *
 * The city keeps an authoritative list — Article 10 of the Planning Code — and
 * it is far better than guessing from OpenStreetMap tags, which cannot tell the
 * San Francisco Mint from a bench plaque. Both are `historic=*`.
 *
 * Districts matter as much as the individual buildings and behave differently:
 * a district is somewhere you are *inside*, not something you pass at a
 * distance, so they are kept as polygons and tested by containment. Reducing
 * Liberty Hill to a dot at its centre would score the middle of it and miss
 * every street that makes it worth walking.
 *
 * Baked by `scripts/build-landmarks.ts`, for the same reason as the High Injury
 * Network: no visitor should wait on three paginated DataSF requests.
 */
import { SpatialGrid, type LatLon } from "./geo";

export interface Landmark extends LatLon {
  name: string;
  /** Article 10 landmark number. */
  number?: string;
  /** Year the building went up, and the year the city designated it. */
  built?: number;
  designated?: number;
  /** "Residential - SF", "Religious", "Object"… */
  propertyType?: string;
  style?: string;
  architect?: string;
  /** The designation criteria it was listed under. */
  criteria?: string;
  /** A sentence or two of real history, where the city has written any. */
  story?: string;
}

export type DistrictKind = "historic" | "cultural";

export interface District {
  name: string;
  kind: DistrictKind;
  /** Year listed or designated. */
  year?: number;
  rings: LatLon[][];
  /** Precomputed for a cheap rejection before any point-in-polygon work. */
  south: number;
  west: number;
  north: number;
  east: number;
  /** Somewhere inside to hang a synthetic feature off. */
  centre: LatLon;
}

interface LandmarkAsset {
  landmarks?: Array<{
    n: string; lat: number; lon: number; no?: string; yr?: number; des?: number;
    ty?: string; st?: string; ar?: string; why?: string; d?: string;
  }>;
  districts?: Array<{ n: string; k: DistrictKind; yr?: number; rings: number[][] }>;
}

export interface LandmarkData {
  landmarks: Landmark[];
  districts: District[];
}

let assetUrl = "./data/landmarks.json";

export function setLandmarkAssetUrl(url: string): void {
  assetUrl = url;
}

let loading: Promise<LandmarkData> | null = null;

export function loadLandmarks(): Promise<LandmarkData> {
  loading ??= (async () => {
    const res = await fetch(assetUrl, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Landmark asset ${res.status}`);
    const data = (await res.json()) as LandmarkAsset;

    const landmarks: Landmark[] = (data.landmarks ?? []).map((l) => ({
      name: l.n,
      lat: l.lat,
      lon: l.lon,
      number: l.no,
      built: l.yr,
      designated: l.des,
      propertyType: l.ty,
      style: l.st,
      architect: l.ar,
      criteria: l.why,
      story: l.d,
    }));

    const districts: District[] = [];
    for (const d of data.districts ?? []) {
      const rings: LatLon[][] = [];
      let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
      let sumLat = 0, sumLon = 0, count = 0;

      for (const flat of d.rings ?? []) {
        const ring: LatLon[] = [];
        for (let i = 0; i + 1 < flat.length; i += 2) {
          const lat = flat[i]!;
          const lon = flat[i + 1]!;
          ring.push({ lat, lon });
          if (lat < south) south = lat;
          if (lat > north) north = lat;
          if (lon < west) west = lon;
          if (lon > east) east = lon;
          sumLat += lat;
          sumLon += lon;
          count++;
        }
        if (ring.length >= 3) rings.push(ring);
      }
      if (rings.length === 0 || count === 0) continue;

      districts.push({
        name: d.n,
        kind: d.k,
        year: d.yr,
        rings,
        south, west, north, east,
        centre: { lat: sumLat / count, lon: sumLon / count },
      });
    }

    return { landmarks, districts };
  })().catch((err) => {
    // Allow a later attempt rather than caching the failure forever.
    loading = null;
    throw err;
  });

  return loading;
}

/** Ray casting. Standard, and exact enough at the scale of a city block. */
function inRing(p: LatLon, ring: LatLon[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (
      a.lat > p.lat !== b.lat > p.lat &&
      p.lon < ((b.lon - a.lon) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lon
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * "Which historic or cultural districts is this point standing in?"
 *
 * There are only a couple of dozen districts, so this is a bounding-box reject
 * followed by ray casting rather than anything cleverer — but it is called once
 * per graph edge, so the cheap rejection matters.
 */
export class DistrictIndex {
  constructor(private districts: District[]) {}

  at(p: LatLon): District[] {
    const hits: District[] = [];
    for (const d of this.districts) {
      if (p.lat < d.south || p.lat > d.north || p.lon < d.west || p.lon > d.east) continue;
      if (d.rings.some((ring) => inRing(p, ring))) hits.push(d);
    }
    return hits;
  }
}

/**
 * Landmarks close enough to an OpenStreetMap feature that they are plainly the
 * same building. The city's record is the better one, so the OSM entry steps
 * aside rather than scoring the same place twice under two names.
 */
export function landmarkGrid(landmarks: Landmark[], refLat: number): SpatialGrid<Landmark> {
  const grid = new SpatialGrid<Landmark>(80, refLat);
  grid.insertAll(landmarks);
  return grid;
}
