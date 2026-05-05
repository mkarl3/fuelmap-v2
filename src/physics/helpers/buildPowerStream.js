// PLAN-side power-stream generator. Spec 4.2 orchestrator.
//
// **Step 6 Prompt 4B — Step 2 (CC#7):** PLAN-side now resamples internally at
// 1-second resolution to match ANALYZE side. Both sides feed canonical helpers
// (`computeNP`, `simulateWbal`) at dt=1, eliminating the dt=60 vs dt=1
// asymmetry that caused systematic NP/W'bal drift between predicted and
// observed numbers on variable terrain.
//
// Implementation:
//  • Per-second simulation along the route — each second computes target
//    speed → grade-corrected watts → cap/floor application → actual speed
//    → distance advance.
//  • `powerStream` (1-min blocks) preserved for backward compatibility with
//    chart consumers / table renderers / segment NP calculations.
//  • `powerStreamPerSec` is the new authoritative output for canonical
//    physics: NP via `computeNP`, W'bal via `buildWbal({ blockSeconds: 1 })`.
//    Eager (always populated) but excluded from IndexedDB persistence by the
//    caller — recomputed on plan load.
//  • `displayStream` (2-min) now aggregated from per-second samples directly
//    rather than from the 1-min blocks — finer underlying resolution flows
//    through to chart rendering.
//  • Module-level WeakMap caches gpxStats-derived invariants (segment grade
//    table, bearing table, distance bin lookups) so flatIFForTargetNP's
//    30-iteration binary search doesn't rebuild them per call.
//
// Locked output shape (Group H + 4B addition):
//   {
//     powerStream:        [{time, power, pctFTP, grade, distKm, speedKph, blockTimeMin}],
//     powerStreamPerSec:  [{t, power, distM, grade}],          // CC#7 (4B)
//     displayStream:      [{time, power, pctFTP, grade, peakGrade, distKm, speedKph}],
//     estimatedDurationMin, avgSpeedKph, avgPower,
//     normalizedPower, tss, ifActual, _physicsOnlyDurationMin,
//   }

import { gradeForSlice }      from './gradeForSlice.js';
import { getSegmentIF }       from './getSegmentIF.js';
import { gradeCategory }      from './gradeCategory.js';
import { speedAtPower }       from './speedAtPower.js';
import { powerAtSpeed }       from './powerAtSpeed.js';
import { computeNP }          from './computeNP.js';
import { fitWarn }            from './fitWarn.js';
import { DEFAULTS }           from '../constants/defaults.js';
import { PHYSICS_CONSTANTS }  from '../constants/physicsConstants.js';

// ── Function-specific tuning constants (per CC#5) ────────────────────────
// Behaviour decisions live at the top of their function as named constants.
// Cross-cutting tuning (Crr, CdA, descent floors, etc.) lives in DEFAULTS.
const WARMUP_SEC            = 180;   // first N seconds ramp from start factor → 1.0 (≈3 min)
const WARMUP_START_FACTOR   = 0.7;   // initial multiplier on target speed
const MIN_SPEED_MS          = 0.5;   // lower bound passed to powerAtSpeed for stability
const STALL_SPEED_MS        = 0.3;   // below this we treat the second as a stall (no advance)
const EMPTY_ROUTE_FALLBACK_MIN = 180; // when speed solver fails entirely
const DISPLAY_BLOCK_MIN     = 2;     // chart aggregation: 2-min display blocks
const DIST_BIN_M            = 100;   // distance-bin resolution for cached grade/bearing lookup
const MAX_SIM_SEC           = 24 * 3600; // hard ceiling — guards against pathological stalls

// (Prompt 4A.5: a `CLIMB_GRADE_THRESHOLD_PCT = 3` constant was previously
// declared here and used as the cap-application gate. It was misleadingly
// imported from `detectClimbs`'s route-topology semantic — appropriate
// there for "what counts as a named climb on the course," wrong here for
// "which blocks get a cap." Removed in 4A.5. Caps now route through
// `gradeCategory` per spec 2.6 / 4.2 Group C — every non-descent block
// receives its category's cap, regardless of how shallow the grade is.)

