/**
 * Bakes San Francisco's designated landmarks and historic districts into a
 * static asset.
 *
 * Three DataSF datasets, fetched once at build time and committed, for the same
 * reason the High Injury Network is:
 *
 *   rzic-39gi  Landmarks — the Article 10 individual landmarks, with the year
 *              built, architectural style, architect and, for a minority of
 *              them, real prose about why the building matters.
 *   knm6-5ej6  Landmark Districts — 20 designated historic districts, as
 *              polygons rather than points, because walking *through* Liberty
 *              Hill is not the same as passing a dot at the middle of it.
 *   5xmc-5bjj  Cultural Districts — Japantown, Calle 24, the Transgender
 *              District and the rest. Living neighbourhoods rather than
 *              preserved architecture, and just as much a reason to walk.
 *
 * Landmark photographs are deliberately not baked. The photo URLs in rzic-39gi
 * already 404 — SF Planning has moved them at least once — and 300 rotting
 * links committed to a repository is worse than none. Wikimedia geosearch
 * already covers buildings this notable.
 *
 *   bun run scripts/build-landmarks.ts
 */
import { mkdir } from "node:fs/promises";

const OUT = "web/data/landmarks.json";
const LANDMARKS = "rzic-39gi";
const LANDMARK_DISTRICTS = "knm6-5ej6";
const CULTURAL_DISTRICTS = "5xmc-5bjj";

type Ring = number[][]; // [lon, lat] pairs, as GeoJSON orders them
interface Geometry {
  type: string;
  coordinates: unknown;
}

const round = (n: number) => Math.round(n * 1e5) / 1e5;

