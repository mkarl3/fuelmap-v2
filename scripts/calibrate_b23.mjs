// B-23 surge factor calibration — read-only analysis.
//
// For each validation fixture (TDL, CC, PP):
//   1. Replicate the saved race configuration and run plan generation.
//   2. Run detectClimbs and capture per-climb predicted NP / avg / duration.
//   3. Parse the matching FIT file, align per-second to the GPX route,
//      and capture per-climb actual NP / avg / duration.
//   4. Compute the implied cap multiplier (act NP / FTP) per climb.
//   5. Score a proposed surge-factor formula against the data.
//
// Output:
//   • scripts/b23_calibration.json — per-climb table for the report.
//   • Markdown tables to stdout (paste-ready into the report).
//
// Reproducible from fuelmap-v2/ via:  node scripts/calibrate_b23.mjs
//
// Race configurations and athlete profiles are mirrored from
// validation_runner/runPlans.js so this script stands alone. If the runPlans
// inputs change in the future, mirror those changes here.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseGpxFile } from '../validation_runner/parseGpxNode.js';
import { parseFIT } from '../src/parsers/fitParser.js';
import {
  bikePhysics,
  blendedCrr,
  rhoFromTemp,
  flatIFForTargetNP,
  buildPowerStream,
  detectClimbs,
  alignFitToGpx,
  computeNP,
  deriveWPrime,
} from '../src/physics/index.js';

// ── Race / athlete / bike catalog (mirrors validation_runner/runPlans.js) ─────
const RACES_DIR = 'C:\\Users\\mkarl\\OneDrive\\Documents\\FuelMAP Doc\\FuelMAP_Validation_Package\\Races';

const ATHLETES = {
  MK_00: { id: 'MK_00', name: 'Mike K 2020', ftp: 215, weight: 170 * 0.453592,
           phenotype: 'allrounder', wPrime: 21700, maxHR: 190, maxCarbIntakeGPerHr: 90 },
  MK_01: { id: 'MK_01', name: 'Mike K 2026', ftp: 200, weight: 170 * 0.453592,
           phenotype: 'allrounder', wPrime: 15000, maxHR: 190, maxCarbIntakeGPerHr: 90 },
};

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

const WIND_DIR_DEG = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };

const RACES = [
  {
    raceId: 'TDL MK_25', athleteId: 'MK_00', bikeId: 'Emonda_21',
    gpxFile: '001 TDL MK Route.gpx', fitFile: '001 TDL MK Ride.fit',
    surfaceMix: [{ id: 'tarmac', pct: 0.85 }, { id: 'chip_seal', pct: 0.15 }],
    tempF: 77, windMph: 10, windEffPct: 25, windDir: 'W',
    targetIF: 0.86,
    capsW: { moderate: 231, steep: 253, wall: 286 },
  },
  {
    raceId: 'CCRIDE_MK_26', athleteId: 'MK_01', bikeId: 'Emonda_21',
    gpxFile: '002 CC MK Route.gpx', fitFile: '002 CC MK Ride.fit',
    surfaceMix: [{ id: 'tarmac', pct: 1.0 }],
    tempF: 45, windMph: 14, windEffPct: 15, windDir: 'W',
    targetIF: 0.76,
    capsW: { moderate: 210, steep: 230, wall: 260 },
  },
  {
    raceId: 'PPRIDE_MK_26', athleteId: 'MK_01', bikeId: 'Aspero_21',
    gpxFile: '003 PP MK Route.gpx', fitFile: '003 PP MK Ride.fit',
    surfaceMix: [{ id: 'tarmac', pct: 0.10 }, { id: 'gravel_1', pct: 0.90 }],
    tempF: 64, windMph: 20, windEffPct: 10, windDir: 'W',
    targetIF: 0.85,
    capsW: { moderate: 210, steep: 230, wall: 260 },
  },
];

// ── Outlier reasons (per Validation_Report.md F-7) ───────────────────────────
// The report flags TDL climb #2 as "rider over-pushing the cap" — behavioral,
// not structural. Excluded from formula fitting in Step 5; included in Step 6
// validation comparison.
const KNOWN_OUTLIERS = new Set([
  'TDL MK_25:2', // 0.5 km, 3.6%/3.6%, NP +42W over plan (+18%) — rider tactical surge
]);

