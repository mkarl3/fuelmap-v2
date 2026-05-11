// B-29 — W'bal validation re-run post B-23.
//
// For each fixture (TDL, CC, PP):
//   1. Plan generation through buildPowerStreamWithSurge (production path).
//   2. Predicted W'bal trajectory at dt=1 over powerStreamPerSec.
//   3. Actual W'bal trajectory via simulateWbal on parsed FIT movingPowerSeries.
//   4. Trajectory comparison at 10% route-distance bins.
//   5. Per-climb W'bal at exit (TDL, PP — CC has no climbs).
//   6. Phenotype override test (MK_01 W'=15000 → 22000 to isolate
//      W'-calibration share of the remaining gap).
//
// Output:
//   • scripts/b29_validation.json — full per-fixture data.
//   • markdown tables printed to stdout (paste-ready into the addendum).
//
// Pre-B-23 baseline numbers are NOT recomputed here — they're sourced from
// FuelMAP_Validation_Package/Validation_Report.md and noted in the addendum.
// This script computes the POST-B-23 column.
//
// Run from fuelmap-v2/:  node scripts/validate_b29.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseGpxFile } from '../validation_runner/parseGpxNode.js';
import { parseFIT } from '../src/parsers/fitParser.js';
import {
  bikePhysics, blendedCrr, rhoFromTemp,
  flatIFForTargetNP, buildPowerStream, buildPowerStreamWithSurge,
  buildWbal, buildWbalFromRawSeries,
  detectClimbs, alignFitToGpx, deriveWPrime,
  simulateWbal,
} from '../src/physics/index.js';

const RACES_DIR = 'C:\\Users\\mkarl\\OneDrive\\Documents\\FuelMAP Doc\\FuelMAP_Validation_Package\\Races';

const ATHLETES = {
  MK_00: { id: 'MK_00', ftp: 215, weight: 170 * 0.453592, phenotype: 'allrounder', wPrime: 21700, maxHR: 190 },
  MK_01: { id: 'MK_01', ftp: 200, weight: 170 * 0.453592, phenotype: 'allrounder', wPrime: 15000, maxHR: 190 },
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
    surfaceMix: [{ id: 'tarmac', pct: 0.85 }, { id: 'chip_seal', pct: 0.15 }],
    tempF: 77, windMph: 10, windEffPct: 25, windDir: 'W',
    targetIF: 0.86, capsW: { moderate: 231, steep: 253, wall: 286 },
    // pre-B-23 baseline from Validation_Report.md
    baseline: {
      predMinPct: 39.4, actMinPct: 8.5,
      planBins:  [80, 73, 92, 78, 78, 85, 95, 90, 51, 79],
      actBins:   [43, 29, 43, 52, 72, 76, 83, 63, 92, 92],
    },
  },
  { raceId: 'CCRIDE_MK_26', athleteId: 'MK_01', bikeId: 'Emonda_21',
    gpx: '002 CC MK Route.gpx', fit: '002 CC MK Ride.fit',
    surfaceMix: [{ id: 'tarmac', pct: 1.0 }],
    tempF: 45, windMph: 14, windEffPct: 15, windDir: 'W',
    targetIF: 0.76, capsW: { moderate: 210, steep: 230, wall: 260 },
    baseline: {
      predMinPct: 91.8, actMinPct: 3.2,
      planBins:  [100, 97, 96, 95, 97, 96, 96, 94, 98, 99],
      actBins:   [74, 72, 52, 68, 35, 44, 54, 35, 14, 18],
    },
  },
  { raceId: 'PPRIDE_MK_26', athleteId: 'MK_01', bikeId: 'Aspero_21',
    gpx: '003 PP MK Route.gpx', fit: '003 PP MK Ride.fit',
    surfaceMix: [{ id: 'tarmac', pct: 0.10 }, { id: 'gravel_1', pct: 0.90 }],
    tempF: 64, windMph: 20, windEffPct: 10, windDir: 'W',
    targetIF: 0.85, capsW: { moderate: 210, steep: 230, wall: 260 },
    baseline: {
      predMinPct: 74.1, actMinPct: 0.0,
      planBins:  [98, 90, 89, 92, 79, 86, 89, 78, 86, 80],
      actBins:   [13,  2, 23, 56,  8, 14, 36, 12,  3, 22],
    },
  },
];

