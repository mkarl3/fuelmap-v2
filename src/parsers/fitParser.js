// ─── FIT PARSER ADAPTER ──────────────────────────────────────────────────────
// Wraps fit-file-parser (npm) behind the same interface used by the legacy
// hand-rolled parseFIT in App.jsx, so downstream consumers (terrain bucketing,
// W'bal, ANALYZE tab, physics) read the same shape regardless of source.
//
// This is the ONLY place in the codebase that imports fit-file-parser. To swap
// to a different package later (e.g. @garmin/fitsdk), only this file changes.
//
// Public API
//   parseFIT(buffer: ArrayBuffer): Promise<ParsedFIT | null>
//   inferHasPower(fitData): boolean
//   inferHasHR(fitData): boolean
//
// ParsedFIT shape (matches legacy parseFIT output, plus additive fields):
//   {
//     // ── Existing fields (used by App.jsx today) ─────────────────────
//     blockMap:          { [movingMinKey: string]: { powers: number[], hrs: number[] } },
//     elapsedMin:        number,   // wall-clock minutes (last ts − first ts)
//     movingMin:         number,   // elapsed minus stopped seconds (rounded to min)
//     stoppedMin:        number,
//     durationMin:       number,   // alias for movingMin (kept for legacy consumers)
//     totalRecords:      number,   // count of all record messages in file
//     rawAvgPower:       number,   // arithmetic mean of moving 1-sec power
//     rawNP:             number,   // 30-sec rolling avg → 4th-power mean → 4th root
//     movingPowerSeries: number[],     // 1-sec power, moving seconds only
//     movingAltSeries:   (number|null)[], // 1-sec altitude (m), moving seconds only
//     movingDistSeries:  number[],     // PER-SECOND DISTANCE DELTA in meters (NOT m/s)
//     movingHRSeries:    number[],     // 1-sec HR, moving seconds only
//     firstGPS:          { lat, lon, dist } | null,
//
//     // ── New additive fields (forward compatibility) ─────────────────
//     movingCadenceSeries: (number|null)[],
//     movingTempSeries:    (number|null)[],   // °C
//     fullGPSPath:         { lat, lon, distM, timestamp }[],
//     laps:                { startTimeMs, endTimeMs, distM, avgPower? }[],
//     hasPower:            boolean,
//     hasHR:               boolean,
//   }
//
// Critical: the post-processing math (NP rolling window, stop detection,
// elapsed/moving/stopped separation, blockMap construction) is identical to
// the legacy parser — copied verbatim. Only the source of raw 1-Hz records
// changes (binary parser → fit-file-parser package).

import FitParser from 'fit-file-parser';

const STOP_SPEED_MS    = 0.5;  // m/s — Garmin's moving-time threshold
const STOP_MIN_DURATION = 5;   // seconds — minimum stop duration to count

// Run fit-file-parser and return its output object, or null on failure.
function parseRaw(buffer) {
  return new Promise((resolve) => {
    try {
      const fp = new FitParser({
        force:           true,
        speedUnit:       'm/s',
        lengthUnit:      'm',
        temperatureUnit: 'celsius',
        elapsedRecordField: true,
        mode:            'list',
      });
      // Buffer can be ArrayBuffer or Uint8Array; the lib accepts both.
      fp.parse(buffer, (err, data) => {
        if (err) { resolve(null); return; }
        resolve(data);
      });
    } catch {
      resolve(null);
    }
  });
}

// Pull a record's value with sensible fallback to its enhanced_* counterpart.
function pickSpeed(rec) {
  const v = rec.speed ?? rec.enhanced_speed;
  return (typeof v === 'number' && isFinite(v)) ? v : null;
}
function pickAlt(rec) {
  const v = rec.altitude ?? rec.enhanced_altitude;
  return (typeof v === 'number' && isFinite(v)) ? Math.round(v * 10) / 10 : null;
}
function pickPower(rec) {
  const v = rec.power;
  return (typeof v === 'number' && isFinite(v) && v < 65535) ? v : null;
}
function pickHR(rec) {
  const v = rec.heart_rate;
  return (typeof v === 'number' && isFinite(v) && v > 0) ? v : null;
}
function pickCadence(rec) {
  const v = rec.cadence;
  return (typeof v === 'number' && isFinite(v)) ? v : null;
}
function pickTemp(rec) {
  const v = rec.temperature;
  return (typeof v === 'number' && isFinite(v)) ? v : null;
}
function pickDist(rec) {
  const v = rec.distance;
  return (typeof v === 'number' && isFinite(v)) ? v : null;
}
function pickLat(rec) {
  const v = rec.position_lat;
  return (typeof v === 'number' && isFinite(v) && Math.abs(v) > 0.01) ? v : null;
}
function pickLon(rec) {
  const v = rec.position_long;
  return (typeof v === 'number' && isFinite(v) && Math.abs(v) > 0.01) ? v : null;
}
function tsMs(rec) {
  const t = rec.timestamp;
  if (t instanceof Date) return t.getTime();
  if (typeof t === 'number') return t;
  return null;
}

