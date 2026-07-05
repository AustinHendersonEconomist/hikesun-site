/* HikeSun client-side scoring engine — a faithful port of hikesun/sun.py and
 * hikesun/score.py so the app can run 100% statically (GitHub Pages).
 *
 * Data comes from tools/export_static.py, sharded into 1-degree cells so the
 * browser only downloads the regions it needs:
 *   data/index.json — az_bins, quant {scale, offset}, cell_deg and the list
 *                     of non-empty cells {id, bbox, n_trails}
 *   data/cells/{id}/trails.json  — trail metadata + sampled points + `hoff`
 *                     row offsets LOCAL to that cell's horizons.bin
 *   data/cells/{id}/horizons.bin — Uint8 rows of az_bins bytes per trail
 *                     point; angle_deg = byte * quant.scale + quant.offset
 *
 * Call Engine.loadIndex() once, then Engine.ensureCells([lon, lat], radiusKm)
 * before searching around a new origin; loaded cells are merged into one
 * in-memory store (each trail's hoff is rebased to the global row space).
 *
 * Conventions (same as the Python code): coordinates are WGS84 (lon, lat);
 * azimuths degrees clockwise from TRUE NORTH [0, 360); horizon bin k covers
 * azimuths [k*3, (k+1)*3). Plain ES6, no dependencies.
 */

"use strict";

