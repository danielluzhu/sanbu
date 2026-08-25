/** Overpass API access: the walkable street graph and the scenic features on it. */
import { cached } from "./store";
import type { LatLon } from "./geo";
import { parseDirection } from "./sun";
import type { District, Landmark } from "./landmarks";

/**
 * Mirrors must send `Access-Control-Allow-Origin`, because this runs in the
 * browser. Several popular Overpass mirrors (kumi.systems, private.coffee) do
 * not, and a failover to one of those fails outright at the CORS layer rather
 * than returning an error we can retry.
 *
 * A mirror must also carry the whole planet. `overpass.osm.ch` was here and
 * had to go: it serves a Switzerland-only extract, so every San Francisco
 * query came back `200 OK` with zero elements and the app built an empty city
 * rather than reporting a failure. Verify both properties before adding one.
 */
const ENDPOINTS = ["https://overpass-api.de/api/interpreter"];

const WEEK = 7 * 24 * 60 * 60 * 1000;

export interface OsmNode extends LatLon {
  id: number;
  tags?: Record<string, string>;
}

export interface OsmWay {
  id: number;
  nodes: number[];
  tags: Record<string, string>;
}

export interface OverpassResult {
  nodes: OsmNode[];
  ways: OsmWay[];
}

interface RawElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  tags?: Record<string, string>;
  center?: { lat: number; lon: number };
}

/**
 * Overpass gives each client only a couple of execution slots and answers with
 * a 429/504 when you exceed them. Every query is therefore funnelled through a
 * single-file queue, and each one retries across mirrors with backoff.
 */
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  // Keep the chain alive even when a job rejects.
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function attempt(url: string, ql: string): Promise<RawElement[]> {
  // `user-agent` is a forbidden header name in browsers: setting it is ignored
  // there, so it is only sent from the Bun build where Overpass etiquette asks
  // for it. A URLSearchParams body keeps this a simple CORS request.
  const headers: Record<string, string> =
    typeof window === "undefined" ? { "user-agent": "sanbu (scenic walk planner)" } : {};

  const res = await fetch(url, {
    method: "POST",
    body: new URLSearchParams({ data: ql }),
    headers,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200).replace(/\s+/g, " ");
    throw new Error(`Overpass ${res.status} from ${new URL(url).host}: ${detail}`);
  }
  const json = (await res.json()) as { elements?: RawElement[]; remark?: string };
  if (json.remark && !json.elements) throw new Error(`Overpass remark: ${json.remark}`);
  return json.elements ?? [];
}

function query(ql: string): Promise<RawElement[]> {
  return serialize(async () => {
    let lastErr: unknown;
    for (let round = 0; round < 3; round++) {
      for (const url of ENDPOINTS) {
        try {
          return await attempt(url, ql);
        } catch (err) {
          lastErr = err;
        }
      }
      // Slots free up on a timescale of seconds, so back off before retrying.
      await sleep(2000 * (round + 1));
    }
    throw new Error(`Overpass unavailable: ${String(lastErr)}`);
  });
}

/**
 * Ways you can legally and sensibly walk on. `steps` is deliberately included —
 * in San Francisco the public stairways are destinations in their own right.
 */
const WALKABLE =
  "^(footway|path|pedestrian|steps|living_street|residential|unclassified|" +
  "service|track|tertiary|secondary|primary|cycleway)$";

export async function fetchWalkNetwork(
  bbox: [number, number, number, number],
): Promise<OverpassResult> {
  const b = bbox.map((n) => n.toFixed(5)).join(",");
  const ql = `[out:json][timeout:80];
(
  way["highway"~"${WALKABLE}"]["foot"!~"^(no|private)$"]["access"!~"^(no|private)$"](${b});
);
out body;
>;
out skel qt;`;

  const key = `walk:${b}`;
  const elements = await cached<RawElement[]>(key, WEEK, async () => {
    const raw = await query(ql);
    // Nowhere in San Francisco has no streets. An empty answer means the
    // mirror let us down, and caching it for a week would be worse than
    // failing now.
    if (raw.length === 0) throw new Error("Overpass returned no streets for that area");
    return raw;
  });

  const nodes: OsmNode[] = [];
  const ways: OsmWay[] = [];
  for (const el of elements) {
    if (el.type === "node" && el.lat !== undefined && el.lon !== undefined) {
      nodes.push({ id: el.id, lat: el.lat, lon: el.lon, tags: el.tags });
    } else if (el.type === "way" && el.nodes) {
      ways.push({ id: el.id, nodes: el.nodes, tags: el.tags ?? {} });
    }
  }
  return { nodes, ways };
}

