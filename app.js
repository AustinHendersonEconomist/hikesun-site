/* Sunward static web UI: search form -> Engine.search cards; clicking a card
 * draws the trail as per-point sun/shade segments from Engine.trailDetail,
 * and the time scrubber recomputes the detail to recolour the trail live.
 * All scoring runs client-side (engine.js); only the map tiles, regional
 * data shards, geocoding, photos and the Open-Meteo cloud forecast come from
 * the network. The search origin is user-movable (draggable pin, map click,
 * address search or geolocation) and persists in localStorage. Vanilla JS. */

"use strict";

const SUN_COLOR = "#FDB515";
const SHADE_COLOR = "#64748B";
const SUN_RGB = [253, 181, 21];
const SHADE_RGB = [203, 213, 225]; // light grey for 0%-sun timeline slots
const DRIVE_KM_PER_MIN = 0.85; // crow-flies km per minute of driving
const SCRUB_HINT = "Drag the slider to move the sun; click a trail to see its sunlight";

// Search origin: user-movable, persisted; default is Cathedral Square,
// Christchurch (same default as the API). Stored as {lon, lat, label}.
const DEFAULT_ORIGIN = { lon: 172.6362, lat: -43.5321, label: "Christchurch (default)" };
const ORIGIN_STORE_KEY = "hikesun-origin";
const RANKMODE_STORE_KEY = "hikesun-rankmode";
const SHADOWS_STORE_KEY = "hikesun-shadows";
const SHADOW_DEBOUNCE_MS = 150;
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";

const SOURCE_LABELS = {
  doc: ["DOC", "Department of Conservation"],
  osm: ["OSM", "OpenStreetMap"],
  hnk: ["HNK", "Herenga ā Nuku Outdoor Access Commission"],
};

/* place kinds (beaches/gardens/parks/reserves): chip emoji, and the unnamed
 * fallback — "Unnamed track" for hikes, "Unnamed beach" etc. for places */
const KIND_EMOJI = { beach: "🏖", garden: "🌳", park: "🌳", reserve: "🦜" };

function displayName(r) {
  if (r.name) return r.name;
  const kind = r.kind || "hike";
  return kind === "hike" ? "Unnamed track" : `Unnamed ${kind}`;
}

/* fetch with a hard timeout so a dead third-party service can't hang the UI */
function fetchTimeout(url, ms = 8000) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ms);
  return fetch(url, { signal: abort.signal }).finally(() => clearTimeout(timer));
}

const el = (id) => document.getElementById(id);
const form = el("search-form");
const dateInput = el("date");
const timeInput = el("time");
const statusBox = el("status");
const resultsBox = el("results");
const scrub = el("scrub");
const scrubLabel = el("scrub-label");
const scrubInfo = el("scrub-info");

let selected = null;      // currently selected search result
let searchSeq = 0;        // guards against out-of-order searches
let photoSeq = 0;         // guards against out-of-order photo-strip loads
let scrubTimer = null;
let engineReady = false;  // Engine.loadIndex succeeded
let lastResults = [];     // most recent search results, re-sorted client-side
                           // by the rank toggle (no refetch)

/* ---- rank mode (terrain vs forecast) ------------------------------------- */

function loadRankMode() {
  try {
    const v = localStorage.getItem(RANKMODE_STORE_KEY);
    if (v === "terrain" || v === "forecast") return v;
  } catch (err) { /* corrupt/unavailable storage — fall back to default */ }
  return "forecast";
}

let rankMode = loadRankMode();
let rankLocked = false; // true when forecast is unavailable for this search

/* ---- origin state -------------------------------------------------------- */

function loadStoredOrigin() {
  try {
    const raw = localStorage.getItem(ORIGIN_STORE_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      if (o && Number.isFinite(o.lon) && Number.isFinite(o.lat)) {
        return { lon: o.lon, lat: o.lat, label: String(o.label || "Saved origin") };
      }
    }
  } catch (err) { /* corrupt storage — fall back to the default */ }
  return { ...DEFAULT_ORIGIN };
}

let origin = loadStoredOrigin();

/* ---- map ---------------------------------------------------------------- */

const map = L.map("map", { zoomControl: true })
  .setView([origin.lat, origin.lon], 11);

const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const esri = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  { maxZoom: 19, attribution: "Imagery &copy; Esri &amp; contributors" }
);

L.control.layers({ "Map": osm, "Satellite": esri }).addTo(map);

const markersLayer = L.layerGroup().addTo(map);
const trailLayer = L.layerGroup().addTo(map);

/* map marker for a result: hikes stay a sun-tinted dot; places (beaches,
 * parks, gardens, reserves) get a recognisable emoji badge, still tinted by
 * how sunny they are, so you can spot a beach on the map at a glance. */
