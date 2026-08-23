/**
 * Loop generation.
 *
 * A round trip is built in two legs: an outbound search to a well-chosen
 * turnaround anchor about half the time budget away, then a return search that
 * charges a heavy premium for reusing outbound edges — otherwise every "loop"
 * collapses into an out-and-back down the same street.
 */
import type { Edge, GraphNode, WalkGraph } from "./graph";
import { haversine, SpatialGrid, type LatLon } from "./geo";
import type { ScenicFeature } from "./overpass";

export interface Preferences {
  /** 0 = play it safe, 1 = chase the views. */
  scenic: number;
  /** How to treat gradient. */
  hills: "avoid" | "seek";
  /** Minutes. */
  minutes: number;
  /** Come back to the start, or spend the whole budget going somewhere. */
  trip: "loop" | "oneway";
}

export interface RouteStop {
  kind: string;
  name: string;
  lat: number;
  lon: number;
  /** Metres along the route where you meet it. */
  at: number;
}

export interface Walk {
  coordinates: Array<[number, number]>;
  distance: number;
  duration: number;
  ascent: number;
  descent: number;
  maxGrade: number;
  scenicScore: number;
  hazardScore: number;
  hinMetres: number;
  carFreeMetres: number;
  stepsMetres: number;
  overlap: number;
  /** True when the walk returns to its start. */
  isLoop: boolean;
  /** Where the walk finishes — the start again on a loop. */
  end: LatLon;
  /**
   * Footfalls on stairways. Independent of stride, so it is kept apart from
   * the walking portion and simply added on.
   */
  stairSteps: number;
  /**
   * Grade-adjusted distance for ordinary walking, in metres, defined so that
   * `strideDistance / stepLength` is the number of paces. Keeping the two
   * separate lets the step estimate respond to a change of height instantly,
   * without replanning the walk.
   */
  strideDistance: number;
  stops: RouteStop[];
  streets: string[];
  /** What this route is best at, relative to the alternatives offered with it. */
  character?: string;
  /** Per-sample elevation for the profile strip, paired with distance. */
  profile: Array<{ d: number; ele: number }>;
}

const FLAT_SPEED = 1.33; // m/s, unhurried city pace
const ASCENT_SECONDS_PER_M = 7; // Naismith-style climb penalty
const STEPS_SLOWDOWN = 1.5;
const RETRACE_PENALTY = 6;

/** Horizontal run of a typical stair tread — one footfall each. */
const STAIR_TREAD = 0.29;
/** Stride shortens as the ground tilts, in either direction. */
const GRADE_STRIDE_PENALTY = 1.2;
/** Step length as a fraction of standing height, the usual pedestrian estimate. */
export const STEP_LENGTH_RATIO = 0.415;

export function stepLengthFor(heightCm: number): number {
  return (heightCm / 100) * STEP_LENGTH_RATIO;
}

/** Paces for a walk at a given height. Cheap enough to call on every input event. */
export function stepsFor(walk: Walk, heightCm: number): number {
  return Math.round(walk.stairSteps + walk.strideDistance / stepLengthFor(heightCm));
}

/** Cost of walking `edge` in the given direction, under the user's preferences. */
function edgeCost(edge: Edge, forward: boolean, prefs: Preferences): number {
  const scenicWeight = prefs.scenic;
  // Safety never switches off entirely, even at maximum scenic.
  const safetyWeight = 0.35 + 0.65 * (1 - prefs.scenic);

  const scenicFactor = 1 / (1 + 2.5 * scenicWeight * edge.scenic);
  const hazardFactor = 1 + 3.0 * safetyWeight * edge.hazard;

  const rise = forward ? edge.rise : -edge.rise;
  let gradeFactor: number;
  if (prefs.hills === "avoid") {
    // Deliberately gentler than it could be. San Francisco's flat corridors are
    // its arterials, so an aggressive hill penalty quietly overrides the safety
    // slider and pushes every walk onto the High Injury Network.
    gradeFactor = 1 + 7 * Math.pow(edge.grade, 1.4);
  } else {
    // Seeking hills: climbing is what you came for, descending is just the way back.
    gradeFactor = rise > 0 ? 1 / (1 + 4 * edge.grade) : 1 + 1.2 * edge.grade;
  }

  return edge.length * scenicFactor * hazardFactor * gradeFactor;
}