// ── CC#7 memoization (Prompt 4B Step 2) ─────────────────────────────────
// Cache per-`gpxStats` invariants: segment grade table, bearing table, and
// per-100m distance-binned grade/bearing lookup arrays. WeakMap keyed off the
// gpxStats object reference — flatIFForTargetNP's 30-iteration binary search
// hits the cache on iterations 2+ since gpxStats is identity-stable across
// calls. Cache automatically released when gpxStats is GC'd.
const _gpxCache = new WeakMap();

function getGpxBins(gpxStats) {
  const cached = _gpxCache.get(gpxStats);
  if (cached) return cached;

  const totalDistM = gpxStats.totalDistKm * 1000;
  const avgGrade = totalDistM > 0
    ? (gpxStats.elevGainM - gpxStats.elevLossM) / totalDistM : 0;
  const segs = gpxStats.segmentGrades && gpxStats.segmentGrades.length > 0
    ? gpxStats.segmentGrades : [{ distM: totalDistM, gradeDecimal: avgGrade }];
  const courseBearings = gpxStats.courseBearings || [];
  const avgBearing = gpxStats.avgCourseBearing || 0;

  const nBins = Math.max(1, Math.ceil(totalDistM / DIST_BIN_M));
  const gradeBins = new Float32Array(nBins);
  const bearingBins = new Float32Array(nBins);
  for (let b = 0; b < nBins; b++) {
    const startM = b * DIST_BIN_M;
    const endM = Math.min(startM + DIST_BIN_M, totalDistM);
    gradeBins[b] = gradeForSlice(segs, startM, endM);
    bearingBins[b] = courseBearings.length > 0
      ? (courseBearings[Math.min(
          courseBearings.length - 1,
          Math.floor((b / nBins) * courseBearings.length),
        )] ?? avgBearing)
      : avgBearing;
  }

  const result = { totalDistM, avgGrade, segs, courseBearings, avgBearing,
                   nBins, gradeBins, bearingBins };
  _gpxCache.set(gpxStats, result);
  return result;
}

/**
 * Grade-dependent descent floor (spec 4.2 Group B).
 * Replaces the legacy 60W (formerly 20W) hard floor with a model that matches
 * how athletes actually pedal on descents:
 *   - shallow descent (0% to -2%): ~50% of base target — keeps pedaling
 *   - rolling descent (-2% to -6%): ~30% of base target — partial pedaling
 *   - steep descent (≤ -6%):       ~15% of FTP        — mostly coasting
 * Coefficients live in DEFAULTS.descentFloors per CC#5.
 *
 * Returns the floor in watts. Caller applies it as `max(floor, gradeWatts)`.
 */
function descentFloorWatts(gradePct, baseTargetW, ftp) {
  const f = DEFAULTS.descentFloors;
  if (gradePct >= 0) return 0;                       // not a descent — no floor
  if (gradePct >= f.shallowGradeMaxPct) return baseTargetW * f.shallowFloorFactor;
  if (gradePct >= f.rollingGradeMaxPct) return baseTargetW * f.rollingFloorFactor;
  return ftp * f.steepFloorFactor;
}

// Local defensive unwrap for structured-error returns from physics helpers.
// Mirrors App.jsx _physicsUnwrap so behavior matches across the relocation.
function _unwrap(result, fallback = 0) {
  if (result && typeof result === 'object' && result.ok === false) {
    fitWarn(`physics_unwrap_${result.reason}`,
      `Physics helper returned structured error: ${result.reason}`,
      result.detail ?? null);
    return fallback;
  }
  return result;
}