function makeMarker(r) {
  const kind = r.kind || "hike";
  const tint = sunTint(headlineFrac(r));
  if (kind === "hike") {
    return L.circleMarker([r.start[1], r.start[0]], {
      radius: 7, color: "#fff", weight: 2, fillColor: tint, fillOpacity: 1,
    });
  }
  const icon = L.divIcon({
    className: "place-marker",
    html: `<span style="background:${tint}">${KIND_EMOJI[kind] || "📍"}</span>`,
    iconSize: [26, 26], iconAnchor: [13, 13],
  });
  return L.marker([r.start[1], r.start[0]], { icon });
}

/* ---- terrain shadow overlay ----------------------------------------------
 * Dedicated shadowPane (zIndex 350, between basemap tiles 200 and trails
 * 400), pointer-events:none, opacity ~0.45 so trails stay visible above it.
 * ShadowLayer creates the pane itself on first onAdd, but we also create it
 * here up front so it exists (and is correctly ordered) even before the
 * layer is toggled on for the first time. */
map.createPane("shadowPane");
map.getPane("shadowPane").style.zIndex = 350;
map.getPane("shadowPane").style.pointerEvents = "none";

const isCoarsePointer = typeof matchMedia === "function"
  && matchMedia("(pointer: coarse)").matches;

function loadShadowsEnabled() {
  try {
    const v = localStorage.getItem(SHADOWS_STORE_KEY);
    if (v === "on" || v === "off") return v === "on";
  } catch (err) { /* corrupt/unavailable storage — fall back to default */ }
  return !isCoarsePointer; // default ON for desktop, OFF for coarse pointers
}

let shadowsEnabled = loadShadowsEnabled();

const shadowLayer = new ShadowLayer({
  workerUrl: "shadow-worker.js",
  mode: "auto",
  opacity: 0.45,
});
const shadowBusyChip = el("shadow-busy");
shadowLayer.on("shadow:busy", () => { shadowBusyChip.hidden = false; });
shadowLayer.on("shadow:idle", () => { shadowBusyChip.hidden = true; });

const shadowToggleBtn = el("shadow-toggle");

function syncShadowToggleUI() {
  shadowToggleBtn.classList.toggle("on", shadowsEnabled);
  shadowToggleBtn.setAttribute("aria-pressed", String(shadowsEnabled));
}

function applyShadowEnabled() {
  if (shadowsEnabled) {
    if (!map.hasLayer(shadowLayer)) shadowLayer.addTo(map);
    shadowLayer.setEnabled(true);
    shadowLayer.setTime(currentShadowEpochMs());
  } else {
    shadowLayer.setEnabled(false);
    shadowBusyChip.hidden = true;
  }
}

function setShadowsEnabled(on) {
  shadowsEnabled = on;
  try {
    localStorage.setItem(SHADOWS_STORE_KEY, on ? "on" : "off");
  } catch (err) { /* private mode etc. — preference just won't persist */ }
  syncShadowToggleUI();
  applyShadowEnabled();
}

shadowToggleBtn.addEventListener("click", () => setShadowsEnabled(!shadowsEnabled));

/* ---- live satellite cloud overlay (NASA GIBS / Himawari Band 13 IR) ------
 * LIVE ONLY: shows the most recent published frame (typically 20-30 min old)
 * and deliberately does NOT follow the time scrubber — the terrain shadows
 * do, but the satellite cannot show the future. Infrared greyscale:
 * bright/white = cloud tops. Frames are published every 10 minutes with some
 * latency, so we probe one known tile and step back until a frame exists. */
const CLOUDS_STORE_KEY = "hikesun-clouds"; // legacy key prefix kept on purpose
const GIBS_URL_PREFIX = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/" +
  "Himawari_AHI_Band13_Clean_Infrared/default/";
const GIBS_URL_SUFFIX = "/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png";
const CLOUD_FRAME_LAG_MIN = 20;         // first candidate: now minus this
const CLOUD_PROBE_TRIES = 6;            // then step back 10 min at a time
const CLOUD_REFRESH_MS = 10 * 60 * 1000;

// cloudPane: above the shadow overlay (350), below the trail lines (400)
map.createPane("cloudPane");
map.getPane("cloudPane").style.zIndex = 360;
map.getPane("cloudPane").style.pointerEvents = "none";

const cloudToggleBtn = el("cloud-toggle");
const cloudCaption = el("cloud-caption");

let cloudsEnabled = false;
let cloudLayer = null;
let cloudRefreshTimer = null;
let cloudSeq = 0; // guards overlapping enable/refresh probe chains

function loadCloudsEnabled() {
  try {
    const v = localStorage.getItem(CLOUDS_STORE_KEY);
    if (v === "on" || v === "off") return v === "on";
  } catch (err) { /* corrupt/unavailable storage — fall back to default */ }
  return false; // default OFF
}

function storeCloudsEnabled(on) {
  try {
    localStorage.setItem(CLOUDS_STORE_KEY, on ? "on" : "off");
  } catch (err) { /* private mode etc. — preference just won't persist */ }
}

function gibsUrl(frameIso) {
  return GIBS_URL_PREFIX + frameIso + GIBS_URL_SUFFIX;
}

/* UTC ISO "YYYY-MM-DDTHH:MM:00Z" for (now − lag − stepBack·10 min), floored
 * to a 10-minute boundary (GIBS publishes Himawari frames every 10 min). */
