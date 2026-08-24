/**
 * sanbu — browser entry point.
 *
 * The whole routing engine runs here. There is no backend: OpenStreetMap,
 * Open-Meteo and DataSF all permit direct browser calls, and the High Injury
 * Network ships as a static asset, so the app is a plain static site.
 */
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./style.css";

import { buildGraph, type WalkGraph } from "../src/graph";
import { planWalks, stepsFor, type Preferences, type RouteStop, type Walk } from "../src/route";
import { haversine, type LatLon } from "../src/geo";
import { IndexedDbStore, setStore } from "../src/store";
import { findPhotos, type Photo } from "../src/photos";
import { loadHin, type HinSegment } from "../src/hin";

setStore(new IndexedDbStore());

const SF_DEFAULT = { lat: 37.7764, lon: -122.4346 }; // Alamo Square
const SF_BOUNDS = { south: 37.69, west: -122.55, north: 37.84, east: -122.34 };

const HEIGHT_KEY = "sanbu:height";

const state = {
  origin: null as LatLon | null,
  minutes: 40,
  scenic: 0.6,
  hills: "avoid" as "avoid" | "seek",
  trip: "loop" as "loop" | "oneway",
  heightCm: Number(localStorage.getItem(HEIGHT_KEY)) || 173,
  busy: false,
  /** The alternatives currently on offer, best first. */
  routes: [] as Walk[],
  selected: 0,
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const els = {
  locate: $<HTMLButtonElement>("locate"),
  locateLabel: $("locate-label"),
  locateSub: $("locate-sub"),
  go: $<HTMLButtonElement>("go"),
  goLabel: $("go-label"),
  scenic: $<HTMLInputElement>("scenic"),
  scenicValue: $("scenic-value"),
  results: $("results"),
  stats: $("stats"),
  stops: $("stops"),
  profile: $("profile"),
  profileCaption: $("profile-caption"),
  toast: $("toast"),
  loading: $("loading"),
  loadingText: $("loading-text"),
  panel: $("panel"),
  panelToggle: $<HTMLButtonElement>("panel-toggle"),
  routes: $("routes"),
  height: $<HTMLInputElement>("height"),
  heightValue: $("height-value"),
  heightAlt: $("height-alt"),
};

/* ---------- Map ---------- */

const map = L.map("map", {
  center: [SF_DEFAULT.lat, SF_DEFAULT.lon],
  zoom: 15,
  zoomControl: false,
  attributionControl: true,
});

// Top-right keeps the buttons clear of the control panel and the results tray.
L.control.zoom({ position: "topright" }).addTo(map);

L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
  subdomains: "abcd",
  maxZoom: 20,
  attribution:
    '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> ' +
    '&copy; <a href="https://carto.com/attributions">CARTO</a> · ' +
    'safety data <a href="https://datasf.org">DataSF</a>',
}).addTo(map);

const routeLayer = L.layerGroup().addTo(map);
const markerLayer = L.layerGroup().addTo(map);
let startMarker: L.Marker | null = null;

/* ---------- High Injury Network overlay ---------- */

/**
 * San Francisco's High Injury Network drawn over the map — the streets that
 * account for most severe and fatal traffic injuries, and the same data the
 * router already weights against.
 *
 * Rendered to a canvas rather than SVG: this is ~6,000 line strings and around
 * 19,000 vertices, which is enough individual DOM paths to make panning stutter.
 */
const riskLayer = L.layerGroup();
const riskRenderer = L.canvas({ padding: 0.15 });
let riskBusy = false;

/** Each segment kept with a precomputed bounding box for fast viewport tests. */
interface RiskSegment {
  line: L.LatLngTuple[];
  south: number;
  west: number;
  north: number;
  east: number;
}

let riskSegments: RiskSegment[] | null = null;

