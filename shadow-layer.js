/* HikeSun ShadowLayer — Leaflet GridLayer showing terrain shadow/sunlight,
 * matching the same physics as the trail scoring engine (horizon profiles
 * for trails; a live ray-march here for the whole visible terrain).
 *
 * Requires SunMath (sunmath.js) to be loaded first — sun position is
 * computed on the MAIN THREAD at each tile's centre and included in the
 * job sent to the worker, so shadow-worker.js stays pure geometry (no
 * importScripts, no SunMath dependency there).
 *
 * Usage:
 *   const layer = new ShadowLayer({
 *     workerUrl: "shadow-worker.js",  // relative to THIS page (web/ uses
 *                                     // "/web/shadow-worker.js")
 *     mode: "auto",                  // "auto" | "cast" | "hillshade"
 *     opacity: 0.45,
 *   });
 *   layer.addTo(map);           // caller adds/removes, per the plan
 *   layer.setTime(epochMs);     // bumps version, re-renders visible tiles
 *   layer.setEnabled(false);    // hide without removing (keeps caches warm)
 *   layer.on("shadow:busy", () => spinner.show());
 *   layer.on("shadow:idle", () => spinner.hide());
 *
 * "auto" mode: cast-shadow ray-march at zoom >= 11, hillshade-only below
 * (cast shadows are physically meaningless at ~500 m/px terrain, per the
 * plan). Whole layer renders a uniform dusk tint (no ray-march at all)
 * when the sun's elevation at the current view centre is below -1 degree.
 */

"use strict";