export type FeatureKind =
  | "viewpoint"
  | "park"
  | "garden"
  | "water"
  | "beach"
  | "tree"
  | "artwork"
  | "historic"
  | "attraction"
  /* Places with a door and a closing time. */
  | "cafe"
  | "bar"
  | "market"
  | "shop"
  | "culture"
  /* A landmark the city has actually designated, and the districts. */
  | "landmark"
  | "district";

export interface ScenicFeature extends LatLon {
  id: string;
  kind: FeatureKind;
  name?: string;
  /** Raw OSM `opening_hours`, where the mapper recorded one. */
  opening?: string;
  /** Compass bearing you look along, for viewpoints that record it. */
  facing?: number;
  /** Metres this point stands above the ground around it. Viewpoints only. */
  prominence?: number;
  /**
   * 0..1 — how much this particular one matters, within its kind.
   *
   * OpenStreetMap files the San Francisco Mint and a bench plaque under the
   * same `historic=*` tag, so without this a walk past a plaque scores like a
   * walk past a national monument. Defaults to 1 for kinds where every member
   * is equivalent.
   */
  significance?: number;
  /** The city's own record, for a designated landmark. */
  landmark?: Landmark;
  /** The district itself, for the synthetic feature representing one. */
  district?: District;
}

/**
 * Scenic features. Areas (parks, water) come back via `out center` so a park
 * is a single weighted point rather than a polygon — good enough for proximity
 * scoring and far cheaper than real point-in-polygon work.
 */
export async function fetchScenicFeatures(
  bbox: [number, number, number, number],
): Promise<ScenicFeature[]> {
  const b = bbox.map((n) => n.toFixed(5)).join(",");
  const ql = `[out:json][timeout:80];
(
  node["tourism"="viewpoint"](${b});
  node["tourism"="artwork"](${b});
  node["natural"="tree"](${b});
  nwr["historic"](${b});
  nwr["heritage"](${b});
  node["tourism"="attraction"](${b});
  way["leisure"~"^(park|garden|nature_reserve)$"](${b});
  way["natural"~"^(water|beach|wood)$"](${b});
  way["landuse"="forest"](${b});
  relation["leisure"~"^(park|nature_reserve)$"](${b});
);
out center tags;`;

  // v3: `historic` widened from nodes to ways and relations and `heritage`
  // added (v2), then historic districts excluded as points (v3). Anything
  // cached under an older key has the wrong features in it.
  const key = `scenic:v3:${b}`;
  const elements = await cached<RawElement[]>(key, WEEK, () => query(ql));

  const out: ScenicFeature[] = [];
  for (const el of elements) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat === undefined || lon === undefined) continue;
    const t = el.tags ?? {};
    const kind = classify(t);
    if (!kind) continue;
    out.push({
      id: `${el.type[0]}${el.id}`,
      lat,
      lon,
      kind,
      name: t.name,
      opening: t.opening_hours,
      facing: kind === "viewpoint" ? parseDirection(t.direction) : undefined,
      significance: kind === "historic" ? historicSignificance(t) : undefined,
    });
  }
  return out;
}

/**
 * Places you might actually stop at: coffee, books, a bar, a gallery.
 *
 * Kept to the kinds worth crossing a street for — no petrol stations, no
 * pharmacies. Fetched separately from the scenery so that the two can be
 * cached independently, and because these are the only features whose worth
 * depends on the clock.
 */
