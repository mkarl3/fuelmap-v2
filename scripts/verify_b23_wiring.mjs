// Verify B-23 production wiring: buildPowerStreamWithSurge two-pass against
// the validation fixtures. Cross-checks against the calibration table.
//
// Expected behavior:
//   • TDL: 8 climbs detected; most fall through (peak <4% or duration >240s);
//     no meaningful change in aggregate NP. _surgeData populated.
//   • CC: 0 climbs detected; pass-2 skipped; output identical to legacy.
//   • PP: 2 climbs detected; both surge-eligible; surge caps applied;
//     aggregate NP rises slightly vs legacy.
//
// Run from fuelmap-v2/:  node scripts/verify_b23_wiring.mjs

import { join } from 'node:path';
import { parseGpxFile } from '../validation_runner/parseGpxNode.js';
import {
  bikePhysics, blendedCrr, rhoFromTemp,
  flatIFForTargetNP, buildPowerStream, buildPowerStreamWithSurge,
  detectClimbs, deriveWPrime,
} from '../src/physics/index.js';

const RACES_DIR = 'C:\\Users\\mkarl\\OneDrive\\Documents\\FuelMAP Doc\\FuelMAP_Validation_Package\\Races';
const FIXTURES = [
  { name: 'TDL', ftp: 215, wPrime: 21700, weight: 170 * 0.453592,
    bikePos: 'road_race', drivetrain: 'road_wax', tireId: 'road_28_32', bikeWt: 17 * 0.453592,
    gpx: '001 TDL MK Route.gpx',
    surfaceMix: [{ id: 'tarmac', pct: 0.85 }, { id: 'chip_seal', pct: 0.15 }],
    tempF: 77, windMph: 10, windEffPct: 25, windDir: 270, targetIF: 0.86,
    capsW: { moderate: 231, steep: 253, wall: 286 } },
  { name: 'CC', ftp: 200, wPrime: 15000, weight: 170 * 0.453592,
    bikePos: 'road_race', drivetrain: 'road_wax', tireId: 'road_28_32', bikeWt: 17 * 0.453592,
    gpx: '002 CC MK Route.gpx',
    surfaceMix: [{ id: 'tarmac', pct: 1.0 }],
    tempF: 45, windMph: 14, windEffPct: 15, windDir: 270, targetIF: 0.76,
    capsW: { moderate: 210, steep: 230, wall: 260 } },
  { name: 'PP', ftp: 200, wPrime: 15000, weight: 170 * 0.453592,
    bikePos: 'gravel_race', drivetrain: 'gravel_wax', tireId: 'gravel_40_50', bikeWt: 22 * 0.453592,
    gpx: '003 PP MK Route.gpx',
    surfaceMix: [{ id: 'tarmac', pct: 0.10 }, { id: 'gravel_1', pct: 0.90 }],
    tempF: 64, windMph: 20, windEffPct: 10, windDir: 270, targetIF: 0.85,
    capsW: { moderate: 210, steep: 230, wall: 260 } },
];

function buildAthlete(f) {
  const a = { id: f.name, ftp: f.ftp, weight: f.weight, phenotype: 'allrounder', wPrime: f.wPrime };
  return { ...a, wPrime: deriveWPrime(a) };
}

for (const f of FIXTURES) {
  console.log(`\n=== ${f.name} ===`);
  const gpxStats = parseGpxFile(join(RACES_DIR, f.gpx));
  const bp = bikePhysics({ positionId: f.bikePos, drivetrainId: f.drivetrain, tireId: f.tireId });
  const Crr = blendedCrr(f.surfaceMix, bp.tireMult);
  const rho = rhoFromTemp((f.tempF - 32) * 5 / 9);
  const effWindMs = f.windMph * 0.44704 * (f.windEffPct / 100);
  const climbCategories = {
    moderate: { min: 0, max: f.capsW.moderate },
    steep:    { min: 0, max: f.capsW.steep },
    wall:     { min: 0, max: f.capsW.wall },
  };
  const athlete = buildAthlete(f);

  const flatIF = flatIFForTargetNP(
    f.targetIF, gpxStats, athlete, Crr, Infinity, bp.CdA, bp.eta, f.bikeWt, rho,
    effWindMs, f.windDir, climbCategories,
  );
  const strat = { mode: 'constant_if', targetIF: flatIF };
  const args = [gpxStats, athlete, strat, Crr, Infinity, bp.CdA, bp.eta, f.bikeWt, rho, effWindMs, f.windDir, climbCategories];

  const legacy = buildPowerStream(...args);
  const surged = buildPowerStreamWithSurge(...args);

  const climbs = detectClimbs(gpxStats);
  console.log(`  flatIF: ${flatIF.toFixed(3)}, climbs detected: ${climbs.length}`);
  console.log(`  Legacy: dur ${legacy.estimatedDurationMin}min, NP ${legacy.normalizedPower}W, IF ${legacy.ifActual}, avg ${legacy.avgPower}W`);
  console.log(`  Surge : dur ${surged.estimatedDurationMin}min, NP ${surged.normalizedPower}W, IF ${surged.ifActual}, avg ${surged.avgPower}W`);
  console.log(`  Δ     : dur ${surged.estimatedDurationMin - legacy.estimatedDurationMin}min, NP ${surged.normalizedPower - legacy.normalizedPower}W`);
  if (surged._surgeData) {
    console.log(`  per-climb surge:`);
    for (const d of surged._surgeData) {
      const tag = d.capMult > d.baseCapMult + 1e-6 ? '  [SURGE APPLIED]' : '';
      console.log(`    #${d.climbId} ${d.startDistKm}km L=${d.lengthKm}km peak=${d.peakGradePct}% dur=${d.predictedDurationSec}s base=${d.baseCapMult} → cap=${d.capMult} (${d.capW}W) surge=${d.surge}${tag}`);
    }
  } else {
    console.log(`  no surge data (no climbs)`);
  }
}