function cloudFrameIso(stepBack) {
  const tenMinMs = 10 * 60000;
  const t = Math.floor((Date.now() - CLOUD_FRAME_LAG_MIN * 60000
    - stepBack * tenMinMs) / tenMinMs) * tenMinMs;
  return new Date(t).toISOString().slice(0, 17) + "00Z";
}

/* probe a single tile that covers NZ at z=6 (row y=40, col x=62 — note GIBS
 * WMTS puts the row before the column) to see if the frame is published */
async function probeCloudFrame(frameIso) {
  const url = gibsUrl(frameIso)
    .replace("{z}", "6").replace("{y}", "40").replace("{x}", "62");
  try {
    const resp = await fetchTimeout(url);
    return resp.ok;
  } catch (err) {
    return false;
  }
}

/* newest available frame time, or null if none of the candidates exists */
async function findCloudFrame() {
  for (let step = 0; step < CLOUD_PROBE_TRIES; step++) {
    const iso = cloudFrameIso(step);
    if (await probeCloudFrame(iso)) return iso;
  }
  return null;
}

function syncCloudToggleUI() {
  cloudToggleBtn.classList.toggle("on", cloudsEnabled);
  cloudToggleBtn.setAttribute("aria-pressed", String(cloudsEnabled));
}

/* create-or-retarget the tile layer for a frame and update the caption
 * (frame time shown as NZ local wall clock) */
function applyCloudFrame(frameIso) {
  const url = gibsUrl(frameIso);
  if (!cloudLayer) {
    cloudLayer = L.tileLayer(url, {
      tms: false,
      maxNativeZoom: 6,
      maxZoom: 15,
      opacity: 0.55,
      pane: "cloudPane",
    });
  } else if (cloudLayer._url !== url) {
    cloudLayer.setUrl(url);
  }
  if (!map.hasLayer(cloudLayer)) cloudLayer.addTo(map);
  cloudCaption.textContent =
    `clouds: live satellite ${SunMath.isoNZ(Date.parse(frameIso)).slice(11, 16)}`;
  cloudCaption.hidden = false;
}

function disableClouds({ persist = true } = {}) {
  cloudSeq++; // cancels any in-flight probe chain
  cloudsEnabled = false;
  if (persist) storeCloudsEnabled(false);
  clearInterval(cloudRefreshTimer);
  cloudRefreshTimer = null;
  if (cloudLayer && map.hasLayer(cloudLayer)) map.removeLayer(cloudLayer);
  cloudCaption.hidden = true;
  syncCloudToggleUI();
}

async function enableClouds({ persist = true } = {}) {
  const seq = ++cloudSeq;
  cloudsEnabled = true;
  if (persist) storeCloudsEnabled(true);
  syncCloudToggleUI();
  const frame = await findCloudFrame();
  if (seq !== cloudSeq) return; // toggled off (or re-toggled) meanwhile
  if (frame == null) {
    showToast("live cloud imagery unavailable right now");
    disableClouds(); // leaves the toggle off
    return;
  }
  applyCloudFrame(frame);
  clearInterval(cloudRefreshTimer);
  cloudRefreshTimer = setInterval(refreshCloudFrame, CLOUD_REFRESH_MS);
}

/* every 10 min while enabled: look for a newer frame and retarget the layer;
 * if GIBS is briefly unreachable just keep showing the last good frame */
async function refreshCloudFrame() {
  const seq = cloudSeq;
  const frame = await findCloudFrame();
  if (seq !== cloudSeq || !cloudsEnabled || frame == null) return;
  applyCloudFrame(frame);
}

cloudToggleBtn.addEventListener("click", () => {
  if (cloudsEnabled) disableClouds();
  else enableClouds();
});

if (loadCloudsEnabled()) enableClouds({ persist: false });

/* full-screen map: hide the sidebar so the map fills the viewport. Leaflet
 * needs invalidateSize() once the container has resized. */
const mapExpandBtn = el("map-expand");
mapExpandBtn.addEventListener("click", () => {
  const full = document.body.classList.toggle("map-full");
  mapExpandBtn.textContent = full ? "✕" : "⛶";
  mapExpandBtn.setAttribute("aria-pressed", String(full));
  mapExpandBtn.title = full ? "Exit full-screen map" : "Toggle full-screen map";
  setTimeout(() => map.invalidateSize(), 60);
});

/* current scrubber time as an NZ epoch (ms), for the shadow layer */
function currentShadowEpochMs() {
  return SunMath.nzEpoch(dateInput.value, minutesToHHMM(+scrub.value));
}

let shadowTimer = null;
function scheduleShadowUpdate() {
  if (!shadowsEnabled) return;
  clearTimeout(shadowTimer);
  shadowTimer = setTimeout(() => {
    shadowLayer.setTime(currentShadowEpochMs());
  }, SHADOW_DEBOUNCE_MS);
}

