# sanbu

**The scenic way round.** Give it your location in San Francisco and a time budget, and it
returns a loop walk back to where you started — routed toward viewpoints, parks, tree cover
and public stairways, and away from the streets that hurt pedestrians.

**Live at [danielluzhu.github.io/sanbu](https://danielluzhu.github.io/sanbu)** — a static site with
no backend. The entire routing engine runs in your browser.

---

## What makes a walk "good"

Every street segment in the area is scored on three axes, and the router optimises over all
three at once rather than finding the shortest path.

### Scenery

Points of interest come from OpenStreetMap, each contributing on a linear falloff out to its
own radius — a viewpoint 40m away counts for much more than one 200m away:

| Feature | Radius | Weight |
| --- | --- | --- |
| Viewpoint | 220m | 1.00 |
| Beach | 260m | 0.70 |
| Water | 220m | 0.60 |
| Park | 130m | 0.55 |
| Garden | 110m | 0.50 |
| Attraction | 120m | 0.35 |
| Historic site / public artwork | 80–90m | 0.30 |
| Street tree | 35m | 0.10, saturating |

Only the strongest contribution of each *type* counts, so a street lined with forty trees
cannot out-score an actual panorama. Traffic-separated paths get +0.25 and stairways +0.20 on
top.

### Safety

The base signal is San Francisco's **Vision Zero High Injury Network** — the ~12% of streets
that account for the large majority of severe and fatal traffic injuries
([DataSF `enwt-3u8m`](https://data.sfgov.org/resource/enwt-3u8m.json)). The geometry is baked
into a static asset at build time rather than fetched per visit.

Crime data was deliberately left out. At single-block granularity it mostly reflects
reporting patterns and foot traffic rather than risk, and crime-weighted routing tends to
encode socioeconomic bias into which neighbourhoods get quietly avoided. The High Injury
Network is pedestrian-specific, objective, and directly relevant to someone on foot.

Segments are classified into three kinds, because in San Francisco `highway=footway` means two
very different things:

- **Traffic-separated** (park paths, promenades, stairways, alleys) — near-zero hazard.
- **Roadside footways** (`footway=sidewalk`, `footway=crossing`) — a sidewalk beside an
  arterial is not a car-free path. It inherits the corridor's risk, +0.34 if on the HIN.
- **Roadways** — scored by class, +0.45 if on the HIN, adjusted for sidewalks, lighting,
  speed limit and tunnels.

### Hills

Elevation comes from a ~90m terrain lattice covering the whole city, baked at build time and
bilinearly interpolated per node. Sampling it live was the original design and it was wrong:
every first-time visitor fired a burst of requests at the elevation API, got rate limited, and
silently received flat terrain — which quietly disabled the hills preference entirely.

Hills are both the cost and the payoff — the views are at the top. **Spare my legs** penalises
gradient; **Take me up** discounts climbing *and* biases the turnaround anchor toward high
ground, which is what actually produces a summit loop. Walking time uses a Naismith-style
model: flat pace plus 7 seconds per metre climbed, with stairways walked slower.

## How a loop gets built

A round trip is two legs:

1. **Outbound** — Dijkstra over the weighted graph to find every node reachable in ~44% of the
   time budget. Turnaround anchors are picked from that band, bucketed into 8 compass sectors
   so candidate loops explore genuinely different directions, and ranked by how cheaply they
   were reached (plus elevation, if you asked for hills).
2. **Return** — Dijkstra back from the anchor with every outbound edge charged a **6x retrace
   premium**. Without it, every "loop" collapses into an out-and-back down the same street.

Each candidate is then judged on scenery, hazard, self-overlap and how close it lands to the
time you asked for, with running over budget penalised harder than coming in under.

## Running it

```bash
bun install
bun run dev          # builds, then serves dist/ on http://localhost:4321
```

`bun run build` produces the static site in `dist/`. `bun run typecheck` checks types. The dev
server only serves `dist/`, so what you test locally is byte for byte what Pages will serve.

The first walk in a new area takes 10–20 seconds while it fetches the street network and scenic
features from Overpass. After that IndexedDB serves them and replanning is under a second.

### Regenerating the baked data

Neither is needed for a normal build — both are committed.

```bash
bun run build:hin          # DataSF High Injury Network -> web/data/hin.json
bun run scripts/build-elevation.ts   # terrain lattice -> web/data/elevation.json
```

The elevation bake takes a while and both providers throttle bursts, so it is paced, fails over
between Open-Meteo and OpenTopoData, and checkpoints as it goes — rerun it to resume.

## Layout

```
src/                Routing engine — no platform assumptions
  graph.ts          OSM ways -> routable graph, split at junctions, scored
  route.ts          Loop generation, cost model, Dijkstra, candidate judging
  hin.ts            Vision Zero High Injury Network + spatial index
  elevation.ts      Terrain lattice loading and interpolation
  overpass.ts       Overpass access — serialised queue, mirror failover, retries
  geo.ts            Haversine, local planar projection, spatial grid
  store.ts          Cache interface; IndexedDB in the browser
  server.ts         Local static dev server
web/
  main.ts           Browser entry — UI, map, and the graph cache
  index.html
  style.css
  data/             Baked HIN and elevation assets
scripts/
  build.ts          Bundles the static site into dist/
  build-hin.ts      Regenerates the High Injury Network asset
  build-elevation.ts  Regenerates the terrain lattice
```

## Why it is static

Every upstream the app needs sends `Access-Control-Allow-Origin: *`, so the browser can call
them directly. The two large, slow datasets — the High Injury Network and the terrain lattice —
are baked at build time, which leaves Overpass as the only live dependency. That has to stay
live: the street network is per-area and far too large to ship.

The consequence is that the whole thing is a folder of files. GitHub Pages serves it, there is
no server to keep running, and it costs nothing.

## Data sources

- [OpenStreetMap](https://openstreetmap.org/copyright) via Overpass — streets and features (ODbL)
- [DataSF](https://data.sfgov.org) — Vision Zero High Injury Network
- [Open-Meteo](https://open-meteo.com/) and [OpenTopoData](https://www.opentopodata.org/) — elevation
- [CARTO](https://carto.com/attributions) — dark basemap tiles

## Limits

- **San Francisco only.** The safety layer is SF's. Requests outside the city are rejected
  rather than silently falling back to a worse model.
- Overpass is a free public endpoint with rate limits. Queries are serialised behind a queue and
  cached in IndexedDB to stay well inside them.
- Scenic scores come from OSM coverage. A viewpoint nobody has mapped does not exist here.
- Terrain on a 90m lattice smooths the sharpest pitches; gradients are capped at 45%.
