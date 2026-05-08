// Step 2 — Reproduce predicted plans from validation_inputs.xlsx values.
// Reads each race's inputs (hardcoded from the spreadsheet so we don't take a
// new dependency) and runs them through the canonical physics module via the
// same path App.jsx uses on plan generation.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseGpxFile } from './parseGpxNode.js';
import {
  bikePhysics,
  blendedCrr,
  rhoFromTemp,
  flatIFForTargetNP,
  buildPowerStream,
  computeVI,
  buildWbal,
  computeNP,
  deriveWPrime,
} from '../src/physics/index.js';

// ── Spreadsheet inputs (mirrored from validation_inputs.xlsx, post-update) ─────
const RACES_DIR = 'C:\\Users\\mkarl\\OneDrive\\Documents\\FuelMAP Doc\\FuelMAP_Validation_Package\\Races';

const ATHLETES = {
  MK_00: { id: 'MK_00', name: 'Mike K 2020', ftp: 215, weight: 170 * 0.453592,
           phenotype: 'allrounder', wPrime: 21700, maxHR: 190, maxCarbIntakeGPerHr: 90 },
  MK_01: { id: 'MK_01', name: 'Mike K 2026', ftp: 200, weight: 170 * 0.453592,
           phenotype: 'allrounder', wPrime: 15000, maxHR: 190, maxCarbIntakeGPerHr: 90 },
};

// Tire Type display string → physics module tireId
const TIRE_TYPE_MAP = {
  'Road 23-25mm':   'road_23_25',
  'Road 28-32mm':   'road_28_32',
  'Gravel 35-40mm': 'gravel_35_40',
  'Gravel 40-50mm': 'gravel_40_50',
  'MTB 2.2-2.4in':  'mtb_2_2_4',
  'MTB 2.4in +':    'mtb_2_4_plus',
};

const BIKES = {
  Emonda_21: { id: 'Emonda_21', name: 'Trek Emonda - 2021', weight: 17 * 0.453592,
               positionId: 'road_race', drivetrainId: 'road_wax', tireType: 'Road 28-32mm' },
  Aspero_21: { id: 'Aspero_21', name: 'Cervelo Aspero - 2021', weight: 22 * 0.453592,
               positionId: 'gravel_race', drivetrainId: 'gravel_wax', tireType: 'Gravel 40-50mm' },
};

// Wind direction enum → degrees (0=N, 90=E, 180=S, 270=W)
const WIND_DIR_DEG = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };

const RACES = [
  {
    raceId: 'TDL MK_25',
    description: 'Tour De Leelanau MK 25',
    athleteId: 'MK_00',
    bikeId: 'Emonda_21',
    gpxFile: '001 TDL MK Route.gpx',
    surfaceMix: [
      { id: 'tarmac',    pct: 0.85 },
      { id: 'chip_seal', pct: 0.15 },
    ],
    tempF: 77,
    windMph: 10,
    windEffPct: 25,
    windDir: 'W',
    pacingModel: 'Constant IF',
    targetIF: 0.86,
    capsW: { moderate: 231, steep: 253, wall: 286 },
    appOutput: { durationMin: 187, ifActual: 0.86, np: 185, avgPower: 167 },
  },
  {
    raceId: 'CCRIDE_MK_26',
    description: 'CC Morning Ride',
    athleteId: 'MK_01',
    bikeId: 'Emonda_21',
    gpxFile: '002 CC MK Route.gpx',
    surfaceMix: [{ id: 'tarmac', pct: 1.0 }],
    tempF: 45,
    windMph: 14,
    windEffPct: 15,
    windDir: 'W',
    pacingModel: 'Constant IF',
    targetIF: 0.76,
    capsW: { moderate: 210, steep: 230, wall: 260 },
    appOutput: { durationMin: 132, ifActual: 0.76, np: 152, avgPower: 142 },
  },
  {
    raceId: 'PPRIDE_MK_26',
    description: 'Prairie Path Ride',
    athleteId: 'MK_01',
    bikeId: 'Aspero_21',
    gpxFile: '003 PP MK Route.gpx',
    surfaceMix: [
      { id: 'tarmac',   pct: 0.10 },
      { id: 'gravel_1', pct: 0.90 },
    ],
    tempF: 64,
    windMph: 20,
    windEffPct: 10,
    windDir: 'W',
    pacingModel: 'Constant IF',
    targetIF: 0.85,
    capsW: { moderate: 210, steep: 230, wall: 260 },
    appOutput: { durationMin: 122, ifActual: 0.85, np: 170, avgPower: 158 },
  },
];

