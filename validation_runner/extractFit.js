// Step 3 — Extract actuals from each FIT file via the canonical parser.
// Reproduces what AnalyzeTab would compute on FIT load. Adds a Convention B
// avg power side-channel so we can compare against the spreadsheet's
// "from Device" column (which is Garmin's session.total_avg_power, normally
// zeros-excluded).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import FitParser from 'fit-file-parser';

import { parseFIT } from '../src/parsers/fitParser.js';
import { computeNP } from '../src/physics/index.js';

const RACES_DIR = 'C:\\Users\\mkarl\\OneDrive\\Documents\\FuelMAP Doc\\FuelMAP_Validation_Package\\Races';

const RACES = [
  { raceId: 'TDL MK_25',     fitFile: '001 TDL MK Ride.fit',
    device: { movingMin: 193, elapsedMin: 230, stoppedMin: 37, np: 183, kj: 1849, avgHR: 167, avgPower: 160 } },
  { raceId: 'CCRIDE_MK_26',  fitFile: '002 CC MK Ride.fit',
    device: { movingMin: 128, elapsedMin: 144, stoppedMin: 16, np: 161, kj: 1097, avgHR: 154, avgPower: 143 } },
  { raceId: 'PPRIDE_MK_26',  fitFile: '003 PP MK Ride.fit',
    device: { movingMin: 124, elapsedMin: 139, stoppedMin: 15, np: 165, kj: 1117, avgHR: 168, avgPower: 150 } },
];

// Use fit-file-parser directly to also pull session.total_avg_power & total_work
// (Garmin's stored values — what shows up in the device "from Device" cells).
function parseRawSession(buffer) {
  return new Promise((resolve) => {
    const fp = new FitParser({
      force: true, speedUnit: 'm/s', lengthUnit: 'm',
      temperatureUnit: 'celsius', elapsedRecordField: true, mode: 'list',
    });
    fp.parse(buffer, (err, data) => err ? resolve(null) : resolve(data));
  });
}

async function processRace(race) {
  const buf = readFileSync(join(RACES_DIR, race.fitFile));
  const ab  = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  const parsed = await parseFIT(ab);
  if (!parsed) return { raceId: race.raceId, error: 'parseFIT returned null' };

  // Garmin session record (Device-stored values)
  const raw = await parseRawSession(ab);
  const session = raw?.sessions?.[0] || raw?.session?.[0] || raw?.session || null;
  const sessionAvgPower = session?.total_avg_power ?? session?.avg_power ?? null;
  const sessionNP       = session?.normalized_power ?? null;
  const sessionWork     = session?.total_work ?? null; // joules
  const sessionAvgHR    = session?.avg_heart_rate ?? null;
  const sessionMaxHR    = session?.max_heart_rate ?? null;
  const sessionTotalTimerSec = session?.total_timer_time ?? null;
  const sessionTotalElapsedSec = session?.total_elapsed_time ?? null;

  // Convention C avg (parseFIT's rawAvgPower — zeros included, moving timeline)
  const npFuelMap = parsed.rawNP;
  const avgC      = parsed.rawAvgPower;

  // Convention B avg (zeros excluded, moving timeline) — for spreadsheet parity
  const nonZero = parsed.movingPowerSeries.filter(p => p > 0);
  const avgB = nonZero.length > 0
    ? Math.round(nonZero.reduce((s, p) => s + p, 0) / nonZero.length)
    : 0;

  // Sanity-check NP via canonical computeNP on movingPowerSeries (must equal parsed.rawNP)
  const npCanonical = computeNP(parsed.movingPowerSeries);

  // KJ from the moving timeline (Convention C; sum * 1 sec / 1000)
  const kjFromMoving = Math.round(
    parsed.movingPowerSeries.reduce((s, p) => s + p, 0) / 1000
  );
  // KJ from the active timeline (zeros excluded)
  const kjFromActive = Math.round(
    nonZero.reduce((s, p) => s + p, 0) / 1000
  );

  // Avg HR from movingHRSeries (filter zeros — HR=0 means dropout, not ride)
  const hrNonZero = parsed.movingHRSeries.filter(h => h > 0);
  const avgHRFuelMap = hrNonZero.length > 0
    ? Math.round(hrNonZero.reduce((s, h) => s + h, 0) / hrNonZero.length)
    : 0;

  return {
    raceId: race.raceId,
    fitFile: race.fitFile,
    parsed: {
      elapsedMin: parsed.elapsedMin,
      movingMin: parsed.movingMin,
      stoppedMin: parsed.stoppedMin,
      totalRecords: parsed.totalRecords,
      rawNP_fitparser: parsed.rawNP,
      rawAvgPower_fitparser: parsed.rawAvgPower,
    },
    fuelmap: {
      np: npFuelMap,
      npCanonical,                    // sanity check: should match np
      avgConventionC: avgC,           // zeros included (locked Convention C)
      avgConventionB: avgB,           // zeros excluded (Garmin convention)
      kjFromMoving,                   // Convention C kJ
      kjFromActive,                   // Convention B kJ
      avgHR: avgHRFuelMap,
      movingMin: parsed.movingMin,
      elapsedMin: parsed.elapsedMin,
      stoppedMin: parsed.stoppedMin,
    },
    session: {
      avgPower: sessionAvgPower,
      np: sessionNP,
      kj: sessionWork != null ? Math.round(sessionWork / 1000) : null,
      avgHR: sessionAvgHR,
      maxHR: sessionMaxHR,
      totalTimerSec: sessionTotalTimerSec,
      totalElapsedSec: sessionTotalElapsedSec,
    },
    device: race.device,
  };
}

const results = [];
for (const race of RACES) {
  console.log(`\n=== ${race.raceId} ===`);
  try {
    const r = await processRace(race);
    if (r.error) {
      console.log('  ERROR:', r.error);
      results.push(r);
      continue;
    }
    const f = r.fuelmap;
    const s = r.session;
    const d = r.device;
    console.log(`  records: ${r.parsed.totalRecords}  movingMin: ${f.movingMin} (Device ${d.movingMin})  elapsed: ${f.elapsedMin} (Device ${d.elapsedMin})  stopped: ${f.stoppedMin} (Device ${d.stoppedMin})`);
    console.log(`  NP   FuelMAP: ${f.np}  Garmin session: ${s.np}  Device col: ${d.np}`);
    console.log(`  Avg  Conv C: ${f.avgConventionC}W  Conv B: ${f.avgConventionB}W  Garmin session: ${s.avgPower != null ? Math.round(s.avgPower) : 'n/a'}W  Device col: ${d.avgPower}W`);
    console.log(`  HR   FuelMAP avg: ${f.avgHR}bpm  Garmin session: ${s.avgHR}bpm  Device col: ${d.avgHR}bpm`);
    console.log(`  KJ   from moving: ${f.kjFromMoving}  from active: ${f.kjFromActive}  Garmin session: ${s.kj}  Device col: ${d.kj}`);
    console.log(`  NP canonical (sanity): ${f.npCanonical} (must match ${f.np})`);
    results.push(r);
  } catch (e) {
    console.error('  EXCEPTION:', e.message);
    console.error(e.stack);
    results.push({ raceId: race.raceId, exception: e.message });
  }
}

writeFileSync(
  join(import.meta.dirname, 'step3_results.json'),
  JSON.stringify(results, null, 2),
);
console.log(`\nWrote ${results.length} results to step3_results.json`);