async function loadRiskSegments(): Promise<RiskSegment[]> {
  if (riskSegments) return riskSegments;
  const segments: HinSegment[] = await loadHin();
  riskSegments = segments.map((seg) => {
    let south = Infinity;
    let west = Infinity;
    let north = -Infinity;
    let east = -Infinity;
    const line: L.LatLngTuple[] = [];
    for (const p of seg.pts) {
      line.push([p.lat, p.lon]);
      if (p.lat < south) south = p.lat;
      if (p.lat > north) north = p.lat;
      if (p.lon < west) west = p.lon;
      if (p.lon > east) east = p.lon;
    }
    return { line, south, west, north, east };
  });
  return riskSegments;
}

/**
 * Redraws the overlay for the current view.
 *
 * Drawing all ~19,000 vertices on every frame halved the pan rate, so only the
 * segments overlapping the viewport are handed to the canvas, and the soft wide
 * pass is skipped when zoomed out — that is exactly where the most geometry is
 * on screen and where the glow adds least.
 */
function refreshRisk(): void {
  if (!riskSegments || !map.hasLayer(riskLayer)) return;

  const b = map.getBounds().pad(0.2);
  const south = b.getSouth();
  const west = b.getWest();
  const north = b.getNorth();
  const east = b.getEast();

  const lines: L.LatLngTuple[][] = [];
  for (const seg of riskSegments) {
    if (seg.north < south || seg.south > north || seg.east < west || seg.west > east) continue;
    lines.push(seg.line);
  }

  riskLayer.clearLayers();
  if (lines.length === 0) return;

  const zoom = map.getZoom();
  if (zoom >= 14) {
    L.polyline(lines, {
      renderer: riskRenderer,
      color: "#ff2d55",
      weight: 9,
      opacity: 0.16,
      lineCap: "round",
      lineJoin: "round",
      interactive: false,
    }).addTo(riskLayer);
  }

  L.polyline(lines, {
    renderer: riskRenderer,
    color: "#ff5b6e",
    weight: zoom >= 14 ? 2.2 : 1.6,
    opacity: zoom >= 14 ? 0.72 : 0.62,
    lineCap: "round",
    lineJoin: "round",
    interactive: false,
  }).addTo(riskLayer);
}

map.on("moveend zoomend", refreshRisk);

async function toggleRisk(on: boolean): Promise<void> {
  const button = document.getElementById("risk-toggle");
  const legend = document.getElementById("risk-legend");

  if (!on) {
    map.removeLayer(riskLayer);
    riskLayer.clearLayers();
    button?.classList.remove("is-active");
    button?.setAttribute("aria-pressed", "false");
    if (legend) legend.hidden = true;
    return;
  }

  if (riskBusy) return;
  riskBusy = true;
  button?.classList.add("is-loading");
  try {
    await loadRiskSegments();
    riskLayer.addTo(map);
    refreshRisk();
    button?.classList.add("is-active");
    button?.setAttribute("aria-pressed", "true");
    if (legend) legend.hidden = false;
  } catch (err) {
    showToast(`Could not load the injury data. ${(err as Error).message}`);
  } finally {
    riskBusy = false;
    button?.classList.remove("is-loading");
  }
}

const RiskControl = L.Control.extend({
  options: { position: "topright" as L.ControlPosition },
  onAdd() {
    const wrap = L.DomUtil.create("div", "leaflet-bar risk-control");
    wrap.innerHTML =
      `<button id="risk-toggle" type="button" aria-pressed="false" ` +
      `title="Show streets with the most severe traffic injuries">` +
      `<span class="risk-control__dot" aria-hidden="true"></span>Risk</button>`;
    // Without this a click on the button also pans or zooms the map beneath it.
    L.DomEvent.disableClickPropagation(wrap);
    wrap.addEventListener("click", () => {
      void toggleRisk(!document.getElementById("risk-toggle")?.classList.contains("is-active"));
    });
    return wrap;
  },
});

map.addControl(new RiskControl());

map.on("click", (e: L.LeafletMouseEvent) =>
  setOrigin(e.latlng.lat, e.latlng.lng, "Pinned on the map"),
);

/* ---------- Origin ---------- */