export async function parseFIT(buffer) {
  const data = await parseRaw(buffer);
  if (!data) return null;

  // fit-file-parser puts record messages on data.records
  const rawRecords = Array.isArray(data.records) ? data.records : [];
  if (rawRecords.length === 0) return null;

  // ── Anchor timestamps to first valid timestamp ───────────────────────────
  // fit-file-parser returns Date objects for timestamps. Build a 1-Hz array
  // keyed by elapsed seconds since the first record's timestamp.
  const firstTs = (() => {
    for (const r of rawRecords) { const t = tsMs(r); if (t !== null) return t; }
    return null;
  })();
  if (firstTs === null) return null;
  const lastTs = (() => {
    for (let i = rawRecords.length - 1; i >= 0; i--) { const t = tsMs(rawRecords[i]); if (t !== null) return t; }
    return firstTs;
  })();
  const elapsedSec = Math.max(rawRecords.length, Math.round((lastTs - firstTs) / 1000));
  const elapsedMin = Math.round(elapsedSec / 60);

  // Index records by elapsed-second offset (matches legacy `byTs` map keyed by
  // ts - tsStart). When multiple records land in the same second, the last one
  // wins — same behavior as legacy code's `byTs[r.ts - tsStart] = r` overwrite.
  const byTs = {};
  let hasAnyPower = false;
  let hasAnyHR    = false;
  for (const r of rawRecords) {
    const t = tsMs(r);
    if (t === null) continue;
    const off = Math.round((t - firstTs) / 1000);
    if (off < 0) continue;
    const power    = pickPower(r);
    const hr       = pickHR(r);
    const speedMs  = pickSpeed(r);
    const alt      = pickAlt(r);
    const dist     = pickDist(r);
    const cadence  = pickCadence(r);
    const temp     = pickTemp(r);
    const lat      = pickLat(r);
    const lon      = pickLon(r);
    if (power !== null) hasAnyPower = true;
    if (hr !== null)    hasAnyHR    = true;
    byTs[off] = { power, hr, speedMs, alt, dist, cadence, temp, lat, lon };
  }

  // ── Stop detection — three-tier strategy ────────────────────────────────
  //
  // Tier 1 (preferred): FIT timer events. The device writes timer_start and
  // timer_stop_all events at the exact moments recording paused/resumed.
  // These are device-authoritative — the same source Garmin Connect / Strava
  // use to compute their displayed moving time.
  //
  // Tier 2: session.total_timer_time. Some files (notably Wahoo files
  // re-exported from Strava) preserve the session aggregate but strip the
  // individual timer events. In that case we know HOW MUCH time was paused
  // but not WHEN, so the moving series still includes all elapsed seconds —
  // displayed moving/stopped totals are correct, but per-second analysis
  // can't filter out the paused intervals.
  //
  // Tier 3 (legacy fallback): speed < 0.5 m/s for ≥ 5 consecutive seconds.
  // Used only when neither timer events nor session record are available.
  // Validated against Barry-Roubaix 2026 → matches Garmin Connect exactly
  // when the device writes zero-speed records through stops.

  let stoppedSec = 0;
  const stoppedOffsets = new Set();
  let stopSource = 'speed-heuristic';

  // Tier 1: timer events.
  const timerEvents = (Array.isArray(data.events) ? data.events : [])
    .filter(e => e.event === 'timer' && (e.event_type === 'start' || e.event_type === 'stop' || e.event_type === 'stop_all'))
    .map(e => ({ off: e.timestamp instanceof Date ? Math.round((e.timestamp.getTime() - firstTs) / 1000) : null, type: e.event_type }))
    .filter(e => e.off !== null && e.off >= 0)
    .sort((a, b) => a.off - b.off);

  if (timerEvents.length > 0) {
    // We only count COMPLETED stop→start pairs. A trailing stop with no
    // matching start is almost always the end-of-activity marker (every FIT
    // file has one); treating it as "auto-paused at end" produces a phantom
    // 1-second stopped period that masks a real need to fall through to the
    // speed heuristic. Exception: a trailing `stop_all` (auto-pause never
    // resumed before activity end) is real — only that variant gets counted.
    let pairsClosed = 0;
    let stopStart = null;
    let stopStartType = null;
    for (const e of timerEvents) {
      if (e.type === 'stop' || e.type === 'stop_all') {
        if (stopStart === null) { stopStart = e.off; stopStartType = e.type; }
        // else: already stopped; ignore duplicate stop events
      } else if (e.type === 'start' && stopStart !== null) {
        for (let t = stopStart; t < e.off; t++) {
          if (t >= 0 && t <= elapsedSec) stoppedOffsets.add(t);
        }
        pairsClosed++;
        stopStart = null;
        stopStartType = null;
      }
    }
    // Trailing stop_all only — bare stop at end of file is the activity-end
    // marker, not a pause. Distinguishing the two avoids the BR-2026-TR bug
    // where boundary {start, stop} events were treated as a 1-sec auto-pause.
    if (stopStart !== null && stopStartType === 'stop_all') {
      for (let t = stopStart; t <= elapsedSec; t++) {
        if (t >= 0) stoppedOffsets.add(t);
      }
      pairsClosed++; // trailing auto-pause counts as a real pause for source detection
    }
    stoppedSec = stoppedOffsets.size;
    // Only claim 'timer-events' as the source if we actually found real pause
    // intervals. A file with only boundary start/stop should fall through.
    if (pairsClosed > 0 && stoppedSec > 0) stopSource = 'timer-events';
  }

  // Tier 3 fallback: speed-based heuristic (only if events found nothing).
  if (stoppedOffsets.size === 0) {
    let inStop = false;
    let stopLen = 0;
    let speedSec = 0;
    const pendingStop = [];
    for (let t = 0; t <= elapsedSec; t++) {
      const r = byTs[t];
      const isStopped = r ? (r.speedMs !== null && r.speedMs < STOP_SPEED_MS) : false;
      if (isStopped) {
        if (!inStop) { inStop = true; stopLen = 0; }
        pendingStop.push(t);
        stopLen++;
      } else {
        if (inStop) {
          if (stopLen >= STOP_MIN_DURATION) {
            speedSec += stopLen;
            for (const s of pendingStop) stoppedOffsets.add(s);
          }
          inStop = false; stopLen = 0; pendingStop.length = 0;
        }
      }
    }
    if (inStop && stopLen >= STOP_MIN_DURATION) {
      speedSec += stopLen;
      for (const s of pendingStop) stoppedOffsets.add(s);
    }
    if (speedSec > 0) { stoppedSec = speedSec; stopSource = 'speed-heuristic'; }
  }

  // Tier 2 (display-only fallback): if we still have nothing and the session
  // record reports a timer/elapsed gap, trust the session for displayed moving
  // and stopped totals. Series filtering remains unchanged (we don't know the
  // boundaries) — downstream NP/avg-power will still operate on all elapsed
  // seconds, which is the existing behavior for files of this kind.
  let displayMovingSec = elapsedSec - stoppedSec;
  let displayStoppedSec = stoppedSec;
  const session0 = Array.isArray(data.sessions) && data.sessions[0];
  if (stoppedOffsets.size === 0 && session0 && typeof session0.total_timer_time === 'number') {
    const timerSec   = Math.round(session0.total_timer_time);
    const sessElapsed = typeof session0.total_elapsed_time === 'number'
      ? Math.round(session0.total_elapsed_time) : elapsedSec;
    if (timerSec < sessElapsed && timerSec > 0) {
      displayMovingSec  = timerSec;
      displayStoppedSec = Math.max(0, sessElapsed - timerSec);
      stopSource = 'session-record';
    }
  }

  const movingMin  = Math.round(displayMovingSec / 60);
  const stoppedMin = Math.round(displayStoppedSec / 60);

  // ── Build elapsed-time 1-Hz power series for NP/avg power ────────────────
  // NP must be computed on the elapsed-time stream (with zeros for stopped
  // and gap seconds) so the 30-sec rolling window operates on contiguous time.
  // This is what the legacy parser does (it computes NP on `powerSeries`
  // before the moving-time filtering runs).
  const powerSeries = [];
  for (let t = 0; t <= elapsedSec; t++) {
    const r = byTs[t];
    powerSeries.push(r && r.power !== null ? r.power : 0);
  }
  const rawAvgPower = powerSeries.length
    ? Math.round(powerSeries.reduce((s, p) => s + p, 0) / powerSeries.length)
    : 0;
  const rollingAvgs = [];
  for (let i = 0; i < powerSeries.length; i++) {
    const w = powerSeries.slice(Math.max(0, i - 29), i + 1);
    rollingAvgs.push(w.reduce((s, p) => s + p, 0) / w.length);
  }
  const rawNP = rollingAvgs.length
    ? Math.round(Math.pow(rollingAvgs.reduce((s, p) => s + Math.pow(p, 4), 0) / rollingAvgs.length, 0.25))
    : 0;

  // ── Build moving-time 1-second series (stopped seconds excluded) ─────────
  const movingPowerSeries   = [];
  const movingAltSeries     = [];
  const movingDistSeries    = []; // per-second distance delta in meters
  const movingHRSeries      = [];
  const movingCadenceSeries = [];
  const movingTempSeries    = [];
  let prevDistM = null;
  for (let t = 0; t <= elapsedSec; t++) {
    if (stoppedOffsets.has(t)) continue;
    const r = byTs[t];
    movingPowerSeries.push(r && r.power !== null ? r.power : 0);
    movingAltSeries.push(r ? r.alt : null);
    movingHRSeries.push(r && r.hr !== null ? r.hr : 0);
    movingCadenceSeries.push(r ? r.cadence : null);
    movingTempSeries.push(r ? r.temp : null);
    const distM = r ? r.dist : null;
    if (distM !== null && prevDistM !== null) {
      movingDistSeries.push(Math.max(0, distM - prevDistM));
    } else {
      movingDistSeries.push(0);
    }
    if (distM !== null) prevDistM = distM;
  }

  // ── 5-min block map keyed by MOVING time minutes ─────────────────────────
  // Kept identical to legacy parser for buildPowerStreamFromFIT compatibility.
  const blockSize = 300; // seconds per block
  const blockMap = {};
  let movingOffset = 0;
  for (let t = 0; t <= elapsedSec; t++) {
    if (stoppedOffsets.has(t)) continue;
    const r = byTs[t];
    if (!r) { movingOffset++; continue; }
    const block = Math.floor(movingOffset / blockSize) * 5; // key = moving minutes
    if (!blockMap[block]) blockMap[block] = { powers: [], hrs: [] };
    blockMap[block].powers.push(r.power !== null ? r.power : 0);
    blockMap[block].hrs.push(r.hr !== null ? r.hr : 0);
    movingOffset++;
  }

  // ── First valid GPS coordinate (used to align FIT start to GPX route) ────
  let firstGPS = null;
  for (const r of rawRecords) {
    const lat = pickLat(r), lon = pickLon(r);
    if (lat !== null && lon !== null) {
      firstGPS = { lat, lon, dist: pickDist(r) ?? 0 };
      break;
    }
  }

  // ── Full GPS path (additive, forward compat) ─────────────────────────────
  const fullGPSPath = [];
  for (const r of rawRecords) {
    const lat = pickLat(r), lon = pickLon(r);
    if (lat !== null && lon !== null) {
      fullGPSPath.push({
        lat, lon,
        distM: pickDist(r) ?? 0,
        timestamp: tsMs(r),
      });
    }
  }

  // ── Lap markers (additive, forward compat) ───────────────────────────────
  const rawLaps = Array.isArray(data.laps) ? data.laps : [];
  const laps = rawLaps.map(l => {
    const startMs = l.start_time instanceof Date ? l.start_time.getTime() : null;
    const endMs   = l.timestamp  instanceof Date ? l.timestamp.getTime()  : null;
    const distM   = (typeof l.total_distance === 'number' && isFinite(l.total_distance)) ? l.total_distance : null;
    const avgP    = (typeof l.avg_power      === 'number' && isFinite(l.avg_power))      ? l.avg_power      : null;
    return { startTimeMs: startMs, endTimeMs: endMs, distM, avgPower: avgP };
  }).filter(l => l.startTimeMs !== null);

  return {
    // Existing fields (must match legacy parseFIT exactly)
    blockMap,
    elapsedMin,
    movingMin,
    stoppedMin,
    durationMin: movingMin,
    totalRecords: rawRecords.length,
    rawAvgPower,
    rawNP,
    movingPowerSeries,
    movingAltSeries,
    movingDistSeries,
    movingHRSeries,
    firstGPS,
    // New additive fields
    movingCadenceSeries,
    movingTempSeries,
    fullGPSPath,
    laps,
    hasPower: hasAnyPower,
    hasHR:    hasAnyHR,
    stopSource, // 'timer-events' | 'speed-heuristic' | 'session-record' — diagnostic
  };
}

// ─── Back-compat helpers ─────────────────────────────────────────────────────
// Old saved races (pre-adapter) won't carry hasPower/hasHR flags. Use these
// helpers in any UI code that branches on those flags so old saves still work.

export function inferHasPower(fitData) {
  if (!fitData) return false;
  if (typeof fitData.hasPower === 'boolean') return fitData.hasPower;
  if (typeof fitData.rawAvgPower === 'number' && fitData.rawAvgPower > 0) return true;
  if (Array.isArray(fitData.movingPowerSeries) && fitData.movingPowerSeries.some(p => p > 0)) return true;
  return false;
}

export function inferHasHR(fitData) {
  if (!fitData) return false;
  if (typeof fitData.hasHR === 'boolean') return fitData.hasHR;
  if (Array.isArray(fitData.movingHRSeries) && fitData.movingHRSeries.some(h => h > 0)) return true;
  return false;
}

export default parseFIT;