// sun-yellow draggable origin pin, kept above the result markers
const originIcon = L.divIcon({
  className: "origin-pin",
  iconSize: [30, 42],
  iconAnchor: [15, 41],
  html:
    '<svg width="30" height="42" viewBox="0 0 30 42" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M15 41C15 41 3 24.5 3 13a12 12 0 1 1 24 0c0 11.5-12 28-12 28z"' +
    ' fill="#FDB515" stroke="#fff" stroke-width="2.5"/>' +
    '<circle cx="15" cy="13" r="4.5" fill="#7a5200"/></svg>',
});

const originMarker = L.marker([origin.lat, origin.lon], {
  icon: originIcon,
  draggable: true,
  zIndexOffset: 1000,
  title: "Search origin — drag to move",
}).addTo(map);
originMarker.bindTooltip("Search origin — drag to move");

originMarker.on("dragend", () => {
  const ll = originMarker.getLatLng();
  setOrigin(ll.lng, ll.lat,
    `Dropped pin (${ll.lat.toFixed(4)}, ${ll.lng.toFixed(4)})`, { recenter: false });
});

/* ---- helpers ------------------------------------------------------------ */

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function showStatus(msg, isError) {
  statusBox.hidden = false;
  statusBox.textContent = msg;
  statusBox.classList.toggle("error", !!isError);
}

function clearStatus() {
  statusBox.hidden = true;
}