function setOrigin(lat: number, lon: number, label: string): void {
  state.origin = { lat, lon };
  els.locate.classList.add("is-set");
  els.locateLabel.textContent = label;
  els.locateSub.textContent = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;

  if (startMarker) markerLayer.removeLayer(startMarker);
  startMarker = L.marker([lat, lon], {
    icon: L.divIcon({ className: "", html: '<div class="start-marker"></div>', iconSize: [16, 16] }),
    interactive: false,
    zIndexOffset: 1000,
  }).addTo(markerLayer);

  map.setView([lat, lon], Math.max(map.getZoom(), 15));
}

els.locate.addEventListener("click", () => {
  if (!navigator.geolocation) {
    showToast("This browser will not share a location. Tap the map to drop a pin instead.");
    return;
  }
  els.locateLabel.textContent = "Finding you…";
  navigator.geolocation.getCurrentPosition(
    (pos) => setOrigin(pos.coords.latitude, pos.coords.longitude, "Your location"),
    (err) => {
      els.locateLabel.textContent = "Use my location";
      const why =
        err.code === err.PERMISSION_DENIED
          ? "Location permission was declined."
          : "Could not get a location fix.";
      showToast(`${why} Tap the map to drop a pin instead.`);
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
  );
});

/* ---------- Controls ---------- */

document.querySelectorAll<HTMLButtonElement>("#time-group button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#time-group button").forEach((b) => {
      b.classList.remove("is-active");
      b.setAttribute("aria-checked", "false");
    });
    btn.classList.add("is-active");
    btn.setAttribute("aria-checked", "true");
    state.minutes = Number(btn.dataset.minutes);
  });
});

document.querySelectorAll<HTMLButtonElement>("#hills button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#hills button").forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    state.hills = btn.dataset.hills === "seek" ? "seek" : "avoid";
  });
});

els.scenic.addEventListener("input", () => {
  const v = Number(els.scenic.value);
  state.scenic = v / 100;
  els.scenicValue.textContent =
    v < 20
      ? "Safety first"
      : v < 45
        ? "Cautious"
        : v < 70
          ? "Balanced"
          : v < 90
            ? "Scenic"
            : "Views at all costs";
});

document.querySelectorAll<HTMLButtonElement>("#trip button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#trip button").forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    state.trip = btn.dataset.trip === "oneway" ? "oneway" : "loop";
  });
});

function renderHeight(): void {
  const cm = state.heightCm;
  const inches = Math.round(cm / 2.54);
  els.heightValue.textContent = `${cm} cm`;
  els.heightAlt.textContent = `${Math.floor(inches / 12)}′${inches % 12}″`;
}

els.height.value = String(state.heightCm);
renderHeight();

els.height.addEventListener("input", () => {
  state.heightCm = Number(els.height.value);
  localStorage.setItem(HEIGHT_KEY, String(state.heightCm));
  renderHeight();
  // Steps are derived from the walk, not baked into it, so the estimate can
  // follow the slider without replanning.
  const walk = state.routes[state.selected];
  if (walk) {
    renderStats(walk);
    renderRoutePicker();
  }
});

els.panelToggle.addEventListener("click", () => els.panel.classList.toggle("is-hidden"));
els.go.addEventListener("click", plan);

// Left and right step through the alternatives once a walk is on screen.
document.addEventListener("keydown", (e) => {
  if (state.routes.length < 2) return;
  if (e.key === "ArrowLeft") selectRoute(state.selected - 1);
  else if (e.key === "ArrowRight") selectRoute(state.selected + 1);
});

/* ---------- Planning ---------- */

/**
 * Graphs are expensive to build (Overpass plus terrain), so one is reused for
 * anyone starting within a few hundred metres of a previous request.
 */
const graphCache: Array<{ graph: WalkGraph; at: number }> = [];
const GRAPH_TTL = 30 * 60 * 1000;
const MAX_GRAPHS = 4;

async function getGraph(centre: LatLon, radiusM: number): Promise<WalkGraph> {
  const fresh = graphCache.filter((e) => Date.now() - e.at <= GRAPH_TTL);
  graphCache.length = 0;
  graphCache.push(...fresh);

  const hit = graphCache.find((e) => haversine(e.graph.centre, centre) < 400);
  if (hit) return hit.graph;

  const graph = await buildGraph(centre, radiusM);
  graphCache.unshift({ graph, at: Date.now() });
  graphCache.length = Math.min(graphCache.length, MAX_GRAPHS);
  return graph;
}