// Phenotype override values — sprinter-leaning W' for MK_01 per Validation
// Report F-9 / Backlog B-19. MK_00 already at sprinter-class via the 21700
// catalog override (Tier 0 honors it post-B-18); leave unchanged for the
// override test so we isolate the MK_01 effect.
const PHENOTYPE_OVERRIDE = {
  MK_00: 21700,   // unchanged — already explicit
  MK_01: 22000,   // sprinter coefficient: 200 × 110
};

const fToC = (f) => (f - 32) * (5 / 9);
const mphToMs = (m) => m * 0.44704;
const buildClimbCats = (c) => ({
  moderate: { min: 0, max: c.moderate },
  steep:    { min: 0, max: c.steep },
  wall:     { min: 0, max: c.wall },
});

async function loadFit(filePath) {
  const buf = readFileSync(filePath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return await parseFIT(ab);
}

function whichTier(athlete) {
  // Mirrors deriveWPrime's tier logic, for reporting only.
  if (athlete?.wPrime > 0) return 'Tier 0 (explicit)';
  if ((athlete?.cpTests ?? []).filter(t => t?.secs > 0 && t?.watts > 0).length >= 2) return 'Tier 1 (CP test)';
  if (athlete?.phenotype) return 'Tier 2 (phenotype)';
  return 'Tier 3 (FTP fallback)';
}

function binTrajectory(numBins, totalRouteM, planWbalSeries, wbalRawSeries, alignment) {
  const binEnds = Array.from({ length: numBins }, (_, i) => (i + 1) * (totalRouteM / numBins));

  // PLAN side — last per-second entry whose distM is within each bin.
  const planBins = new Array(numBins).fill(null);
  let curBin = 0;
  for (const pt of planWbalSeries) {
    while (curBin < numBins - 1 && pt.distM > binEnds[curBin]) curBin++;
    if (pt.distM <= binEnds[curBin]) {
      planBins[curBin] = { wbal: pt.wbal, wbalPct: pt.wbalPct };
    }
  }

  // ACTUAL side — last on-route per-second entry whose alignment.gpxDistM is within each bin.
  const actualBins = new Array(numBins).fill(null);
  for (let i = 0; i < wbalRawSeries.length; i++) {
    const a = alignment[i];
    if (!a || !a.onRoute || a.gpxDistM == null) continue;
    let bin = 0;
    while (bin < numBins - 1 && a.gpxDistM > binEnds[bin]) bin++;
    actualBins[bin] = { wbal: wbalRawSeries[i] };
  }

  return { planBins, actualBins };
}

function perClimbWbalExit(climbs, planWbalSeries, wbalRawSeries, alignment, wPrime) {
  return climbs.map(climb => {
    const startM = climb.startDistKm * 1000;
    const endM = startM + climb.lengthKm * 1000;

    // PLAN side — last per-second sample within climb
    let lastPlanWbal = null;
    for (const pt of planWbalSeries) {
      if (pt.distM >= startM && pt.distM <= endM) lastPlanWbal = pt.wbal;
    }
    // ACTUAL side — last on-route per-second sample within climb
    let lastActWbal = null;
    for (let i = 0; i < wbalRawSeries.length; i++) {
      const a = alignment[i];
      if (!a || !a.onRoute || a.gpxDistM == null) continue;
      if (a.gpxDistM >= startM && a.gpxDistM <= endM) lastActWbal = wbalRawSeries[i];
    }
    return {
      climbId: climb.id,
      startDistKm: climb.startDistKm,
      lengthKm: climb.lengthKm,
      peakGradePct: climb.peakGradePct,
      category: climb.category,
      predWbalPct: lastPlanWbal != null ? Math.round(lastPlanWbal / wPrime * 1000) / 10 : null,
      actWbalPct:  lastActWbal  != null ? Math.round(lastActWbal  / wPrime * 1000) / 10 : null,
    };
  });
}

function summarizeMin(wbalSeries, wPrime) {
  let minJ = wPrime, atSec = 0;
  for (let i = 0; i < wbalSeries.length; i++) {
    if (wbalSeries[i] < minJ) { minJ = wbalSeries[i]; atSec = i; }
  }
  return { minJ: Math.round(minJ), minPct: Math.round(minJ / wPrime * 1000) / 10, atSec };
}

async function processRace(race) {
  const athlete = ATHLETES[race.athleteId];
  const bike = BIKES[race.bikeId];
  const tireId = TIRE_TYPE_MAP[bike.tireType];

  const gpxStats = parseGpxFile(join(RACES_DIR, race.gpx));
  const totalRouteM = gpxStats.totalDistKm * 1000;

  // ── PLAN side ──
  const bp = bikePhysics({ positionId: bike.positionId, drivetrainId: bike.drivetrainId, tireId });
  const Crr = blendedCrr(race.surfaceMix, bp.tireMult);
  const rho = rhoFromTemp(fToC(race.tempF));
  const effWind = mphToMs(race.windMph) * (race.windEffPct / 100);
  const climbCats = buildClimbCats(race.capsW);
  const wPrimeBase = deriveWPrime(athlete);
  const athleteForPhysics = { ...athlete, wPrime: wPrimeBase };

  const flatIF = flatIFForTargetNP(
    race.targetIF, gpxStats, athleteForPhysics,
    Crr, Infinity, bp.CdA, bp.eta, bike.weight, rho,
    effWind, WIND_DIR[race.windDir], climbCats,
  );
  // Production path: buildPowerStreamWithSurge (B-23 v1).
  const planResult = buildPowerStreamWithSurge(
    gpxStats, athleteForPhysics, { mode: 'constant_if', targetIF: flatIF },
    Crr, Infinity, bp.CdA, bp.eta, bike.weight, rho,
    effWind, WIND_DIR[race.windDir], climbCats,
  );

  // CLEAN B-23 ISOLATION: re-run plan with static caps (pre-B-23 path) at the
  // SAME W' that production uses now. Lets us decouple B-23's surge effect from
  // the B-18 W' change that landed in the same window. Pre-B-23 baseline in
  // the Validation Report used W' = 16125 for TDL (pre-B-18); now production
  // uses W' = 21700 (Tier 0). On CC and PP, W' = 15000 in both eras, so the
  // isolation pass equals the Validation Report numbers — included anyway as
  // a sanity check.
  const planResultNoSurge = buildPowerStream(
    gpxStats, athleteForPhysics, { mode: 'constant_if', targetIF: flatIF },
    Crr, Infinity, bp.CdA, bp.eta, bike.weight, rho,
    effWind, WIND_DIR[race.windDir], climbCats,
  );

  // Predicted W'bal per-second
  const planWbalSeries = buildWbal(planResult.powerStreamPerSec, athleteForPhysics, { blockSeconds: 1 });
  const predMin = summarizeMin(planWbalSeries.map(p => p.wbal), wPrimeBase);
  // No-surge isolation min
  const planWbalNoSurge = buildWbal(planResultNoSurge.powerStreamPerSec, athleteForPhysics, { blockSeconds: 1 });
  const predMinNoSurge = summarizeMin(planWbalNoSurge.map(p => p.wbal), wPrimeBase);

  // ── ACTUAL side ──
  const parsed = await loadFit(join(RACES_DIR, race.fit));
  const alignment = alignFitToGpx(parsed.movingGPSPath, gpxStats._gpxPts);

  // Raw per-second W'bal via simulateWbal directly (so we have per-sec trajectory
  // for bin attribution; buildWbalFromRawSeries returns minute-downsampled).
  const cpForSim = athlete.ftp;
  const wbalRawSeries = simulateWbal(parsed.movingPowerSeries, 1, cpForSim, wPrimeBase);
  const actMin = summarizeMin(wbalRawSeries, wPrimeBase);

  // Use the canonical helper for cross-check on peak burn
  const actualWbalSummary = buildWbalFromRawSeries(parsed.movingPowerSeries, athleteForPhysics, parsed.movingAltSeries);

  // Trajectory bins
  const { planBins, actualBins } = binTrajectory(10, totalRouteM, planWbalSeries, wbalRawSeries, alignment);
  const trajectory = planBins.map((p, i) => {
    const a = actualBins[i];
    return {
      binPct: (i + 1) * 10,
      predPct: p ? Math.round(p.wbalPct) : null,
      actPct:  a ? Math.round(a.wbal / wPrimeBase * 100) : null,
    };
  });

  // Per-climb W'bal exit
  const climbs = detectClimbs(gpxStats);
  const perClimb = climbs.length > 0
    ? perClimbWbalExit(climbs, planWbalSeries, wbalRawSeries, alignment, wPrimeBase)
    : [];

  // ── PHENOTYPE OVERRIDE TEST ──
  // Force athlete.wPrime to PHENOTYPE_OVERRIDE; re-run buildWbal and the raw
  // per-second wbal. Compare min and trajectory at the higher W'.
  const wPrimeOver = PHENOTYPE_OVERRIDE[race.athleteId];
  const athleteOver = { ...athlete, wPrime: wPrimeOver };
  const wPrimeOverResolved = deriveWPrime(athleteOver); // sanity check Tier 0
  const planWbalOver = buildWbal(planResult.powerStreamPerSec, athleteOver, { blockSeconds: 1 });
  const predMinOver = summarizeMin(planWbalOver.map(p => p.wbal), wPrimeOverResolved);
  const wbalRawOver = simulateWbal(parsed.movingPowerSeries, 1, cpForSim, wPrimeOverResolved);
  const actMinOver = summarizeMin(wbalRawOver, wPrimeOverResolved);
  const { planBins: planBinsOver, actualBins: actualBinsOver } =
    binTrajectory(10, totalRouteM, planWbalOver, wbalRawOver, alignment);
  const trajectoryOver = planBinsOver.map((p, i) => {
    const a = actualBinsOver[i];
    return {
      binPct: (i + 1) * 10,
      predPct: p ? Math.round(p.wbalPct) : null,
      actPct:  a ? Math.round(a.wbal / wPrimeOverResolved * 100) : null,
    };
  });

  // ── Aggregate metrics ──
  const surgeData = planResult._surgeData || [];

  return {
    raceId: race.raceId,
    athleteId: race.athleteId,
    ftp: athlete.ftp,
    wPrimeBase,
    wPrimeBaseTier: whichTier(athleteForPhysics),
    wPrimeOver: wPrimeOverResolved,
    plan: {
      flatIF: Math.round(flatIF * 1000) / 1000,
      np: planResult.normalizedPower,
      avgPower: planResult.avgPower,
      ifActual: planResult.ifActual,
      tss: planResult.tss,
      durationMin: planResult.estimatedDurationMin,
      surgeApplied: surgeData.filter(d => d.capMult > d.baseCapMult + 1e-6).length,
      surgeDetails: surgeData,
    },
    baseline: race.baseline,
    post: {
      predMinPct: predMin.minPct,
      actMinPct: actMin.minPct,
      gapPp: Math.round((actMin.minPct - predMin.minPct) * 10) / 10,
      peakBurnPredJ: actualWbalSummary?.peakBurnJ ?? null,
      trajectory,
    },
    isolationNoSurge: {
      // Same W' as production, but plan built with static caps (no surge).
      // Cleanly isolates B-23's contribution from the B-18 W' change.
      predMinPct: predMinNoSurge.minPct,
      actMinPct: actMin.minPct,
      gapPp: Math.round((actMin.minPct - predMinNoSurge.minPct) * 10) / 10,
    },
    phenotypeOverride: {
      wPrime: wPrimeOverResolved,
      predMinPct: predMinOver.minPct,
      actMinPct: actMinOver.minPct,
      gapPp: Math.round((actMinOver.minPct - predMinOver.minPct) * 10) / 10,
      trajectory: trajectoryOver,
    },
    perClimb,
  };
}

function printRaceSummary(r) {
  console.log(`\n=== ${r.raceId} ===   FTP ${r.ftp}   W' ${r.wPrimeBase}J (${r.wPrimeBaseTier})`);
  console.log(`  Plan: flatIF ${r.plan.flatIF}, NP ${r.plan.np}W, IF ${r.plan.ifActual}, dur ${r.plan.durationMin}min`);
  console.log(`  Surge applied to ${r.plan.surgeApplied} climbs:`);
  for (const d of r.plan.surgeDetails) {
    const tag = d.capMult > d.baseCapMult + 1e-6 ? ' [SURGE]' : '';
    console.log(`    #${d.climbId} start ${d.startDistKm}km L=${d.lengthKm}km peak=${d.peakGradePct}% dur=${d.predictedDurationSec}s cap=${d.capW}W (×${d.capMult})${tag}`);
  }
  console.log('');
  console.log(`  Min W'bal:`);
  console.log(`    pre-B-23 (report):  pred ${r.baseline.predMinPct}% / act ${r.baseline.actMinPct}%   gap ${(r.baseline.actMinPct - r.baseline.predMinPct).toFixed(1)}pp`);
  console.log(`    no-surge isolation: pred ${r.isolationNoSurge.predMinPct}% / act ${r.isolationNoSurge.actMinPct}%   gap ${r.isolationNoSurge.gapPp}pp  (same W' as production, no B-23 surge)`);
  console.log(`    POST-B-23 (prod):   pred ${r.post.predMinPct}% / act ${r.post.actMinPct}%   gap ${r.post.gapPp}pp`);
  const isolationGap = r.isolationNoSurge.gapPp; // signed pp
  const postGap = r.post.gapPp;
  const b23Effect = isolationGap - postGap; // positive = B-23 narrowed gap
  const totalDelta = (r.baseline.actMinPct - r.baseline.predMinPct) - postGap;
  console.log(`    B-23 contribution:  ${b23Effect >= 0 ? '+' : ''}${b23Effect.toFixed(1)}pp narrowing (clean)`);
  console.log(`    total delta vs report (B-23 + B-18 W' shift): ${totalDelta >= 0 ? '+' : ''}${totalDelta.toFixed(1)}pp`);
  console.log('');
  console.log(`  Trajectory bins (% of W' at end of each 10% route bin):`);
  const fmt = (v) => v == null ? '  --' : String(v).padStart(5);
  console.log(`    bin:        ${Array.from({length: 10}, (_, i) => String((i + 1) * 10).padStart(5)).join('')}`);
  console.log(`    pred pre:   ${r.baseline.planBins.map(fmt).join('')}`);
  console.log(`    pred post:  ${r.post.trajectory.map(t => fmt(t.predPct)).join('')}`);
  console.log(`    act pre:    ${r.baseline.actBins.map(fmt).join('')}`);
  console.log(`    act post:   ${r.post.trajectory.map(t => fmt(t.actPct)).join('')}`);
  console.log('');
  console.log(`  PHENOTYPE OVERRIDE (W' = ${r.phenotypeOverride.wPrime}J):`);
  console.log(`    pred min ${r.phenotypeOverride.predMinPct}% / act min ${r.phenotypeOverride.actMinPct}%   gap ${r.phenotypeOverride.gapPp}pp`);
  console.log(`    bin:        ${Array.from({length: 10}, (_, i) => String((i + 1) * 10).padStart(5)).join('')}`);
  console.log(`    pred over:  ${r.phenotypeOverride.trajectory.map(t => fmt(t.predPct)).join('')}`);
  console.log(`    act over:   ${r.phenotypeOverride.trajectory.map(t => fmt(t.actPct)).join('')}`);
  if (r.perClimb.length > 0) {
    console.log('');
    console.log(`  Per-climb W'bal exit (% of W'):`);
    console.log(`    #  start  L     peak  cat       pred%  act%`);
    for (const c of r.perClimb) {
      console.log(`    ${c.climbId}  ${String(c.startDistKm).padStart(5)}km ${c.lengthKm}km ${String(c.peakGradePct).padStart(4)}% ${c.category.padEnd(9)} ${String(c.predWbalPct).padStart(6)}%  ${String(c.actWbalPct).padStart(5)}%`);
    }
  }
}

async function main() {
  const all = [];
  for (const race of RACES) {
    try {
      const r = await processRace(race);
      all.push(r);
      printRaceSummary(r);
    } catch (e) {
      console.error(`\n=== ${race.raceId} EXCEPTION ===`); console.error(e.message); console.error(e.stack);
      all.push({ raceId: race.raceId, exception: e.message });
    }
  }
  writeFileSync(
    join(import.meta.dirname, 'b29_validation.json'),
    JSON.stringify(all, null, 2),
  );
  console.log(`\nWrote ${all.length} results to scripts/b29_validation.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
