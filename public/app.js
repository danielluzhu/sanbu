/* sanbu — front end. Map, controls, and rendering of a planned walk. */

const SF_DEFAULT = { lat: 37.7764, lon: -122.4346 }; // Alamo Square

const state = {
  origin: null,
  minutes: 40,
  scenic: 0.6,
  hills: "avoid",
  busy: false,
};

const $ = (id) => document.getElementById(id);
const els = {
  locate: $("locate"),
  locateLabel: $("locate-label"),
  locateSub: $("locate-sub"),
  go: $("go"),
  goLabel: $("go-label"),
  scenic: $("scenic"),
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
  panelToggle: $("panel-toggle"),
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
let startMarker = null;

map.on("click", (e) => setOrigin(e.latlng.lat, e.latlng.lng, "Pinned on the map"));

/* ---------- Origin ---------- */

function setOrigin(lat, lon, label) {
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

document.querySelectorAll("#time-group button").forEach((btn) => {
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

document.querySelectorAll("#hills button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#hills button").forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    state.hills = btn.dataset.hills;
  });
});

els.scenic.addEventListener("input", () => {
  const v = Number(els.scenic.value);
  state.scenic = v / 100;
  els.scenicValue.textContent =
    v < 20 ? "Safety first" : v < 45 ? "Cautious" : v < 70 ? "Balanced" : v < 90 ? "Scenic" : "Views at all costs";
});

els.panelToggle.addEventListener("click", () => els.panel.classList.toggle("is-hidden"));

els.go.addEventListener("click", plan);

/* ---------- Planning ---------- */

async function plan() {
  if (state.busy) return;
  if (!state.origin) {
    showToast("Pick a starting point first — use your location or tap the map.");
    return;
  }

  setBusy(true);
  hideToast();

  try {
    const res = await fetch("/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lat: state.origin.lat,
        lon: state.origin.lon,
        minutes: state.minutes,
        scenic: state.scenic,
        hills: state.hills,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || "Something went wrong planning that walk.");
      return;
    }
    renderWalk(data.walk);
  } catch (err) {
    showToast(`Could not reach the planner. ${err.message}`);
  } finally {
    setBusy(false);
  }
}

function setBusy(busy) {
  state.busy = busy;
  els.go.disabled = busy;
  els.goLabel.textContent = busy ? "Finding your walk…" : "Walk me";
  els.loading.hidden = !busy;
  if (busy) {
    // The first request for an area pays for Overpass + terrain; say so.
    els.loadingText.textContent = "Reading the streets…";
    setTimeout(() => {
      if (state.busy) els.loadingText.textContent = "Scoring viewpoints and slopes…";
    }, 2600);
    setTimeout(() => {
      if (state.busy) els.loadingText.textContent = "First walk in a new area takes a moment…";
    }, 8000);
  }
}

/* ---------- Rendering ---------- */

const STOP_ICONS = {
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

function renderWalk(walk) {
  routeLayer.clearLayers();
  markerLayer.clearLayers();
  if (startMarker) startMarker.addTo(markerLayer);

  drawRoute(walk.coordinates);
  drawStops(walk.stops);
  renderStats(walk);
  renderProfile(walk);
  renderStops(walk.stops);

  els.results.hidden = false;

  // Measure the tray rather than guessing: its height changes with the number
  // of stat tiles, and an unpadded fit tucks the route underneath it.
  const narrow = window.innerWidth <= 860;
  const tray = els.results.offsetHeight + 28;
  map.fitBounds(L.latLngBounds(walk.coordinates), {
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
function drawRoute(coords) {
  if (coords.length < 2) return;

  L.polyline(coords, {
    color: "#ff9b4a",
    weight: 15,
    opacity: 0.13,
    lineJoin: "round",
    lineCap: "round",
    interactive: false,
  }).addTo(routeLayer);

  const STOPS = [
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

function gradientAt(stops, t) {
  const scaled = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const a = stops[i];
  const b = stops[i + 1];
  const mix = a.map((v, k) => Math.round(v + (b[k] - v) * f));
  return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
}

function drawStops(stops) {
  stops.forEach((stop) => {
    const icon = STOP_ICONS[stop.kind] || "✦";
    L.marker([stop.lat, stop.lon], {
      icon: L.divIcon({
        className: "",
        html: `<div class="stop-marker">${icon}</div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      }),
    })
      .bindPopup(
        `<b>${escapeHtml(stop.name)}</b><em>${labelFor(stop.kind)} · ${fmtDistance(stop.at)} in</em>`,
      )
      .addTo(markerLayer);
  });
}

function renderStats(walk) {
  const hinPct = walk.distance > 0 ? (walk.hinMetres / walk.distance) * 100 : 0;
  const carFreePct = walk.distance > 0 ? (walk.carFreeMetres / walk.distance) * 100 : 0;

  const stats = [
    { value: fmtDistance(walk.distance), label: "Distance" },
    { value: `${Math.round(walk.duration / 60)} min`, label: "On foot" },
    { value: `${Math.round(walk.ascent)} m`, label: "Climb" },
    {
      value: `${Math.round(carFreePct)}%`,
      label: "Car-free",
      tone: carFreePct > 35 ? "good" : null,
    },
    {
      value: hinPct < 1 ? "None" : `${Math.round(hinPct)}%`,
      label: "High-injury st.",
      tone: hinPct < 5 ? "good" : hinPct < 20 ? "warn" : "bad",
    },
  ];

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

function renderProfile(walk) {
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
  const maxD = pts[pts.length - 1].d || 1;
  const eles = pts.map((p) => p.ele);
  const lo = Math.min(...eles);
  const hi = Math.max(...eles);
  const span = Math.max(8, hi - lo); // never exaggerate a flat walk

  const x = (d) => (d / maxD) * W;
  const y = (e) => H - PAD - ((e - lo) / span) * (H - PAD * 2);

  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.d).toFixed(1)},${y(p.ele).toFixed(1)}`).join(" ");
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

function renderStops(stops) {
  if (stops.length === 0) {
    els.stops.innerHTML =
      '<span class="chip chip--empty">No named landmarks on this one — just good streets</span>';
    return;
  }
  els.stops.innerHTML = stops
    .map(
      (s, i) => `<button class="chip" data-i="${i}">
        <span class="chip__icon">${STOP_ICONS[s.kind] || "✦"}</span>
        <span>${escapeHtml(s.name)}</span>
        <span class="chip__at">${fmtDistance(s.at)}</span>
      </button>`,
    )
    .join("");

  els.stops.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const stop = stops[Number(chip.dataset.i)];
      map.flyTo([stop.lat, stop.lon], 17, { duration: 0.7 });
    });
  });
}

/* ---------- Utilities ---------- */

function labelFor(kind) {
  const labels = {
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
  return labels[kind] || "Point of interest";
}

function fmtDistance(m) {
  return m < 950 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

let toastTimer;
function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 7000);
}
function hideToast() {
  els.toast.hidden = true;
}

/* ---------- Boot ---------- */

setOrigin(SF_DEFAULT.lat, SF_DEFAULT.lon, "Alamo Square");
els.locate.classList.remove("is-set");
els.locateLabel.textContent = "Use my location";
els.locateSub.textContent = "starting at Alamo Square — or tap the map";
