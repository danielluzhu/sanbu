/**
 * Builds a routable walking graph and scores every edge for scenery, hazard
 * and steepness.
 *
 * OSM ways are split at junctions so that each edge runs from one decision
 * point to the next, carrying the intermediate geometry along for drawing.
 */
import { warmElevation, elevationAt, type Lattice } from "./elevation";
import {
  fetchPlaces,
  fetchScenicFeatures,
  fetchWalkNetwork,
  type ScenicFeature,
} from "./overpass";
import { HinIndex, loadHin } from "./hin";
import { SpatialGrid, bboxAround, haversine, metresPerDegree, type LatLon } from "./geo";

export interface GraphNode extends LatLon {
  id: number;
  ele: number;
}

export interface Edge {
  id: number;
  from: number;
  to: number;
  pts: LatLon[];
  length: number;
  /**
   * 0..1, higher is prettier — as it would be in plain daylight with every
   * door open. Kept for display and for comparing routes to each other; the
   * router uses `scenicAt`, which reads this apart into its two halves below.
   */
  scenic: number;
  /** The part of `scenic` the clock cannot touch: canopy, car-free, stairways. */
  scenicBase: number;
  /**
   * The part that depends on when you walk past — views that need light,
   * places that need to be open. Weights are the score each would earn at its
   * best; the time of arrival scales them.
   */
  timed: TimedCredit[];
  /** 0..1, higher is more dangerous on foot. */
  hazard: number;
  /** Metres climbed walking from -> to (negative going down). */
  rise: number;
  /** Absolute gradient as a fraction, e.g. 0.12 for a 12% slope. */
  grade: number;
  highway: string;
  name?: string;
  onHin: boolean;
  isSteps: boolean;
  carFree: boolean;
  /** Named scenic features that earned this edge its score. */
  credits: ScenicFeature[];
  /** Treads on this edge, where OSM records them. Only set for stairways. */
  stepCount?: number;
  /** Nothing lights this stretch once the sun is down. */
  unlit: boolean;
}

/** A time-sensitive feature and the score it would contribute at its best. */
export interface TimedCredit {
  feature: ScenicFeature;
  weight: number;
}

export interface WalkGraph {
  nodes: Map<number, GraphNode>;
  edges: Edge[];
  adjacency: Map<number, number[]>;
  features: ScenicFeature[];
  centre: LatLon;
}

/** Distances at which each feature type stops contributing, and how much it gives. */
const SCENIC_RULES: Record<string, { radius: number; weight: number }> = {
  viewpoint: { radius: 220, weight: 1.0 },
  park: { radius: 130, weight: 0.55 },
  garden: { radius: 110, weight: 0.5 },
  water: { radius: 220, weight: 0.6 },
  beach: { radius: 260, weight: 0.7 },
  historic: { radius: 90, weight: 0.3 },
  artwork: { radius: 80, weight: 0.3 },
  attraction: { radius: 120, weight: 0.35 },
  tree: { radius: 35, weight: 0.1 },
  // Somewhere with a door is only worth it if you pass the door, so these
  // reach far less far than a view does.
  cafe: { radius: 70, weight: 0.42 },
  bar: { radius: 60, weight: 0.3 },
  market: { radius: 90, weight: 0.45 },
  shop: { radius: 60, weight: 0.28 },
  culture: { radius: 110, weight: 0.5 },
};

/** Feature kinds whose worth rises and falls with the hour. */
const TIME_SENSITIVE = new Set([
  "viewpoint",
  "park",
  "garden",
  "water",
  "beach",
  "historic",
  "artwork",
  "attraction",
  "cafe",
  "bar",
  "market",
  "shop",
  "culture",
]);

/**
 * Genuinely traffic-separated ways. `footway` is deliberately absent: San
 * Francisco maps its sidewalks as separate footway ways, and a sidewalk running
 * along an arterial is not a car-free path — it is the pavement beside the
 * traffic. Only footways that are *not* tagged as sidewalks or crossings (park
 * paths, alleys, promenades) count as car-free.
 */
