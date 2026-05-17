// B-35 Slice B — Open-Meteo weather service.
//
// Not physics, not UI — a standalone fetch + client-side aggregation service.
// Open-Meteo is keyless and CORS-enabled, so this runs directly in the browser
// (and in Node 18+ for the test harness).
//
// Endpoint selection by how far out the race is:
//   • Within the forecast horizon (~16 days ahead) → Forecast API for the
//     specific date (+ start hour if given). source: 'forecast'.
//   • Beyond the horizon, INCLUDING past dates → Historical Weather API
//     (/v1/archive). Fetch a ±2-week window around the race month/day across
//     the last ~10 years and aggregate client-side. source: 'normal'.
//     (PLAN never fetches the realized weather of a specific past day — that
//      is ANALYZE's job in Slice D. Past PLAN dates get climatological normals.)
//
// NOT /v1/climate — that endpoint is climate-change *projection* model output
// (1950–2050), NOT observed-history normals. We aggregate /v1/archive ourselves.
//
// Output shape maps onto the Slice-A structured weatherContext fields:
//   { tempC:       { value, source, range:{low,high}|null },
//     windSpeedMs: { value, source, range:{low,high}|null },
//     windDirDeg:  { value, source, confidence:0..1|null },
//     precipPct:   { value, source, range:null, amountMm },
//     meta:        { mode, sampleYears?, windowDays, fetchedAt, lat, lon, dateISO } }
// `confidence` is null for forecast (single day → no directional distribution).

export const OPEN_METEO_ATTRIBUTION = {
  text: 'Weather data by Open-Meteo.com',
  license: 'CC BY 4.0',
  url: 'https://open-meteo.com/',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
};

const FORECAST_BASE = 'https://api.open-meteo.com/v1/forecast';
const ARCHIVE_BASE  = 'https://archive-api.open-meteo.com/v1/archive';
const FORECAST_HORIZON_DAYS = 16;   // Open-Meteo forecast reach
const HISTORY_YEARS          = 10;  // target sample depth for normals
const HISTORY_YEARS_MIN      = 5;   // below this, treat as failure
const WINDOW_DAYS            = 14;  // ± around race month/day
const START_HOUR_BAND        = 2;   // ± hours kept around race start hour
const WET_DAY_MM             = 1.0; // daily precip ≥ this = "measurable"
const HOURLY_VARS = 'temperature_2m,precipitation,wind_speed_10m,wind_direction_10m';

// ── Pure helpers ─────────────────────────────────────────────────────────

// Circular statistics for wind bearings (degrees, meteorological "from").
// Plain numeric averaging is wrong for circular data (mean of 350° and 10°
// is ~0°, not 180°). Convert each bearing to a unit vector, sum, take the
// resultant angle (= prevailing direction); the normalized resultant LENGTH
// (0–1) is the directional consistency / confidence.
export function circularWindStats(bearingsDeg) {
  const valid = (bearingsDeg || []).filter(b => Number.isFinite(b));
  if (valid.length === 0) return { prevailingDeg: null, confidence: null };
  let sx = 0, sy = 0;
  for (const b of valid) {
    const r = (b * Math.PI) / 180;
    sx += Math.cos(r);
    sy += Math.sin(r);
  }
  const n = valid.length;
  const mx = sx / n, my = sy / n;
  let ang = (Math.atan2(my, mx) * 180) / Math.PI;
  if (ang < 0) ang += 360;
  const confidence = Math.sqrt(mx * mx + my * my); // 0 = fully variable, 1 = fixed
  return {
    prevailingDeg: Math.round(ang) % 360,
    confidence: Math.round(confidence * 1000) / 1000,
  };
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

// 'forecast' if the race date is within the forecast horizon (today inclusive,
// up to +16d). Everything else — far-future OR any past date — is 'normal'.
export function weatherMode(dateISO, now = new Date()) {
  if (!dateISO) return null;
  const race = new Date(dateISO + 'T00:00:00');
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((race - today) / 86400000);
  return (days >= 0 && days <= FORECAST_HORIZON_DAYS) ? 'forecast' : 'normal';
}

// Parse 'HH:MM' → integer hour (0–23) or null.
function startHour(startTime) {
  if (!startTime || !/^\d{1,2}:\d{2}/.test(startTime)) return null;
  const h = parseInt(startTime.slice(0, 2), 10);
  return Number.isFinite(h) ? Math.max(0, Math.min(23, h)) : null;
}

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function getJSON(url) {
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`Weather fetch failed (network): ${e.message}`);
  }
  if (!res.ok) throw new Error(`Weather fetch failed (HTTP ${res.status})`);
  const json = await res.json();
  if (json?.error) throw new Error(`Open-Meteo error: ${json.reason || 'unknown'}`);
  return json;
}

