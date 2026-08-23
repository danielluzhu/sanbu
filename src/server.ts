/** sanbu — HTTP server. Static assets plus the walk-planning endpoint. */
import { buildGraph, type WalkGraph } from "./graph";
import { planLoop, type Preferences } from "./route";
import { haversine, type LatLon } from "./geo";

const PORT = Number(process.env.PORT ?? 4321);

/**
 * Graphs are expensive to build (several upstream calls) and highly reusable —
 * anyone starting within a few hundred metres of a previous request can share
 * one. Keep a handful in memory keyed by rounded centre.
 */
const graphCache = new Map<string, { graph: WalkGraph; at: number }>();
const GRAPH_TTL = 30 * 60 * 1000;
const MAX_GRAPHS = 6;

async function getGraph(centre: LatLon, radiusM: number): Promise<WalkGraph> {
  for (const [key, entry] of graphCache) {
    if (Date.now() - entry.at > GRAPH_TTL) {
      graphCache.delete(key);
      continue;
    }
    if (haversine(entry.graph.centre, centre) < 400) return entry.graph;
  }

  const graph = await buildGraph(centre, radiusM);
  graphCache.set(`${centre.lat.toFixed(3)},${centre.lon.toFixed(3)}:${radiusM}`, {
    graph,
    at: Date.now(),
  });
  while (graphCache.size > MAX_GRAPHS) {
    const oldest = [...graphCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!oldest) break;
    graphCache.delete(oldest[0]);
  }
  return graph;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const SF = { south: 37.69, west: -122.55, north: 37.84, east: -122.34 };

function inServiceArea(p: LatLon): boolean {
  return p.lat >= SF.south && p.lat <= SF.north && p.lon >= SF.west && p.lon <= SF.east;
}

async function plan(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Expected a JSON body." }, 400);
  }

  const lat = Number(body.lat);
  const lon = Number(body.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return json({ error: "A valid lat and lon are required." }, 400);
  }

  const origin = { lat, lon };
  if (!inServiceArea(origin)) {
    return json(
      {
        error:
          "sanbu's safety data is San Francisco's Vision Zero network, so walks " +
          "are limited to San Francisco for now.",
        outOfArea: true,
      },
      400,
    );
  }

  const minutes = Math.max(10, Math.min(120, Number(body.minutes) || 40));
  const prefs: Preferences = {
    minutes,
    scenic: Math.max(0, Math.min(1, Number(body.scenic ?? 0.6))),
    hills: body.hills === "seek" ? "seek" : "avoid",
  };

  // Enough room for the loop to breathe without pulling half the city.
  const radiusM = Math.min(2600, Math.max(900, minutes * 1.33 * 60 * 0.42));

  try {
    const graph = await getGraph(origin, radiusM);
    if (graph.edges.length === 0) {
      return json({ error: "No walkable streets found around that point." }, 404);
    }

    const walk = planLoop(graph, origin, prefs);
    if (!walk) {
      return json(
        { error: "Could not find a loop from there. Try a longer walk or a nearby street." },
        404,
      );
    }

    return json({
      walk,
      meta: {
        edges: graph.edges.length,
        nodes: graph.nodes.size,
        features: graph.features.length,
        radiusM: Math.round(radiusM),
      },
    });
  } catch (err) {
    console.error("plan failed:", err);
    return json(
      { error: `Upstream map data is unavailable right now. ${(err as Error).message}` },
      502,
    );
  }
}

const staticFile = (path: string, type: string) =>
  new Response(Bun.file(path), { headers: { "content-type": type } });

const server = Bun.serve({
  port: PORT,
  idleTimeout: 240,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/api/plan" && req.method === "POST") return plan(req);
    if (pathname === "/api/health") return json({ ok: true, graphs: graphCache.size });

    if (pathname === "/" || pathname === "/index.html") {
      return staticFile("public/index.html", "text/html; charset=utf-8");
    }
    if (pathname === "/app.js") return staticFile("public/app.js", "text/javascript");
    if (pathname === "/style.css") return staticFile("public/style.css", "text/css");

    if (pathname === "/vendor/leaflet.js") {
      return staticFile("node_modules/leaflet/dist/leaflet.js", "text/javascript");
    }
    if (pathname === "/vendor/leaflet.css") {
      return staticFile("node_modules/leaflet/dist/leaflet.css", "text/css");
    }
    if (pathname.startsWith("/vendor/images/")) {
      const name = pathname.slice("/vendor/images/".length);
      if (/^[\w.-]+$/.test(name)) {
        return staticFile(`node_modules/leaflet/dist/images/${name}`, "image/png");
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`sanbu listening on http://localhost:${server.port}`);
