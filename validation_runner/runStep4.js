// Step 4 — Per-climb stats predicted vs actual.
// Reuses Step 2's plan reproduction and Step 3's FIT extraction. Adds:
//   1. detectClimbs(gpxStats) to identify climbs
//   2. PLAN-side per-climb stats by aggregating powerStreamPerSec across each
//      climb's distance window (same shape as ANALYZE-side stats)
//   3. alignFitToGpx + buildPerClimbStats for ANALYZE-side actuals
//   4. Per-climb predicted-vs-actual deltas

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseGpxFile } from './parseGpxNode.js';
import { parseFIT } from '../src/parsers/fitParser.js';
import {
  bikePhysics, blendedCrr, rhoFromTemp,
  flatIFForTargetNP, buildPowerStream, deriveWPrime,
  detectClimbs, buildPerClimbStats,
  alignFitToGpx, buildWbalFromRawSeries,
  computeNP,
} from '../src/physics/index.js';

const RACES_DIR = 'C:\\Users\\mkarl\\OneDrive\\Documents\\FuelMAP Doc\\FuelMAP_Validation_Package\\Races';

const ATHLETES = {
  MK_00: { id: 'MK_00', ftp: 215, weight: 170 * 0.453592, phenotype: 'allrounder', wPrime: 21700 },
  MK_01: { id: 'MK_01', ftp: 200, weight: 170 * 0.453592, phenotype: 'allrounder', wPrime: 15000 },
};
const TIRE_TYPE_MAP = {
  'Road 28-32mm': 'road_28_32', 'Gravel 40-50mm': 'gravel_40_50',
  'Road 23-25mm': 'road_23_25', 'Gravel 35-40mm': 'gravel_35_40',
};
const BIKES = {
  Emonda_21: { id: 'Emonda_21', weight: 17 * 0.453592, positionId: 'road_race', drivetrainId: 'road_wax', tireType: 'Road 28-32mm' },
  Aspero_21: { id: 'Aspero_21', weight: 22 * 0.453592, positionId: 'gravel_race', drivetrainId: 'gravel_wax', tireType: 'Gravel 40-50mm' },
};
const WIND_DIR = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };

const RACES = [
  { raceId: 'TDL MK_25', athleteId: 'MK_00', bikeId: 'Emonda_21',
    gpx: '001 TDL MK Route.gpx', fit: '001 TDL MK Ride.fit',
    surfaceMix: [{id:'tarmac',pct:85},{id:'chip_seal',pct:15}],
    tempF: 77, windMph: 10, windEffPct: 25, windDir: 'W',
    targetIF: 0.86, capsW: { moderate: 231, steep: 253, wall: 286 } },
  { raceId: 'CCRIDE_MK_26', athleteId: 'MK_01', bikeId: 'Emonda_21',
    gpx: '002 CC MK Route.gpx', fit: '002 CC MK Ride.fit',
    surfaceMix: [{id:'tarmac',pct:100}],
    tempF: 45, windMph: 14, windEffPct: 15, windDir: 'W',
    targetIF: 0.76, capsW: { moderate: 210, steep: 230, wall: 260 } },
  { raceId: 'PPRIDE_MK_26', athleteId: 'MK_01', bikeId: 'Aspero_21',
    gpx: '003 PP MK Route.gpx', fit: '003 PP MK Ride.fit',
    surfaceMix: [{id:'tarmac',pct:10},{id:'gravel_1',pct:90}],
    tempF: 64, windMph: 20, windEffPct: 10, windDir: 'W',
    targetIF: 0.85, capsW: { moderate: 210, steep: 230, wall: 260 } },
];

const fToC = (f) => (f - 32) * (5 / 9);
const mphToMs = (m) => m * 0.44704;

function buildClimbCats(c) {
  return { moderate: { min: 0, max: c.moderate }, steep: { min: 0, max: c.steep }, wall: { min: 0, max: c.wall } };
}