const Engine = (() => {
  const TZ = "Pacific/Auckland";
  const SUN_MIN_ELEV_DEG = 0.25; // sun must clear this to count as up at all
  const CLOUD_PENALTY = 0.75;    // effective = terrain * (1 - 0.75 * cloud)
  const SAMPLE_MIN = 10;         // timeline sampling step (minutes)
  const DRIVE_KM_PER_MIN = 0.85; // crow-flies km per minute of driving
  const R_EARTH_KM = 6371.0;
  const DEG = Math.PI / 180.0;
  const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";

  /* Python-style modulo: result has the sign of the divisor. */
  function mod(a, b) {
    return ((a % b) + b) % b;
  }

  function clip(x, lo, hi) {
    return Math.min(hi, Math.max(lo, x));
  }

  /* ---- solar position (port of hikesun/sun.py, NOAA algorithm) ---------- */

  /* NOAA atmospheric refraction correction (degrees) for a true (geometric)
   * elevation in degrees. Same piecewise formula as _refraction_deg. */
  function refractionDeg(elevDeg) {
    if (elevDeg > 85.0) return 0.0;
    const tanE = Math.tan(elevDeg * DEG);
    if (elevDeg > 5.0) {
      return (58.1 / tanE - 0.07 / tanE ** 3 + 0.000086 / tanE ** 5) / 3600.0;
    }
    if (elevDeg > -0.575) {
      return (1735.0 + elevDeg * (-518.2 + elevDeg *
        (103.4 + elevDeg * (-12.79 + elevDeg * 0.711)))) / 3600.0;
    }
    return (-20.774 / tanE) / 3600.0;
  }

  /* Sun {elevation, azimuth} in degrees at a UTC epoch (ms). Azimuth is
   * clockwise from true north [0, 360); elevation includes refraction. */
  function sunPosition(latDeg, lonDeg, dateUTCms) {
    // Unix epoch is JD 2440587.5.
    const jd = dateUTCms / 86400000.0 + 2440587.5;
    const jc = (jd - 2451545.0) / 36525.0; // Julian centuries since J2000.0

    const meanLong = mod(280.46646 + jc * (36000.76983 + jc * 0.0003032), 360.0);
    const meanAnom = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
    const eccent = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);

    const maR = meanAnom * DEG;
    const eqOfCtr = Math.sin(maR) * (1.914602 - jc * (0.004817 + 0.000014 * jc))
      + Math.sin(2 * maR) * (0.019993 - 0.000101 * jc)
      + Math.sin(3 * maR) * 0.000289;
    const trueLong = meanLong + eqOfCtr;
    const omega = (125.04 - 1934.136 * jc) * DEG; // lunar ascending node
    const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega);

    const meanObliq = 23.0 + (26.0 + (21.448 - jc * (46.815 + jc *
      (0.00059 - jc * 0.001813))) / 60.0) / 60.0;
    const obliqR = (meanObliq + 0.00256 * Math.cos(omega)) * DEG;

    const decl = Math.asin(Math.sin(obliqR) * Math.sin(appLong * DEG)); // rad

    const varY = Math.tan(obliqR / 2.0) ** 2;
    const mlR = meanLong * DEG;
    const eqTimeMin = 4.0 / DEG * (
      varY * Math.sin(2 * mlR)
      - 2.0 * eccent * Math.sin(maR)
      + 4.0 * eccent * varY * Math.sin(maR) * Math.cos(2 * mlR)
      - 0.5 * varY ** 2 * Math.sin(4 * mlR)
      - 1.25 * eccent ** 2 * Math.sin(2 * maR)
    );

    // jd + 0.5 puts the day boundary at 00:00 UTC, so the fractional part
    // is minutes-into-the-UTC-day; tst lands in [0, 1440) after the mod.
    const utcMin = mod(jd + 0.5, 1.0) * 1440.0;
    const tst = mod(utcMin + eqTimeMin + 4.0 * lonDeg, 1440.0);
    const haR = (tst / 4.0 - 180.0) * DEG;

    const latR = latDeg * DEG;
    const cosZen = clip(Math.sin(latR) * Math.sin(decl)
      + Math.cos(latR) * Math.cos(decl) * Math.cos(haR), -1.0, 1.0);
    const zen = Math.acos(cosZen);
    let elev = 90.0 - zen / DEG;
    elev += refractionDeg(elev);

    const sinZen = Math.sin(zen);
    let az;
    if (sinZen < 1e-12) {
      az = 0.0; // azimuth undefined at zenith
    } else {
      const cosAz = clip(
        (Math.sin(latR) * cosZen - Math.sin(decl)) / (Math.cos(latR) * sinZen),
        -1.0, 1.0);
      const azBase = Math.acos(cosAz) / DEG;
      az = haR > 0.0 ? mod(azBase + 180.0, 360.0) : mod(540.0 - azBase, 360.0);
    }
    return { elevation: elev, azimuth: az };
  }

  /* ---- Pacific/Auckland wall-clock time ---------------------------------- */

  const nzFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  /* NZ wall-clock date/time at epochMs, re-encoded as a fake-UTC epoch so
   * (wall - epoch) is the NZ UTC offset in ms. */
  function nzWallMs(epochMs) {
    const p = {};
    for (const part of nzFormatter.formatToParts(epochMs)) {
      p[part.type] = part.value;
    }
    // hour12:false can yield "24" at midnight; normalise to 0.
    return Date.UTC(+p.year, +p.month - 1, +p.day,
      +p.hour % 24, +p.minute, +p.second);
  }

  /* UTC epoch (ms) for wall-clock "YYYY-MM-DD" + "HH:MM" in Pacific/Auckland,
   * regardless of the viewer's timezone. Guess the epoch as if NZ were UTC,
   * format the guess back into NZ wall time via Intl, and correct by the
   * difference; the second iteration settles DST-boundary cases (UTC+12
   * winter / UTC+13 daylight time, resolved from the tz database). */
  function nzEpoch(dateStr, timeStr) {
    const [y, mo, d] = dateStr.split("-").map(Number);
    const [h, mi] = timeStr.split(":").map(Number);
    const targetWall = Date.UTC(y, mo - 1, d, h, mi || 0, 0);
    let epoch = targetWall;
    for (let i = 0; i < 2; i++) {
      epoch += targetWall - nzWallMs(epoch);
    }
    return epoch;
  }

  /* ISO-8601 string with the correct +12:00/+13:00 NZ offset, matching
   * Python's datetime.isoformat() (e.g. "2026-07-02T10:00:00+12:00"). */
  function isoNZ(epochMs) {
    const offsetMin = (nzWallMs(epochMs) - epochMs) / 60000;
    const wall = new Date(epochMs + offsetMin * 60000);
    const pad = (n) => String(n).padStart(2, "0");
    const sign = offsetMin < 0 ? "-" : "+";
    const absOff = Math.abs(offsetMin);
    return `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-` +
      `${pad(wall.getUTCDate())}T${pad(wall.getUTCHours())}:` +
      `${pad(wall.getUTCMinutes())}:${pad(wall.getUTCSeconds())}` +
      `${sign}${pad(Math.floor(absOff / 60))}:${pad(absOff % 60)}`;
  }

  /* NZ wall-clock "YYYY-MM-DD" for an epoch (today's date when omitted). */
  function nzDateStr(epochMs = Date.now()) {
    return isoNZ(epochMs).slice(0, 10);
  }

  /* ---- data loading (sharded cells) -------------------------------------- */

  const CELL_MARGIN_KM = 30; // extra half-width padding around search squares
  const M_PER_DEG_LON_EQ = Math.PI / 180.0 * 6371000.0;

  let dataBase = "."; // base URL holding the data/ tree (set by loadIndex)
  // Merged store over all loaded cells. cellState: id -> Promise that settles
  // when the cell is merged (or confirmed missing); loadedCells counts cells
  // that finished loading, including empty/404 ones.
  let data = null; // { cells, cellDeg, azBins, quant, generated,
                   //   trails, byId, horizons: Uint8Array, rows,
                   //   cellState: Map, loadedCells }

  /* Fetch {base}/data/index.json and reset the in-memory store. Must be
   * called (and awaited) before any other data function. */
  async function loadIndex(baseUrl = ".") {
    const base = baseUrl.replace(/\/+$/, "");
    const resp = await fetch(`${base}/data/index.json`);
    if (!resp.ok) throw new Error(`data/index.json: HTTP ${resp.status}`);
    const meta = await resp.json();
    dataBase = base;
    data = {
      cells: meta.cells,
      cellDeg: meta.cell_deg,
      azBins: meta.az_bins,
      quant: meta.quant,
      generated: meta.generated,
      trails: [],
      byId: new Map(),
      horizons: new Uint8Array(0),
      rows: 0,
      cellState: new Map(),
      loadedCells: 0,
    };
    return data;
  }

  function requireData() {
    if (!data) throw new Error("trail index not loaded — call loadIndex() first");
    return data;
  }

  /* (metres per degree longitude, latitude) at lat — mirrors geo.m_per_deg. */
  function mPerDeg(latDeg) {
    const latR = latDeg * DEG;
    return {
      lon: M_PER_DEG_LON_EQ * Math.cos(latR),
      lat: 111132.954 - 559.822 * Math.cos(2 * latR)
        + 1.175 * Math.cos(4 * latR),
    };
  }

  /* Synchronously splice one fetched cell into the merged store; the trail
   * hoff values in the file are LOCAL and get rebased to the global rows. */
  function mergeCell(id, meta, bytes) {
    const d = requireData();
    if (bytes.length % d.azBins !== 0) {
      throw new Error(`cell ${id}: horizons.bin size ${bytes.length}` +
        ` is not a multiple of az_bins=${d.azBins}`);
    }
    const rowsBefore = d.rows;
    for (const trail of meta.trails) {
      trail.hoff += rowsBefore;
      d.trails.push(trail);
      d.byId.set(trail.id, trail);
    }
    const merged = new Uint8Array(d.horizons.length + bytes.length);
    merged.set(d.horizons, 0);
    merged.set(bytes, d.horizons.length);
    d.horizons = merged;
    d.rows = rowsBefore + bytes.length / d.azBins;
  }

  async function fetchCell(id) {
    const dir = `${dataBase}/data/cells/${id}`;
    const [metaResp, binResp] = await Promise.all([
      fetch(`${dir}/trails.json`),
      fetch(`${dir}/horizons.bin`),
    ]);
    if (metaResp.status === 404 || binResp.status === 404) {
      // deployed index lists a cell whose files are gone: treat as empty
      console.warn(`HikeSun: cell ${id} files missing (404), treating as empty`);
      data.loadedCells++;
      return;
    }
    if (!metaResp.ok) throw new Error(`${dir}/trails.json: HTTP ${metaResp.status}`);
    if (!binResp.ok) throw new Error(`${dir}/horizons.bin: HTTP ${binResp.status}`);
    const [meta, buf] = await Promise.all([metaResp.json(), binResp.arrayBuffer()]);
    mergeCell(id, meta, new Uint8Array(buf));
    data.loadedCells++;
  }

  /* Load cell id exactly once; concurrent callers share the same promise.
   * A failed (non-404) fetch is forgotten so a later call can retry. */
  function loadCell(id) {
    const d = requireData();
    let pending = d.cellState.get(id);
    if (!pending) {
      pending = fetchCell(id);
      d.cellState.set(id, pending);
      pending.catch(() => d.cellState.delete(id));
    }
    return pending;
  }

  /* Ensure every cell within reach of a search around origin [lon, lat]
   * (WGS84) with radiusKm is loaded: cells whose bbox intersects the square
   * of half-width (radiusKm + 30) km around the origin are fetched in
   * parallel; already-loaded cells are never refetched. Resolves with the
   * total number of loaded cells (across all calls so far). */
  async function ensureCells([lon, lat], radiusKm) {
    const d = requireData();
    const m = mPerDeg(lat);
    const halfM = (radiusKm + CELL_MARGIN_KM) * 1000.0;
    const dLon = halfM / m.lon;
    const dLat = halfM / m.lat;
    const wanted = d.cells.filter((c) =>
      c.bbox[0] <= lon + dLon && c.bbox[2] >= lon - dLon &&
      c.bbox[1] <= lat + dLat && c.bbox[3] >= lat - dLat);
    await Promise.all(wanted.map((c) => loadCell(c.id)));
    return d.loadedCells;
  }

  /* ---- scoring (port of hikesun/score.py) -------------------------------- */

  /* True iff global trail point pointIndexGlobal is in sun for a sun at
   * (elevDeg, azDeg): the sun is up AND clears the precomputed terrain
   * horizon for its 3-degree azimuth bin. */
  function inSun(pointIndexGlobal, elevDeg, azDeg) {
    const d = requireData();
    if (elevDeg <= SUN_MIN_ELEV_DEG) return false;
    const bin = Math.floor(azDeg / (360.0 / d.azBins)) % d.azBins;
    const byte = d.horizons[pointIndexGlobal * d.azBins + bin];
    return elevDeg > byte * d.quant.scale + d.quant.offset;
  }

  /* Sunlit fraction of a trail's points at one instant. The sun position is
   * evaluated once at the trail's FIRST point; the Python code uses the
   * point centroid, but across a <=25 km trail the two differ by well under
   * one 3-degree azimuth bin, so scores match. */
  function sunFracAt(trail, epochMs) {
    const sun = sunPosition(trail.points[0][1], trail.points[0][0], epochMs);
    let sunny = 0;
    for (let i = 0; i < trail.points.length; i++) {
      if (inSun(trail.hoff + i, sun.elevation, sun.azimuth)) sunny++;
    }
    return sunny / trail.points.length;
  }

  /* Score how sunny a trail is over a hike starting at startMs (UTC epoch
   * ms). Same result shape as Python score_trail: {trail_id, terrain_frac,
   * timeline: [{t, frac}], effective, cloud_cover, no_forecast} with 10-min
   * sampling inclusive of both endpoints. */
  function scoreTrail(trail, startMs, durationMin = null, cloud = null) {
    requireData();
    let duration;
    if (durationMin != null) {
      duration = durationMin;
    } else {
      const est = trail.est_minutes != null ? trail.est_minutes : 60.0;
      duration = Math.min(600.0, Math.max(30.0, est));
    }
    const n = Math.floor(duration / SAMPLE_MIN) + 1;
    const timeline = [];
    let total = 0;
    for (let k = 0; k < n; k++) {
      const t = startMs + k * SAMPLE_MIN * 60000;
      const frac = sunFracAt(trail, t);
      total += frac;
      timeline.push({ t: isoNZ(t), frac });
    }
    const terrainFrac = total / n;
    const effective = cloud == null
      ? terrainFrac : terrainFrac * (1.0 - CLOUD_PENALTY * cloud);
    return {
      trail_id: trail.id,
      terrain_frac: terrainFrac,
      timeline,
      effective,
      cloud_cover: cloud,
      no_forecast: cloud == null,
    };
  }

  /* Great-circle distance in km between two (lon, lat) WGS84 points. */
  function haversineKm(lon1, lat1, lon2, lat2) {
    const dLon = (lon2 - lon1) * DEG;
    const dLat = (lat2 - lat1) * DEG;
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
    return 2 * R_EARTH_KM * Math.asin(Math.sqrt(a));
  }

  /* Sunny-trail search; same filters, result shape and ordering as Python
   * score.search. cloud is an optional 0..1 fraction (fetched once for the
   * origin by the caller via getCloudCover). */
  function search({ lat, lon, driveMin = 30, startMs, minMinutes = null,
                    maxMinutes = null, difficulties = null, limit = 20,
                    cloud = null }) {
    const d = requireData();
    const radiusKm = driveMin * DRIVE_KM_PER_MIN;
    const results = [];
    for (const trail of d.trails) {
      if (!trail.start) continue;
      const distKm = haversineKm(lon, lat, trail.start[0], trail.start[1]);
      if (distKm > radiusKm) continue;
      const est = trail.est_minutes;
      if (minMinutes != null && (est == null || est < minMinutes)) continue;
      if (maxMinutes != null && (est == null || est > maxMinutes)) continue;
      if (difficulties != null && !difficulties.includes(trail.difficulty)) continue;
      const score = scoreTrail(trail, startMs, null, cloud);
      results.push({
        id: trail.id,
        name: trail.name,
        source: trail.source,
        category: trail.category,
        difficulty: trail.difficulty,
        length_m: trail.length_m,
        est_minutes: est,
        canopy_frac: trail.canopy_frac,
        canopy_type: trail.canopy_type,
        region: trail.region,
        url: trail.url,
        photo_url: trail.photo_url,
        drive_km: distKm,
        drive_min_est: distKm / DRIVE_KM_PER_MIN,
        start: trail.start,
        sun: {
          terrain_frac: score.terrain_frac,
          cloud_cover: score.cloud_cover,
          effective: score.effective,
          no_forecast: score.no_forecast,
        },
        timeline: score.timeline,
      });
    }
    results.sort((a, b) => b.sun.effective - a.sun.effective);
    return results.slice(0, limit);
  }

  /* Full detail for one trail: metadata, geometry, per-point sun state at
   * atMs and a 10-min sun timeline for 08:00-17:00 NZ local on atMs's date
   * (55 entries). Same shape as Python trail_detail. */
  function trailDetail(id, atMs) {
    const d = requireData();
    const trail = d.byId.get(id);
    if (!trail) throw new Error(`no trail with id ${id}`);

    const sunNow = sunPosition(trail.points[0][1], trail.points[0][0], atMs);
    const points = trail.points.map(([lon, lat, elev], i) => ({
      lon, lat, elev_m: elev,
      sun: inSun(trail.hoff + i, sunNow.elevation, sunNow.azimuth),
    }));

    const dayStart = nzEpoch(nzDateStr(atMs), "08:00");
    const n = (17 - 8) * 60 / SAMPLE_MIN + 1;
    const timeline = [];
    for (let k = 0; k < n; k++) {
      const t = dayStart + k * SAMPLE_MIN * 60000;
      timeline.push({ t: isoNZ(t), frac: sunFracAt(trail, t) });
    }

    return {
      id: trail.id,
      name: trail.name,
      source: trail.source,
      category: trail.category,
      difficulty: trail.difficulty,
      status: trail.status,
      length_m: trail.length_m,
      est_minutes: trail.est_minutes,
      canopy_frac: trail.canopy_frac,
      canopy_type: trail.canopy_type,
      region: trail.region,
      description: trail.description,
      url: trail.url,
      photo_url: trail.photo_url,
      geometry: trail.geometry,
      points,
      timeline,
    };
  }

  /* ---- weather (port of score.get_cloud_cover) ---------------------------- */

  /* Open-Meteo hourly cloud cover fraction (0..1) for the NZ-local dateStr
   * ("YYYY-MM-DD") at the given NZ-local hour, or null on ANY failure so
   * weather can never break scoring. */
  async function getCloudCover(lat, lon, dateStr, hour) {
    try {
      const url = `${OPEN_METEO_URL}?latitude=${lat.toFixed(4)}` +
        `&longitude=${lon.toFixed(4)}&hourly=cloud_cover` +
        `&timezone=Pacific%2FAuckland&start_date=${dateStr}&end_date=${dateStr}`;
      // hard 8 s cap: weather being down must never stall the UI
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 8000);
      const resp = await fetch(url, { signal: abort.signal }).finally(
        () => clearTimeout(timer));
      if (!resp.ok) return null;
      const body = await resp.json();
      const idx = body.hourly.time.indexOf(
        `${dateStr}T${String(hour).padStart(2, "0")}:00`);
      if (idx < 0) return null;
      const value = body.hourly.cloud_cover[idx];
      if (value == null) return null;
      return Math.min(1.0, Math.max(0.0, value / 100.0));
    } catch (err) {
      return null;
    }
  }

  return {
    sunPosition, nzEpoch, isoNZ, nzDateStr, loadIndex, ensureCells, inSun,
    scoreTrail, search, trailDetail, getCloudCover,
  };
})();