// ── Conversions ────────────────────────────────────────────────────────────────
const fahrenheitToCelsius = (f) => (f - 32) * (5 / 9);
const mphToMs             = (mph) => mph * 0.44704;

function buildClimbCategoriesFromCaps(capsW) {
  // App.jsx / ensureClimbCapsPopulated shape: { moderate: {min, max}, steep: {min, max}, wall: {min, max} }
  return {
    moderate: { min: 0, max: capsW.moderate },
    steep:    { min: 0, max: capsW.steep },
    wall:     { min: 0, max: capsW.wall },
  };
}

function runRace(race) {
  const athlete = ATHLETES[race.athleteId];
  const bike    = BIKES[race.bikeId];
  if (!athlete) throw new Error(`Unknown athlete ${race.athleteId}`);
  if (!bike)    throw new Error(`Unknown bike ${race.bikeId}`);

  const tireId = TIRE_TYPE_MAP[bike.tireType];
  if (!tireId) throw new Error(`No tire mapping for ${bike.tireType}`);

  const gpxPath = join(RACES_DIR, race.gpxFile);
  const gpxStats = parseGpxFile(gpxPath);
  if (!gpxStats) throw new Error(`Failed to parse ${gpxPath}`);

  // Resolve bike physics → CdA, eta, tireMult
  const bikeForPhysics = { positionId: bike.positionId, drivetrainId: bike.drivetrainId, tireId };
  const bp = bikePhysics(bikeForPhysics);
  if (bp && bp.ok === false) throw new Error(`bikePhysics failed: ${JSON.stringify(bp)}`);
  const { CdA, eta, tireMult } = bp;

  // Resolve Crr from surface mix (App.jsx surfaceMix shape: array of {id, pct})
  const crrResult = blendedCrr(race.surfaceMix, tireMult);
  if (crrResult && crrResult.ok === false) throw new Error(`blendedCrr failed: ${JSON.stringify(crrResult)}`);
  const Crr = crrResult;

  // Air density from temperature (sea level — no elevation correction in app)
  const tempC = fahrenheitToCelsius(race.tempF);
  const rho   = rhoFromTemp(tempC);

  // Wind in m/s scaled by effectiveness (matches App.jsx line 1708)
  const windSpeedMs    = mphToMs(race.windMph);
  const effWindMs      = windSpeedMs * (race.windEffPct / 100);
  const windDirDeg     = WIND_DIR_DEG[race.windDir];

  const climbCategories = buildClimbCategoriesFromCaps(race.capsW);
  const maxPower = Infinity; // App.jsx default — no global cap unless user sets one

  // Ensure athlete has wPrime resolved (deriveWPrime is what App.jsx feeds)
  // Athletes catalogue gives explicit wPrime; deriveWPrime accepts it via athlete.wPrime.
  const wPrime = deriveWPrime(athlete);
  const athleteForPhysics = { ...athlete, wPrime };

  // Step 1 — flatIFForTargetNP search
  const flatIF = flatIFForTargetNP(
    race.targetIF, gpxStats, athleteForPhysics,
    Crr, maxPower, CdA, eta, bike.weight, rho,
    effWindMs, windDirDeg, climbCategories,
  );
  if (flatIF && typeof flatIF === 'object' && flatIF.ok === false) {
    return { raceId: race.raceId, error: flatIF };
  }

  // Step 2 — final buildPowerStream at converged flatIF
  const strat = { mode: 'constant_if', targetIF: flatIF };
  const result = buildPowerStream(
    gpxStats, athleteForPhysics, strat,
    Crr, maxPower, CdA, eta, bike.weight, rho,
    effWindMs, windDirDeg, climbCategories,
  );
  if (result && result.ok === false) return { raceId: race.raceId, error: result };

  // VI correction (App.jsx line 1773)
  const viData = computeVI(gpxStats, race.surfaceMix, result.estimatedDurationMin);

  // W'bal at dt=1 over per-second stream (CC#7 path App.jsx uses for pacingPlan)
  const wbalSeries = buildWbal(result.powerStreamPerSec, athleteForPhysics, { blockSeconds: 1 });
  const wbalMinJ   = wbalSeries.reduce(
    (m, p) => Math.min(m, p.wbal ?? p.value ?? Infinity), Infinity);
  const wbalMinPctOfWPrime = wPrime > 0 ? wbalMinJ / wPrime : null;

  // Convention C avg power (zeros included) for cross-check vs PLAN's
  // "active filter" avg
  const perSecPowers = result.powerStreamPerSec.map(p => p.power);
  const conventionCAvg = perSecPowers.length > 0
    ? Math.round(perSecPowers.reduce((s, p) => s + p, 0) / perSecPowers.length)
    : 0;

  return {
    raceId: race.raceId,
    inputs: {
      athlete: { id: athlete.id, ftp: athlete.ftp, weightKg: athlete.weight, wPrime },
      bike: { id: bike.id, weightKg: bike.weight, CdA, eta, tireMult },
      tempC, rho, windSpeedMs, effWindMs, windDirDeg,
      Crr, climbCategories,
      gpx: { totalDistKm: gpxStats.totalDistKm, elevGainM: gpxStats.elevGainM,
             elevLossM: gpxStats.elevLossM, avgCourseBearing: gpxStats.avgCourseBearing },
    },
    search: { flatIF: Math.round(flatIF * 1000) / 1000 },
    repro: {
      durationMin: result.estimatedDurationMin,
      avgSpeedKph: result.avgSpeedKph,
      avgPower:    result.avgPower,             // Convention B in code (zeros excluded)
      avgPowerConvC: conventionCAvg,            // Convention C (zeros included)
      np:          result.normalizedPower,
      ifActual:    result.ifActual,
      tss:         result.tss,
      wbalMinJ:    Math.round(wbalMinJ),
      wbalMinPctOfWPrime: wbalMinPctOfWPrime != null
        ? Math.round(wbalMinPctOfWPrime * 1000) / 10 : null,
      vi: viData,
    },
    appOutput: race.appOutput,
    deltas: {
      durationMin: result.estimatedDurationMin - race.appOutput.durationMin,
      np:          result.normalizedPower - race.appOutput.np,
      ifActual:    Math.round((result.ifActual - race.appOutput.ifActual) * 1000) / 1000,
      avgPower:    result.avgPower - race.appOutput.avgPower,
    },
  };
}

