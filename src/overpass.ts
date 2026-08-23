/** Overpass API access: the walkable street graph and the scenic features on it. */
import { cached } from "./store";
import type { LatLon } from "./geo";

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

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
  const elements = await cached<RawElement[]>(key, WEEK, () => query(ql));

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
  | "attraction";

export interface ScenicFeature extends LatLon {
  id: string;
  kind: FeatureKind;
  name?: string;
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
  node["historic"](${b});
  node["tourism"="attraction"](${b});
  way["leisure"~"^(park|garden|nature_reserve)$"](${b});
  way["natural"~"^(water|beach|wood)$"](${b});
  way["landuse"="forest"](${b});
  relation["leisure"~"^(park|nature_reserve)$"](${b});
);
out center tags;`;

  const key = `scenic:${b}`;
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
    });
  }
  return out;
}

function classify(t: Record<string, string>): FeatureKind | null {
  if (t.tourism === "viewpoint") return "viewpoint";
  if (t.natural === "tree") return "tree";
  if (t.natural === "water") return "water";
  if (t.natural === "beach") return "beach";
  if (t.leisure === "garden") return "garden";
  if (t.leisure === "park" || t.leisure === "nature_reserve") return "park";
  if (t.natural === "wood" || t.landuse === "forest") return "park";
  if (t.tourism === "artwork") return "artwork";
  if (t.tourism === "attraction") return "attraction";
  if (t.historic) return "historic";
  return null;
}
