// PLAN-side power-stream generator. Spec 4.2 orchestrator.
//
// **Step 6 Prompt 4A — Step 1+2 (placeholder relocation):** this file is a
// verbatim port of the legacy buildPowerStream from App.jsx. Behavior is
// preserved exactly. Logic changes (Groups B/C/D/E/F/G/H/I/J/K per spec 4.2)
// will be applied in subsequent steps of Prompt 4A.
//
// Locked output shape (Group H — non-negotiable for this prompt):
//   {
//     powerStream: [{time, power, pctFTP, grade, distKm, speedKph, blockTimeMin}],
//     displayStream: [{time, power, pctFTP, grade, peakGrade, distKm, speedKph}],
//     estimatedDurationMin, avgSpeedKph, avgPower,
//     normalizedPower, tss, ifActual, _physicsOnlyDurationMin,
//   }

import { gradeForSlice }      from './gradeForSlice.js';
import { getSegmentIF }       from './getSegmentIF.js';
import { gradeCategory }      from './gradeCategory.js';
import { speedAtPower }       from './speedAtPower.js';
import { powerAtSpeed }       from './powerAtSpeed.js';
import { fitWarn }            from './fitWarn.js';
import { DEFAULTS }           from '../constants/defaults.js';
import { PHYSICS_CONSTANTS }  from '../constants/physicsConstants.js';

// ── Function-specific tuning constants (per CC#5) ────────────────────────
// Behaviour decisions live at the top of their function as named constants.
// Cross-cutting tuning (Crr, CdA, descent floors, etc.) lives in DEFAULTS.
const WARMUP_BLOCKS         = 3;     // first N blocks ramp from start factor → 1.0
const WARMUP_START_FACTOR   = 0.7;   // initial multiplier on target speed
const BEARING_BUCKETS       = 200;   // GPX-side; sized to gpxStats.courseBearings
const MIN_SPEED_MS          = 0.5;   // lower bound passed to powerAtSpeed for stability
const WARMUP_MIN_SPEED_MS   = 0.3;   // below this speed, we cap blockTime at 1 min
const EMPTY_ROUTE_FALLBACK_MIN = 180; // when speed solver fails entirely
const DISPLAY_BLOCK_MIN     = 2;     // chart aggregation: 2-min display blocks
const NP_ROLLING_WINDOW_SEC = 30;    // canonical NP rolling-window length

