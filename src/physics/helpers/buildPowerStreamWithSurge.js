// B-23 — two-pass plan generation with per-climb surge factor.
//
// Pass 1: run buildPowerStream with the user's static category caps. Capture
// per-second power stream.
// Pass 2: run detectClimbs on gpxStats. For each detected climb, slice
// pass-1's powerStreamPerSec by `distM ∈ [startM, endM]` to compute a
// PREDICTED climb duration, then call surgeAdjustedCapMult to get the
// per-climb cap (in watts). Run buildPowerStream a second time, this time
// passing perClimbSurgeCaps so blocks within a climb's range use that
// climb's surge cap rather than the category cap.
//
// Behavior preservation: when detectClimbs returns no climbs (flat routes
// like CC), this collapses to a single buildPowerStream call (skipping
// pass 2 entirely). Routes with climbs pay one extra buildPowerStream call.
//
// Caller integration: where the codebase previously made a final
// buildPowerStream call after flatIFForTargetNP converged, that call site
// now invokes buildPowerStreamWithSurge instead. flatIFForTargetNP itself
// is left untouched — its IF search runs against static caps. Surge
// applied only on the final pass means converged NP may end up slightly
// above target on routes with surge-eligible climbs (short steep). This
// is an accepted v1 approximation per `B23_Calibration_Report.md` Step 7
// Q1.
//
// Output shape matches buildPowerStream exactly, plus an optional
// `_surgeData` diagnostic field listing per-climb surge values.

import { buildPowerStream } from './buildPowerStream.js';
import { detectClimbs } from './detectClimbs.js';
import { surgeAdjustedCapMult, SURGE_FACTOR_DEFAULTS } from './surgeFactor.js';
import { DEFAULTS } from '../constants/defaults.js';
import { PHYSICS_CONSTANTS } from '../constants/physicsConstants.js';

/**
 * Two-pass buildPowerStream with B-23 surge factor applied to detected
 * climbs. Same output shape as buildPowerStream.
 *
 * Constants are pluggable via the optional final argument so tests and
 * calibration scripts can override SURGE_* constants without modifying the
 * helper.
 */
export function buildPowerStreamWithSurge(
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
  surgeFactorTuning = SURGE_FACTOR_DEFAULTS,
) {
  // Pass 1 — static caps.
  const pass1 = buildPowerStream(
    gpxStats, athlete, pacingStrategy,
    Crr, maxPower, CdA, eta, bikeWeight, rho, windSpeedMs, windDirDeg,
    climbCategories,
  );
  if (!pass1 || pass1.ok === false) return pass1;

  const climbs = detectClimbs(gpxStats);
  if (!climbs || climbs.length === 0) return pass1;

  const ftp = athlete?.ftp;
  if (!ftp || ftp <= 0) return pass1; // no FTP — can't compute multipliers; ship pass-1

  const perSec = pass1.powerStreamPerSec || [];

  const surgeData = [];
  const perClimbSurgeCaps = [];
  for (const climb of climbs) {
    const startM = climb.startDistKm * 1000;
    const endM = startM + climb.lengthKm * 1000;
    let durationSec = 0;
    for (const p of perSec) {
      if (p.distM >= startM && p.distM <= endM) durationSec++;
    }
    if (durationSec === 0) continue;

    const catSettings = climbCategories?.[climb.category];
    if (!catSettings || !(catSettings.max > 0)) continue;
    const baseCapMult = catSettings.max / ftp;

    const { capMult, surge } = surgeAdjustedCapMult(
      { durationSec, peakGradePct: climb.peakGradePct, baseCapMult },
      surgeFactorTuning,
    );

    const capW = Math.round(capMult * ftp);
    perClimbSurgeCaps.push({ startM, endM, capW });
    surgeData.push({
      climbId: climb.id,
      category: climb.category,
      startDistKm: climb.startDistKm,
      lengthKm: climb.lengthKm,
      peakGradePct: climb.peakGradePct,
      predictedDurationSec: durationSec,
      baseCapMult: round3(baseCapMult),
      surge: round3(surge),
      capMult: round3(capMult),
      capW,
    });
  }

  // If every climb fell through to baseCapMult, pass 2 would produce identical
  // output — skip it to save the recompute.
  const anySurgeApplied = surgeData.some(d => d.capMult > d.baseCapMult + 1e-6);
  if (!anySurgeApplied) {
    return { ...pass1, _surgeData: surgeData };
  }

  const pass2 = buildPowerStream(
    gpxStats, athlete, pacingStrategy,
    Crr, maxPower, CdA, eta, bikeWeight, rho, windSpeedMs, windDirDeg,
    climbCategories,
    perClimbSurgeCaps,
  );
  if (!pass2 || pass2.ok === false) return pass2;
  return { ...pass2, _surgeData: surgeData };
}

const round3 = (n) => Math.round(n * 1000) / 1000;

export default buildPowerStreamWithSurge;

// ─── Sanity checks ───────────────────────────────────────────────────────
//
// PP-style fixture (2 short steep climbs at 5–6% peak): pass-2 caps for the
// two climbs land at ≈1.32 and ≈1.53 × FTP, allowing the IF search's
// converged power to flow into surge on those climbs rather than being
// hard-clipped at the static category cap.
//
// CC-style fixture (no climbs detected): collapses to single buildPowerStream
// call; output identical to legacy.
//
// Athlete with no FTP / no climbs / climbCategories nil: returns pass-1
// untouched. No structured-error change vs buildPowerStream.