(function (root) {
  const TILE_PX = 256;
  const DEM_CACHE_MAX = 150;   // decoded-DEM LRU entries (Float32Array tiles)
  const SHADOW_CACHE_MAX = 300; // rendered-shadow LRU entries (ImageData)
  const TIME_BUCKET_MS = 15 * 60 * 1000; // 15-min scrubber steps
  const DUSK_ELEV_DEG = -1.0; // below this: uniform dusk tint, no ray-march
  const CAST_MIN_ZOOM = 11;   // "auto" mode: cast >= 11, hillshade below
  const DEM_CACHE_NAME = "hikesun-dem";
  const SHADOW_RGB = "30,41,59"; // slate-800, matches shadow-worker.js

  const isMobile = typeof matchMedia === "function"
    && matchMedia("(pointer: coarse)").matches;
  const WORKER_POOL_SIZE = Math.max(
    1, Math.min(isMobile ? 2 : 4, (navigator.hardwareConcurrency || 4) - 1));

  /* ---- small LRU map (insertion-order eviction via Map) ------------------- */
  class LRU {
    constructor(max) {
      this.max = max;
      this.map = new Map();
    }
    get(key) {
      if (!this.map.has(key)) return undefined;
      const v = this.map.get(key);
      this.map.delete(key);
      this.map.set(key, v); // refresh recency
      return v;
    }
    set(key, value) {
      if (this.map.has(key)) this.map.delete(key);
      this.map.set(key, value);
      while (this.map.size > this.max) {
        const oldestKey = this.map.keys().next().value;
        this.map.delete(oldestKey);
      }
    }
    has(key) {
      return this.map.has(key);
    }
  }

  /* Round an epoch to the nearest 15-min bucket (matches the scrubber's own
   * step, so dragging back and forth over the same value hits the cache). */
  function timeBucket(epochMs) {
    return Math.round(epochMs / TIME_BUCKET_MS) * TIME_BUCKET_MS;
  }

  function dateStrOf(epochMs) {
    return SunMath.nzDateStr(epochMs);
  }

  const ShadowLayer = L.GridLayer.extend({
    options: {
      mode: "auto",       // "auto" | "cast" | "hillshade"
      opacity: 0.45,
      workerUrl: "shadow-worker.js",
      pane: "shadowPane",
      tileSize: TILE_PX,
      updateWhenIdle: false,
      updateWhenZooming: false,
      keepBuffer: 2,
      className: "hikesun-shadow-tile",
    },

    initialize(options) {
      L.GridLayer.prototype.initialize.call(this, options);
      this._epochMs = Date.now();
      this._enabled = true;
      this._version = 0; // bumped by setTime/setDate; stale renders discard
      this._busyCount = 0;
      this._nextJobId = 1;
      this._pendingJobs = new Map(); // jobId -> {tileKey, coords, version}
      this._demCache = new LRU(DEM_CACHE_MAX);       // "z/x/y" -> Float32Array|null
      this._shadowCache = new LRU(SHADOW_CACHE_MAX); // render key -> ImageData
      this._tiles2 = new Map(); // "z/x/y" -> {canvas, ctx, coords}
      this._initWorkerPool();
    },

    onAdd(map) {
      this._ensurePane(map);
      L.GridLayer.prototype.onAdd.call(this, map);
    },

    onRemove(map) {
      L.GridLayer.prototype.onRemove.call(this, map);
    },

    /* Create (once) the dedicated shadow pane at zIndex 350 — above basemap
     * tiles (200), below trails/markers (400), per the plan. Safe to call
     * repeatedly (Leaflet no-ops if the pane already exists). */
    _ensurePane(map) {
      if (!map.getPane("shadowPane")) {
        const pane = map.createPane("shadowPane");
        pane.style.zIndex = 350;
        pane.style.pointerEvents = "none";
      }
    },

    _initWorkerPool() {
      this._workers = [];
      this._nextWorker = 0;
      for (let i = 0; i < WORKER_POOL_SIZE; i++) {
        let worker;
        try {
          worker = new Worker(this.options.workerUrl);
        } catch (err) {
          console.error("Sunward: failed to start shadow worker", err);
          break;
        }
        worker.onmessage = (ev) => this._onWorkerMessage(ev);
        worker.onerror = (ev) => {
          console.error("Sunward: shadow worker error", ev.message || ev);
        };
        this._workers.push(worker);
      }
    },

    _pickWorker() {
      if (this._workers.length === 0) return null;
      const w = this._workers[this._nextWorker % this._workers.length];
      this._nextWorker++;
      return w;
    },

    /* ---- public API -------------------------------------------------------- */

    /* Set the instant to render (UTC epoch ms). Bumps the version counter
     * and re-renders visible tiles from cache (no network refetch — the
     * DEM cache is time-independent; only the render cache key changes). */
    setTime(epochMs) {
      this._epochMs = epochMs;
      this._version++;
      this._rerenderVisible();
    },

    /* Convenience wrapper matching the plan's "setDate" mention: sets the
     * instant from a wall-clock date + time string pair (NZ local), via
     * SunMath.nzEpoch. */
    setDate(dateStr, timeStr) {
      this.setTime(SunMath.nzEpoch(dateStr, timeStr));
    },

    setEnabled(enabled) {
      this._enabled = !!enabled;
      const container = this.getContainer && this.getContainer();
      if (container) container.style.display = this._enabled ? "" : "none";
    },

    isEnabled() {
      return this._enabled;
    },

    /* ---- GridLayer overrides ------------------------------------------------ */

    createTile(coords, done) {
      const canvas = L.DomUtil.create("canvas", "leaflet-tile");
      canvas.width = TILE_PX;
      canvas.height = TILE_PX;
      const ctx = canvas.getContext("2d");
      const key = `${coords.z}/${coords.x}/${coords.y}`;
      this._tiles2.set(key, { canvas, ctx, coords });

      this._renderTile(coords, canvas, ctx, this._version);
      // done(error, tile): call asynchronously-safe immediately; the tile
      // paints progressively (hillshade, then cast) via _paintPhase, which
      // is fine to happen after Leaflet considers the tile "loaded".
      setTimeout(() => done(null, canvas), 0);
      return canvas;
    },

    _removeTile(key) {
      this._tiles2.delete(key);
      L.GridLayer.prototype._removeTile.call(this, key);
    },

    /* ---- rendering ----------------------------------------------------------- */

    _tileCentreLatLng(coords) {
      const map = this._map;
      const nw = map.unproject(
        [coords.x * TILE_PX, coords.y * TILE_PX], coords.z);
      const se = map.unproject(
        [(coords.x + 1) * TILE_PX, (coords.y + 1) * TILE_PX], coords.z);
      return L.latLng((nw.lat + se.lat) / 2, (nw.lng + se.lng) / 2);
    },

    _effectiveMode(zoom) {
      if (this.options.mode === "cast") return "cast";
      if (this.options.mode === "hillshade") return "hillshade";
      return zoom >= CAST_MIN_ZOOM ? "cast" : "hillshade";
    },

    _renderTile(coords, canvas, ctx, version) {
      const centre = this._tileCentreLatLng(coords);
      const sun = SunMath.sunPosition(centre.lat, centre.lng, this._epochMs);
      const bucket = timeBucket(this._epochMs);
      const dateStr = dateStrOf(this._epochMs);
      const mode = this._effectiveMode(coords.z);
      const cacheKeyBase =
        `${coords.z}/${coords.x}/${coords.y}|${dateStr}|${bucket}|${mode}`;

      if (sun.elevation < DUSK_ELEV_DEG) {
        this._paintDusk(ctx);
        return;
      }

      const hillshadeKey = `${cacheKeyBase}|hillshade`;
      const cachedHillshade = this._shadowCache.get(hillshadeKey);
      if (cachedHillshade) {
        this._paintImageData(ctx, cachedHillshade);
      }
      const castKey = `${cacheKeyBase}|cast`;
      if (mode === "cast") {
        const cachedCast = this._shadowCache.get(castKey);
        if (cachedCast) {
          this._paintImageData(ctx, cachedCast);
          return; // already have the final result, no need to re-dispatch
        }
      } else if (cachedHillshade) {
        return; // hillshade mode + cache hit: done
      }

      this._dispatchJob(coords, sun, mode, version, hillshadeKey, castKey);
    },

    _dispatchJob(coords, sun, mode, version, hillshadeKey, castKey) {
      const worker = this._pickWorker();
      if (!worker) return;
      const id = this._nextJobId++;
      this._pendingJobs.set(id, {
        tileKey: `${coords.z}/${coords.x}/${coords.y}`,
        coords, version, hillshadeKey, castKey,
      });
      this._setBusy(true);
      const tileUrl = (typeof HIKESUN_TILE_URL !== "undefined")
        ? HIKESUN_TILE_URL
        : "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
      worker.postMessage({
        id,
        type: "render",
        tile: { z: coords.z, x: coords.x, y: coords.y },
        tileUrl,
        epochMs: this._epochMs,
        sunAzDeg: sun.azimuth,
        sunElevDeg: sun.elevation,
        mode,
        latDeg: this._tileCentreLatLng(coords).lat,
      });
    },

    _onWorkerMessage(ev) {
      const msg = ev.data;
      const job = this._pendingJobs.get(msg.id);
      if (msg.phase === "error") {
        console.error("Sunward: shadow worker job failed:", msg.message);
        if (job) {
          this._pendingJobs.delete(msg.id);
          this._setBusy(false);
        }
        return;
      }
      if (!job) return; // tile scrolled away / superseded; drop the result
      const isFinal = job.mode === "hillshade" ? msg.phase === "hillshade"
        : msg.phase === "cast";

      const cacheKey = msg.phase === "hillshade" ? job.hillshadeKey : job.castKey;
      const imgData = new ImageData(
        new Uint8ClampedArray(msg.buffer), TILE_PX, TILE_PX);
      this._shadowCache.set(cacheKey, imgData);

      if (job.version === this._version) {
        const tileEntry = this._tiles2.get(job.tileKey);
        if (tileEntry) this._paintImageData(tileEntry.ctx, imgData);
      }

      if (isFinal) {
        this._pendingJobs.delete(msg.id);
        this._setBusy(false);
      }
    },

    _paintImageData(ctx, imgData) {
      ctx.clearRect(0, 0, TILE_PX, TILE_PX);
      ctx.putImageData(imgData, 0, 0);
    },

    _paintDusk(ctx) {
      ctx.clearRect(0, 0, TILE_PX, TILE_PX);
      ctx.fillStyle = `rgba(${SHADOW_RGB}, 0.55)`;
      ctx.fillRect(0, 0, TILE_PX, TILE_PX);
    },

    _rerenderVisible() {
      for (const [, entry] of this._tiles2) {
        this._renderTile(entry.coords, entry.canvas, entry.ctx, this._version);
      }
    },

    _setBusy(busy) {
      if (busy) {
        this._busyCount++;
        if (this._busyCount === 1) this.fire("shadow:busy");
      } else {
        this._busyCount = Math.max(0, this._busyCount - 1);
        if (this._busyCount === 0) this.fire("shadow:idle");
      }
    },
  });

  root.ShadowLayer = ShadowLayer;
})(typeof window !== "undefined" ? window : this);