// ── Proposed surge-factor formulas ───────────────────────────────────────────
// Multiplicative structure: surge = durationScore × gradeScore.
// Both scores are linear-clamped between [0,1]. Surge maps linearly to a cap
// multiplier between SURGE_CAP_MIN and SURGE_CAP_MAX. Below
// SURGE_FACTOR_THRESHOLD we fall back to the static gradeCategory cap to
// preserve current long-climb behavior.
//
// Multiple candidate constant sets are evaluated against the calibration
// data. The script reports MAE / max abs delta and a "constraining-only" MAE
// (under-prediction is bad — formula would forbid observed riding) so Step 5
// can pick a defensible set.
const FORMULA_STARTER = {
  name: 'starter',
  SURGE_DURATION_FLOOR_SEC: 60,
  SURGE_DURATION_CEIL_SEC: 300,
  SURGE_GRADE_FLOOR_PCT: 3.0,
  SURGE_GRADE_CEIL_PCT: 8.0,
  SURGE_CAP_MIN: 1.05,
  SURGE_CAP_MAX: 1.50,
  SURGE_FACTOR_THRESHOLD: 0.10,
};

// Tightened to better fit PP surges. Lower GRADE_CEIL so 6%+ saturates;
// raise CAP_MAX to land PP #2 (implied 1.53). Shorten DURATION_CEIL to 240s
// so the surge effect is concentrated on the genuinely short efforts.
const FORMULA_TIGHTENED = {
  name: 'tightened',
  SURGE_DURATION_FLOOR_SEC: 60,
  SURGE_DURATION_CEIL_SEC: 240,
  SURGE_GRADE_FLOOR_PCT: 3.0,
  SURGE_GRADE_CEIL_PCT: 6.0,
  SURGE_CAP_MIN: 1.05,
  SURGE_CAP_MAX: 1.55,
  SURGE_FACTOR_THRESHOLD: 0.10,
};

// Sharper grade transition. TDL short climbs cluster at 3.9–4.5% peak with
// implied ~base cap (rider didn't surge); PP climbs at 5.1–6.1% peak surged
// hard. Lifting GRADE_FLOOR to 4% concentrates the surge effect on the
// genuinely steep short efforts. FLOOR_AT_BASE_CAP=true is required so the
// formula never drops below the existing static cap (a wall-category climb
// with low surge could otherwise compute a formula cap below 1.30).
const FORMULA_SHARP = {
  name: 'sharp',
  SURGE_DURATION_FLOOR_SEC: 60,
  SURGE_DURATION_CEIL_SEC: 240,
  SURGE_GRADE_FLOOR_PCT: 4.0,
  SURGE_GRADE_CEIL_PCT: 6.0,
  SURGE_CAP_MIN: 1.05,
  SURGE_CAP_MAX: 1.55,
  SURGE_FACTOR_THRESHOLD: 0.10,
  FLOOR_AT_BASE_CAP: true,
};

const FORMULA_CANDIDATES = [FORMULA_STARTER, FORMULA_TIGHTENED, FORMULA_SHARP];

// Default formula reported in the persisted JSON
const FORMULA = FORMULA_SHARP;

function durationScore(sec, F) {
  if (sec <= F.SURGE_DURATION_FLOOR_SEC) return 1.0;
  if (sec >= F.SURGE_DURATION_CEIL_SEC) return 0.0;
  return 1.0 - (sec - F.SURGE_DURATION_FLOOR_SEC)
             / (F.SURGE_DURATION_CEIL_SEC - F.SURGE_DURATION_FLOOR_SEC);
}

function gradeScore(pct, F) {
  if (pct <= F.SURGE_GRADE_FLOOR_PCT) return 0.0;
  if (pct >= F.SURGE_GRADE_CEIL_PCT) return 1.0;
  return (pct - F.SURGE_GRADE_FLOOR_PCT)
       / (F.SURGE_GRADE_CEIL_PCT - F.SURGE_GRADE_FLOOR_PCT);
}

