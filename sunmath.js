/* HikeSun solar math — shared by engine.js (main thread) and shadow-worker.js
 * (Web Worker, via importScripts). A faithful port of hikesun/sun.py (NOAA
 * algorithm), plus Pacific/Auckland wall-clock helpers.
 *
 * Plain script, no module system: attaches a single global, `SunMath`, to
 * `self` (works as `window.SunMath` on the main thread and is reachable from
 * a worker after `importScripts("sunmath.js")`).
 *
 * Conventions (same as the Python code): azimuths are degrees clockwise from
 * TRUE NORTH [0, 360); elevation is degrees above the horizon, refraction-
 * corrected. Datetimes in/out are UTC epoch milliseconds unless noted.
 */

"use strict";

(function (root) {
  const TZ = "Pacific/Auckland";
  const DEG = Math.PI / 180.0;

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

  root.SunMath = { sunPosition, nzEpoch, isoNZ, nzDateStr };
})(typeof self !== "undefined" ? self : this);

/* ---- self-test (paste into the browser console) ---------------------------
 * Expected values computed with the Python reference implementation
 * (hikesun.sun.sun_position) — the port should agree to ~1e-6 deg:
 *
 *   SunMath.nzEpoch("2026-07-02", "10:00")            // 1782943200000 (NZST, UTC+12)
 *   SunMath.nzEpoch("2026-01-15", "10:00")            // 1768424400000 (NZDT, UTC+13)
 *   SunMath.isoNZ(1782943200000)                      // "2026-07-02T10:00:00+12:00"
 *   SunMath.isoNZ(1768424400000)                      // "2026-01-15T10:00:00+13:00"
 *
 *   // Christchurch (lat -43.5321, lon 172.6362), winter morning/afternoon:
 *   SunMath.sunPosition(-43.5321, 172.6362, 1782943200000)
 *     // { elevation: 14.7362, azimuth: 36.1774 }    (2026-07-02 10:00 NZST)
 *   SunMath.sunPosition(-43.5321, 172.6362, 1782961200000)
 *     // { elevation: 15.4740, azimuth: 325.2813 }   (2026-07-02 15:00 NZST)
 *   SunMath.sunPosition(-43.5321, 172.6362, 1768424400000)
 *     // { elevation: 39.8035, azimuth: 81.8071 }    (2026-01-15 10:00 NZDT)
 * --------------------------------------------------------------------------- */