export async function fetchPlaces(
  bbox: [number, number, number, number],
): Promise<ScenicFeature[]> {
  const b = bbox.map((n) => n.toFixed(5)).join(",");
  const ql = `[out:json][timeout:80];
(
  nwr["amenity"~"^(cafe|bar|pub|ice_cream|marketplace|library|theatre|cinema)$"](${b});
  nwr["shop"~"^(bakery|books|art|antiques|music|second_hand|florist|greengrocer|deli|chocolate|coffee|tea|farm|craft|garden_centre|gift|frame|pottery|photo)$"](${b});
  nwr["tourism"~"^(museum|gallery)$"](${b});
);
out center tags;`;

  const key = `places:${b}`;
  const elements = await cached<RawElement[]>(key, WEEK, () => query(ql));

  const out: ScenicFeature[] = [];
  for (const el of elements) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat === undefined || lon === undefined) continue;
    const t = el.tags ?? {};
    const kind = classifyPlace(t);
    if (!kind) continue;
    out.push({
      id: `${el.type[0]}${el.id}`,
      lat,
      lon,
      kind,
      name: t.name,
      opening: t.opening_hours,
    });
  }
  return out;
}

function classifyPlace(t: Record<string, string>): FeatureKind | null {
  const amenity = t.amenity ?? "";
  const shop = t.shop ?? "";

  if (amenity === "cafe" || amenity === "ice_cream") return "cafe";
  if (["bakery", "coffee", "chocolate", "tea", "deli", "pastry"].includes(shop)) return "cafe";
  if (amenity === "bar" || amenity === "pub") return "bar";
  if (amenity === "marketplace" || shop === "greengrocer" || shop === "farm") return "market";
  if (t.tourism === "museum" || t.tourism === "gallery" || shop === "art") return "culture";
  if (["library", "theatre", "cinema"].includes(amenity)) return "culture";
  if (shop) return "shop";
  return null;
}

/**
 * Historic sites you would cross town for, versus historic sites you would
 * read in passing.
 *
 * OpenStreetMap has no notion of importance, so this reads the tags that stand
 * in for one: a national heritage grade or a National Register listing is the
 * strongest signal, then having an encyclopaedia article about you, then being
 * a whole building rather than a marker, then merely being named.
 */
const SUBSTANTIAL = new Set([
  "building", "church", "chapel", "monastery", "castle", "fort", "citadel",
  "monument", "ruins", "ship", "aircraft", "tower", "manor", "farm", "mint",
  "aqueduct", "bridge", "locomotive", "railway_station", "lighthouse", "wreck",
]);

function historicSignificance(t: Record<string, string>): number {
  const grade = Number.parseInt(t.heritage ?? "", 10);
  if ((Number.isFinite(grade) && grade <= 2) || t["ref:nrhp"]) return 1;
  if (t.wikidata || t.wikipedia) return 0.75;

  let score = SUBSTANTIAL.has(t.historic ?? "") ? 0.5 : 0.25;
  if (Number.isFinite(grade)) score = Math.max(score, 0.55);
  if (t.name) score += 0.1;
  return Math.min(1, score);
}

function classify(t: Record<string, string>): FeatureKind | null {
  // A district is an area you are inside, not a point you pass. San Francisco
  // publishes its own district boundaries as polygons, which is a far better
  // answer than the centre of a neighbourhood-sized centroid — and this has to
  // be decided before anything else, because these are commonly also tagged
  // `tourism=attraction` and would otherwise come through as a landmark pin
  // dropped in the middle of a neighbourhood.
  if (t.historic === "district" || t.boundary === "protected_area") return null;

  if (t.tourism === "viewpoint") return "viewpoint";
  if (t.natural === "tree") return "tree";
  if (t.natural === "water") return "water";
  if (t.natural === "beach") return "beach";
  if (t.leisure === "garden") return "garden";
  if (t.leisure === "park" || t.leisure === "nature_reserve") return "park";
  if (t.natural === "wood" || t.landuse === "forest") return "park";
  if (t.tourism === "artwork") return "artwork";
  if (t.tourism === "attraction") return "attraction";
  if (t.historic || t.heritage) return "historic";
  return null;
}