function formulaCapMult(durationSec, peakGradePct, baseCapMult, F = FORMULA) {
  const surge = durationScore(durationSec, F) * gradeScore(peakGradePct, F);
  let cap;
  if (surge < F.SURGE_FACTOR_THRESHOLD) cap = baseCapMult;
  else cap = F.SURGE_CAP_MIN + surge * (F.SURGE_CAP_MAX - F.SURGE_CAP_MIN);
  if (F.FLOOR_AT_BASE_CAP && cap < baseCapMult) cap = baseCapMult;
  return cap;
}

// ── Per-climb stats helpers ──────────────────────────────────────────────────
function predictedClimbStats(perSec, climb) {
  const startM = climb.startDistKm * 1000;
  const endM = startM + climb.lengthKm * 1000;
  const powers = [];
  for (const p of perSec) {
    if (p.distM >= startM && p.distM <= endM) powers.push(p.power);
  }
  if (powers.length === 0) return { secondsInClimb: 0, np: null, avgP: null };
  const np = Math.round(computeNP(powers));
  const avgP = Math.round(powers.reduce((s, p) => s + p, 0) / powers.length);
  return { secondsInClimb: powers.length, np, avgP };
}

function actualClimbStats(climb, movingPowerSeries, alignment) {
  if (!alignment || alignment.length !== movingPowerSeries.length) {
    return { secondsInClimb: 0, np: null, avgP: null };
  }
  const startM = climb.startDistKm * 1000;
  const endM = startM + climb.lengthKm * 1000;
  const powers = [];
  for (let i = 0; i < movingPowerSeries.length; i++) {
    const a = alignment[i];
    if (!a || !a.onRoute || a.gpxDistM == null) continue;
    if (a.gpxDistM >= startM && a.gpxDistM <= endM) powers.push(movingPowerSeries[i]);
  }
  if (powers.length === 0) return { secondsInClimb: 0, np: null, avgP: null };
  // computeNP needs ≥30 sec of data for the rolling window to be meaningful;
  // it uses partial-window math under that. Flag short slices for the report.
  const np = Math.round(computeNP(powers));
  const avgP = Math.round(powers.reduce((s, p) => s + p, 0) / powers.length);
  return { secondsInClimb: powers.length, np, avgP };
}

const round3 = (n) => Math.round(n * 1000) / 1000;
const round2 = (n) => Math.round(n * 100) / 100;