/* ---- self-test (paste into the browser console) ---------------------------
 * Expected values computed with the Python reference implementation
 * (hikesun.sun.sun_position) — the port should agree to ~1e-6 deg:
 *
 *   Engine.nzEpoch("2026-07-02", "10:00")            // 1782943200000 (NZST, UTC+12)
 *   Engine.nzEpoch("2026-01-15", "10:00")            // 1768424400000 (NZDT, UTC+13)
 *   Engine.isoNZ(1782943200000)                      // "2026-07-02T10:00:00+12:00"
 *   Engine.isoNZ(1768424400000)                      // "2026-01-15T10:00:00+13:00"
 *
 *   // Christchurch (lat -43.5321, lon 172.6362), winter morning/afternoon:
 *   Engine.sunPosition(-43.5321, 172.6362, 1782943200000)
 *     // { elevation: 14.7362, azimuth: 36.1774 }    (2026-07-02 10:00 NZST)
 *   Engine.sunPosition(-43.5321, 172.6362, 1782961200000)
 *     // { elevation: 15.4740, azimuth: 325.2813 }   (2026-07-02 15:00 NZST)
 *   Engine.sunPosition(-43.5321, 172.6362, 1768424400000)
 *     // { elevation: 39.8035, azimuth: 81.8071 }    (2026-01-15 10:00 NZDT)
 *
 *   // Load the shard index, then the cells around Christchurch (30 min
 *   // drive => 25.5 km search radius; cells within radius + 30 km load):
 *   await Engine.loadIndex(".")                       // { cells: [...], ... }
 *   await Engine.ensureCells([172.6362, -43.5321], 30 * 0.85)
 *     // -> total loaded cell count (e.g. 2: "172_-44" + "172_-43");
 *     //    calling it again with the same origin resolves without refetching
 *   Engine.search({ lat: -43.5321, lon: 172.6362, driveMin: 30,
 *                   startMs: Engine.nzEpoch("2026-07-02", "10:00") })
 *     // results sorted by sun.effective desc; timeline t values end +12:00
 * --------------------------------------------------------------------------- */