const TRUE_CAR_FREE = new Set(["path", "pedestrian", "steps", "track", "cycleway"]);
const ROADSIDE_FOOTWAY = new Set(["sidewalk", "crossing", "traffic_island", "link"]);

function isCarFree(highway: string, tags: Record<string, string>): boolean {
  if (TRUE_CAR_FREE.has(highway)) return true;
  if (highway === "footway") return !ROADSIDE_FOOTWAY.has(tags.footway ?? "");
  return false;
}

/** A footway that exists because a road exists — inherits that road's risk. */
function isRoadside(highway: string, tags: Record<string, string>): boolean {
  return highway === "footway" && ROADSIDE_FOOTWAY.has(tags.footway ?? "");
}

/**
 * Rise and length are both sampled from the same smooth terrain field, so the
 * ratio is the local gradient at any edge length — only sub-5m stubs (kerb
 * links, crossing fragments) are pure noise. The cap sits just above the
 * steepest real San Francisco street grades.
 */
const GRADE_MIN_LENGTH = 5;
const GRADE_CAP = 0.45;
const ARTERIAL: Record<string, number> = {
  primary: 0.75,
  secondary: 0.6,
  tertiary: 0.32,
  unclassified: 0.16,
  service: 0.12,
  residential: 0.1,
  living_street: 0.04,
};

export async function buildGraph(centre: LatLon, radiusM: number): Promise<WalkGraph> {
  const bbox = bboxAround(centre, radiusM);

  const [network, scenery, places, hinSegments, lattice] = await Promise.all([
    fetchWalkNetwork(bbox),
    fetchScenicFeatures(bbox),
    fetchPlaces(bbox),
    loadHin(),
    warmElevation(bbox),
  ]);

  const features = [...scenery, ...places];
  measureProminence(features, lattice);

  const hin = new HinIndex(hinSegments, centre.lat);

  const coords = new Map<number, LatLon>();
  for (const n of network.nodes) coords.set(n.id, { lat: n.lat, lon: n.lon });

  // A node is a junction if two or more ways touch it, or it terminates a way.
  const usage = new Map<number, number>();
  for (const way of network.ways) {
    for (const id of way.nodes) usage.set(id, (usage.get(id) ?? 0) + 1);
  }

  const nodes = new Map<number, GraphNode>();
  const edges: Edge[] = [];
  const adjacency = new Map<number, number[]>();

  const ensureNode = (id: number): GraphNode | null => {
    const existing = nodes.get(id);
    if (existing) return existing;
    const c = coords.get(id);
    if (!c) return null;
    const node: GraphNode = { id, lat: c.lat, lon: c.lon, ele: elevationAt(lattice, c) };
    nodes.set(id, node);
    return node;
  };

  const featureGrid = new SpatialGrid<ScenicFeature>(60, centre.lat);
  featureGrid.insertAll(features);

  const link = (nodeId: number, edgeId: number) => {
    const list = adjacency.get(nodeId);
    if (list) list.push(edgeId);
    else adjacency.set(nodeId, [edgeId]);
  };

  for (const way of network.ways) {
    const tags = way.tags;
    const highway = tags.highway ?? "";
    const isSteps = highway === "steps";
    const carFree = isCarFree(highway, tags);

    // About a third of San Francisco's stairways record their tread count.
    // It is a property of the whole way, so convert it to a density now —
    // splitting at junctions would otherwise count it once per resulting edge.
    let stepsPerMetre: number | undefined;
    if (isSteps) {
      const declared = Number.parseInt(tags.step_count ?? "", 10);
      if (Number.isFinite(declared) && declared > 0 && declared < 2000) {
        let wayLength = 0;
        for (let i = 1; i < way.nodes.length; i++) {
          const a = coords.get(way.nodes[i - 1]!);
          const b = coords.get(way.nodes[i]!);
          if (a && b) wayLength += haversine(a, b);
        }
        if (wayLength > 0) stepsPerMetre = declared / wayLength;
      }
    }

    // Walk the way, cutting a new edge each time we reach a junction.
    let runStart: number | null = null;
    let runPts: LatLon[] = [];

    for (let i = 0; i < way.nodes.length; i++) {
      const id = way.nodes[i]!;
      const c = coords.get(id);
      if (!c) continue;

      if (runStart === null) {
        runStart = id;
        runPts = [c];
        continue;
      }

      runPts.push(c);
      const isJunction = (usage.get(id) ?? 0) > 1 || i === way.nodes.length - 1;
      if (!isJunction) continue;

      const a = ensureNode(runStart);
      const b = ensureNode(id);
      if (a && b && a.id !== b.id && runPts.length >= 2) {
        const edge = makeEdge(
          edges.length,
          a,
          b,
          runPts,
          tags,
          highway,
          isSteps,
          carFree,
          featureGrid,
          hin,
          stepsPerMetre,
        );
        if (edge.length > 0) {
          edges.push(edge);
          link(a.id, edge.id);
          link(b.id, edge.id);
        }
      }

      runStart = id;
      runPts = [c];
    }
  }

  return { nodes, edges, adjacency, features, centre };
}