function inServiceArea(p: LatLon): boolean {
  return (
    p.lat >= SF_BOUNDS.south &&
    p.lat <= SF_BOUNDS.north &&
    p.lon >= SF_BOUNDS.west &&
    p.lon <= SF_BOUNDS.east
  );
}

async function plan(): Promise<void> {
  if (state.busy) return;
  if (!state.origin) {
    showToast("Pick a starting point first — use your location or tap the map.");
    return;
  }
  if (!inServiceArea(state.origin)) {
    showToast(
      "sanbu's safety data is San Francisco's Vision Zero network, so walks are " +
        "limited to San Francisco for now.",
    );
    return;
  }

  const prefs: Preferences = {
    minutes: state.minutes,
    scenic: state.scenic,
    hills: state.hills,
    trip: state.trip,
  };
  // Enough room for the loop to breathe without pulling half the city.
  const radiusM = Math.min(2600, Math.max(900, prefs.minutes * 1.33 * 60 * 0.42));

  setBusy(true);
  hideToast();

  try {
    const graph = await getGraph(state.origin, radiusM);
    if (graph.edges.length === 0) {
      showToast("No walkable streets found around that point.");
      return;
    }

    // Yield once so the spinner paints before the search occupies the thread.
    await new Promise((r) => setTimeout(r, 0));

    const walks = planWalks(graph, state.origin, prefs, 5);
    if (walks.length === 0) {
      showToast(
        state.trip === "loop"
          ? "Could not find a loop from there. Try a longer walk or a nearby street."
          : "Could not find anywhere good to walk to in that time. Try a longer walk.",
      );
      return;
    }
    state.routes = walks;
    selectRoute(0);
  } catch (err) {
    showToast(`Map data is unavailable right now. ${(err as Error).message}`);
  } finally {
    setBusy(false);
  }
}

let busyTimers: number[] = [];

function setBusy(busy: boolean): void {
  state.busy = busy;
  els.go.disabled = busy;
  els.goLabel.textContent = busy ? "Finding your walk…" : "Walk me";
  els.loading.hidden = !busy;

  busyTimers.forEach(clearTimeout);
  busyTimers = [];
  if (!busy) return;

  // The first walk in an area pays for Overpass and terrain; say so rather than
  // leaving a bare spinner.
  els.loadingText.textContent = "Reading the streets…";
  busyTimers.push(
    setTimeout(() => {
      if (state.busy) els.loadingText.textContent = "Scoring viewpoints and slopes…";
    }, 2600) as unknown as number,
    setTimeout(() => {
      if (state.busy) els.loadingText.textContent = "First walk in a new area takes a moment…";
    }, 8000) as unknown as number,
  );
}

/* ---------- Rendering ---------- */

const STOP_ICONS: Record<string, string> = {
  viewpoint: "◎",
  park: "❦",
  garden: "✿",
  water: "≈",
  beach: "≈",
  historic: "⌂",
  artwork: "◈",
  attraction: "✦",
  tree: "↟",
};

/** Switches to one of the offered routes, wrapping at both ends. */
function selectRoute(index: number): void {
  if (state.routes.length === 0) return;
  const n = state.routes.length;
  state.selected = ((index % n) + n) % n;
  renderWalk(state.routes[state.selected]!);
  els.routes
    .querySelector(`.route[data-i="${state.selected}"]`)
    ?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
}

function renderRoutePicker(): void {
  if (state.routes.length < 2) {
    els.routes.innerHTML = "";
    return;
  }
  els.routes.innerHTML = state.routes
    .map((w, i) => {
      const km = w.distance < 950 ? `${Math.round(w.distance)} m` : `${(w.distance / 1000).toFixed(1)} km`;
      return `<button class="route${i === state.selected ? " is-active" : ""}"
          data-i="${i}" role="tab" aria-selected="${i === state.selected}">
        <div class="route__name">${escapeHtml(w.character ?? "Alternative")}</div>
        <div class="route__meta">${km} · ${Math.round(w.duration / 60)} min · ${Math.round(w.ascent)} m ↑</div>
      </button>`;
    })
    .join("");

  els.routes.querySelectorAll<HTMLButtonElement>(".route").forEach((btn) => {
    btn.addEventListener("click", () => selectRoute(Number(btn.dataset.i)));
  });
}