function edgeSeconds(edge: Edge, forward: boolean): number {
  const rise = forward ? edge.rise : -edge.rise;
  const base = (edge.length / FLAT_SPEED) * (edge.isSteps ? STEPS_SLOWDOWN : 1);
  return base + Math.max(0, rise) * ASCENT_SECONDS_PER_M;
}

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, val: number): void {
    this.keys.push(key);
    this.vals.push(val);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p]! <= this.keys[i]!) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): { key: number; val: number } | null {
    if (this.keys.length === 0) return null;
    const key = this.keys[0]!;
    const val = this.vals[0]!;
    const lastK = this.keys.pop()!;
    const lastV = this.vals.pop()!;
    if (this.keys.length > 0) {
      this.keys[0] = lastK;
      this.vals[0] = lastV;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.keys.length && this.keys[l]! < this.keys[m]!) m = l;
        if (r < this.keys.length && this.keys[r]! < this.keys[m]!) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return { key, val };
  }

  private swap(a: number, b: number): void {
    [this.keys[a], this.keys[b]] = [this.keys[b]!, this.keys[a]!];
    [this.vals[a], this.vals[b]] = [this.vals[b]!, this.vals[a]!];
  }
}

interface SearchResult {
  cost: Map<number, number>;
  seconds: Map<number, number>;
  prevEdge: Map<number, number>;
  prevNode: Map<number, number>;
}

function dijkstra(
  graph: WalkGraph,
  source: number,
  prefs: Preferences,
  maxSeconds: number,
  penalised?: Set<number>,
): SearchResult {
  const cost = new Map<number, number>([[source, 0]]);
  const seconds = new Map<number, number>([[source, 0]]);
  const prevEdge = new Map<number, number>();
  const prevNode = new Map<number, number>();
  const done = new Set<number>();

  const heap = new MinHeap();
  heap.push(0, source);

  while (heap.size > 0) {
    const top = heap.pop()!;
    const node = top.val;
    if (done.has(node)) continue;
    done.add(node);
    if ((seconds.get(node) ?? 0) > maxSeconds) continue;

    for (const edgeId of graph.adjacency.get(node) ?? []) {
      const edge = graph.edges[edgeId]!;
      const forward = edge.from === node;
      const next = forward ? edge.to : edge.from;
      if (done.has(next)) continue;

      let step = edgeCost(edge, forward, prefs);
      if (penalised?.has(edgeId)) step *= RETRACE_PENALTY;

      const newCost = top.key + step;
      if (newCost < (cost.get(next) ?? Infinity)) {
        cost.set(next, newCost);
        seconds.set(next, (seconds.get(node) ?? 0) + edgeSeconds(edge, forward));
        prevEdge.set(next, edgeId);
        prevNode.set(next, node);
        heap.push(newCost, next);
      }
    }
  }

  return { cost, seconds, prevEdge, prevNode };
}

function tracePath(search: SearchResult, target: number): number[] | null {
  const edges: number[] = [];
  let cur = target;
  const guard = new Set<number>();
  while (search.prevEdge.has(cur)) {
    if (guard.has(cur)) return null;
    guard.add(cur);
    edges.push(search.prevEdge.get(cur)!);
    cur = search.prevNode.get(cur)!;
  }
  return edges.reverse();
}

export function nearestNode(graph: WalkGraph, p: LatLon): GraphNode | null {
  let best: GraphNode | null = null;
  let bestD = Infinity;
  for (const node of graph.nodes.values()) {
    // Only nodes that actually connect somewhere are useful starts.
    if (!graph.adjacency.has(node.id)) continue;
    const d = haversine(p, node);
    if (d < bestD) {
      bestD = d;
      best = node;
    }
  }
  return best;
}

function bearing(from: LatLon, to: LatLon): number {
  return (Math.atan2(to.lon - from.lon, to.lat - from.lat) * 180) / Math.PI;
}

export interface Anchor {
  node: number;
  sector: number;
}

