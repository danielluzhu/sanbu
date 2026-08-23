/**
 * Terrain sampling via Open-Meteo's free elevation API (no key, 100 points per
 * request).
 *
 * Sampling every graph node would be thousands of points per walk. Instead we
 * sample a fixed ~90m lattice over the area, cache each cell in SQLite forever
 * (terrain does not move), and bilinearly interpolate for individual nodes.
 */
import { elevationGet, elevationPutMany } from "./db";
import { metresPerDegree, type LatLon } from "./geo";

const CELL_M = 90;
const BATCH = 100;

/**
 * One fixed reference latitude for the whole lattice.
 *
 * This must not vary per point: index -> centre -> index has to round-trip
 * exactly, or lookups land in cells that were never fetched and the terrain
 * comes back full of holes, which in turn fabricates cliff-edge gradients.
 */
const REF_LAT = 37.7749;
const SCALE = metresPerDegree(REF_LAT);

function cellIndex(lat: number, lon: number): { ix: number; iy: number } {
  return {
    ix: Math.round((lon * SCALE.x) / CELL_M),
    iy: Math.round((lat * SCALE.y) / CELL_M),
  };
}

function cellCentre(ix: number, iy: number): LatLon {
  return { lat: (iy * CELL_M) / SCALE.y, lon: (ix * CELL_M) / SCALE.x };
}

const key = (ix: number, iy: number) => `${ix}:${iy}`;

/**
 * Ensures every lattice cell covering the bbox is in the elevation cache,
 * fetching the misses from Open-Meteo in batches.
 */
export async function warmElevation(
  bbox: [number, number, number, number],
): Promise<Map<string, number>> {
  const [south, west, north, east] = bbox;

  const lo = cellIndex(south, west);
  const hi = cellIndex(north, east);

  const wanted: Array<{ ix: number; iy: number }> = [];
  const have = new Map<string, number>();

  // Two cells of margin: OSM ways routinely run past the bbox they were
  // selected by, and a node just outside must still find terrain.
  for (let ix = lo.ix - 2; ix <= hi.ix + 2; ix++) {
    for (let iy = lo.iy - 2; iy <= hi.iy + 2; iy++) {
      const k = key(ix, iy);
      const hit = elevationGet(k);
      if (hit !== null) have.set(k, hit);
      else wanted.push({ ix, iy });
    }
  }

  for (let i = 0; i < wanted.length; i += BATCH) {
    const chunk = wanted.slice(i, i + BATCH);
    const coords = chunk.map((c) => cellCentre(c.ix, c.iy));
    const url =
      "https://api.open-meteo.com/v1/elevation" +
      `?latitude=${coords.map((c) => c.lat.toFixed(6)).join(",")}` +
      `&longitude=${coords.map((c) => c.lon.toFixed(6)).join(",")}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
      const json = (await res.json()) as { elevation?: number[] };
      const eles = json.elevation ?? [];
      const rows: Array<[string, number]> = [];
      chunk.forEach((c, j) => {
        const e = eles[j];
        if (typeof e === "number") {
          const k = key(c.ix, c.iy);
          rows.push([k, e]);
          have.set(k, e);
        }
      });
      elevationPutMany(rows);
    } catch {
      // A terrain gap degrades hill-awareness for part of the map; it should
      // not fail the whole walk. Missing cells read as flat.
    }
  }

  return have;
}

/**
 * Bilinear sample of the cached lattice.
 *
 * Never returns a hard 0 for a missing cell: an invented sea-level point beside
 * a real hilltop reads as a cliff and poisons every gradient near it. Gaps fall
 * back to the nearest cells, then to the lattice mean.
 */
export function elevationAt(lattice: Map<string, number>, p: LatLon): number {
  const fx = (p.lon * SCALE.x) / CELL_M;
  const fy = (p.lat * SCALE.y) / CELL_M;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;

  const at = (ix: number, iy: number): number | undefined => lattice.get(key(ix, iy));

  const c00 = at(x0, y0);
  const c10 = at(x0 + 1, y0);
  const c01 = at(x0, y0 + 1);
  const c11 = at(x0 + 1, y0 + 1);

  if (c00 !== undefined && c10 !== undefined && c01 !== undefined && c11 !== undefined) {
    const top = c00 * (1 - tx) + c10 * tx;
    const bot = c01 * (1 - tx) + c11 * tx;
    return top * (1 - ty) + bot * ty;
  }

  const corners = [c00, c10, c01, c11].filter((v): v is number => v !== undefined);
  if (corners.length > 0) {
    return corners.reduce((a, b) => a + b, 0) / corners.length;
  }

  // Widening search — a genuine gap in coverage rather than an edge case.
  for (let r = 2; r <= 4; r++) {
    const ring: number[] = [];
    for (let i = -r; i <= r; i++) {
      for (let j = -r; j <= r; j++) {
        const v = at(x0 + i, y0 + j);
        if (v !== undefined) ring.push(v);
      }
    }
    if (ring.length > 0) return ring.reduce((a, b) => a + b, 0) / ring.length;
  }

  return latticeMean(lattice);
}

const meanCache = new WeakMap<Map<string, number>, number>();

function latticeMean(lattice: Map<string, number>): number {
  const cached = meanCache.get(lattice);
  if (cached !== undefined) return cached;
  let sum = 0;
  let n = 0;
  for (const v of lattice.values()) {
    sum += v;
    n++;
  }
  const mean = n > 0 ? sum / n : 0;
  meanCache.set(lattice, mean);
  return mean;
}
