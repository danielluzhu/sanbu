# sanbu

**The scenic way round.** Give it your location in San Francisco and a time budget, and it
returns a loop walk back to where you started — routed toward viewpoints, parks, tree cover
and public stairways, and away from the streets that hurt pedestrians.

Built with Bun, SQLite and Leaflet. No API keys.

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
([DataSF `enwt-3u8m`](https://data.sfgov.org/resource/enwt-3u8m.json), 5,917 segments).

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

Elevation comes from [Open-Meteo](https://open-meteo.com/)'s free terrain API, sampled on a
fixed ~90m lattice, cached permanently in SQLite and bilinearly interpolated per node.

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
bun run dev          # http://localhost:4321
```

`bun start` for production, `bun run typecheck` for types. `PORT` overrides the port.

The first request in a new area takes 10–20 seconds while it fetches the street network,
scenic features and terrain. After that SQLite serves it and replanning is ~1 second.

## Layout

```
src/
  server.ts     HTTP + in-memory graph cache (reused within 400m)
  graph.ts      OSM ways -> routable graph, split at junctions, scored
  route.ts      Loop generation, cost model, Dijkstra, candidate judging
  hin.ts        Vision Zero High Injury Network + spatial index
  elevation.ts  Terrain lattice, cached forever
  overpass.ts   Overpass access — serialised queue, mirror failover, retries
  geo.ts        Haversine, local planar projection, spatial grid
  db.ts         SQLite cache
public/         Single-page front end (Leaflet, no framework)
```

## Data sources

- [OpenStreetMap](https://openstreetmap.org/copyright) via Overpass — streets and features (ODbL)
- [DataSF](https://data.sfgov.org) — Vision Zero High Injury Network
- [Open-Meteo](https://open-meteo.com/) — elevation
- [CARTO](https://carto.com/attributions) — dark basemap tiles

## Limits

- **San Francisco only.** The safety layer is SF's. Requests outside the city are rejected
  rather than silently falling back to a worse model.
- Overpass and Open-Meteo are free public endpoints with rate limits; the cache exists to stay
  well inside them.
- Scenic scores come from OSM coverage. A viewpoint nobody has mapped does not exist here.
- Terrain on a 90m lattice smooths the sharpest pitches; gradients are capped at 45%.