function makeEdge(
  id: number,
  a: GraphNode,
  b: GraphNode,
  pts: LatLon[],
  tags: Record<string, string>,
  highway: string,
  isSteps: boolean,
  carFree: boolean,
  featureGrid: SpatialGrid<ScenicFeature>,
  hin: HinIndex,
  stepsPerMetre?: number,
): Edge {
  let length = 0;
  for (let i = 1; i < pts.length; i++) length += haversine(pts[i - 1]!, pts[i]!);

  // Sample the middle plus both ends so a long edge is not judged by one point.
  const samples: LatLon[] = [pts[0]!, pts[Math.floor(pts.length / 2)]!, pts[pts.length - 1]!];

  // Computed once and shared, so the reported HIN exposure and the hazard used
  // for routing can never disagree.
  const onHin = samples.some((s) => hin.isHighInjury(s));

  const { base, timed, credits } = scoreScenery(samples, featureGrid, carFree, isSteps);
  const hazard = scoreHazard(tags, highway, carFree, onHin);

  // The daylight-with-everything-open reading, for display and for ranking
  // routes against one another.
  let neutral = base;
  for (const c of timed) neutral += c.weight;

  const rise = b.ele - a.ele;
  const grade =
    length >= GRADE_MIN_LENGTH ? Math.min(GRADE_CAP, Math.abs(rise) / length) : 0;

  return {
    id,
    from: a.id,
    to: b.id,
    pts,
    length,
    scenic: Math.min(1, neutral),
    scenicBase: base,
    timed,
    hazard,
    rise,
    grade,
    highway,
    name: tags.name,
    onHin,
    isSteps,
    carFree,
    credits,
    stepCount: stepsPerMetre !== undefined ? stepsPerMetre * length : undefined,
    unlit: isUnlit(highway, tags),
  };
}

/**
 * Streets we should assume go dark. An explicit `lit=no` is the reliable
 * signal; beyond that only genuinely rural-feeling ways are presumed unlit,
 * because San Francisco lights its streets and its public stairways and
 * guessing otherwise would quietly ban half the city after 18:00 in winter.
 */
function isUnlit(highway: string, tags: Record<string, string>): boolean {
  if (tags.lit === "no") return true;
  if (tags.lit) return false;
  return highway === "path" || highway === "track";
}

/**
 * How far each viewpoint stands above the ground around it, sampled off the
 * terrain lattice. A railing 90m above its surroundings still earns its walk
 * after dark — that is when the city below turns into the view — whereas a
 * viewpoint at street level does not.
 */
