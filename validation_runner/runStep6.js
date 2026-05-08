// Step 6 — W'bal trajectory comparison: predicted vs actual.
//   • Predicted: buildWbal(powerStreamPerSec, athlete, {blockSeconds: 1}) — CC#7 path
//   • Actual:    buildWbalFromRawSeries(movingPowerSeries, athlete, movingAltSeries)
// Comparison metrics:
//   • min W'bal (J and % of W')
//   • peak burn (J in any single second)
//   • trajectory by route-distance decile (10% bins) — predicted vs actual W'bal pct
//   • directional consistency (does actual track predicted shape?)

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseGpxFile } from './parseGpxNode.js';
import { parseFIT } from '../src/parsers/fitParser.js';
import {
  bikePhysics, blendedCrr, rhoFromTemp,
  flatIFForTargetNP, buildPowerStream, deriveWPrime,
  buildWbal, buildWbalFromRawSeries,
  alignFitToGpx,
} from '../src/physics/index.js';

const RACES_DIR = 'C:\\Users\\mkarl\\OneDrive\\Documents\\FuelMAP Doc\\FuelMAP_Validation_Package\\Races';

const ATHLETES = {
  MK_00: { id: 'MK_00', ftp: 215, weight: 170 * 0.453592, phenotype: 'allrounder', wPrime: 21700 },
  MK_01: { id: 'MK_01', ftp: 200, weight: 170 * 0.453592, phenotype: 'allrounder', wPrime: 15000 },
};
const TIRE_TYPE_MAP = { 'Road 28-32mm': 'road_28_32', 'Gravel 40-50mm': 'gravel_40_50' };
const BIKES = {
  Emonda_21: { weight: 17 * 0.453592, positionId: 'road_race', drivetrainId: 'road_wax', tireType: 'Road 28-32mm' },
  Aspero_21: { weight: 22 * 0.453592, positionId: 'gravel_race', drivetrainId: 'gravel_wax', tireType: 'Gravel 40-50mm' },
};
const WIND_DIR = { N: 0, E: 90, S: 180, W: 270 };

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

const fToC = (f) => (f - 32) * (5/9);
const mphToMs = (m) => m * 0.44704;
const buildClimbCats = (c) => ({ moderate:{min:0,max:c.moderate}, steep:{min:0,max:c.steep}, wall:{min:0,max:c.wall} });

