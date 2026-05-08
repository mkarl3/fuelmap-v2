// Step 5 — Fade analysis: third-by-third predicted vs actual NP/IF/avg by
// route distance (Pattern A everywhere — locked decision).
//
// Mirrors App.jsx's fade-analysis card (lines ~3525–3590):
//   • Route-distance buckets via alignment[i].gpxDistM (PLAN side: powerStreamPerSec[i].distM).
//   • PLAN-side per-third NP via npOfStream(powerStream 1-min blocks, blockMins=1).
//   • ACTUAL per-third NP via npOfStream(movingPowerSeries 1-sec, blockMins=1/60).
//
// (Note: npOfStream is a local rolling-window NP — not the canonical computeNP
//  in the physics module. For 1-sec it uses a 30-sec rolling window; for 1-min
//  blocks the window degenerates to 1. We replicate that exactly so numbers
//  match what the FuelMAP UI shows. The methodology divergence is a Step 8
//  finding.)

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseGpxFile } from './parseGpxNode.js';
import { parseFIT } from '../src/parsers/fitParser.js';
import {
  bikePhysics, blendedCrr, rhoFromTemp,
  flatIFForTargetNP, buildPowerStream, deriveWPrime,
  alignFitToGpx,
  computeNP,
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

// Replica of App.jsx npOfStream — local rolling-window NP. NOT the canonical
// computeNP. For 1-sec data uses 30-sec rolling window; for 1-min uses ~1.
function npOfStream(stream, blockMins) {
  if (!stream || stream.length === 0) return 0;
  const window = Math.max(1, Math.ceil(0.5 / blockMins));
  const powers = stream.map(b => b.power);
  const rolling = powers.map((_, i, a) => {
    const w = a.slice(Math.max(0, i - window + 1), i + 1);
    return w.reduce((s, p) => s + p, 0) / w.length;
  });
  return Math.round(Math.pow(rolling.reduce((s, p) => s + p ** 4, 0) / rolling.length, 0.25));
}

async function processRace(race) {
  const athlete = ATHLETES[race.athleteId];
  const bike = BIKES[race.bikeId];
  const tireId = TIRE_TYPE_MAP[bike.tireType];
  const ftp = athlete.ftp;

  const gpxStats = parseGpxFile(join(RACES_DIR, race.gpx));
  const totalRouteM = gpxStats.totalDistKm * 1000;
  const t1End = totalRouteM / 3;
  const t2End = totalRouteM * 2 / 3;

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

  // PLAN-side route-distance thirds via powerStream (1-min blocks, distKm field).
  const planStream = planResult.powerStream;
  const t1Km = gpxStats.totalDistKm / 3;
  const t2Km = gpxStats.totalDistKm * 2 / 3;
  const planThirds = [
    planStream.filter(pt => pt.distKm < t1Km),
    planStream.filter(pt => pt.distKm >= t1Km && pt.distKm < t2Km),
    planStream.filter(pt => pt.distKm >= t2Km),
  ];
  const planNPs = planThirds.map(t => npOfStream(t, 1));
  const planIFs = planNPs.map(np => Math.round(np / ftp * 100) / 100);

  // PLAN-side avg power per third (zeros included → Convention C; matches what
  // the user sees in plan-summary panels)
  const planAvgs = planThirds.map(t => t.length ? Math.round(t.reduce((s,p)=>s+p.power,0)/t.length) : 0);

  // PLAN-side per-third stats also via canonical computeNP for cross-check
  // (filters powerStreamPerSec by distM, matching apples-to-apples with actual)
  const perSec = planResult.powerStreamPerSec;
  const planThirdsPerSec = [
    perSec.filter(p => p.distM < t1End),
    perSec.filter(p => p.distM >= t1End && p.distM < t2End),
    perSec.filter(p => p.distM >= t2End),
  ];
  const planNPsCanonical = planThirdsPerSec.map(t => computeNP(t.map(p => p.power)));

  // ── ACTUAL side ─────────────────────────────────────────────────────────────
  const buf = readFileSync(join(RACES_DIR, race.fit));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const parsed = await parseFIT(ab);

  const alignment = alignFitToGpx(parsed.movingGPSPath, gpxStats._gpxPts);
  const onRouteCount = alignment.filter(a => a.onRoute).length;

  // Bucket FIT seconds by route-distance third (mirrors thirdsByRouteDistance
  // useMemo in App.jsx). Off-route seconds excluded.
  const actualThirds = [[], [], []];
  for (let i = 0; i < alignment.length; i++) {
    const a = alignment[i];
    if (!a.onRoute || a.gpxDistM == null) continue;
    const idx = a.gpxDistM < t1End ? 0 : a.gpxDistM < t2End ? 1 : 2;
    actualThirds[idx].push({ power: parsed.movingPowerSeries[i] });
  }
  const actualNPs = actualThirds.map(t => npOfStream(t, 1/60));    // App's local rolling-NP
  const actualIFs = actualNPs.map(np => Math.round(np / ftp * 100) / 100);
  const actualAvgs = actualThirds.map(t => {
    if (t.length === 0) return 0;
    return Math.round(t.reduce((s,p)=>s+p.power,0)/t.length);
  });
  // Cross-check actual NP via canonical computeNP
  const actualNPsCanonical = actualThirds.map(t => computeNP(t.map(p => p.power)));

  // ── Deltas ──────────────────────────────────────────────────────────────────
  const npDeltas = actualNPs.map((np,i) => np - planNPs[i]);
  const ifDeltas = actualIFs.map((iff,i) => Math.round((iff - planIFs[i]) * 1000) / 1000);
  const avgDeltas = actualAvgs.map((a,i) => a - planAvgs[i]);
  const npPctDeltas = actualNPs.map((np,i) =>
    planNPs[i] > 0 ? Math.round((np - planNPs[i]) / planNPs[i] * 100 * 10) / 10 : 0);

  console.log(`\n=== ${race.raceId} ===`);
  console.log(`  GPX ${gpxStats.totalDistKm}km  thirds at km ${t1Km.toFixed(1)} / ${t2Km.toFixed(1)}`);
  console.log(`  alignment: ${onRouteCount}/${alignment.length} on-route (${Math.round(onRouteCount/alignment.length*100)}%)`);
  console.log(`  Third  | secs   | plan NP / actual NP / Δ / Δ%  | plan IF / act IF / Δ | plan avg / act avg / Δ`);
  for (let i = 0; i < 3; i++) {
    console.log(
      `  ${i+1}      | ${String(actualThirds[i].length).padStart(6)} | `
      + `${String(planNPs[i]).padStart(3)} / ${String(actualNPs[i]).padStart(3)} / ${(npDeltas[i]>=0?'+':'')+npDeltas[i]} / ${(npPctDeltas[i]>=0?'+':'')+npPctDeltas[i]}%   `
      + `| ${planIFs[i].toFixed(2)} / ${actualIFs[i].toFixed(2)} / ${(ifDeltas[i]>=0?'+':'')+ifDeltas[i].toFixed(3)}`
      + ` | ${String(planAvgs[i]).padStart(3)} / ${String(actualAvgs[i]).padStart(3)} / ${(avgDeltas[i]>=0?'+':'')+avgDeltas[i]}`
    );
  }
  // Canonical-NP cross-check (per-second-based)
  console.log(`  (canonical NP cross-check) plan ${planNPsCanonical.map(n=>String(n)).join(' / ')} | actual ${actualNPsCanonical.map(n=>String(n)).join(' / ')}`);

  // Directional pattern
  const directions = [];
  for (let i = 1; i < 3; i++) {
    const d = actualNPs[i] - actualNPs[i-1];
    directions.push(d > 5 ? '↑' : d < -5 ? '↓' : '=');
  }
  console.log(`  Actual fade pattern: third1=${actualNPs[0]} ${directions[0]} third2=${actualNPs[1]} ${directions[1]} third3=${actualNPs[2]}`);

  return {
    raceId: race.raceId,
    totalRouteKm: gpxStats.totalDistKm,
    onRouteFrac: onRouteCount / alignment.length,
    thirds: [0,1,2].map(i => ({
      idx: i+1,
      secs: actualThirds[i].length,
      plan:    { np: planNPs[i], if: planIFs[i], avg: planAvgs[i], canonicalNP: planNPsCanonical[i] },
      actual:  { np: actualNPs[i], if: actualIFs[i], avg: actualAvgs[i], canonicalNP: actualNPsCanonical[i] },
      delta:   { np: npDeltas[i], if: ifDeltas[i], avg: avgDeltas[i], npPct: npPctDeltas[i] },
    })),
  };
}

const all = [];
for (const race of RACES) {
  try { all.push(await processRace(race)); }
  catch (e) {
    console.error(`\n=== ${race.raceId} EXCEPTION ===`); console.error(e.message);
    all.push({ raceId: race.raceId, exception: e.message });
  }
}

writeFileSync(
  join(import.meta.dirname, 'step5_results.json'),
  JSON.stringify(all, null, 2),
);
console.log(`\nWrote ${all.length} results to step5_results.json`);