/**
 * Picks turnaround points at the right distance, spread around the compass so
 * the candidate routes explore genuinely different directions.
 *
 * On a one-way walk the anchor is not a turnaround but the destination, so
 * arriving somewhere worth arriving at counts for much more.
 */
function chooseAnchors(
  graph: WalkGraph,
  start: GraphNode,
  outbound: SearchResult,
  reachSeconds: number,
  perSector: number,
  prefs: Preferences,
  oneWay: boolean,
): Anchor[] {
  const SECTORS = 8;
  const buckets = new Map<number, Array<{ node: number; quality: number }>>();

  // Somewhere to actually finish, for one-way walks.
  const destinations = new SpatialGrid<ScenicFeature>(120, start.lat);
  if (oneWay) {
    for (const f of graph.features) {
      if (f.kind === "viewpoint" || f.kind === "park" || f.kind === "beach") {
        destinations.insert(f);
      }
    }
  }

  for (const [node, secs] of outbound.seconds) {
    if (secs < reachSeconds * 0.8 || secs > reachSeconds * 1.2) continue;
    const g = graph.nodes.get(node);
    if (!g) continue;

    // Prefer anchors reached by cheap (i.e. scenic and safe) paths.
    const cost = outbound.cost.get(node) ?? Infinity;
    if (!Number.isFinite(cost) || cost <= 0) continue;
    let quality = secs / cost;

    // The turnaround point sets the character of the whole loop, so the hills
    // preference is applied here as well as in the edge cost. Routing toward a
    // summit is what actually produces a climb; discounting steep edges alone
    // is too weak to change which way you go.
    const climb = g.ele - start.ele;
    if (prefs.hills === "seek") quality *= 1 + Math.max(0, climb) / 45;
    else quality *= 1 / (1 + Math.max(0, climb) / 70);

    if (oneWay) {
      // Ending in the middle of a street is a poor reward for a 40 minute walk.
      const near = destinations.within(g.lat, g.lon, 160);
      if (near.length === 0) quality *= 0.35;
      else quality *= 1 + Math.min(1.2, 0.5 * near.length);
    }

    const b = bearing(start, g);
    const sector = Math.floor(((b + 180) / 360) * SECTORS) % SECTORS;
    const list = buckets.get(sector);
    if (list) list.push({ node, quality });
    else buckets.set(sector, [{ node, quality }]);
  }

  const anchors: Anchor[] = [];
  for (const [sector, list] of buckets) {
    list.sort((a, b) => b.quality - a.quality);
    for (const item of list.slice(0, perSector)) anchors.push({ node: item.node, sector });
  }
  return anchors;
}