async function processRace(race) {
  const athlete = ATHLETES[race.athleteId];
  const bike = BIKES[race.bikeId];
  const tireId = TIRE_TYPE_MAP[bike.tireType];

  const gpxStats = parseGpxFile(join(RACES_DIR, race.gpx));
  const totalRouteM = gpxStats.totalDistKm * 1000;

  // ── PLAN side ───────────────────────────────────────────────────────────────
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

  // PLAN-side W'bal series (per-second, dt=1) — CC#7 canonical path
  const planWbalSeries = buildWbal(planResult.powerStreamPerSec, athleteForPhysics, { blockSeconds: 1 });
  // Each entry has: t, time(min), power, distM, distKm, grade, wbal, wbalPct
  const predMinWbalEntry = planWbalSeries.reduce((m, p) => p.wbal < m.wbal ? p : m, planWbalSeries[0]);
  // peak burn = max single-second drop
  let predPeakBurnJ = 0, predPeakBurnAtSec = 0, prev = wPrime;
  for (let i = 0; i < planWbalSeries.length; i++) {
    const burn = Math.max(0, prev - planWbalSeries[i].wbal);
    if (burn > predPeakBurnJ) { predPeakBurnJ = burn; predPeakBurnAtSec = i; }
    prev = planWbalSeries[i].wbal;
  }

  // ── ACTUAL side ─────────────────────────────────────────────────────────────
  const buf = readFileSync(join(RACES_DIR, race.fit));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const parsed = await parseFIT(ab);
  const actualWbal = buildWbalFromRawSeries(parsed.movingPowerSeries, athleteForPhysics, parsed.movingAltSeries);

  // Need alignment to map actual W'bal seconds to route distance for trajectory bucketing
  const alignment = alignFitToGpx(parsed.movingGPSPath, gpxStats._gpxPts);

  // ── Trajectory comparison: 10% route-distance bins ──────────────────────────
  // For each bin, take the wbal pct at the LAST sample whose distance falls in
  // the bin (i.e., end-of-bin wbal). Plan side reads from planWbalSeries
  // (per-sec, indexed by powerStreamPerSec.distM). Actual side reads from
  // wbalSeries (per-sec) cross-referenced with alignment[i].gpxDistM.
  const NUM_BINS = 10;
  const binEnds = Array.from({length: NUM_BINS}, (_, i) => (i + 1) * (totalRouteM / NUM_BINS));

  // Plan side: walk planWbalSeries, find last entry per bin
  const planBins = new Array(NUM_BINS).fill(null);
  let curBin = 0;
  for (let i = 0; i < planWbalSeries.length; i++) {
    const d = planWbalSeries[i].distM;
    while (curBin < NUM_BINS - 1 && d > binEnds[curBin]) curBin++;
    if (d <= binEnds[curBin]) {
      planBins[curBin] = { wbal: planWbalSeries[i].wbal, wbalPct: planWbalSeries[i].wbalPct };
    }
  }

  // Actual side: iterate by FIT second, bin by alignment[i].gpxDistM, take last
  // wbal in each bin. Need per-second wbal — buildWbalFromRawSeries only
  // returns minute-downsampled chartData. Re-run simulateWbal on movingPowerSeries
  // for the per-second trajectory.
  // Simpler: use the chartData (per-minute) and snap each bin to the closest minute.
  // But that's lower resolution. Let's re-derive per-second wbal here.
  // (Reusing simulateWbal would require import; easier to call buildWbal-equivalent
  //  on a synthetic stream. Instead: we'll just use the chart minute data with
  //  interpolation to estimate.)
  // Cleaner route: rerun simulateWbal directly.

  // Use the canonical helper; but to keep imports tight, replicate the same call
  // that buildWbalFromRawSeries makes:
  const { simulateWbal } = await import('../src/physics/helpers/simulateWbal.js');
  const cpForSim = athlete.ftp;  // both sides fall back to FTP since no cpTests
  const wbalRawSeries = simulateWbal(parsed.movingPowerSeries, 1, cpForSim, wPrime);

  const actualBins = new Array(NUM_BINS).fill(null);
  // Walk by FIT second, look up gpxDistM, accumulate last wbal in each bin
  for (let i = 0; i < wbalRawSeries.length; i++) {
    const a = alignment[i];
    if (!a || !a.onRoute || a.gpxDistM == null) continue;
    const d = a.gpxDistM;
    let bin = 0;
    while (bin < NUM_BINS - 1 && d > binEnds[bin]) bin++;
    actualBins[bin] = { wbal: wbalRawSeries[i], wbalPct: (wbalRawSeries[i] / wPrime) * 100 };
  }

  // Find min wbal across the per-second actual series
  let actMinWbal = wPrime, actMinWbalSec = 0;
  for (let i = 0; i < wbalRawSeries.length; i++) {
    if (wbalRawSeries[i] < actMinWbal) { actMinWbal = wbalRawSeries[i]; actMinWbalSec = i; }
  }

  // Print summary
  console.log(`\n=== ${race.raceId} ===  W'=${wPrime}J  CP=${cpForSim}W`);
  console.log(`  Min W'bal:  predicted ${Math.round(predMinWbalEntry.wbal)}J (${predMinWbalEntry.wbalPct.toFixed(1)}%)  at planSec ${predMinWbalEntry.t}`);
  console.log(`              actual    ${Math.round(actMinWbal)}J (${(actMinWbal/wPrime*100).toFixed(1)}%)  at fitSec ${actMinWbalSec}`);
  const minDeltaJ = actMinWbal - predMinWbalEntry.wbal;
  const minDeltaPct = (actMinWbal/wPrime - predMinWbalEntry.wbal/wPrime) * 100;
  console.log(`              delta     ${minDeltaJ >= 0 ? '+' : ''}${Math.round(minDeltaJ)}J  (${minDeltaPct >= 0 ? '+' : ''}${minDeltaPct.toFixed(1)}pp)`);
  console.log(`  Peak burn:  predicted ${predPeakBurnJ}J/sec at planSec ${predPeakBurnAtSec}   actual ${actualWbal.peakBurnJ}J/sec at fitSec ${actualWbal.peakBurnTime}`);

  console.log(`  Trajectory by route-distance decile (W'bal % of W' at end of each 10% bin):`);
  console.log(`    bin:   ${Array.from({length:NUM_BINS},(_,i)=>String(((i+1)*10)).padStart(5)).join('')}`);
  console.log(`    pred:  ${planBins.map(b=>b?String(Math.round(b.wbalPct)).padStart(5):'  -- ').join('')}`);
  console.log(`    act:   ${actualBins.map(b=>b?String(Math.round(b.wbalPct)).padStart(5):'  -- ').join('')}`);
  const deltas = planBins.map((p,i) => {
    const a = actualBins[i];
    if (!p || !a) return null;
    return Math.round(a.wbalPct - p.wbalPct);
  });
  console.log(`    Δpp:   ${deltas.map(d=>d==null?'  -- ':((d>=0?'+':'')+d).padStart(5)).join('')}`);

  // Trajectory directional consistency: does actual track predicted? (sign of
  // delta-from-prev-bin agreement)
  let agreeCount = 0, totalCmp = 0;
  for (let i = 1; i < NUM_BINS; i++) {
    if (!planBins[i] || !planBins[i-1] || !actualBins[i] || !actualBins[i-1]) continue;
    const planDir = Math.sign(planBins[i].wbalPct - planBins[i-1].wbalPct);
    const actDir = Math.sign(actualBins[i].wbalPct - actualBins[i-1].wbalPct);
    totalCmp++;
    if (planDir === actDir || (planDir === 0 && Math.abs(actualBins[i].wbalPct - actualBins[i-1].wbalPct) < 2)) {
      agreeCount++;
    }
  }
  console.log(`  Direction agreement: ${agreeCount}/${totalCmp} bin transitions move same direction`);

  return {
    raceId: race.raceId,
    wPrime,
    pred: { minWbalJ: Math.round(predMinWbalEntry.wbal), minWbalPct: Math.round(predMinWbalEntry.wbalPct*10)/10,
            peakBurnJ: predPeakBurnJ, minWbalAtSec: predMinWbalEntry.t, },
    actual: { minWbalJ: Math.round(actMinWbal), minWbalPct: Math.round(actMinWbal/wPrime*1000)/10,
              peakBurnJ: actualWbal.peakBurnJ, minWbalAtSec: actMinWbalSec, },
    delta: { minWbalJ: Math.round(minDeltaJ), minWbalPp: Math.round(minDeltaPct*10)/10,
             peakBurnJ: actualWbal.peakBurnJ - predPeakBurnJ, },
    trajectory: planBins.map((p,i) => ({
      binPct: (i+1)*10, predWbalPct: p ? Math.round(p.wbalPct) : null,
      actWbalPct: actualBins[i] ? Math.round(actualBins[i].wbalPct) : null,
      delta: deltas[i],
    })),
    directionAgreement: { agree: agreeCount, total: totalCmp },
  };
}

const all = [];
for (const race of RACES) {
  try { all.push(await processRace(race)); }
  catch (e) {
    console.error(`\n=== ${race.raceId} EXCEPTION ===`); console.error(e.message); console.error(e.stack);
    all.push({ raceId: race.raceId, exception: e.message });
  }
}

writeFileSync(
  join(import.meta.dirname, 'step6_results.json'),
  JSON.stringify(all, null, 2),
);
console.log(`\nWrote ${all.length} results to step6_results.json`);