// ── Main pass ────────────────────────────────────────────────────────────────
async function loadParsedFit(filePath) {
  const buf = readFileSync(filePath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return await parseFIT(ab);
}

async function processFixture(race) {
  const athlete = ATHLETES[race.athleteId];
  const bike = BIKES[race.bikeId];
  const tireId = TIRE_TYPE_MAP[bike.tireType];

  const gpxStats = parseGpxFile(join(RACES_DIR, race.gpxFile));
  if (!gpxStats) throw new Error(`Failed to parse ${race.gpxFile}`);

  const bp = bikePhysics({ positionId: bike.positionId, drivetrainId: bike.drivetrainId, tireId });
  const Crr = blendedCrr(race.surfaceMix, bp.tireMult);
  const tempC = (race.tempF - 32) * 5 / 9;
  const rho = rhoFromTemp(tempC);
  const windSpeedMs = race.windMph * 0.44704;
  const effWindMs = windSpeedMs * (race.windEffPct / 100);
  const windDirDeg = WIND_DIR_DEG[race.windDir];
  const climbCategories = {
    moderate: { min: 0, max: race.capsW.moderate },
    steep:    { min: 0, max: race.capsW.steep },
    wall:     { min: 0, max: race.capsW.wall },
  };

  const wPrime = deriveWPrime(athlete);
  const athleteForPhysics = { ...athlete, wPrime };

  const flatIF = flatIFForTargetNP(
    race.targetIF, gpxStats, athleteForPhysics,
    Crr, Infinity, bp.CdA, bp.eta, bike.weight, rho,
    effWindMs, windDirDeg, climbCategories,
  );
  if (flatIF && typeof flatIF === 'object' && flatIF.ok === false) {
    throw new Error(`flatIFForTargetNP returned error on ${race.raceId}: ${JSON.stringify(flatIF)}`);
  }

  const plan = buildPowerStream(
    gpxStats, athleteForPhysics,
    { mode: 'constant_if', targetIF: flatIF },
    Crr, Infinity, bp.CdA, bp.eta, bike.weight, rho,
    effWindMs, windDirDeg, climbCategories,
  );
  if (plan && plan.ok === false) {
    throw new Error(`buildPowerStream returned error on ${race.raceId}: ${JSON.stringify(plan)}`);
  }

  const climbs = detectClimbs(gpxStats);

  let parsedFit = null, alignment = null;
  if (climbs.length > 0) {
    parsedFit = await loadParsedFit(join(RACES_DIR, race.fitFile));
    alignment = alignFitToGpx(parsedFit.movingGPSPath, gpxStats._gpxPts);
  }

  const rows = climbs.map(c => {
    const pred = predictedClimbStats(plan.powerStreamPerSec, c);
    const act = parsedFit
      ? actualClimbStats(c, parsedFit.movingPowerSeries, alignment)
      : { secondsInClimb: 0, np: null, avgP: null };
    const baseCapMult = race.capsW[c.category] / athlete.ftp;
    const impliedCapMult = act.np != null ? act.np / athlete.ftp : null;
    const key = `${race.raceId}:${c.id}`;
    const outlier = KNOWN_OUTLIERS.has(key) ? 'rider_over_pushing' : null;

    // Formula prediction at the proposed constants. We use ACTUAL duration
    // for the formula score to validate against actuals; in production the
    // formula would consume PREDICTED duration (which is unknown until plan
    // generation runs). They're typically close on short climbs.
    const formulaCap = act.np != null
      ? round3(formulaCapMult(act.secondsInClimb, c.peakGradePct, baseCapMult))
      : null;
    const delta = (formulaCap != null && impliedCapMult != null)
      ? round3(formulaCap - impliedCapMult)
      : null;

    return {
      fixture:     race.raceId,
      climbId:     c.id,
      ftp:         athlete.ftp,
      startDistKm: c.startDistKm,
      lengthKm:    c.lengthKm,
      avgGradePct: c.avgGrade,
      peakGradePct: c.peakGradePct,
      category:    c.category,
      currentCapW: race.capsW[c.category],
      baseCapMult: round3(baseCapMult),
      predicted:   pred,
      actual:      act,
      impliedCapMult: impliedCapMult != null ? round3(impliedCapMult) : null,
      formulaCapMult: formulaCap,
      delta,
      outlier,
    };
  });

  return { raceId: race.raceId, route: { totalDistKm: gpxStats.totalDistKm, elevGainM: gpxStats.elevGainM, climbCount: climbs.length }, rows };
}

function printMarkdownTable(allRows) {
  const head = '| Fixture | # | Length km | Avg/Peak % | Cat | Pred dur | Act dur | Pred NP | Act NP | Implied | Current | Formula | Δ | Outlier |';
  const sep  = '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';
  console.log(head);
  console.log(sep);
  for (const r of allRows) {
    const predDur = r.predicted.secondsInClimb ? `${r.predicted.secondsInClimb}s` : '—';
    const actDur  = r.actual.secondsInClimb    ? `${r.actual.secondsInClimb}s`    : '—';
    const predNP  = r.predicted.np ?? '—';
    const actNP   = r.actual.np ?? '—';
    const implied = r.impliedCapMult ?? '—';
    const formula = r.formulaCapMult ?? '—';
    const delta   = r.delta ?? '—';
    const out     = r.outlier ? `**${r.outlier}**` : '';
    console.log(`| ${r.fixture} | ${r.climbId} | ${r.lengthKm} | ${r.avgGradePct}/${r.peakGradePct} | ${r.category} | ${predDur} | ${actDur} | ${predNP}W | ${actNP}W | ${implied} | ${r.baseCapMult} | ${formula} | ${delta} | ${out} |`);
  }
}

function summarizeFit(allRows) {
  const fitable = allRows.filter(r => r.actual.np != null && !r.outlier);
  if (fitable.length === 0) return { count: 0 };
  const errs = fitable.map(r => Math.abs(r.delta));
  const mae = errs.reduce((s, e) => s + e, 0) / errs.length;
  const max = Math.max(...errs);
  // Constraining errors: formula < implied (cap forbids observed riding)
  const constraining = fitable.filter(r => r.delta < 0).map(r => -r.delta);
  const constrainingMae = constraining.length > 0
    ? constraining.reduce((s, e) => s + e, 0) / constraining.length : 0;
  const constrainingMax = constraining.length > 0 ? Math.max(...constraining) : 0;
  return {
    count: fitable.length,
    MAE: round3(mae),
    maxAbs: round3(max),
    constrainingCount: constraining.length,
    constrainingMAE: round3(constrainingMae),
    constrainingMax: round3(constrainingMax),
  };
}

function evaluateFormula(F, allRows) {
  const evaluated = allRows.map(r => {
    if (r.actual.np == null) return r;
    const formulaCap = round3(formulaCapMult(r.actual.secondsInClimb, r.peakGradePct, r.baseCapMult, F));
    const delta = r.impliedCapMult != null ? round3(formulaCap - r.impliedCapMult) : null;
    return { ...r, formulaCapMult: formulaCap, delta };
  });
  return { formulaName: F.name, summary: summarizeFit(evaluated), rows: evaluated };
}

async function main() {
  const allRows = [];
  const fixtures = [];
  for (const race of RACES) {
    console.log(`\n=== ${race.raceId} ===`);
    try {
      const r = await processFixture(race);
      fixtures.push(r);
      console.log(`  route: ${r.route.totalDistKm} km, +${r.route.elevGainM}m, ${r.route.climbCount} climbs`);
      allRows.push(...r.rows);
    } catch (e) {
      console.error('  EXCEPTION:', e.message);
      console.error(e.stack);
    }
  }

  console.log('\n--- Calibration table (default formula = tightened) ---\n');
  printMarkdownTable(allRows);

  console.log('\n--- Formula candidate fits (excluding outliers, actual-NP rows) ---');
  const candidateResults = FORMULA_CANDIDATES.map(F => evaluateFormula(F, allRows));
  for (const c of candidateResults) {
    console.log(`  ${c.formulaName.padEnd(22)} → ${JSON.stringify(c.summary)}`);
  }

  console.log('\n--- Per-row deltas across candidates ---');
  console.log(['Fixture', '#', 'Implied', ...FORMULA_CANDIDATES.map(f => f.name)].join(' | '));
  for (let i = 0; i < allRows.length; i++) {
    const r0 = allRows[i];
    if (r0.actual.np == null) continue;
    const cells = [
      r0.fixture, r0.climbId, r0.impliedCapMult,
      ...candidateResults.map(c => `${c.rows[i].formulaCapMult} (Δ${c.rows[i].delta >= 0 ? '+' : ''}${c.rows[i].delta})`),
    ];
    console.log(cells.join(' | ') + (r0.outlier ? ' OUTLIER' : ''));
  }

  console.log('\n--- Sorted by ACT duration (asc) [non-outlier rows with act NP] ---');
  const dur = allRows.filter(r => r.actual.np != null && !r.outlier)
                     .sort((a, b) => a.actual.secondsInClimb - b.actual.secondsInClimb);
  for (const r of dur) console.log(`  ${r.actual.secondsInClimb}s | peak ${r.peakGradePct}% | implied ${r.impliedCapMult} | ${r.fixture} #${r.climbId}`);

  console.log('\n--- Sorted by PEAK grade (asc) [non-outlier rows with act NP] ---');
  const grade = allRows.filter(r => r.actual.np != null && !r.outlier)
                       .sort((a, b) => a.peakGradePct - b.peakGradePct);
  for (const r of grade) console.log(`  peak ${r.peakGradePct}% | ${r.actual.secondsInClimb}s | implied ${r.impliedCapMult} | ${r.fixture} #${r.climbId}`);

  // Persist
  const out = {
    formula: FORMULA,
    candidates: candidateResults.map(c => ({ name: c.formulaName, summary: c.summary })),
    summary: summarizeFit(allRows),
    fixtures,
    rows: allRows,
  };
  writeFileSync(join(import.meta.dirname, 'b23_calibration.json'), JSON.stringify(out, null, 2));
  console.log(`\nWrote ${allRows.length} rows to scripts/b23_calibration.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