// ── Forecast mode ────────────────────────────────────────────────────────

async function fetchForecast({ lat, lon, dateISO, startTime }) {
  const url = `${FORECAST_BASE}?latitude=${lat}&longitude=${lon}`
    + `&hourly=${HOURLY_VARS},precipitation_probability`
    + `&wind_speed_unit=ms&timezone=auto`
    + `&start_date=${dateISO}&end_date=${dateISO}`;
  const j = await getJSON(url);
  const H = j.hourly;
  if (!H || !Array.isArray(H.time) || H.time.length === 0) {
    throw new Error('Forecast returned no hourly data for that date');
  }
  const temps = H.temperature_2m, winds = H.wind_speed_10m,
        dirs = H.wind_direction_10m, precs = H.precipitation,
        pprob = H.precipitation_probability || [];

  const hr = startHour(startTime);
  // If a start hour is given, focus on a ±2h band around it; else the whole day.
  const idxs = H.time
    .map((t, i) => ({ i, h: new Date(t).getHours() }))
    .filter(({ h }) => hr == null ? true : Math.abs(h - hr) <= START_HOUR_BAND)
    .map(({ i }) => i);
  const pick = idxs.length ? idxs : H.time.map((_, i) => i);

  const tArr = pick.map(i => temps[i]).filter(Number.isFinite);
  const wArr = pick.map(i => winds[i]).filter(Number.isFinite);
  const dArr = pick.map(i => dirs[i]).filter(Number.isFinite);
  const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;

  // Day-level range from the full day's min/max (range is reference context).
  const dayT = temps.filter(Number.isFinite);
  const dayW = winds.filter(Number.isFinite);
  const { prevailingDeg } = circularWindStats(dArr);

  const dayPrecip = precs.filter(Number.isFinite).reduce((s, x) => s + x, 0);
  const maxProb = pprob.filter(Number.isFinite).length
    ? Math.max(...pprob.filter(Number.isFinite)) : null;

  return {
    tempC:       { value: round1(mean(tArr)), source: 'forecast',
                   range: dayT.length ? { low: round1(Math.min(...dayT)), high: round1(Math.max(...dayT)) } : null },
    windSpeedMs: { value: round1(mean(wArr)), source: 'forecast',
                   range: dayW.length ? { low: round1(Math.min(...dayW)), high: round1(Math.max(...dayW)) } : null },
    windDirDeg:  { value: prevailingDeg ?? 270, source: 'forecast', confidence: null },
    precipPct:   { value: maxProb != null ? Math.round(maxProb) : null,
                   source: 'forecast', range: null, amountMm: round1(dayPrecip) },
    meta: { mode: 'forecast', windowDays: 0, fetchedAt: new Date().toISOString(),
            lat, lon, dateISO },
  };
}

// ── Historical normal mode ───────────────────────────────────────────────