function assemble(
  graph: WalkGraph,
  startNode: GraphNode,
  edgeIds: number[],
  prefs: Preferences,
): Walk | null {
  if (edgeIds.length === 0) return null;

  const coordinates: Array<[number, number]> = [];
  const profile: Array<{ d: number; ele: number }> = [];
  const stopMap = new Map<string, RouteStop>();
  const streetSet = new Set<string>();
  const seen = new Map<number, number>();

  let distance = 0;
  let duration = 0;
  let ascent = 0;
  let descent = 0;
  let maxGrade = 0;
  let scenicSum = 0;
  let hazardSum = 0;
  let hinMetres = 0;
  let carFreeMetres = 0;
  let stepsMetres = 0;
  let overlapMetres = 0;
  let stairSteps = 0;
  let strideDistance = 0;

  let cursor = startNode.id;

  for (const edgeId of edgeIds) {
    const edge = graph.edges[edgeId]!;
    const forward = edge.from === cursor;
    if (!forward && edge.to !== cursor) return null; // discontinuous path

    const pts = forward ? edge.pts : [...edge.pts].reverse();
    const startIdx = coordinates.length === 0 ? 0 : 1;
    for (let i = startIdx; i < pts.length; i++) {
      coordinates.push([pts[i]!.lat, pts[i]!.lon]);
    }

    const count = (seen.get(edgeId) ?? 0) + 1;
    seen.set(edgeId, count);
    if (count > 1) overlapMetres += edge.length;

    const rise = forward ? edge.rise : -edge.rise;
    if (rise > 0) ascent += rise;
    else descent -= rise;

    const fromEle = forward
      ? graph.nodes.get(edge.from)!.ele
      : graph.nodes.get(edge.to)!.ele;
    profile.push({ d: distance, ele: fromEle });

    distance += edge.length;
    duration += edgeSeconds(edge, forward);
    maxGrade = Math.max(maxGrade, edge.grade);
    scenicSum += edge.scenic * edge.length;
    hazardSum += edge.hazard * edge.length;
    if (edge.onHin) hinMetres += edge.length;
    if (edge.carFree) carFreeMetres += edge.length;
    if (edge.isSteps) stepsMetres += edge.length;
    if (edge.name) streetSet.add(edge.name);

    if (edge.isSteps) {
      // One footfall per tread. Roughly a third of San Francisco's stairways
      // record their real count; the rest are estimated from their run.
      stairSteps += edge.stepCount ?? edge.length / STAIR_TREAD;
    } else {
      // Stride shortens on a slope, so the same distance costs more paces.
      strideDistance += edge.length * (1 + GRADE_STRIDE_PENALTY * edge.grade);
    }

    for (const f of edge.credits) {
      if (!f.name && f.kind !== "viewpoint") continue;
      if (!stopMap.has(f.id)) {
        stopMap.set(f.id, {
          kind: f.kind,
          name: f.name ?? titleFor(f),
          lat: f.lat,
          lon: f.lon,
          at: distance,
        });
      }
    }

    cursor = forward ? edge.to : edge.from;
  }

  const last = graph.nodes.get(cursor);
  if (last) profile.push({ d: distance, ele: last.ele });

  const endNode = last ?? startNode;

  return {
    coordinates,
    distance,
    duration,
    ascent,
    descent,
    maxGrade,
    scenicScore: distance > 0 ? scenicSum / distance : 0,
    hazardScore: distance > 0 ? hazardSum / distance : 0,
    hinMetres,
    carFreeMetres,
    stepsMetres,
    overlap: distance > 0 ? overlapMetres / distance : 0,
    isLoop: cursor === startNode.id,
    end: { lat: endNode.lat, lon: endNode.lon },
    stairSteps,
    strideDistance,
    stops: [...stopMap.values()].sort((a, b) => a.at - b.at),
    streets: [...streetSet],
    profile,
  };
}

function titleFor(f: ScenicFeature): string {
  const labels: Record<string, string> = {
    viewpoint: "Viewpoint",
    park: "Park",
    garden: "Garden",
    water: "Waterside",
    beach: "Beach",
    historic: "Historic spot",
    artwork: "Public artwork",
    attraction: "Local attraction",
    tree: "Tree canopy",
  };
  return labels[f.kind] ?? "Point of interest";
}

/** How good is this candidate, all things considered? */
function judge(walk: Walk, targetSeconds: number, prefs: Preferences): number {
  const fit = Math.abs(walk.duration - targetSeconds) / targetSeconds;
  let score =
    walk.scenicScore * 2.4 -
    walk.hazardScore * 1.8 -
    walk.overlap * 2.2 -
    fit * 4.0;

  // Running over budget is worse than coming in under it: people plan around
  // the number they asked for.
  if (walk.duration > targetSeconds) score -= fit * 1.5;

  // A loop that never leaves the block is not a walk.
  if (walk.coordinates.length < 8) score -= 1;

  // Only a round trip can meaningfully double back on itself.
  if (prefs.trip === "oneway") score += walk.overlap * 2.2;

  if (prefs.hills === "seek") score += Math.min(1.0, walk.ascent / 220);
  else score -= Math.min(0.8, walk.ascent / 500);

  return score;
}

/** Fraction of `a`'s length that also appears in `b`. */
function overlapWith(a: Set<number>, b: Set<number>, graph: WalkGraph): number {
  let shared = 0;
  let total = 0;
  for (const id of a) {
    const len = graph.edges[id]?.length ?? 0;
    total += len;
    if (b.has(id)) shared += len;
  }
  return total > 0 ? shared / total : 0;
}

interface Candidate {
  walk: Walk;
  score: number;
  edges: Set<number>;
  sector: number;
}

