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

### The risk overlay

The **Risk** button on the map draws the High Injury Network over the city — the same data the
router weights against, made visible so you can see why a walk went the way it did.

It is labelled for what it is. This is *traffic* injury data from SFMTA and DPH: the streets
where people get hit by vehicles. It is not a crime map and the UI says so, because a red
overlay on a city map invites exactly that misreading.

Two things make it usable rather than a slideshow. It renders to a **canvas** instead of SVG —
~6,000 line strings is far too many individual DOM paths to pan smoothly — and only the segments
overlapping the current viewport are handed to the renderer. Drawing all ~19,000 vertices every
frame halved the pan rate in testing (30fps to 15); culling to the viewport and dropping the
soft glow pass below zoom 14 brought it back to 23.

### Photographs

Markers and the stop chips carry a photo of the place, found by geosearching
[Wikimedia Commons](https://commons.wikimedia.org) around each stop's coordinate — Commons
indexes images by where they were taken, so this needs no API key and no per-feature tagging.
Diagrams, maps and plaques are filtered out by title and file type. Photos load after the route
is already drawn, so they never hold up a walk, and author and licence are shown because most
Commons licences require attribution.

### Steps

The step estimate is not distance divided by a constant, because this app knows two things that
break that: stairways and gradient.

- **Stairways** get one footfall per tread. About 30% of San Francisco's stairways record a
  `step_count` in OpenStreetMap (the Vulcan Stairway declares 219), and those are used directly;
  the rest are estimated from their horizontal run at ~29cm per tread. Because a way gets split
  at junctions, the tag is converted to a per-metre density first — otherwise a stairway
  crossing three junctions would count its steps three times.
- **Slopes** shorten your stride, so the same distance costs more paces.
- **Height** sets the flat step length, at the usual 0.415 x height.

Steps come out as `stairSteps + strideDistance / stepLength`, where `strideDistance` is a
grade-adjusted distance computed once per walk. Keeping the two apart means moving the height
slider updates the estimate instantly, with no replanning. At 3.0km that spans 5,027 steps for
someone 155cm to 4,014 for someone 195cm.

## How a walk gets built

**Round trip** is two legs:

1. **Outbound** — Dijkstra over the weighted graph to find every node reachable in ~44% of the
   time budget. Turnaround anchors are picked from that band, bucketed into 8 compass sectors
   so candidates explore genuinely different directions, and ranked by how cheaply they were
   reached (plus elevation, if you asked for hills).
2. **Return** — Dijkstra back from the anchor with every outbound edge charged a **6x retrace
   premium**. Without it, every "loop" collapses into an out-and-back down the same street.

**One way** spends the whole budget going outward and stops there. The anchor is no longer a
turnaround but a destination, so arriving somewhere worth arriving at is weighted heavily:
endpoints with no viewpoint, park or beach within 160m are penalised hard, because finishing a
40-minute walk in the middle of an ordinary street is a poor reward.

Each candidate is judged on scenery, hazard, self-overlap and how close it lands to the time you
asked for, with running over budget penalised harder than coming in under.

### Choosing between routes

The route matters as much as the destination, so the planner returns up to **five** options
rather than one. They are kept genuinely distinct: at most one per compass sector until every
sector has had a turn, and any candidate sharing more than 55% of its length with an
already-chosen route is dropped — five variations on the same street is not a choice.

Each is then named for whatever it is best at within the offered set — *Most scenic*, *Safest*,
*Most stairways*, *Most car-free*, *Flattest*, *Shortest* — one label each, strongest claim
first. The alternatives are drawn on the map as faint dashed lines so the choice is visible,
and you can swipe the cards, click them, or use the arrow keys.

## Running it

```bash
bun install
bun run dev          # builds, then serves dist/ on http://localhost:4321
```

`bun run build` produces the static site in `dist/`. `bun run typecheck` checks types. The dev
server only serves `dist/`, so what you test locally is byte for byte what Pages will serve.

The first walk in a new area takes 10–20 seconds while it fetches the street network and scenic
features from Overpass. After that IndexedDB serves them and replanning is under a second.

### Publishing

```bash
bun run deploy          # typecheck, build, push main, publish dist/ to gh-pages
```

Publishing through GitHub Actions needs a token with the `workflow` scope. The workflow is
written and sits at `.github/workflows/pages.yml`, but until
`gh auth refresh -h github.com -s workflow` has been run it cannot be pushed, so `bun run deploy`
does the same job from here.

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
- [Wikimedia Commons](https://commons.wikimedia.org) — photographs, per their individual licences
- [CARTO](https://carto.com/attributions) — dark basemap tiles

## Limits

- **San Francisco only.** The safety layer is SF's. Requests outside the city are rejected
  rather than silently falling back to a worse model.
- Overpass is a free public endpoint with rate limits. Queries are serialised behind a queue and
  cached in IndexedDB to stay well inside them.
- Scenic scores come from OSM coverage. A viewpoint nobody has mapped does not exist here.
- Photos depend on Commons coverage. Well-known places have them; a quiet mini park may not.
- Terrain on a 90m lattice smooths the sharpest pitches; gradients are capped at 45%.
- Step counts are an estimate. Stride varies with pace, load and fatigue in ways height alone
  does not capture, so treat the number as a good guess rather than a pedometer reading.