async function fetchNormal({ lat, lon, dateISO, startTime }) {
  const race = new Date(dateISO + 'T00:00:00');
  const nowYear = new Date().getFullYear();
  // Last N complete years (exclude the race's own year and the current year
  // to avoid archive's ~5-day lag biting near "today").
  const years = [];
  for (let y = nowYear - 1; y >= nowYear - HISTORY_YEARS && years.length < HISTORY_YEARS; y--) {
    years.push(y);
  }

  const reqs = years.map(async (y) => {
    const center = new Date(y, race.getMonth(), race.getDate());
    const start = new Date(center); start.setDate(start.getDate() - WINDOW_DAYS);
    const end   = new Date(center); end.setDate(end.getDate() + WINDOW_DAYS);
    const url = `${ARCHIVE_BASE}?latitude=${lat}&longitude=${lon}`
      + `&hourly=${HOURLY_VARS}&wind_speed_unit=ms&timezone=auto`
      + `&start_date=${fmtDate(start)}&end_date=${fmtDate(end)}`;
    try {
      const j = await getJSON(url);
      return j?.hourly?.time?.length ? j.hourly : null;
    } catch {
      return null; // tolerate per-year failure; require a minimum below
    }
  });

  const hourlies = (await Promise.all(reqs)).filter(Boolean);
  if (hourlies.length < HISTORY_YEARS_MIN) {
    throw new Error(`Only ${hourlies.length}/${HISTORY_YEARS} history years available `
      + `(need ≥${HISTORY_YEARS_MIN}) — manual entry available`);
  }

  const hr = startHour(startTime);
  const temps = [], winds = [], dirs = [];
  const dayPrecip = new Map(); // 'YYYY-MM-DD' → summed mm

  for (const H of hourlies) {
    for (let i = 0; i < H.time.length; i++) {
      const t = H.time[i];
      const h = new Date(t).getHours();
      const inBand = hr == null ? true : Math.abs(h - hr) <= START_HOUR_BAND;
      if (inBand) {
        if (Number.isFinite(H.temperature_2m[i]))   temps.push(H.temperature_2m[i]);
        if (Number.isFinite(H.wind_speed_10m[i]))   winds.push(H.wind_speed_10m[i]);
        if (Number.isFinite(H.wind_direction_10m[i])) dirs.push(H.wind_direction_10m[i]);
      }
      // Precip probability is a per-DAY notion → accumulate full-day totals
      // regardless of the start-hour band.
      const day = t.slice(0, 10);
      const p = Number.isFinite(H.precipitation[i]) ? H.precipitation[i] : 0;
      dayPrecip.set(day, (dayPrecip.get(day) || 0) + p);
    }
  }

  const tSorted = [...temps].sort((a, b) => a - b);
  const wSorted = [...winds].sort((a, b) => a - b);
  const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  const { prevailingDeg, confidence } = circularWindStats(dirs);

  const dayTotals = [...dayPrecip.values()];
  const wetDays = dayTotals.filter(v => v >= WET_DAY_MM);
  const probabilityPct = dayTotals.length
    ? Math.round((wetDays.length / dayTotals.length) * 100) : null;
  const wetSorted = wetDays.sort((a, b) => a - b);
  const typicalAmountMm = wetSorted.length ? round1(percentile(wetSorted, 0.5)) : 0;

  return {
    tempC: {
      value: round1(mean(temps)), source: 'normal',
      range: tSorted.length ? { low: round1(percentile(tSorted, 0.1)),
                                high: round1(percentile(tSorted, 0.9)) } : null,
    },
    windSpeedMs: {
      value: round1(mean(winds)), source: 'normal',
      range: wSorted.length ? { low: round1(percentile(wSorted, 0.1)),
                                high: round1(percentile(wSorted, 0.9)) } : null,
    },
    windDirDeg: { value: prevailingDeg ?? 270, source: 'normal', confidence },
    precipPct:  { value: probabilityPct, source: 'normal', range: null,
                  amountMm: typicalAmountMm },
    meta: { mode: 'normal', sampleYears: hourlies.length, windowDays: WINDOW_DAYS,
            fetchedAt: new Date().toISOString(), lat, lon, dateISO },
  };
}

// ── Public entry ─────────────────────────────────────────────────────────

