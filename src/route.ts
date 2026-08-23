/**
 * Loop generation.
 *
 * A round trip is built in two legs: an outbound search to a well-chosen
 * turnaround anchor about half the time budget away, then a return search that
 * charges a heavy premium for reusing outbound edges — otherwise every "loop"
 * collapses into an out-and-back down the same street.
 */
import type { Edge, GraphNode, WalkGraph } from "./graph";
import { haversine, type LatLon } from "./geo";
import type { ScenicFeature } from "./overpass";

export interface Preferences {
  /** 0 = play it safe, 1 = chase the views. */
  scenic: number;
  /** How to treat gradient. */
  hills: "avoid" | "seek";
  /** Minutes. */
  minutes: number;
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
  stops: RouteStop[];
  streets: string[];
  /** Per-sample elevation for the profile strip, paired with distance. */
  profile: Array<{ d: number; ele: number }>;
}

const FLAT_SPEED = 1.33; // m/s, unhurried city pace
const ASCENT_SECONDS_PER_M = 7; // Naismith-style climb penalty
const STEPS_SLOWDOWN = 1.5;
const RETRACE_PENALTY = 6;

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

/**
 * Picks turnaround points roughly half the budget away, spread around the
 * compass so the candidate loops explore genuinely different directions.
 */
function chooseAnchors(
  graph: WalkGraph,
  start: GraphNode,
  outbound: SearchResult,
  halfSeconds: number,
  perSector: number,
  prefs: Preferences,
): number[] {
  const SECTORS = 8;
  const buckets = new Map<number, Array<{ node: number; quality: number }>>();

  for (const [node, secs] of outbound.seconds) {
    if (secs < halfSeconds * 0.8 || secs > halfSeconds * 1.2) continue;
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

    const b = bearing(start, g);
    const sector = Math.floor(((b + 180) / 360) * SECTORS) % SECTORS;
    const list = buckets.get(sector);
    if (list) list.push({ node, quality });
    else buckets.set(sector, [{ node, quality }]);
  }

  const anchors: number[] = [];
  for (const list of buckets.values()) {
    list.sort((a, b) => b.quality - a.quality);
    for (const item of list.slice(0, perSector)) anchors.push(item.node);
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

  if (prefs.hills === "seek") score += Math.min(1.0, walk.ascent / 220);
  else score -= Math.min(0.8, walk.ascent / 500);

  return score;
}

export function planLoop(graph: WalkGraph, origin: LatLon, prefs: Preferences): Walk | null {
  const start = nearestNode(graph, origin);
  if (!start) return null;

  const targetSeconds = prefs.minutes * 60;

  // The return leg pays a retrace premium, so it reliably comes back longer
  // than the outbound one. Aiming the turnaround a little short of halfway is
  // what keeps the finished loop near the time the user actually asked for.
  const halfSeconds = targetSeconds * 0.44;

  const outbound = dijkstra(graph, start.id, prefs, halfSeconds * 1.4);
  const anchors = chooseAnchors(graph, start, outbound, halfSeconds, 3, prefs);
  if (anchors.length === 0) return null;

  let best: Walk | null = null;
  let bestScore = -Infinity;

  for (const anchor of anchors) {
    const outEdges = tracePath(outbound, anchor);
    if (!outEdges || outEdges.length === 0) continue;

    // Charge a premium for retracing the way we came.
    const used = new Set(outEdges);
    const back = dijkstra(graph, anchor, prefs, targetSeconds * 1.3, used);
    const backEdges = tracePath(back, start.id);
    if (!backEdges || backEdges.length === 0) continue;

    const walk = assemble(graph, start, [...outEdges, ...backEdges], prefs);
    if (!walk) continue;

    const score = judge(walk, targetSeconds, prefs);
    if (score > bestScore) {
      bestScore = score;
      best = walk;
    }
  }

  return best;
}