function renderWalk(walk: Walk): void {
  routeLayer.clearLayers();
  markerLayer.clearLayers();
  if (startMarker) startMarker.addTo(markerLayer);

  // The routes not taken, so the choice is visible on the map itself.
  state.routes.forEach((other, i) => {
    if (i === state.selected) return;
    L.polyline(other.coordinates, {
      color: "#8d95a5",
      weight: 2,
      opacity: 0.3,
      dashArray: "3 6",
      interactive: false,
    }).addTo(routeLayer);
  });

  drawRoute(walk.coordinates);

  // A one-way walk ends somewhere else, and that needs saying on the map.
  if (!walk.isLoop) {
    L.marker([walk.end.lat, walk.end.lon], {
      icon: L.divIcon({ className: "", html: '<div class="end-marker"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
      zIndexOffset: 900,
    })
      .bindPopup("<b>Journey's end</b><em>One-way walk finishes here</em>")
      .addTo(markerLayer);
  }
  drawStops(walk.stops);
  renderStats(walk);
  renderProfile(walk);
  renderStops(walk.stops);
  renderRoutePicker();
  loadPhotos(walk.stops);

  els.results.hidden = false;

  // Measure the tray rather than guessing: its height changes with the number
  // of stat tiles, and an unpadded fit tucks the route underneath it.
  const narrow = window.innerWidth <= 860;
  const tray = els.results.offsetHeight + 28;
  const allPoints = state.routes.flatMap((w) => w.coordinates) as L.LatLngTuple[];
  map.fitBounds(L.latLngBounds(allPoints.length ? allPoints : (walk.coordinates as L.LatLngTuple[])), {
    paddingTopLeft: narrow ? [24, tray] : [364, 30],
    paddingBottomRight: narrow ? [24, 96] : [30, tray],
  });

  if (narrow) els.panel.classList.add("is-hidden");
}

/**
 * Leaflet has no gradient stroke, so the route is drawn as a run of short
 * polylines whose colour walks from amber to rose along the way — it reads as
 * direction of travel. A wide, faint copy underneath gives the glow.
 */
function drawRoute(coords: Array<[number, number]>): void {
  if (coords.length < 2) return;

  L.polyline(coords, {
    color: "#ff9b4a",
    weight: 15,
    opacity: 0.13,
    lineJoin: "round",
    lineCap: "round",
    interactive: false,
  }).addTo(routeLayer);

  const STOPS: Array<[number, number, number]> = [
    [255, 196, 107],
    [255, 125, 92],
    [242, 97, 139],
  ];
  const chunks = Math.min(48, Math.max(8, Math.floor(coords.length / 4)));
  const per = Math.ceil(coords.length / chunks);

  for (let i = 0; i < coords.length - 1; i += per) {
    const slice = coords.slice(i, Math.min(coords.length, i + per + 1));
    if (slice.length < 2) continue;
    const t = i / Math.max(1, coords.length - 1);
    L.polyline(slice, {
      color: gradientAt(STOPS, t),
      weight: 4.5,
      opacity: 0.95,
      lineJoin: "round",
      lineCap: "round",
      interactive: false,
    }).addTo(routeLayer);
  }
}

function gradientAt(stops: Array<[number, number, number]>, t: number): string {
  const scaled = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const a = stops[i]!;
  const b = stops[i + 1]!;
  const mix = a.map((v, k) => Math.round(v + (b[k]! - v) * f));
  return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
}

const stopMarkers = new Map<RouteStop, L.Marker>();

function popupHtml(stop: RouteStop, photo?: Photo | null): string {
  const head =
    `<b>${escapeHtml(stop.name)}</b>` +
    `<em>${labelFor(stop.kind)} · ${fmtDistance(stop.at)} in</em>`;
  if (!photo) return head;

  const credit = [photo.author, photo.license]
    .filter((v): v is string => Boolean(v))
    .map(escapeHtml)
    .join(" · ");
  return (
    `<a class="popup-photo" href="${escapeHtml(photo.page)}" target="_blank" rel="noopener">` +
    `<img src="${escapeHtml(photo.url)}" alt="${escapeHtml(stop.name)}" ` +
    `onerror="this.closest('.popup-photo').remove()" />` +
    `</a>${head}` +
    (credit ? `<em class="popup-credit">${credit} · Wikimedia Commons</em>` : "")
  );
}

function drawStops(stops: RouteStop[]): void {
  stopMarkers.clear();
  stops.forEach((stop) => {
    const icon = STOP_ICONS[stop.kind] ?? "✦";
    const marker = L.marker([stop.lat, stop.lon], {
      icon: L.divIcon({
        className: "",
        html: `<div class="stop-marker">${icon}</div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      }),
    })
      .bindPopup(popupHtml(stop), { maxWidth: 300, minWidth: 240 })
      .addTo(markerLayer);
    stopMarkers.set(stop, marker);
  });
}

/**
 * Photos load after the walk is already on screen. They are a garnish, so they
 * fill in as they arrive rather than holding up the route.
 */
let photoRun = 0;

function loadPhotos(stops: RouteStop[]): void {
  const run = ++photoRun;
  // Viewpoints first — they are what someone actually wants to see.
  const ordered = [...stops].sort(
    (a, b) => (a.kind === "viewpoint" ? 0 : 1) - (b.kind === "viewpoint" ? 0 : 1),
  );

  void findPhotos(ordered, (stop, photo) => {
    // A newer walk has started; discard results for the old one.
    if (run !== photoRun || !photo) return;

    stopMarkers.get(stop)?.setPopupContent(popupHtml(stop, photo));

    const chip = els.stops.querySelector<HTMLElement>(`.chip[data-i="${stops.indexOf(stop)}"]`);
    const slot = chip?.querySelector<HTMLElement>(".chip__icon");
    if (!chip || !slot) return;

    // Deliberately NOT lazy. The chips live in a horizontal scroller, so most
    // of them start outside the viewport and a lazy image there simply never
    // loads until you swipe onto it — which reads as broken. They are 96px
    // thumbnails; loading them all eagerly is the cheaper mistake.
    const img = new Image();
    img.className = "chip__thumb";
    img.alt = "";
    img.decoding = "async";
    img.src = photo.icon;
    // If the image genuinely fails, put the glyph back rather than leaving a hole.
    img.onerror = () => {
      img.replaceWith(slot);
      chip.classList.remove("has-photo");
    };
    slot.replaceWith(img);
    chip.classList.add("has-photo");
  });
}

function renderStats(walk: Walk): void {
  const hinPct = walk.distance > 0 ? (walk.hinMetres / walk.distance) * 100 : 0;
  const carFreePct = walk.distance > 0 ? (walk.carFreeMetres / walk.distance) * 100 : 0;

  const stats: Array<{ value: string; label: string; tone?: string }> = [
    { value: fmtDistance(walk.distance), label: "Distance" },
    { value: `${Math.round(walk.duration / 60)} min`, label: "On foot" },
    { value: `${Math.round(walk.ascent)} m`, label: "Climb" },
    {
      value: `${Math.round(carFreePct)}%`,
      label: "Car-free",
      tone: carFreePct > 35 ? "good" : undefined,
    },
    {
      value: hinPct < 1 ? "None" : `${Math.round(hinPct)}%`,
      label: "High-injury st.",
      tone: hinPct < 5 ? "good" : hinPct < 20 ? "warn" : "bad",
    },
  ];

  const steps = stepsFor(walk, state.heightCm);
  stats.splice(3, 0, {
    value: steps >= 10000 ? `${(steps / 1000).toFixed(1)}k` : String(steps),
    label: "Steps",
  });

  if (walk.stepsMetres > 20) {
    stats.push({ value: `${Math.round(walk.stepsMetres)} m`, label: "Stairways" });
  }

  els.stats.innerHTML = stats
    .map(
      (s) => `<div class="stat${s.tone ? ` stat--${s.tone}` : ""}">
        <div class="stat__value">${s.value}</div>
        <div class="stat__label">${s.label}</div>
      </div>`,
    )
    .join("");
}

function renderProfile(walk: Walk): void {
  const svg = els.profile;
  const pts = walk.profile;
  svg.innerHTML = "<title>Elevation profile of the walk</title>";
  if (pts.length < 2) {
    els.profileCaption.textContent = "";
    return;
  }

  const W = 600;
  const H = 60;
  const PAD = 6;
  const maxD = pts[pts.length - 1]!.d || 1;
  const eles = pts.map((p) => p.ele);
  const lo = Math.min(...eles);
  const hi = Math.max(...eles);
  const span = Math.max(8, hi - lo); // never exaggerate a flat walk

  const x = (d: number) => (d / maxD) * W;
  const y = (e: number) => H - PAD - ((e - lo) / span) * (H - PAD * 2);

  const line = pts
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.d).toFixed(1)},${y(p.ele).toFixed(1)}`)
    .join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;

  svg.insertAdjacentHTML(
    "beforeend",
    `<defs>
       <linearGradient id="profileFill" x1="0" y1="0" x2="0" y2="1">
         <stop offset="0%" stop-color="#ffc46b" stop-opacity="0.34" />
         <stop offset="100%" stop-color="#ffc46b" stop-opacity="0" />
       </linearGradient>
       <linearGradient id="profileLine" x1="0" y1="0" x2="1" y2="0">
         <stop offset="0%" stop-color="#ffc46b" />
         <stop offset="60%" stop-color="#ff7d5c" />
         <stop offset="100%" stop-color="#f2618b" />
       </linearGradient>
     </defs>
     <path d="${area}" fill="url(#profileFill)" />
     <path d="${line}" fill="none" stroke="url(#profileLine)" stroke-width="1.8"
           stroke-linejoin="round" vector-effect="non-scaling-stroke" />`,
  );

  const grade = Math.round(walk.maxGrade * 100);
  els.profileCaption.textContent =
    `${Math.round(lo)}–${Math.round(hi)} m elevation · steepest pitch ${grade}%` +
    (grade >= 15 ? " — properly San Francisco" : "");
}

function renderStops(stops: RouteStop[]): void {
  if (stops.length === 0) {
    els.stops.innerHTML =
      '<span class="chip chip--empty">No named landmarks on this one — just good streets</span>';
    return;
  }
  els.stops.innerHTML = stops
    .map(
      (s, i) => `<button class="chip" data-i="${i}">
        <span class="chip__icon">${STOP_ICONS[s.kind] ?? "✦"}</span>
        <span>${escapeHtml(s.name)}</span>
        <span class="chip__at">${fmtDistance(s.at)}</span>
      </button>`,
    )
    .join("");

  els.stops.querySelectorAll<HTMLButtonElement>(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const stop = stops[Number(chip.dataset.i)];
      if (stop) map.flyTo([stop.lat, stop.lon], 17, { duration: 0.7 });
    });
  });
}

/* ---------- Utilities ---------- */

function labelFor(kind: string): string {
  const labels: Record<string, string> = {
    viewpoint: "Viewpoint",
    park: "Park",
    garden: "Garden",
    water: "Waterside",
    beach: "Beach",
    historic: "Historic",
    artwork: "Public art",
    attraction: "Attraction",
    tree: "Canopy",
  };
  return labels[kind] ?? "Point of interest";
}

function fmtDistance(m: number): string {
  return m < 950 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

function escapeHtml(s: string): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

let toastTimer: number | undefined;

function showToast(msg: string): void {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 7000) as unknown as number;
}

function hideToast(): void {
  els.toast.hidden = true;
}

/* ---------- Boot ---------- */

setOrigin(SF_DEFAULT.lat, SF_DEFAULT.lon, "Alamo Square");
els.locate.classList.remove("is-set");
els.locateLabel.textContent = "Use my location";
els.locateSub.textContent = "starting at Alamo Square — or tap the map";