/**
 * Names each route by whatever it is best at within the offered set, so the
 * choice is between characters rather than between five near-identical lines.
 * Each label is used once, strongest claim first.
 */
function labelWalks(walks: Walk[]): void {
  const claims: Array<{ label: string; pick: (w: Walk) => number }> = [
    { label: "Most scenic", pick: (w) => w.scenicScore },
    { label: "Safest", pick: (w) => -w.hazardScore },
    { label: "Most stairways", pick: (w) => (w.stepsMetres > 40 ? w.stepsMetres : -1) },
    { label: "Most car-free", pick: (w) => w.carFreeMetres / Math.max(1, w.distance) },
    { label: "Flattest", pick: (w) => -w.ascent },
    { label: "Shortest", pick: (w) => -w.distance },
  ];

  const taken = new Set<Walk>();
  for (const claim of claims) {
    let best: Walk | null = null;
    let bestVal = -Infinity;
    for (const w of walks) {
      if (taken.has(w)) continue;
      const v = claim.pick(w);
      if (v > bestVal) {
        bestVal = v;
        best = w;
      }
    }
    if (best && bestVal > -Infinity) {
      best.character = claim.label;
      taken.add(best);
    }
  }
  for (const w of walks) w.character ??= "Alternative";
}

/**
 * Builds several genuinely different routes and returns them best first.
 *
 * Candidates come from turnaround anchors spread around the compass, then are
 * filtered so that no two routes share most of their length — five variations
 * on the same street is not a choice.
 */
export function planWalks(
  graph: WalkGraph,
  origin: LatLon,
  prefs: Preferences,
  count = 5,
): Walk[] {
  const start = nearestNode(graph, origin);
  if (!start) return [];

  const targetSeconds = prefs.minutes * 60;
  const oneWay = prefs.trip === "oneway";

  // A one-way walk spends the whole budget going out. A loop pays a retrace
  // premium on the way back, so aiming its turnaround a little short of halfway
  // is what keeps the finished loop near the time actually asked for.
  const reachSeconds = oneWay ? targetSeconds : targetSeconds * 0.44;

  const outbound = dijkstra(graph, start.id, prefs, reachSeconds * 1.4);
  const anchors = chooseAnchors(graph, start, outbound, reachSeconds, 3, prefs, oneWay);
  if (anchors.length === 0) return [];

  const candidates: Candidate[] = [];

  for (const anchor of anchors) {
    const outEdges = tracePath(outbound, anchor.node);
    if (!outEdges || outEdges.length === 0) continue;

    let edgeIds = outEdges;
    if (!oneWay) {
      // Charge a premium for retracing the way we came.
      const used = new Set(outEdges);
      const back = dijkstra(graph, anchor.node, prefs, targetSeconds * 1.3, used);
      const backEdges = tracePath(back, start.id);
      if (!backEdges || backEdges.length === 0) continue;
      edgeIds = [...outEdges, ...backEdges];
    }

    const walk = assemble(graph, start, edgeIds, prefs);
    if (!walk) continue;

    candidates.push({
      walk,
      score: judge(walk, targetSeconds, prefs),
      edges: new Set(edgeIds),
      sector: anchor.sector,
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  // Keep routes that are actually distinct from the ones already chosen, and
  // at most one per compass sector until every sector has had a turn.
  const chosen: Candidate[] = [];
  const usedSectors = new Set<number>();

  for (const pass of [0, 1]) {
    for (const c of candidates) {
      if (chosen.length >= count) break;
      if (chosen.includes(c)) continue;
      if (pass === 0 && usedSectors.has(c.sector)) continue;
      const tooSimilar = chosen.some((k) => overlapWith(c.edges, k.edges, graph) > 0.55);
      if (tooSimilar) continue;
      chosen.push(c);
      usedSectors.add(c.sector);
    }
  }

  const walks = chosen.map((c) => c.walk);
  labelWalks(walks);
  return walks;
}

/** Convenience for callers that only want the best route. */
export function planLoop(graph: WalkGraph, origin: LatLon, prefs: Preferences): Walk | null {
  return planWalks(graph, origin, prefs, 1)[0] ?? null;
}