const results = [];
for (const race of RACES) {
  console.log(`\n=== ${race.raceId} ===`);
  try {
    const r = runRace(race);
    results.push(r);
    if (r.error) {
      console.log(`  ERROR:`, r.error);
      continue;
    }
    console.log(`  GPX: ${r.inputs.gpx.totalDistKm} km, +${r.inputs.gpx.elevGainM}m / -${r.inputs.gpx.elevLossM}m`);
    console.log(`  Crr ${r.inputs.Crr.toFixed(5)}  CdA ${r.inputs.bike.CdA}  eta ${r.inputs.bike.eta}  rho ${r.inputs.rho.toFixed(4)}`);
    console.log(`  flatIF (search converged) = ${r.search.flatIF}`);
    console.log(`  Reproduced  : duration ${r.repro.durationMin} min  IF ${r.repro.ifActual}  NP ${r.repro.np}W  avgB ${r.repro.avgPower}W  avgC ${r.repro.avgPowerConvC}W  TSS ${r.repro.tss}`);
    console.log(`  App Output  : duration ${r.appOutput.durationMin} min  IF ${r.appOutput.ifActual}  NP ${r.appOutput.np}W  avg ${r.appOutput.avgPower}W`);
    console.log(`  Delta       : duration ${r.deltas.durationMin}  IF ${r.deltas.ifActual}  NP ${r.deltas.np}W  avg ${r.deltas.avgPower}W`);
    console.log(`  W'bal min   : ${r.repro.wbalMinJ} J (${r.repro.wbalMinPctOfWPrime}% of W'=${r.inputs.athlete.wPrime})`);
    console.log(`  VI          :`, r.repro.vi);
  } catch (e) {
    console.error(`  EXCEPTION:`, e.message);
    console.error(e.stack);
    results.push({ raceId: race.raceId, exception: e.message });
  }
}

writeFileSync(
  join(import.meta.dirname, 'step2_results.json'),
  JSON.stringify(results, null, 2),
);
console.log(`\nWrote ${results.length} results to step2_results.json`);