// PLAN-side per-climb stats: aggregate powerStreamPerSec across each climb's
// distance window. Mirrors buildPerClimbStats's aggregation but on the plan
// stream (which is per-second, with distM).
function planPerClimb(climbs, perSec, ftp) {
  return climbs.map(climb => {
    const startM = climb.startDistKm * 1000;
    const endM   = startM + climb.lengthKm * 1000;
    const powers = perSec
      .filter(p => p.distM >= startM && p.distM <= endM)
      .map(p => p.power);
    if (powers.length === 0) return null;
    const np = computeNP(powers);
    const avgP = Math.round(powers.reduce((s,p)=>s+p,0) / powers.length);
    const pctFTP = ftp > 0 ? Math.round(np / ftp * 100) : 0;
    return {
      climbId: climb.id,
      startDistKm: climb.startDistKm,
      lengthKm: climb.lengthKm,
      avgGrade: climb.avgGrade,
      peakGradePct: climb.peakGradePct,
      category: climb.category,
      np, avgP, pctFTP,
      secondsInClimb: powers.length,
    };
  }).filter(c => c != null);
}

async function processRace(race) {
  const athlete = ATHLETES[race.athleteId];
  const bike = BIKES[race.bikeId];
  const tireId = TIRE_TYPE_MAP[bike.tireType];
  const ftp = athlete.ftp;

  const gpxStats = parseGpxFile(join(RACES_DIR, race.gpx));
  const climbs = detectClimbs(gpxStats);
  console.log(`\n=== ${race.raceId} ===`);
  console.log(`  GPX ${gpxStats.totalDistKm}km, +${gpxStats.elevGainM}m  → detected climbs: ${climbs.length}`);

  if (climbs.length === 0) {
    return { raceId: race.raceId, climbs: [], note: 'No climbs detected (route too flat)' };
  }

  // ── PLAN side: rebuild plan stream then aggregate by climb ─────────────────
  const bp = bikePhysics({ positionId: bike.positionId, drivetrainId: bike.drivetrainId, tireId });
  const Crr = blendedCrr(race.surfaceMix, bp.tireMult);
  const rho = rhoFromTemp(fToC(race.tempF));
  const effWind = mphToMs(race.windMph) * (race.windEffPct / 100);
  const climbCats = buildClimbCats(race.capsW);

  const wPrime = deriveWPrime(athlete);
  const athleteForPhysics = { ...athlete, wPrime };

  const flatIF = flatIFForTargetNP(
    race.targetIF, gpxStats, athleteForPhysics,
    Crr, Infinity, bp.CdA, bp.eta, bike.weight, rho,
    effWind, WIND_DIR[race.windDir], climbCats,
  );
  const planResult = buildPowerStream(
    gpxStats, athleteForPhysics, { mode: 'constant_if', targetIF: flatIF },
    Crr, Infinity, bp.CdA, bp.eta, bike.weight, rho,
    effWind, WIND_DIR[race.windDir], climbCats,
  );
  const predictedPerClimb = planPerClimb(climbs, planResult.powerStreamPerSec, ftp);

  // ── ANALYZE side: parseFIT + alignFitToGpx + buildPerClimbStats ────────────
  const buf = readFileSync(join(RACES_DIR, race.fit));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const parsed = await parseFIT(ab);

  // Build alignment using parseFIT's movingGPSPath. Note the helper docs say
  // it accepts that shape directly (per-moving-second, null entries OK).
  console.log(`  alignFitToGpx: ${parsed.movingGPSPath.length} FIT seconds × ${gpxStats._gpxPts.length} GPX points...`);
  const t0 = Date.now();
  const alignment = alignFitToGpx(parsed.movingGPSPath, gpxStats._gpxPts);
  const t1 = Date.now();
  const onRouteCount = alignment.filter(a => a.onRoute).length;
  console.log(`  alignment done in ${t1-t0}ms — onRoute ${onRouteCount}/${alignment.length} (${Math.round(onRouteCount/alignment.length*100)}%)`);

  // ANALYZE-side W'bal for per-climb wbalAtExit
  const actualWbal = buildWbalFromRawSeries(parsed.movingPowerSeries, athleteForPhysics, parsed.movingAltSeries);

  const actualPerClimb = buildPerClimbStats(
    climbs, parsed.movingPowerSeries, parsed.movingDistSeries,
    actualWbal, ftp, alignment,
  );

  // ── Pair predicted to actual, compute deltas ───────────────────────────────
  const byId = new Map(actualPerClimb.map(c => [c.climbId, c]));
  const rows = predictedPerClimb.map(p => {
    const a = byId.get(p.climbId);
    if (!a) return { climbId: p.climbId, status: 'no_actual_data', predicted: p };
    return {
      climbId: p.climbId,
      startDistKm: p.startDistKm,
      lengthKm: p.lengthKm,
      avgGrade: p.avgGrade,
      peakGradePct: p.peakGradePct,
      category: p.category,
      pred: { np: p.np, avgP: p.avgP, pctFTP: p.pctFTP, secs: p.secondsInClimb },
      act:  { np: a.np, avgP: a.avgP, pctFTP: a.pctFTP, secs: a.secondsInClimb,
              wbalPctAtExit: a.wbalPctAtExit },
      delta: {
        np:    a.np - p.np,
        avgP:  a.avgP - p.avgP,
        pctFTP: a.pctFTP - p.pctFTP,
      },
    };
  });

  // Print per-climb table
  console.log(`  Climb |  startKm  lenKm   avg%  peak%   cat      | pred NP / avg | act NP / avg | ΔNP / Δavg | wbalExit%`);
  for (const r of rows) {
    if (r.status) { console.log(`  ${r.climbId.toString().padStart(2)}    | ${r.status}`); continue; }
    const fmt = (n,w=4)=>String(Math.round(n)).padStart(w);
    console.log(
      `  ${String(r.climbId).padStart(2)}    | ${String(r.startDistKm).padStart(7)}  ${String(r.lengthKm).padStart(5)}  ${String(r.avgGrade).padStart(5)}  ${String(r.peakGradePct).padStart(5)}  ${r.category.padEnd(8)} | ${fmt(r.pred.np)} / ${fmt(r.pred.avgP)}  | ${fmt(r.act.np)} / ${fmt(r.act.avgP)}  | ${(r.delta.np>=0?'+':'')+r.delta.np} / ${(r.delta.avgP>=0?'+':'')+r.delta.avgP}     | ${r.act.wbalPctAtExit ?? '-'}`
    );
  }

  // Aggregate stats across all climbs
  const validRows = rows.filter(r => !r.status);
  if (validRows.length > 0) {
    const npDeltas = validRows.map(r => r.delta.np);
    const avgDeltas = validRows.map(r => r.delta.avgP);
    const pctDeltas = validRows.map(r => r.delta.pctFTP);
    const mean = (arr) => arr.reduce((s,x)=>s+x,0) / arr.length;
    const mae  = (arr) => arr.reduce((s,x)=>s+Math.abs(x),0) / arr.length;
    console.log(`  Summary across ${validRows.length} climbs:`);
    console.log(`    NP delta   mean ${mean(npDeltas).toFixed(1)}W   MAE ${mae(npDeltas).toFixed(1)}W   range [${Math.min(...npDeltas)}, ${Math.max(...npDeltas)}]`);
    console.log(`    avg delta  mean ${mean(avgDeltas).toFixed(1)}W   MAE ${mae(avgDeltas).toFixed(1)}W   range [${Math.min(...avgDeltas)}, ${Math.max(...avgDeltas)}]`);
    console.log(`    pctFTP Δ   mean ${mean(pctDeltas).toFixed(1)}pp  MAE ${mae(pctDeltas).toFixed(1)}pp  range [${Math.min(...pctDeltas)}, ${Math.max(...pctDeltas)}]`);
  }

  return { raceId: race.raceId, climbCount: climbs.length, alignmentMs: t1-t0,
           onRouteFrac: onRouteCount/alignment.length, rows };
}

const all = [];
for (const race of RACES) {
  try { all.push(await processRace(race)); }
  catch (e) {
    console.error(`\n=== ${race.raceId} EXCEPTION ===`);
    console.error(e.message); console.error(e.stack);
    all.push({ raceId: race.raceId, exception: e.message });
  }
}

writeFileSync(
  join(import.meta.dirname, 'step4_results.json'),
  JSON.stringify(all, null, 2),
);
console.log(`\nWrote ${all.length} results to step4_results.json`);