function measureProminence(features: ScenicFeature[], lattice: Lattice): void {
  const RING_M = 350;
  for (const f of features) {
    if (f.kind !== "viewpoint") continue;
    const here = elevationAt(lattice, f);
    const m = metresPerDegree(f.lat);
    let around = 0;
    const SAMPLES = 8;
    for (let i = 0; i < SAMPLES; i++) {
      const angle = (i / SAMPLES) * 2 * Math.PI;
      around += elevationAt(lattice, {
        lat: f.lat + (Math.sin(angle) * RING_M) / m.y,
        lon: f.lon + (Math.cos(angle) * RING_M) / m.x,
      });
    }
    f.prominence = here - around / SAMPLES;
  }
}

function scoreScenery(
  samples: LatLon[],
  grid: SpatialGrid<ScenicFeature>,
  carFree: boolean,
  isSteps: boolean,
): { base: number; timed: TimedCredit[]; credits: ScenicFeature[] } {
  // Best contribution per feature type, so a street lined with 40 trees does
  // not out-score an actual panorama.
  const best = new Map<string, number>();
  const credits = new Map<string, ScenicFeature>();
  let treeCount = 0;

  for (const s of samples) {
    for (const kind of Object.keys(SCENIC_RULES)) {
      const rule = SCENIC_RULES[kind]!;
      for (const f of grid.within(s.lat, s.lon, rule.radius)) {
        if (f.kind !== kind) continue;
        if (kind === "tree") {
          treeCount++;
          continue;
        }
        const d = haversine(s, f);
        // Linear falloff: full weight on top of it, nothing at the radius.
        const contribution = rule.weight * (1 - d / rule.radius);
        if (contribution > (best.get(kind) ?? 0)) {
          best.set(kind, contribution);
          credits.set(kind, f);
        }
      }
    }
  }

  let base = 0;
  const timed: TimedCredit[] = [];
  for (const [kind, weight] of best) {
    const feature = credits.get(kind);
    if (feature && TIME_SENSITIVE.has(kind)) timed.push({ feature, weight });
    else base += weight;
  }

  // Canopy: saturating bonus for street trees. Trees are pleasant at any hour,
  // and the sun is not what makes a street feel green.
  if (treeCount > 0) base += Math.min(0.35, 0.045 * Math.sqrt(treeCount));
  if (carFree) base += 0.25;
  if (isSteps) base += 0.2;

  return { base, timed, credits: [...credits.values()] };
}

function scoreHazard(
  tags: Record<string, string>,
  highway: string,
  carFree: boolean,
  onHin: boolean,
): number {
  if (carFree) {
    // Traffic-separated. Only lighting matters much, and being near a high
    // injury corridor still counts for a little — you have to cross it.
    let hazard = tags.lit === "no" ? 0.12 : 0.03;
    if (onHin) hazard += 0.1;
    return Math.min(1, hazard);
  }

  if (isRoadside(highway, tags)) {
    // A sidewalk or crossing: safer than the roadway, but it inherits the
    // corridor's traffic risk rather than escaping it.
    let hazard = tags.footway === "crossing" ? 0.28 : 0.16;
    if (onHin) hazard += 0.34;
    if (tags.crossing === "unmarked") hazard += 0.12;
    if (tags.lit === "no") hazard += 0.08;
    return Math.min(1, hazard);
  }

  let hazard = ARTERIAL[highway] ?? 0.2;

  // Vision Zero High Injury Network: the single strongest pedestrian signal.
  if (onHin) hazard += 0.45;

  if (tags.sidewalk === "no" || tags.sidewalk === "none") hazard += 0.25;
  else if (tags.sidewalk && tags.sidewalk !== "no") hazard -= 0.08;

  if (tags.lit === "no") hazard += 0.1;
  else if (tags.lit === "yes") hazard -= 0.05;

  const maxspeed = parseInt(tags.maxspeed ?? "", 10);
  if (!Number.isNaN(maxspeed)) {
    if (maxspeed >= 35) hazard += 0.15;
    else if (maxspeed <= 20) hazard -= 0.08;
  }

  if (tags.tunnel === "yes") hazard += 0.2;
  if (tags.crossing) hazard -= 0.05;

  return Math.max(0, Math.min(1, hazard));
}