export function buildPowerStream(
  gpxStats, athlete, pacingStrategy,
  Crr        = DEFAULTS.Crr,
  maxPower   = Infinity,
  CdA        = DEFAULTS.bikePhysics.CdA,
  eta        = DEFAULTS.bikePhysics.eta,
  bikeWeight = 0,
  rho        = PHYSICS_CONSTANTS.rhoSeaLevelStandard,
  windSpeedMs = 0,
  windDirDeg  = 270,
  climbCategories = null,
) {
  // Prompt 4B precondition (replaces the legacy FTP×2 fallback ceiling).
  // Caller must always pass climbCategories — App.jsx auto-restores defaults
  // before calling per the Group C / 4A.5 design. Returning a structured
  // error here surfaces any future caller bug (or refactor regression) via
  // the _physicsUnwrap → fitWarn console path.
  if (!climbCategories) {
    return { ok: false, reason: 'climb_categories_required' };
  }

  const totalMass = athlete.weight + bikeWeight;

  // Pull cached gpxStats-derived bins (built once per gpxStats reference).
  const { totalDistM, gradeBins, bearingBins, nBins, avgBearing } = getGpxBins(gpxStats);

  // Compute headwind component for a given course bearing.
  const headwindForBearing = (bearing) => {
    if (windSpeedMs === 0) return 0;
    const diff = ((windDirDeg - bearing) * Math.PI) / 180;
    return windSpeedMs * Math.cos(diff);
  };

  // Determine base IF.
  const baseIF = pacingStrategy.mode === "constant_if"
    ? pacingStrategy.targetIF
    : (pacingStrategy.segments?.[0]?.targetIF ?? 0.75);

  // ── Per-second simulation (CC#7) ───────────────────────────────────────
  // Walk the route second-by-second. Each second:
  //   1. Look up grade & bearing for current distance bin.
  //   2. Compute target flat-road speed (with wind) for current segIF.
  //   3. Apply warmup ramp.
  //   4. Compute grade-corrected watts to hold target speed.
  //   5. Apply descent floor / climb cap routing (spec 4.2 Group B + C).
  //   6. Solve actual speed at clamped watts on this grade with wind.
  //   7. Advance distance by speed*1sec; record sample.
  const perSec = [];
  let s = 0;       // distance traveled (m)
  let t = 0;       // time elapsed (sec)
  let stalled = false;

  while (s < totalDistM && t < MAX_SIM_SEC) {
    const bin = Math.min(nBins - 1, Math.floor(s / DIST_BIN_M));
    const grade = gradeBins[bin];
    const bearing = bearingBins[bin] ?? avgBearing;
    const headwind = headwindForBearing(bearing);
    const progress = totalDistM > 0 ? (s / totalDistM) : 0;

    const segIF = pacingStrategy.mode === "segments"
      ? _unwrap(getSegmentIF(pacingStrategy.segments, progress), baseIF)
      : baseIF;

    // Warmup: first WARMUP_SEC seconds ramp from WARMUP_START_FACTOR → 1.0.
    // Applied ONCE to targetSpeed only — gradeWatts derives from that reduced
    // speed, so warmup is already captured. Do NOT multiply blockWatts again.
    const warmupFactor = t < WARMUP_SEC
      ? WARMUP_START_FACTOR + (t / WARMUP_SEC) * (1 - WARMUP_START_FACTOR)
      : 1.0;

    // Group E (spec 4.2): wind included in target speed.
    const targetSpeed = _unwrap(
      speedAtPower(segIF * athlete.ftp, 0, totalMass, Crr, CdA, eta, rho, headwind)
    ) * warmupFactor;

    // Power required to hold targetSpeed on this second's grade WITH wind.
    const gradeWatts = powerAtSpeed(
      Math.max(MIN_SPEED_MS, targetSpeed), grade, totalMass, Crr, CdA, eta, rho, headwind
    );

    // Floor / ceiling routing per spec 4.2 Groups B + C, fixed in 4A.5.
    // `gradeCategory` (spec 2.6) is the canonical per-second classifier:
    //   gradePct < 0       → 'descent'   (Group B grade-dependent floor)
    //   0 ≤ gradePct < 6   → 'moderate'  (Group C cap from climbCategories)
    //   6 ≤ gradePct < 10  → 'steep'
    //   gradePct ≥ 10      → 'wall'
    const gradePct = grade * 100;
    const flatWattsForSec = segIF * athlete.ftp;
    let secFloor = 0;
    let secCeiling = maxPower;

    if (gradePct < 0) {
      secFloor = descentFloorWatts(gradePct, flatWattsForSec, athlete.ftp);
    } else {
      const cat = gradeCategory(gradePct);
      const catSettings = climbCategories[cat];
      if (!catSettings || !(catSettings.max > 0)) {
        return { ok: false, reason: 'climb_cap_unset', detail: { category: cat, gradePct } };
      }
      secCeiling = Math.min(secCeiling, catSettings.max);
      if (catSettings.min > 0) secFloor = catSettings.min;
    }

    const watts = Math.round(Math.min(secCeiling, Math.max(secFloor, gradeWatts)));

    // Actual speed WITH wind — headwind slows you, tailwind helps.
    const speed = _unwrap(speedAtPower(watts, grade, totalMass, Crr, CdA, eta, rho, headwind));
    const ds = speed > STALL_SPEED_MS ? speed : 0;

    perSec.push({
      t,
      power: watts,
      distM: s,
      grade,
      speedMs: speed,
    });

    s += ds;
    t += 1;
    if (ds <= 0) {
      // Stalled (sub-stall speed) — break to avoid infinite loop. Should be
      // rare; indicates either climb-cap-set-too-low + steep-grade or a bug.
      stalled = true;
      break;
    }
  }

  // Fallback if simulation degenerated (no samples produced).
  const totalSec = perSec.length;
  if (totalSec === 0) {
    return {
      powerStream: [],
      powerStreamPerSec: [],
      displayStream: [],
      estimatedDurationMin: EMPTY_ROUTE_FALLBACK_MIN,
      avgSpeedKph: 0,
      avgPower: 0,
      normalizedPower: 0,
      tss: 0,
      ifActual: 0,
      _physicsOnlyDurationMin: EMPTY_ROUTE_FALLBACK_MIN,
    };
  }
  if (stalled) {
    fitWarn('build_power_stream_stalled',
      'buildPowerStream halted on stall — climb cap may be infeasibly low for grade.',
      { atDistM: s, totalDistM, atSec: t });
  }

  const actualDurationMin = totalSec / 60;

  // ── Aggregate per-second → 1-min powerStream (legacy contract) ────────
  // Charts, segment-NP code, and the per-block table consume this shape.
  // 1-min blocks formed by averaging 60 consecutive per-second samples.
  const powerStream = [];
  const numBlocks = Math.ceil(totalSec / 60);
  let cumMin = 0;
  for (let b = 0; b < numBlocks; b++) {
    const start = b * 60;
    const end = Math.min(start + 60, totalSec);
    const slice = perSec.slice(start, end);
    if (slice.length === 0) break;
    const avgP = Math.round(slice.reduce((a, p) => a + p.power, 0) / slice.length);
    const avgGrade = slice.reduce((a, p) => a + p.grade, 0) / slice.length;
    const avgSpeedMs = slice.reduce((a, p) => a + p.speedMs, 0) / slice.length;
    const blockTimeMin = slice.length / 60;
    powerStream.push({
      time: Math.round(cumMin),
      power: avgP,
      pctFTP: avgP / athlete.ftp,
      grade: Math.round(avgGrade * 1000) / 10,    // %, 1 decimal
      distKm: Math.round(slice[0].distM / 100) / 10,
      speedKph: Math.round(avgSpeedMs * 3.6 * 10) / 10,
      blockTimeMin,
    });
    cumMin += blockTimeMin;
  }

  // ── Aggregate per-second → 2-min displayStream (chart only) ────────────
  const displayStream = [];
  for (let b = 0; b < numBlocks; b += DISPLAY_BLOCK_MIN) {
    const start = b * 60;
    const end = Math.min(start + DISPLAY_BLOCK_MIN * 60, totalSec);
    const slice = perSec.slice(start, end);
    if (slice.length === 0) break;
    // Convention C: avg includes coasting zeros — match NP timeline.
    // (Same convention as legacy displayStream; preserved for chart parity.)
    const sliceActive = slice.filter(p => p.power > 0);
    const avgDisplayPower = sliceActive.length > 0
      ? Math.round(sliceActive.reduce((a, p) => a + p.power, 0) / sliceActive.length)
      : 0;
    const peakGradeDecimal = slice.reduce((a, p) => Math.max(a, p.grade), -Infinity);
    const avgGradeDecimal = slice.reduce((a, p) => a + p.grade, 0) / slice.length;
    const avgSpeedMs = slice.reduce((a, p) => a + p.speedMs, 0) / slice.length;
    displayStream.push({
      time: b,
      power: avgDisplayPower,
      pctFTP: avgDisplayPower / athlete.ftp,
      grade: Math.round(avgGradeDecimal * 1000) / 10,
      peakGrade: Math.round(peakGradeDecimal * 1000) / 10,
      distKm: Math.round(slice[0].distM / 100) / 10,
      speedKph: Math.round(avgSpeedMs * 3.6 * 10) / 10,
    });
  }

  // ── Final metrics from per-second stream (canonical) ──────────────────
  // NP via canonical computeNP (CC#1) — 30-sec rolling, 4th-power mean.
  // avg via duration-weighted moving timeline (zeros excluded — Garmin/Strava
  // convention; the active-only filter matches the legacy 1-min behavior and
  // ANALYZE-side avgPower calculation, keeping PLAN/ACTUAL directly
  // comparable).
  const powersPerSec = perSec.map(p => p.power);
  const normalizedPower = computeNP(powersPerSec);
  const activePowers = powersPerSec.filter(p => p > 0);
  const avgPower = activePowers.length > 0
    ? Math.round(activePowers.reduce((a, p) => a + p, 0) / activePowers.length)
    : 0;
  const ifActual = athlete.ftp > 0
    ? Math.round((normalizedPower / athlete.ftp) * 100) / 100
    : 0;
  const tss = Math.round((actualDurationMin / 60) * ifActual * ifActual * 100);

  // ── Per-second output (CC#7 canonical) ────────────────────────────────
  // Slim shape — only fields downstream consumers need (W'bal at dt=1, NP
  // recompute, future align-FIT-to-plan diff). Keeping it slim minimizes
  // memory pressure (a 5-hour ride = 18000 entries).
  const powerStreamPerSec = perSec.map(p => ({
    t: p.t,                 // seconds (canonical)
    time: p.t / 60,         // minutes — preserves WbalChart `pt.time` contract
    power: p.power,
    distM: p.distM,
    distKm: Math.round(p.distM / 100) / 10,
    grade: Math.round(p.grade * 1000) / 10,  // % w/ 1 decimal — chart contract
  }));

  return {
    powerStream,           // 1-min blocks — legacy chart/table consumers
    powerStreamPerSec,     // 1-sec stream — canonical math (CC#7)
    displayStream,         // 2-min aggregates — charts only
    estimatedDurationMin: Math.round(actualDurationMin),
    avgSpeedKph: Math.round((gpxStats.totalDistKm / (actualDurationMin / 60)) * 10) / 10,
    avgPower,
    normalizedPower,
    tss,
    ifActual,
    _physicsOnlyDurationMin: Math.round(actualDurationMin),
  };
}

export default buildPowerStream;
