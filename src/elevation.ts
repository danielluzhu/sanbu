/**
 * Terrain.
 *
 * Elevation is not fetched at runtime. A lattice covering all of San Francisco
 * is baked into a static asset by `scripts/build-elevation.ts` and loaded once:
 * sampling live meant every first visit fired a burst of requests at Open-Meteo
 * and got rate limited, which silently flattened the terrain and quietly broke
 * the hills preference.
 *
 * Node elevations are bilinearly interpolated from the lattice.
 */
import { metresPerDegree, type LatLon } from "./geo";

export const CELL_M = 90;

/**
 * One fixed reference latitude for the whole lattice.
 *
 * This must not vary per point: index -> centre -> index has to round-trip
 * exactly, or lookups land in cells that were never sampled and the terrain
 * comes back full of holes, which in turn fabricates cliff-edge gradients.
 */
export const REF_LAT = 37.7749;
const SCALE = metresPerDegree(REF_LAT);

export function cellIndex(lat: number, lon: number): { ix: number; iy: number } {
  return {
    ix: Math.round((lon * SCALE.x) / CELL_M),
    iy: Math.round((lat * SCALE.y) / CELL_M),
  };
}

export function cellCentre(ix: number, iy: number): LatLon {
  return { lat: (iy * CELL_M) / SCALE.y, lon: (ix * CELL_M) / SCALE.x };
}

interface ElevationAsset {
  ix0: number;
  iy0: number;
  nx: number;
  ny: number;
  ele: number[];
}

/**
 * The loaded lattice. Kept as a flat typed array addressed by grid index rather
 * than a string-keyed map — it is tens of thousands of cells and gets hit once
 * per graph node, several times over.
 */
export interface Lattice {
  ix0: number;
  iy0: number;
  nx: number;
  ny: number;
  ele: Int16Array;
  mean: number;
}

let assetUrl = "./data/elevation.json";

export function setElevationAssetUrl(url: string): void {
  assetUrl = url;
}

let loading: Promise<Lattice> | null = null;

export function loadLattice(): Promise<Lattice> {
  // One in-flight request shared by every caller, held for the life of the page.
  loading ??= (async () => {
    const res = await fetch(assetUrl, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Elevation asset ${res.status}`);
    const data = (await res.json()) as ElevationAsset;

    const ele = Int16Array.from(data.ele);
    let sum = 0;
    let n = 0;
    for (const v of ele) {
      if (v !== 0) {
        sum += v;
        n++;
      }
    }

    return {
      ix0: data.ix0,
      iy0: data.iy0,
      nx: data.nx,
      ny: data.ny,
      ele,
      // Used only where a point falls outside the lattice entirely. The mean of
      // dry land is a far less damaging guess than zero.
      mean: n > 0 ? sum / n : 0,
    };
  })().catch((err) => {
    // Allow a later attempt rather than caching the failure forever.
    loading = null;
    throw err;
  });

  return loading;
}

/** The graph builder asks for terrain by bbox; the baked lattice covers all of it. */
export async function warmElevation(_bbox: [number, number, number, number]): Promise<Lattice> {
  return loadLattice();
}

function at(lattice: Lattice, ix: number, iy: number): number | undefined {
  const col = ix - lattice.ix0;
  const row = iy - lattice.iy0;
  if (col < 0 || col >= lattice.nx || row < 0 || row >= lattice.ny) return undefined;
  return lattice.ele[row * lattice.nx + col];
}

/**
 * Bilinear sample of the lattice.
 *
 * Never returns a hard 0 for a point off the grid: an invented sea-level point
 * beside a real hilltop reads as a cliff and poisons every gradient near it.
 */
export function elevationAt(lattice: Lattice, p: LatLon): number {
  const fx = (p.lon * SCALE.x) / CELL_M;
  const fy = (p.lat * SCALE.y) / CELL_M;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;

  const c00 = at(lattice, x0, y0);
  const c10 = at(lattice, x0 + 1, y0);
  const c01 = at(lattice, x0, y0 + 1);
  const c11 = at(lattice, x0 + 1, y0 + 1);

  if (c00 !== undefined && c10 !== undefined && c01 !== undefined && c11 !== undefined) {
    const top = c00 * (1 - tx) + c10 * tx;
    const bot = c01 * (1 - tx) + c11 * tx;
    return top * (1 - ty) + bot * ty;
  }

  const corners = [c00, c10, c01, c11].filter((v): v is number => v !== undefined);
  if (corners.length > 0) return corners.reduce((a, b) => a + b, 0) / corners.length;

  return lattice.mean;
}