async function soda<T>(dataset: string, query = ""): Promise<T[]> {
  const url = `https://data.sfgov.org/resource/${dataset}.json?$limit=5000${query}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`DataSF ${dataset} ${res.status}`);
  return (await res.json()) as T[];
}

/** Every outer ring in a Polygon or MultiPolygon, ignoring holes. */
function outerRings(geom: Geometry | undefined): Ring[] {
  if (!geom) return [];
  if (geom.type === "Polygon") {
    const rings = geom.coordinates as Ring[];
    return rings[0] ? [rings[0]] : [];
  }
  if (geom.type === "MultiPolygon") {
    return (geom.coordinates as Ring[][]).map((p) => p[0]).filter((r): r is Ring => !!r);
  }
  return [];
}

/** Rough bounding-box area, only ever used to pick the biggest ring. */
function ringSpan(ring: Ring): number {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x! < minX) minX = x!;
    if (x! > maxX) maxX = x!;
    if (y! < minY) minY = y!;
    if (y! > maxY) maxY = y!;
  }
  return (maxX - minX) * (maxY - minY);
}

function centroid(ring: Ring): { lat: number; lon: number } | null {
  if (ring.length === 0) return null;
  let x = 0;
  let y = 0;
  for (const [lon, lat] of ring) {
    x += lon!;
    y += lat!;
  }
  return { lat: round(y / ring.length), lon: round(x / ring.length) };
}

/**
 * Douglas–Peucker, in degrees. District outlines follow parcel lines and carry
 * far more vertices than a map at walking zoom can show — one of them has 1,692
 * for a shape you could draw with thirty.
 */
function simplify(ring: Ring, tolerance = 0.00004): Ring {
  if (ring.length <= 4) return ring;

  const keep = new Uint8Array(ring.length);
  keep[0] = 1;
  keep[ring.length - 1] = 1;

  const stack: Array<[number, number]> = [[0, ring.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let worst = 0;
    let index = -1;
    const [ax, ay] = ring[first]!;
    const [bx, by] = ring[last]!;
    const dx = bx! - ax!;
    const dy = by! - ay!;
    const len2 = dx * dx + dy * dy;

    for (let i = first + 1; i < last; i++) {
      const [px, py] = ring[i]!;
      let t = len2 === 0 ? 0 : ((px! - ax!) * dx + (py! - ay!) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px! - (ax! + t * dx), py! - (ay! + t * dy));
      if (d > worst) {
        worst = d;
        index = i;
      }
    }

    if (index >= 0 && worst > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  return ring.filter((_, i) => keep[i] === 1);
}

function flatten(ring: Ring): number[] {
  const flat: number[] = [];
  for (const [lon, lat] of ring) flat.push(round(lat!), round(lon!));
  return flat;
}

/**
 * The first sentence or two of a landmark's significance, or nothing.
 *
 * Most rows read "Coming Soon!" — the city has written real text for only about
 * one in five. A placeholder shown as history is worse than an honest silence.
 */
function story(raw: string | undefined): string | undefined {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  if (text.length < 60) return undefined;
  if (/^coming soon/i.test(text)) return undefined;

  let out = "";
  for (const sentence of text.split(/(?<=\.)\s+/)) {
    if (out && out.length + sentence.length > 280) break;
    out += (out ? " " : "") + sentence;
    if (out.length > 180) break;
  }
  return out || text.slice(0, 280);
}

/** "1928" out of whatever the year columns happen to contain. */
function year(raw: string | undefined): number | undefined {
  const match = /(1[6-9]\d{2}|20\d{2})/.exec(raw ?? "");
  return match ? Number(match[1]) : undefined;
}

function clean(raw: string | undefined): string | undefined {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!text || text === "N/A" || text === "Unknown") return undefined;
  return text;
}

/* ---------- Individual landmarks ---------- */

interface LandmarkRow {
  the_geom?: Geometry;
  name?: string;
  landmarkno?: string;
  yearbuilt?: string;
  yeardes?: string;
  proptype?: string;
  style?: string;
  archbuild?: string;
  description?: string;
  sigsum?: string;
  status?: string;
}

console.log("  fetching individual landmarks…");
const rows = await soda<LandmarkRow>(LANDMARKS);
console.log(`    ${rows.length} rows`);

interface BakedLandmark {
  n: string;
  lat: number;
  lon: number;
  no?: string;
  yr?: number;
  des?: number;
  ty?: string;
  st?: string;
  ar?: string;
  why?: string;
  d?: string;
}

const byNumber = new Map<string, BakedLandmark>();
let skippedPending = 0;

for (const row of rows) {
  // "Work Program" means the designation is still being drafted. Only adopted
  // landmarks are landmarks.
  if ((row.status ?? "").trim() !== "Adopted") {
    skippedPending++;
    continue;
  }
  const name = clean(row.name);
  if (!name) continue;

  // A landmark spanning several parcels arrives as one row per parcel; the
  // largest ring is the one worth taking a centre from.
  const rings = outerRings(row.the_geom);
  if (rings.length === 0) continue;
  const biggest = rings.reduce((a, b) => (ringSpan(a) >= ringSpan(b) ? a : b));
  const centre = centroid(biggest);
  if (!centre) continue;

  const key = clean(row.landmarkno) ?? name;
  if (byNumber.has(key)) continue;

  byNumber.set(key, {
    n: name,
    lat: centre.lat,
    lon: centre.lon,
    no: clean(row.landmarkno),
    yr: year(row.yearbuilt),
    des: year(row.yeardes),
    ty: clean(row.proptype),
    st: clean(row.style),
    ar: clean(row.archbuild),
    why: clean(row.sigsum),
    d: story(row.description),
  });
}

const landmarks = [...byNumber.values()].sort((a, b) => a.n.localeCompare(b.n));
console.log(
  `    ${landmarks.length} adopted landmarks (${skippedPending} still in work program), ` +
    `${landmarks.filter((l) => l.d).length} with written history`,
);

/* ---------- Districts ---------- */

interface DistrictRow {
  the_geom?: Geometry;
  geometry?: Geometry;
  multigeom?: Geometry;
  district?: string;
  district_name?: string;
  datelisted?: string;
  designation_date?: string;
}

interface BakedDistrict {
  n: string;
  k: "historic" | "cultural";
  yr?: number;
  rings: number[][];
}

/** Title Case, because the districts dataset shouts its names in caps. */
function titleCase(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\bAnd\b/g, "and")
    .replace(/\bOf\b/g, "of");
}

async function districts(
  dataset: string,
  kind: "historic" | "cultural",
  label: string,
): Promise<BakedDistrict[]> {
  console.log(`  fetching ${label}…`);
  const raw = await soda<DistrictRow>(dataset);
  const merged = new Map<string, BakedDistrict>();

  for (const row of raw) {
    const name = clean(row.district_name) ?? clean(row.district);
    if (!name) continue;
    const rings = outerRings(row.the_geom ?? row.geometry ?? row.multigeom);
    if (rings.length === 0) continue;

    const title = /[a-z]/.test(name) ? name : titleCase(name);
    // A district in several pieces — Market Street Masonry is six — arrives as
    // one row per piece. It is still one district.
    const district = merged.get(title) ?? {
      n: title,
      k: kind,
      yr: year(row.datelisted ?? row.designation_date),
      rings: [],
    };
    for (const ring of rings) {
      const flat = flatten(simplify(ring));
      if (flat.length >= 8) district.rings.push(flat);
    }
    merged.set(title, district);
  }

  const out = [...merged.values()];

  const before = raw.reduce(
    (n, r) => n + outerRings(r.the_geom ?? r.geometry ?? r.multigeom).reduce((m, x) => m + x.length, 0),
    0,
  );
  const after = out.reduce((n, d) => n + d.rings.reduce((m, r) => m + r.length / 2, 0), 0);
  console.log(`    ${out.length} districts, ${before} → ${after} vertices`);
  return out.filter((d) => d.rings.length > 0);
}

const historicDistricts = await districts(LANDMARK_DISTRICTS, "historic", "landmark districts");
const culturalDistricts = await districts(CULTURAL_DISTRICTS, "cultural", "cultural districts");

/* ---------- Write ---------- */

await mkdir("web/data", { recursive: true });
const body = JSON.stringify({
  source: [LANDMARKS, LANDMARK_DISTRICTS, CULTURAL_DISTRICTS].map(
    (d) => `https://data.sfgov.org/resource/${d}.json`,
  ),
  name: "San Francisco designated landmarks, historic districts and cultural districts",
  landmarks,
  districts: [...historicDistricts, ...culturalDistricts],
});
await Bun.write(OUT, body);

console.log(
  `\n${OUT}: ${landmarks.length} landmarks, ` +
    `${historicDistricts.length + culturalDistricts.length} districts, ` +
    `${(body.length / 1024).toFixed(0)} KB raw, ` +
    `${(Bun.gzipSync(Buffer.from(body)).length / 1024).toFixed(0)} KB gzipped`,
);