let toastTimer = null;
function showToast(msg) {
  const t = el("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
}

/* grey -> sun-yellow tint for a sun fraction in [0, 1] */
function sunTint(frac) {
  const f = Math.max(0, Math.min(1, frac));
  const c = SHADE_RGB.map((s, i) => Math.round(s + (SUN_RGB[i] - s) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function fmtMinutes(min) {
  if (min == null) return "time n/a";
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

// canopy chip: native bush vs plantation (LCDB land-cover), or null to omit
const CANOPY_KIND = {
  native: ["🌿", "native bush"],
  exotic: ["🌲", "plantation"],
  mixed: ["🌳", "mixed forest"],
};
function canopyMeta(r) {
  if (r.canopy_frac == null || r.canopy_type === "none") return null;
  const pct = Math.round(r.canopy_frac * 100);
  if (pct === 0) return null;   // barely clips bush — not worth a chip
  const [emoji, label] = CANOPY_KIND[r.canopy_type] || ["🌲", "canopy"];
  return `<span title="Tree canopy (LCDB land cover)">${emoji} ${pct}% ${label}</span>`;
}

function minutesToHHMM(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function hhmmToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
}

/* ---- origin controls ----------------------------------------------------- */

function setOrigin(lon, lat, label, opts = {}) {
  origin = { lon, lat, label };
  try {
    localStorage.setItem(ORIGIN_STORE_KEY, JSON.stringify(origin));
  } catch (err) { /* private mode etc. — origin just won't persist */ }
  originMarker.setLatLng([lat, lon]);
  el("origin-label").textContent = `📍 Origin: ${label}`;
  if (opts.recenter) map.setView([lat, lon], Math.max(map.getZoom(), 11));
  showToast("Origin set");
  runSearch();
}

/* "set origin by clicking the map" toggle */
const armBtn = el("origin-arm");
let picking = false;

function setPicking(on) {
  picking = on;
  armBtn.classList.toggle("armed", on);
  armBtn.textContent = on ? "Click the map to set origin…" : "📍 Set origin";
  el("map").classList.toggle("picking", on);
}

armBtn.addEventListener("click", () => setPicking(!picking));

map.on("click", (ev) => {
  if (!picking) return;
  setPicking(false);
  setOrigin(ev.latlng.lng, ev.latlng.lat,
    `Dropped pin (${ev.latlng.lat.toFixed(4)}, ${ev.latlng.lng.toFixed(4)})`,
    { recenter: false });
});

/* address search (Nominatim, debounced, Enter/button only per fair use) */
const addrInput = el("addr");
const addrResults = el("addr-results");
let addrTimer = null;
let geocodeSeq = 0;

function requestGeocode() {
  clearTimeout(addrTimer);
  addrTimer = setTimeout(geocode, 400);
}

async function geocode() {
  const q = addrInput.value.trim();
  if (!q) {
    hideAddrResults();
    return;
  }
  const seq = ++geocodeSeq;
  let places;
  try {
    const resp = await fetchTimeout(
      `${NOMINATIM_URL}?format=json&countrycodes=nz&limit=5&q=${encodeURIComponent(q)}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    places = await resp.json();
  } catch (err) {
    if (seq === geocodeSeq) {
      showStatus("Address lookup failed — check your connection and try again.", true);
    }
    return;
  }
  if (seq !== geocodeSeq) return;
  renderAddrResults(places);
}

function renderAddrResults(places) {
  addrResults.innerHTML = "";
  if (!places.length) {
    const none = document.createElement("div");
    none.className = "addr-empty";
    none.textContent = "No NZ matches — try adding a suburb or town.";
    addrResults.appendChild(none);
  }
  for (const p of places) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = p.display_name;
    btn.title = p.display_name;
    btn.addEventListener("click", () => {
      const label = String(p.display_name).split(",").slice(0, 2).join(",");
      hideAddrResults();
      addrInput.value = label;
      setOrigin(parseFloat(p.lon), parseFloat(p.lat), label, { recenter: true });
    });
    addrResults.appendChild(btn);
  }
  const credit = document.createElement("div");
  credit.className = "addr-credit";
  credit.textContent = "search © OpenStreetMap Nominatim";
  addrResults.appendChild(credit);
  addrResults.hidden = false;
}

function hideAddrResults() {
  addrResults.hidden = true;
  addrResults.innerHTML = "";
}

el("addr-go").addEventListener("click", requestGeocode);
addrInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault(); // find the address; don't submit the search form
    requestGeocode();
  } else if (ev.key === "Escape") {
    hideAddrResults();
  }
});
document.addEventListener("click", (ev) => {
  if (!addrResults.hidden && !ev.target.closest(".addr-row")) hideAddrResults();
});

/* "use my location" (may be blocked — degrade with a message) */
el("locate-btn").addEventListener("click", () => {
  if (!navigator.geolocation) {
    showStatus("Geolocation is not available in this browser — try the address box.", true);
    return;
  }
  showStatus("Locating…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      clearStatus();
      setOrigin(pos.coords.longitude, pos.coords.latitude, "My location",
        { recenter: true });
    },
    () => showStatus(
      "Could not get your location (it may be blocked) — try the address box.", true),
    { timeout: 10000 },
  );
});

/* ---- search ------------------------------------------------------------- */

/* checked "Show" kinds as a flat array (one chip may carry several comma-
 * separated kinds, e.g. "park,garden"), or null when every chip is checked —
 * all-on means no kind constraint. All-off yields [] (matches nothing). */
function selectedKinds() {
  const boxes = [...document.querySelectorAll("#kinds input")];
  const checked = boxes.filter((b) => b.checked);
  if (!boxes.length || checked.length === boxes.length) return null;
  return checked.flatMap((b) => b.value.split(","));
}

async function runSearch() {
  if (!engineReady) return; // index not loaded (message already shown)
  const btn = el("search-btn");
  const seq = ++searchSeq;
  btn.disabled = true;
  clearStatus();
  try {
    const dateStr = dateInput.value;
    const timeStr = timeInput.value || "10:00";
    const driveMin = Number(el("drive-min").value) || 30;
    const startMs = Engine.nzEpoch(dateStr, timeStr);

    // make sure the regional data shards covering the drive radius are in
    showStatus("Loading region data…");
    await Engine.ensureCells([origin.lon, origin.lat], driveMin * DRIVE_KM_PER_MIN);
    if (seq !== searchSeq) return; // superseded by a newer search

    const minM = el("min-minutes").value;
    const maxM = el("max-minutes").value;
    const checked = [...document.querySelectorAll("#difficulty input:checked")]
      .map((c) => c.value);
    const results = await Engine.search({
      lat: origin.lat,
      lon: origin.lon,
      driveMin,
      startMs,
      minMinutes: minM ? Number(minM) : null,
      maxMinutes: maxM ? Number(maxM) : null,
      difficulties: checked.length ? checked : null,
      kinds: selectedKinds(),
      limit: 20,
      useWeather: true,
      rankBy: rankMode,
    });
    if (seq !== searchSeq) return; // superseded by a newer search
    lastResults = results;
    renderResults(results);
  } catch (err) {
    if (seq !== searchSeq) return;
    resultsBox.innerHTML = "";
    showStatus(`Search failed: ${err.message}`, true);
  } finally {
    if (seq === searchSeq) btn.disabled = false;
  }
}

/* headline metric for a result under the current rank mode: "forecast" shows
 * sun.effective (terrain x cloud), "terrain" shows sun.terrain_frac. When a
 * trail has no forecast, effective === terrain_frac already, so this never
 * needs a special case. */
function headlineFrac(r) {
  return rankMode === "terrain" ? r.sun.terrain_frac : r.sun.effective;
}

function sortResults(results) {
  const sorted = results.slice();
  if (rankMode === "terrain") {
    sorted.sort((a, b) => b.sun.terrain_frac - a.sun.terrain_frac);
  } else {
    sorted.sort((a, b) => b.sun.effective - a.sun.effective);
  }
  return sorted;
}

/* Lock the rank toggle to terrain (with an explanatory note) when NONE of
 * the results has a forecast — e.g. date beyond the ~16-day horizon, or
 * Open-Meteo unreachable. Never an error state. */
function updateRankLock(results) {
  rankLocked = results.length > 0 && results.every((r) => r.sun.no_forecast);
  const toggle = el("rank-toggle");
  const note = el("rank-lock-note");
  if (toggle) toggle.classList.toggle("locked", rankLocked);
  const forecastBtn = el("rank-forecast");
  if (forecastBtn) forecastBtn.disabled = rankLocked;
  if (rankLocked && rankMode !== "terrain") {
    rankMode = "terrain";
    syncRankToggleUI();
  }
  if (note) note.hidden = !rankLocked;
}

function syncRankToggleUI() {
  const terrainBtn = el("rank-terrain");
  const forecastBtn = el("rank-forecast");
  if (!terrainBtn || !forecastBtn) return;
  terrainBtn.classList.toggle("active", rankMode === "terrain");
  forecastBtn.classList.toggle("active", rankMode === "forecast");
  terrainBtn.setAttribute("aria-pressed", String(rankMode === "terrain"));
  forecastBtn.setAttribute("aria-pressed", String(rankMode === "forecast"));
}

function setRankMode(mode) {
  if (mode === rankMode) return;
  rankMode = mode;
  try {
    localStorage.setItem(RANKMODE_STORE_KEY, rankMode);
  } catch (err) { /* private mode etc. — rank mode just won't persist */ }
  syncRankToggleUI();
  if (lastResults.length) renderResults(lastResults);
}

function renderResults(results) {
  resultsBox.innerHTML = "";
  markersLayer.clearLayers();
  trailLayer.clearLayers();
  selected = null;
  hidePhotoStrip();
  scrubInfo.textContent = SCRUB_HINT;
  // start the shared scrubber at the searched time; from here the user can
  // drag it freely (moving the shadows) and any trail they pick is shown at
  // whatever time the slider is on.
  const searchMin = hhmmToMinutes(timeInput.value || "10:00");
  scrub.value = Math.max(480, Math.min(1020, Math.round(searchMin / 15) * 15));
  scrubLabel.textContent = minutesToHHMM(+scrub.value);
  scheduleShadowUpdate();

  updateRankLock(results);
  syncRankToggleUI();

  if (!results.length) {
    showStatus("No trails found — try a longer drive time or fewer filters.");
    return;
  }
  const sorted = sortResults(results);
  showStatus(`${sorted.length} trail${sorted.length > 1 ? "s" : ""} found, sunniest first.`);

  for (const r of sorted) {
    const card = buildCard(r);
    resultsBox.appendChild(card);

    const marker = makeMarker(r).addTo(markersLayer);
    marker.bindTooltip(displayName(r));
    marker.on("click", () => {
      selectTrail(r, card);
      card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }
}

function sourceBadge(source) {
  const key = String(source || "").toLowerCase();
  const [label, full] = SOURCE_LABELS[key] || [key.toUpperCase() || "?", ""];
  const cls = SOURCE_LABELS[key] ? key : "osm";
  return `<span class="badge ${cls}" title="${escapeHtml(full)}">${escapeHtml(label)}</span>`;
}

/* thin cloud strip above a card's sun timeline: one segment per timeline_cloud
 * slot, grey-scale by cloud fraction (dark = cloudy). Absent/all-null ->
 * caller omits the strip entirely (no forecast for this trail). */
function cloudStripHtml(r) {
  const tc = r.timeline_cloud;
  if (!tc || !tc.length || tc.every((c) => c == null)) return "";
  const slots = r.timeline.map((s, i) => {
    const c = tc[i];
    const label = c == null
      ? `${s.t.slice(11, 16)} — ${Math.round(s.frac * 100)}% terrain sun · no forecast`
      : `${s.t.slice(11, 16)} — ${Math.round(s.frac * 100)}% terrain sun · ${Math.round(c * 100)}% cloud`;
    const bg = c == null ? "#e2e6eb" : cloudTint(c);
    return `<i style="background:${bg}" title="${escapeHtml(label)}"></i>`;
  }).join("");
  return `<div class="cloud-strip">${slots}</div>`;
}

/* white (clear) -> mid-grey (overcast) tint for a cloud fraction in [0, 1] */
function cloudTint(frac) {
  const f = Math.max(0, Math.min(1, frac));
  const v = Math.round(245 - 110 * f);
  return `rgb(${v},${v},${v})`;
}

function buildCard(r) {
  const card = document.createElement("div");
  card.className = "card";

  const headline = headlineFrac(r);
  const sunPct = Math.round(headline * 100);
  const meta = [];
  meta.push(sourceBadge(r.source));
  const kind = r.kind || "hike";
  if (kind !== "hike") {
    meta.push(`<span class="chip kind" title="Place type">` +
      `${KIND_EMOJI[kind] || "📍"} ${escapeHtml(kind)}</span>`);
  }
  if (r.difficulty) {
    meta.push(`<span class="chip ${escapeHtml(r.difficulty)}">${escapeHtml(r.difficulty)}</span>`);
  }
  if (r.region) {
    meta.push(`<span title="Region">📍 ${escapeHtml(r.region)}</span>`);
  }
  meta.push(`<span>🥾 ${fmtMinutes(r.est_minutes)}</span>`);
  meta.push(`<span>🚗 ~${Math.round(r.drive_min_est)} min (${r.drive_km.toFixed(0)} km)</span>`);
  const canopy = canopyMeta(r);
  if (canopy) meta.push(canopy);

  const slots = r.timeline.map((s) =>
    `<i style="background:${sunTint(s.frac)}" title="${s.t.slice(11, 16)} — ${Math.round(s.frac * 100)}% in sun"></i>`
  ).join("");
  const tlStart = r.timeline.length ? r.timeline[0].t.slice(11, 16) : "";
  const tlEnd = r.timeline.length ? r.timeline[r.timeline.length - 1].t.slice(11, 16) : "";
  const cloudStrip = cloudStripHtml(r);

  const photo = r.photo_url
    ? `<img class="card-photo" src="${escapeHtml(r.photo_url)}" alt="" loading="lazy">`
    : "";
  if (photo) card.classList.add("has-photo");

  const componentsLine = r.sun.no_forecast
    ? `<small>sun · no forecast</small>`
    : `<small title="sun score = terrain sun × (1 − 0.75 × cloud), duration-weighted over your hike window">` +
      `☀ ${Math.round(r.sun.terrain_frac * 100)}% terrain · ` +
      `☁ ${Math.round(r.sun.cloud_cover * 100)}% cloud</small>`;

  card.innerHTML = `
    ${photo}
    <div class="card-main">
      <div class="card-top">
        <h3>${escapeHtml(displayName(r))}</h3>
        <div class="sunpct">
          <b>${sunPct}%</b>
          ${componentsLine}
        </div>
      </div>
      <div class="meta">${meta.join("")}</div>
      ${cloudStrip}
      <div class="timeline">${slots}</div>
      <div class="tl-caption"><span>${tlStart}</span><span>sun along your hike</span><span>${tlEnd}</span></div>
    </div>
  `;
  const img = card.querySelector(".card-photo");
  if (img) {
    // broken/blocked thumbnails degrade to the photo-less card look
    img.addEventListener("error", () => {
      img.remove();
      card.classList.remove("has-photo");
    });
  }
  card.addEventListener("click", () => selectTrail(r, card));
  return card;
}

/* ---- photos (trail photo + nearby Wikimedia Commons) --------------------- */

function hidePhotoStrip() {
  photoSeq++;
  el("photo-strip").hidden = true;
  el("photos").innerHTML = "";
  el("photo-credit").hidden = true;
}

/* up to 4 CC photos geotagged within 2 km of (lat, lon); [] on ANY failure */
async function fetchCommonsPhotos(lat, lon) {
  try {
    const geoResp = await fetchTimeout(
      `${COMMONS_API}?action=query&list=geosearch&gscoord=${lat.toFixed(5)}%7C${lon.toFixed(5)}` +
      "&gsradius=2000&gsnamespace=6&gslimit=4&format=json&origin=*");
    if (!geoResp.ok) return [];
    const geoBody = await geoResp.json();
    const found = (geoBody.query && geoBody.query.geosearch) || [];
    if (!found.length) return [];
    const ids = found.map((p) => p.pageid).join("|");
    const infoResp = await fetchTimeout(
      `${COMMONS_API}?action=query&prop=imageinfo&iiprop=url&iiurlwidth=200` +
      `&pageids=${encodeURIComponent(ids)}&format=json&origin=*`);
    if (!infoResp.ok) return [];
    const infoBody = await infoResp.json();
    const out = [];
    for (const page of Object.values((infoBody.query && infoBody.query.pages) || {})) {
      const ii = page.imageinfo && page.imageinfo[0];
      if (ii && ii.thumburl) {
        out.push({
          thumb: ii.thumburl,
          href: ii.descriptionurl || null,
          title: String(page.title || "").replace(/^File:/, ""),
        });
      }
    }
    return out.slice(0, 4);
  } catch (err) {
    return []; // photos are decoration — never let them break the UI
  }
}

async function loadPhotoStrip(r) {
  const seq = ++photoSeq;
  const strip = el("photo-strip");
  const box = el("photos");
  strip.hidden = true;
  box.innerHTML = "";
  el("photo-credit").hidden = true;

  const items = [];
  if (r.photo_url) {
    items.push({ thumb: r.photo_url, href: r.url || null, title: displayName(r) });
  }
  const commons = await fetchCommonsPhotos(r.start[1], r.start[0]);
  if (seq !== photoSeq) return; // a newer selection superseded this load
  items.push(...commons);
  if (!items.length) return;

  for (const it of items) {
    let wrap;
    if (it.href) {
      wrap = document.createElement("a");
      wrap.href = it.href;
      wrap.target = "_blank";
      wrap.rel = "noopener";
    } else {
      wrap = document.createElement("span");
    }
    wrap.className = "photo";
    wrap.title = it.title || "";
    const img = document.createElement("img");
    img.src = it.thumb;
    img.alt = it.title || "";
    img.loading = "lazy";
    img.addEventListener("error", () => wrap.remove());
    wrap.appendChild(img);
    box.appendChild(wrap);
  }
  el("photo-credit").hidden = !commons.length;
  strip.hidden = false;
}

/* ---- trail detail + scrubber -------------------------------------------- */

function selectTrail(result, card) {
  selected = result;
  for (const c of resultsBox.querySelectorAll(".card")) c.classList.remove("selected");
  card.classList.add("selected");

  // keep the scrubber wherever the user left it (they may have been
  // exploring shadows at another time); show this trail's sun for that time
  loadTrailDetail(true);
  loadPhotoStrip(result);
}

function loadTrailDetail(fitMap) {
  if (!selected) return;
  try {
    const atMs = Engine.nzEpoch(dateInput.value, minutesToHHMM(+scrub.value));
    drawTrail(Engine.trailDetail(selected.id, atMs), fitMap);
  } catch (err) {
    showStatus(`Could not load trail: ${err.message}`, true);
  }
}

function drawTrail(detail, fitMap) {
  trailLayer.clearLayers();
  const pts = detail.points;
  if (pts.length < 2) return;

  const latlngs = pts.map((p) => [p.lat, p.lon]);
  // white casing underneath makes the colours pop on both base layers
  L.polyline(latlngs, { color: "#fff", weight: 9, opacity: 0.9, lineCap: "round" })
    .addTo(trailLayer);
  // per-point segments: segment i takes the sun state of its leading point
  for (let i = 0; i < pts.length - 1; i++) {
    L.polyline([latlngs[i], latlngs[i + 1]], {
      color: pts[i].sun ? SUN_COLOR : SHADE_COLOR,
      weight: 5,
      opacity: 1,
      lineCap: "round",
    }).addTo(trailLayer);
  }

  if (fitMap) map.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40] });

  const sunny = pts.filter((p) => p.sun).length;
  const pct = Math.round((100 * sunny) / pts.length);
  const cloudPct = cloudAtScrub();
  const cloudPart = cloudPct == null ? "" : ` · ${cloudPct}% cloud`;
  scrubInfo.textContent =
    `${displayName(detail)} — ${pct}% of the trail in sun at ${minutesToHHMM(+scrub.value)}${cloudPart}`;
}

/* cloud fraction (0-100) at the scrubber's current time for the selected
 * result's own timeline_cloud, or null if no forecast covers that slot. */
function cloudAtScrub() {
  if (!selected || !selected.timeline_cloud || !selected.timeline) return null;
  const scrubMin = +scrub.value;
  let best = null;
  let bestDiff = Infinity;
  for (let i = 0; i < selected.timeline.length; i++) {
    const slotMin = hhmmToMinutes(selected.timeline[i].t.slice(11, 16));
    const diff = Math.abs(slotMin - scrubMin);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = selected.timeline_cloud[i];
    }
  }
  return best == null ? null : Math.round(best * 100);
}

scrub.addEventListener("input", () => {
  scrubLabel.textContent = minutesToHHMM(+scrub.value);
  scheduleShadowUpdate();  // move the shadows regardless of any selection
  if (selected) {
    clearTimeout(scrubTimer);
    scrubTimer = setTimeout(() => loadTrailDetail(false), 120);
  } else {
    // no trail chosen yet: reflect the time and keep nudging toward the map
    scrubInfo.textContent = shadowsEnabled
      ? `Terrain shadows at ${minutesToHHMM(+scrub.value)} — click a trail to see its sunlight`
      : `${minutesToHHMM(+scrub.value)} — turn on 🌗 Shadows, or click a trail`;
  }
});

/* date change also drives the shadow overlay (bound to both the scrubber
 * and the date input, per the plan) */
dateInput.addEventListener("change", () => scheduleShadowUpdate());

/* ---- rank toggle ---------------------------------------------------------- */

const rankTerrainBtn = el("rank-terrain");
const rankForecastBtn = el("rank-forecast");
if (rankTerrainBtn && rankForecastBtn) {
  rankTerrainBtn.addEventListener("click", () => setRankMode("terrain"));
  rankForecastBtn.addEventListener("click", () => {
    if (!rankLocked) setRankMode("forecast");
  });
}

/* ---- boot ---------------------------------------------------------------- */

form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  runSearch();
});

(async function init() {
  // Default to today's date in NZ (the server resolved date=None the same
  // way), so viewers in other timezones still search the right NZ day.
  dateInput.value = Engine.nzDateStr();
  el("origin-label").textContent = `📍 Origin: ${origin.label}`;
  syncRankToggleUI();
  syncShadowToggleUI();
  applyShadowEnabled();

  // Sanity numbers for manual verification (see engine.js self-test block):
  // sunPosition(-43.5321, 172.6362, nzEpoch("2026-07-02","10:00")) should
  // give elevation ~14.7362, azimuth ~36.1774.
  const probe = Engine.sunPosition(-43.5321, 172.6362,
    Engine.nzEpoch("2026-07-02", "10:00"));
  console.log("Sunward static: sun @ Chch 2026-07-02 10:00 NZ =",
    probe.elevation.toFixed(4), "deg elev,", probe.azimuth.toFixed(4),
    "deg az (expect ~14.7362 / ~36.1774)");

  el("search-btn").disabled = true;
  showStatus("loading trail index…");
  try {
    await Engine.loadIndex(".");
    engineReady = true;
    console.log("Sunward static: trail index loaded");
  } catch (err) {
    showStatus(`Could not load trail data: ${err.message}`, true);
    return;
  } finally {
    el("search-btn").disabled = false;
  }
  runSearch();
})();