// Fetch race weather. Throws on network/parse failure or insufficient history
// — the caller (Slice C) catches, shows a non-blocking notice + retry, and
// falls back to manual entry. Never resolves to a silent partial.
export async function fetchRaceWeather({ lat, lon, dateISO, startTime } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error('Weather fetch needs a route location (lat/lon)');
  }
  if (!dateISO) throw new Error('Weather fetch needs a race date');
  const mode = weatherMode(dateISO);
  return mode === 'forecast'
    ? fetchForecast({ lat, lon, dateISO, startTime })
    : fetchNormal({ lat, lon, dateISO, startTime });
}

// ── ANALYZE: realized weather for a specific ride day (Slice D) ───────────
//
// Display-only. Unlike PLAN's `normal` mode (10-yr climatological aggregate),
// this fetches the ACTUAL hourly weather of the exact ride date at the ride
// location and tags `source:'actual'`. Confidence here is the intra-day
// directional spread of that real day (meaningful as "how variable was the
// wind that day"), not a multi-year prevailing measure.
export async function fetchActualWeather({ lat, lon, dateISO, startTime } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error('Actual weather needs the ride location (lat/lon)');
  }
  if (!dateISO) throw new Error('Actual weather needs the ride date');
  const url = `${ARCHIVE_BASE}?latitude=${lat}&longitude=${lon}`
    + `&hourly=${HOURLY_VARS}&wind_speed_unit=ms&timezone=auto`
    + `&start_date=${dateISO}&end_date=${dateISO}`;
  const j = await getJSON(url);
  const H = j.hourly;
  if (!H || !Array.isArray(H.time) || H.time.length === 0) {
    throw new Error('No archived weather for that date/location yet');
  }
  const hr = startHour(startTime);
  const pick = H.time
    .map((t, i) => ({ i, h: new Date(t).getHours() }))
    .filter(({ h }) => hr == null ? true : Math.abs(h - hr) <= START_HOUR_BAND)
    .map(({ i }) => i);
  const idxs = pick.length ? pick : H.time.map((_, i) => i);
  const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  const tA = idxs.map(i => H.temperature_2m[i]).filter(Number.isFinite);
  const wA = idxs.map(i => H.wind_speed_10m[i]).filter(Number.isFinite);
  const dA = idxs.map(i => H.wind_direction_10m[i]).filter(Number.isFinite);
  const dayT = H.temperature_2m.filter(Number.isFinite);
  const dayW = H.wind_speed_10m.filter(Number.isFinite);
  const dayPrecip = H.precipitation.filter(Number.isFinite).reduce((s, x) => s + x, 0);
  const { prevailingDeg, confidence } = circularWindStats(dA);

  return {
    tempC:       { value: round1(mean(tA)), source: 'actual',
                   range: dayT.length ? { low: round1(Math.min(...dayT)), high: round1(Math.max(...dayT)) } : null },
    windSpeedMs: { value: round1(mean(wA)), source: 'actual',
                   range: dayW.length ? { low: round1(Math.min(...dayW)), high: round1(Math.max(...dayW)) } : null },
    windDirDeg:  { value: prevailingDeg ?? 270, source: 'actual', confidence },
    precipPct:   { value: dayPrecip >= WET_DAY_MM ? 100 : 0, source: 'actual',
                   range: null, amountMm: round1(dayPrecip) },
    meta: { mode: 'actual', windowDays: 0, fetchedAt: new Date().toISOString(),
            lat, lon, dateISO },
  };
}

// ─── Sanity checks ───────────────────────────────────────────────────────
//
// circularWindStats:
//   [350, 10]            → prevailing ≈ 0°, confidence ≈ 0.98 (tight)
//   [0, 90, 180, 270]    → confidence ≈ 0 (fully variable; dir undefined-ish)
//   [270, 280, 260, 275] → prevailing ≈ 271°, confidence ≈ 0.99
//   []                   → { prevailingDeg: null, confidence: null }
//
// weatherMode (now = 2026-05-15):
//   '2026-05-20' → 'forecast' (5 days out)
//   '2026-06-30' → 'normal'   (>16 days out)
//   '2025-09-01' → 'normal'   (past — PLAN uses normals, not realized)
//   '2026-05-15' → 'forecast' (today)