// (Prompt 4A.5: a `CLIMB_GRADE_THRESHOLD_PCT = 3` constant was previously
// declared here and used as the cap-application gate. It was misleadingly
// imported from `detectClimbs`'s route-topology semantic — appropriate
// there for "what counts as a named climb on the course," wrong here for
// "which blocks get a cap." Removed in 4A.5. Caps now route through
// `gradeCategory` per spec 2.6 / 4.2 Group C — every non-descent block
// receives its category's cap, regardless of how shallow the grade is.)

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
  const totalMass = athlete.weight + bikeWeight;
  const totalDistM = gpxStats.totalDistKm * 1000;
  const avgGrade = totalDistM > 0
    ? (gpxStats.elevGainM - gpxStats.elevLossM) / totalDistM : 0;

  const segs = gpxStats.segmentGrades && gpxStats.segmentGrades.length > 0
    ? gpxStats.segmentGrades : [{ distM: totalDistM, gradeDecimal: avgGrade }];

  // Per-block bearing array from GPX (200 buckets). Falls back to avgCourseBearing or 0.
  const courseBearings = gpxStats.courseBearings || [];
  const avgBearing = gpxStats.avgCourseBearing || 0;
  // Compute headwind component for a given course bearing
  const headwindForBearing = (bearing) => {
    if (windSpeedMs === 0) return 0;
    const diff = ((windDirDeg - bearing) * Math.PI) / 180;
    return windSpeedMs * Math.cos(diff);
  };


  // Determine base IF and target duration
  const baseIF = pacingStrategy.mode === "constant_if"
    ? pacingStrategy.targetIF
    : (pacingStrategy.segments?.[0]?.targetIF ?? 0.75);

  // Flat-road speed at target IF — this is the reference speed the rider targets.
  // Duration is computed from this, matching estimateDuration exactly.
  const avgHeadwind = headwindForBearing(avgBearing);
  const flatWatts = baseIF * athlete.ftp;
  // Duration estimate uses zero-wind flat speed for stable block-count sizing
  // regardless of wind input. Per-block math below applies wind correctly.
  const flatSpeed = _unwrap(speedAtPower(flatWatts, 0, totalMass, Crr, CdA, eta, rho, 0));
  const durationMin = flatSpeed > 0.1 ? (totalDistM / flatSpeed) / 60 : EMPTY_ROUTE_FALLBACK_MIN;

  // If a power ceiling is active, the ride will be slower than flatSpeed predicts.
  const effectiveWatts = Math.min(maxPower, baseIF * athlete.ftp);
  const effectiveFlatSpeed = _unwrap(speedAtPower(effectiveWatts, 0, totalMass, Crr, CdA, eta, rho, 0));
  const durationEstimate = effectiveFlatSpeed > 0.1 ? (totalDistM / effectiveFlatSpeed) / 60 : EMPTY_ROUTE_FALLBACK_MIN;

  // Build 1-min blocks for physics accuracy. At 1-min resolution, short punchy climbs
  // appear as distinct distance slices and the climb floor fires on actual GPX grades
  // rather than averaged-away 5-min grades. Each block covers a proportional distance slice.
  const blocks = Math.max(1, Math.ceil(durationEstimate / 1));
  const distPerBlock = totalDistM / blocks; // meters per 1-min block
  const powerStream = [];
  let actualDurationMin = 0;

  for (let i = 0; i < blocks; i++) {
    const blockStartM = i * distPerBlock;
    const blockEndM = blockStartM + distPerBlock;
    const grade = gradeForSlice(segs, blockStartM, blockEndM);

    // Warmup: first WARMUP_BLOCKS ramp from WARMUP_START_FACTOR to 100% of
    // target speed. Applied ONCE to targetSpeed only — gradeWatts derives
    // from that reduced speed, so warmup is already captured. Do NOT
    // multiply blockWatts by warmupFactor again.
    const warmupFactor = i < WARMUP_BLOCKS
      ? WARMUP_START_FACTOR + (i / WARMUP_BLOCKS) * (1 - WARMUP_START_FACTOR)
      : 1.0;
    const segIF = pacingStrategy.mode === "segments"
      ? _unwrap(getSegmentIF(pacingStrategy.segments, blockStartM / totalDistM), baseIF)
      : baseIF;

    // Map 1-min block index proportionally to the 200-bucket GPX bearing array.
    const bearingIdx = courseBearings.length > 0
      ? Math.min(courseBearings.length - 1, Math.floor(i / blocks * courseBearings.length))
      : 0;
    const blockBearing = courseBearings.length > 0 ? (courseBearings[bearingIdx] ?? avgBearing) : avgBearing;
    const blockHeadwind = headwindForBearing(blockBearing);

    // Group E (spec 4.2): wind is included in target speed.
    // Rationale: real athletes hold power into headwinds and accept slower
    // speed rather than burning matches to maintain no-wind speed. The
    // "constant-speed pacing" model (Decision Log) is preserved with the
    // amendment that the rider's "constant speed" is conditioned on the
    // current wind, not the no-wind baseline. Behavior change: predicted
    // durations on windy routes shift longer (validated in Section 5).
    const targetSpeed = _unwrap(
      speedAtPower(segIF * athlete.ftp, 0, totalMass, Crr, CdA, eta, rho, blockHeadwind)
    ) * warmupFactor;

    // Power required to hold targetSpeed on this block's grade WITH wind.
    const gradeWatts = powerAtSpeed(
      Math.max(MIN_SPEED_MS, targetSpeed), grade, totalMass, Crr, CdA, eta, rho, blockHeadwind
    );

    // Apply category-based climb power (min/max) if grade qualifies.
    // Categories take full precedence over global ceiling on climb blocks.
    // Global maxPower ceiling applies only to blocks where the grade demands
    // MORE than flat-road effort — i.e. actual hard efforts, not descents.
    // Applying the ceiling on descents (where gradeWatts > flatWatts because
    // the rider is trying to hold pace downhill) distorts NP calculation and
    // causes the back-solver to over-compensate, producing paradoxically faster
    // times with a ceiling than without.
    const gradePct = grade * 100;
    const flatWattsForBlock = segIF * athlete.ftp;
    let blockFloor = 0;
    // Group D (spec 4.2): ceiling applies uniformly. The legacy
    // effort-block-only asymmetry was a hack to compensate for the legacy
    // 20/60W flat descent floor distorting NP on descents. With Group B's
    // realistic grade-dependent descent floors, the asymmetry isn't needed
    // — descent power stays well below ftp×2 naturally. The maxPower
    // ceiling now applies to every block; the ftp×2 fallback ceiling is
    // still here as a safety net but goes away when search-with-caps lands
    // (Step 9 of Prompt 4A).
    let blockCeiling = Math.min(maxPower, athlete.ftp * 2);

    // Floor / ceiling routing per spec 4.2 Groups B + C, fixed in 4A.5.
    // `gradeCategory` (spec 2.6) is the canonical per-block classifier:
    //   gradePct < 0       → 'descent'   (Group B grade-dependent floor)
    //   0 ≤ gradePct < 6   → 'moderate'  (Group C cap from climbCategories)
    //   6 ≤ gradePct < 10  → 'steep'
    //   gradePct ≥ 10      → 'wall'
    // Caps apply uniformly across non-descent blocks — every block ≥ 0%
    // grade gets the corresponding category cap, regardless of whether the
    // grade is shallow enough that `detectClimbs` would skip it as a named
    // climb. The 3% threshold belongs to route-topology classification, not
    // per-block effort budgeting.
    if (gradePct < 0) {
      // Group B descent floor — no climb cap on descents.
      blockFloor = descentFloorWatts(gradePct, flatWattsForBlock, athlete.ftp);
    } else if (climbCategories) {
      // Group C climb cap. When climbCategories is provided, caps are
      // mandatory (pre-populated at race creation, auto-restored on user-
      // clear by computePlan in App.jsx). A missing or zero `max` is a bug
      // indicator — surface via _physicsUnwrap → fitWarn console path.
      const cat = gradeCategory(gradePct);
      const catSettings = climbCategories[cat];
      if (!catSettings || !(catSettings.max > 0)) {
        return { ok: false, reason: 'climb_cap_unset', detail: { category: cat, gradePct } };
      }
      blockCeiling = catSettings.max;
      if (catSettings.min > 0) blockFloor = catSettings.min;
    }
    // When climbCategories is null (legacy callers — none in current flow
    // post-Prompt 4A), the legacy `min(maxPower, ftp×2)` fallback ceiling
    // applies via blockCeiling above. Defensive code path; effectively dead
    // in normal flow.
    // Clamp gradeWatts to the resolved floor/ceiling. The legacy 60W literal
    // is gone — descent floor handles the descent case; climb caps the climb
    // case; flat blocks fall back to gradeWatts naturally.
    const blockWatts = Math.round(Math.min(blockCeiling, Math.max(blockFloor, gradeWatts)));

    // Actual speed WITH wind — headwind slows you, tailwind helps.
    const speed = _unwrap(speedAtPower(blockWatts, grade, totalMass, Crr, CdA, eta, rho, blockHeadwind));
    const blockTimeMin = speed > WARMUP_MIN_SPEED_MS ? (distPerBlock / speed) / 60 : 1;
    const speedKph = Math.round(speed * 3.6 * 10) / 10;

    powerStream.push({
      time: Math.round(actualDurationMin),
      power: blockWatts,
      pctFTP: blockWatts / athlete.ftp,
      grade: Math.round(grade * 1000) / 10,
      distKm: Math.round(blockStartM / 100) / 10,
      speedKph,
      blockTimeMin,
    });
    actualDurationMin += blockTimeMin;
  }

  // NP: 30-second rolling average then 4th-power mean.
  // At 1-min blocks, window = ceil(30/60) = 1 block. Finer terrain resolution now feeds
  // into the 4th-power mean, producing more accurate NP on variable terrain.
  const rollingWindow = Math.max(1, Math.ceil(NP_ROLLING_WINDOW_SEC / (actualDurationMin / blocks * 60)));
  const blockPowers = powerStream.map(p => p.power);
  const rollingAvgs = blockPowers.map((_, i) => {
    const window = blockPowers.slice(Math.max(0, i - rollingWindow + 1), i + 1);
    return window.reduce((s, p) => s + p, 0) / window.length;
  });
  const normalizedPower = Math.round(Math.pow(
    rollingAvgs.reduce((s, p) => s + Math.pow(p, 4), 0) / rollingAvgs.length,
    0.25
  ));
  // Duration-weighted avg power, excluding zero-power blocks. Matches Garmin's
  // convention (zeros from coasting excluded) and the ANALYZE-side calculation,
  // making PLAN and ACTUAL directly comparable. Simple unweighted mean previously
  // under-counted hard climb time (long, high-power blocks) and over-counted fast
  // descent time (short, low-power blocks).
  const activeBlocks = powerStream.filter(p => p.power > 0);
  const totalActiveTime = activeBlocks.reduce((s, p) => s + p.blockTimeMin, 0);
  const avgPower = totalActiveTime > 0
    ? Math.round(activeBlocks.reduce((s, p) => s + p.power * p.blockTimeMin, 0) / totalActiveTime)
    : 0;
  const ifActual = Math.round((normalizedPower / athlete.ftp) * 100) / 100;
  const tss = Math.round((actualDurationMin / 60) * ifActual * ifActual * 100);

  // Build display stream by aggregating DISPLAY_BLOCK_MIN-wide groups of 1-min blocks.
  // Charts render displayStream; all physics (NP, W'bal, climb floor, nutrition) uses powerStream.
  const displayStream = [];
  for (let i = 0; i < powerStream.length; i += DISPLAY_BLOCK_MIN) {
    const slice = powerStream.slice(i, i + DISPLAY_BLOCK_MIN);
    // Duration-weighted, exclude zeros — same convention as headline avgPower above.
    const sliceActive = slice.filter(p => p.power > 0);
    const sliceActiveTime = sliceActive.reduce((s, p) => s + p.blockTimeMin, 0);
    const avgDisplayPower = sliceActiveTime > 0
      ? Math.round(sliceActive.reduce((s, p) => s + p.power * p.blockTimeMin, 0) / sliceActiveTime)
      : 0;
    const peakGrade = Math.max(...slice.map(p => p.grade));
    // S1-FOLLOWUP: grade and speed averaging left as simple means by design — revisit later.
    const avgGrade = Math.round(slice.reduce((s, p) => s + p.grade, 0) / slice.length * 10) / 10;
    const avgSpeed = Math.round(slice.reduce((s, p) => s + p.speedKph, 0) / slice.length * 10) / 10;
    displayStream.push({
      time: slice[0].time,
      power: avgDisplayPower,
      pctFTP: avgDisplayPower / athlete.ftp,
      grade: avgGrade,
      peakGrade: Math.round(peakGrade * 10) / 10,
      distKm: slice[0].distKm,
      speedKph: avgSpeed,
    });
  }

  return {
    powerStream,      // 1-min blocks — NP, W'bal, nutrition physics
    displayStream,    // 2-min aggregates — charts only
    estimatedDurationMin: Math.round(actualDurationMin),
    avgSpeedKph: Math.round((gpxStats.totalDistKm / (actualDurationMin / 60)) * 10) / 10,
    avgPower,
    normalizedPower,
    tss,
    ifActual,
    // VI correction — caller must pass surfaceMix separately; stored here for display
    _physicsOnlyDurationMin: Math.round(actualDurationMin),
  };
}

export default buildPowerStream;
