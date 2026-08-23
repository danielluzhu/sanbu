/** Geometry helpers. All distances in metres, all angles in degrees. */

export interface LatLon {
  lat: number;
  lon: number;
}

const R_EARTH = 6371008.8;
const DEG = Math.PI / 180;

export function haversine(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const la = a.lat * DEG;
  const lb = b.lat * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}

/**
 * Metres-per-degree at a given latitude. Used to build cheap local planar
 * approximations — over a few km of San Francisco the error is negligible and
 * it lets us do squared-distance comparisons without trig in hot loops.
 */
export function metresPerDegree(lat: number): { x: number; y: number } {
  return { x: 111320 * Math.cos(lat * DEG), y: 110574 };
}

/** Expand a point into a [south, west, north, east] bbox of the given radius. */
export function bboxAround(centre: LatLon, radiusM: number): [number, number, number, number] {
  const m = metresPerDegree(centre.lat);
  const dLat = radiusM / m.y;
  const dLon = radiusM / m.x;
  return [centre.lat - dLat, centre.lon - dLon, centre.lat + dLat, centre.lon + dLon];
}

/** Shortest distance from point p to segment ab, in metres (local planar). */
export function pointToSegment(p: LatLon, a: LatLon, b: LatLon): number {
  const m = metresPerDegree(p.lat);
  const px = p.lon * m.x, py = p.lat * m.y;
  const ax = a.lon * m.x, ay = a.lat * m.y;
  const bx = b.lon * m.x, by = b.lat * m.y;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function polylineLength(pts: LatLon[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += haversine(pts[i - 1]!, pts[i]!);
  return total;
}

/**
 * Uniform grid bucketing for nearest-feature lookups. We do a lot of "how many
 * trees are within 60m of this segment" queries; a flat scan over every POI is
 * O(edges x pois) and gets slow fast.
 */
export class SpatialGrid<T extends LatLon> {
  private cells = new Map<string, T[]>();
  private mx: number;
  private my: number;

  constructor(private cellSizeM: number, refLat: number) {
    const m = metresPerDegree(refLat);
    this.mx = m.x;
    this.my = m.y;
  }

  private key(lat: number, lon: number): string {
    const cx = Math.floor((lon * this.mx) / this.cellSizeM);
    const cy = Math.floor((lat * this.my) / this.cellSizeM);
    return `${cx}:${cy}`;
  }

  insert(item: T): void {
    const k = this.key(item.lat, item.lon);
    const bucket = this.cells.get(k);
    if (bucket) bucket.push(item);
    else this.cells.set(k, [item]);
  }

  insertAll(items: Iterable<T>): void {
    for (const it of items) this.insert(it);
  }

  /** Everything in the cells overlapping a radius around the point. Cheap superset. */
  near(lat: number, lon: number, radiusM: number): T[] {
    const span = Math.ceil(radiusM / this.cellSizeM);
    const cx = Math.floor((lon * this.mx) / this.cellSizeM);
    const cy = Math.floor((lat * this.my) / this.cellSizeM);
    const out: T[] = [];
    for (let i = -span; i <= span; i++) {
      for (let j = -span; j <= span; j++) {
        const bucket = this.cells.get(`${cx + i}:${cy + j}`);
        if (bucket) out.push(...bucket);
      }
    }
    return out;
  }

  /** Items genuinely within radiusM, distance-checked. */
  within(lat: number, lon: number, radiusM: number): T[] {
    const p = { lat, lon };
    return this.near(lat, lon, radiusM).filter((c) => haversine(p, c) <= radiusM);
  }
}
