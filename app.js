/* HikeSun static web UI: search form -> Engine.search cards; clicking a card
 * draws the trail as per-point sun/shade segments from Engine.trailDetail,
 * and the time scrubber recomputes the detail to recolour the trail live.
 * All scoring runs client-side (engine.js); only the map tiles and the
 * Open-Meteo cloud forecast come from the network. Vanilla JS. */

"use strict";

const SUN_COLOR = "#FDB515";
const SHADE_COLOR = "#64748B";
const SUN_RGB = [253, 181, 21];
const SHADE_RGB = [203, 213, 225]; // light grey for 0%-sun timeline slots
const UNNAMED = "Unnamed track";
// Search origin: Cathedral Square, Christchurch (same default as the API).
const ORIGIN_LON = 172.6362;
const ORIGIN_LAT = -43.5321;

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
let scrubTimer = null;

/* ---- map ---------------------------------------------------------------- */

const map = L.map("map", { zoomControl: true }).setView([-43.55, 172.65], 11);

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

function minutesToHHMM(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function hhmmToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
}

/* ---- search ------------------------------------------------------------- */

async function runSearch() {
  const btn = el("search-btn");
  btn.disabled = true;
  clearStatus();
  try {
    const dateStr = dateInput.value;
    const timeStr = timeInput.value || "10:00";
    const startMs = Engine.nzEpoch(dateStr, timeStr);
    // One forecast lookup for the origin (as the server did); null on any
    // failure means "no forecast" and terrain-only scores.
    const cloud = await Engine.getCloudCover(
      ORIGIN_LAT, ORIGIN_LON, dateStr, hhmmToMinutes(timeStr) / 60 | 0);
    const minM = el("min-minutes").value;
    const maxM = el("max-minutes").value;
    const checked = [...document.querySelectorAll("#difficulty input:checked")]
      .map((c) => c.value);
    const results = Engine.search({
      lat: ORIGIN_LAT,
      lon: ORIGIN_LON,
      driveMin: Number(el("drive-min").value) || 30,
      startMs,
      minMinutes: minM ? Number(minM) : null,
      maxMinutes: maxM ? Number(maxM) : null,
      difficulties: checked.length ? checked : null,
      limit: 20,
      cloud,
    });
    renderResults(results);
  } catch (err) {
    resultsBox.innerHTML = "";
    showStatus(`Search failed: ${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

function renderResults(results) {
  resultsBox.innerHTML = "";
  markersLayer.clearLayers();
  trailLayer.clearLayers();
  selected = null;
  scrub.disabled = true;
  scrubInfo.textContent = "Select a trail to scrub its sunlight through the day";

  if (!results.length) {
    showStatus("No trails found — try a longer drive time or fewer filters.");
    return;
  }
  showStatus(`${results.length} trail${results.length > 1 ? "s" : ""} found, sunniest first.`);

  for (const r of results) {
    const card = buildCard(r);
    resultsBox.appendChild(card);

    const marker = L.circleMarker([r.start[1], r.start[0]], {
      radius: 7,
      color: "#fff",
      weight: 2,
      fillColor: sunTint(r.sun.effective),
      fillOpacity: 1,
    }).addTo(markersLayer);
    marker.bindTooltip(r.name || UNNAMED);
    marker.on("click", () => {
      selectTrail(r, card);
      card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }
}

function buildCard(r) {
  const card = document.createElement("div");
  card.className = "card";

  const sunPct = Math.round(r.sun.effective * 100);
  const meta = [];
  meta.push(`<span class="badge ${r.source === "doc" ? "doc" : "osm"}">${r.source === "doc" ? "DOC" : "OSM"}</span>`);
  if (r.difficulty) {
    meta.push(`<span class="chip ${escapeHtml(r.difficulty)}">${escapeHtml(r.difficulty)}</span>`);
  }
  meta.push(`<span>🥾 ${fmtMinutes(r.est_minutes)}</span>`);
  meta.push(`<span>🚗 ~${Math.round(r.drive_min_est)} min (${r.drive_km.toFixed(0)} km)</span>`);
  if (r.canopy_frac != null) {
    meta.push(`<span>🌲 ${Math.round(r.canopy_frac * 100)}% canopy</span>`);
  }

  const slots = r.timeline.map((s) =>
    `<i style="background:${sunTint(s.frac)}" title="${s.t.slice(11, 16)} — ${Math.round(s.frac * 100)}% in sun"></i>`
  ).join("");
  const tlStart = r.timeline.length ? r.timeline[0].t.slice(11, 16) : "";
  const tlEnd = r.timeline.length ? r.timeline[r.timeline.length - 1].t.slice(11, 16) : "";

  card.innerHTML = `
    <div class="card-top">
      <h3>${escapeHtml(r.name || UNNAMED)}</h3>
      <div class="sunpct">
        <b>${sunPct}%</b>
        <small>${r.sun.no_forecast ? "sun · no forecast" : "sun (incl. cloud)"}</small>
      </div>
    </div>
    <div class="meta">${meta.join("")}</div>
    <div class="timeline">${slots}</div>
    <div class="tl-caption"><span>${tlStart}</span><span>sun along your hike</span><span>${tlEnd}</span></div>
  `;
  card.addEventListener("click", () => selectTrail(r, card));
  return card;
}

/* ---- trail detail + scrubber -------------------------------------------- */

function selectTrail(result, card) {
  selected = result;
  for (const c of resultsBox.querySelectorAll(".card")) c.classList.remove("selected");
  card.classList.add("selected");

  // start the scrubber at the searched start time, clamped to 08:00-17:00
  const start = hhmmToMinutes(timeInput.value || "10:00");
  scrub.value = Math.max(480, Math.min(1020, Math.round(start / 15) * 15));
  scrub.disabled = false;
  scrubLabel.textContent = minutesToHHMM(+scrub.value);
  loadTrailDetail(true);
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
  scrubInfo.textContent =
    `${detail.name || UNNAMED} — ${pct}% of the trail in sun at ${minutesToHHMM(+scrub.value)}`;
}

scrub.addEventListener("input", () => {
  scrubLabel.textContent = minutesToHHMM(+scrub.value);
  clearTimeout(scrubTimer);
  scrubTimer = setTimeout(() => loadTrailDetail(false), 120);
});

/* ---- boot ---------------------------------------------------------------- */

form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  runSearch();
});

(async function init() {
  // Default to today's date in NZ (the server resolved date=None the same
  // way), so viewers in other timezones still search the right NZ day.
  dateInput.value = Engine.nzDateStr();
  el("search-btn").disabled = true;
  showStatus("loading trail data…");
  try {
    const data = await Engine.loadData(".");
    console.log(`HikeSun static: ${data.trails.length} trails loaded ` +
      `(generated ${data.generated}, ${data.horizons.length} horizon bytes)`);
    // Sanity numbers for manual verification (see engine.js self-test block):
    // sunPosition(-43.5321, 172.6362, nzEpoch("2026-07-02","10:00")) should
    // give elevation ~14.7362, azimuth ~36.1774.
    const probe = Engine.sunPosition(-43.5321, 172.6362,
      Engine.nzEpoch("2026-07-02", "10:00"));
    console.log("HikeSun static: sun @ Chch 2026-07-02 10:00 NZ =",
      probe.elevation.toFixed(4), "deg elev,", probe.azimuth.toFixed(4),
      "deg az (expect ~14.7362 / ~36.1774)");
  } catch (err) {
    showStatus(`Could not load trail data: ${err.message}`, true);
    return;
  } finally {
    el("search-btn").disabled = false;
  }
  runSearch();
})();
