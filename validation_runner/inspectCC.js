// Diagnostic: inspect CC ride's power profile to see if W'bal divergence is
// driven by real surges or by artifacts (PM dropouts, calibration issues, spikes).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFIT } from '../src/parsers/fitParser.js';
import { simulateWbal } from '../src/physics/helpers/simulateWbal.js';

const RACES_DIR = 'C:\\Users\\mkarl\\OneDrive\\Documents\\FuelMAP Doc\\FuelMAP_Validation_Package\\Races';

async function inspect(label, fitFile, cp, wPrime) {
  const buf = readFileSync(join(RACES_DIR, fitFile));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const parsed = await parseFIT(ab);
  const ps = parsed.movingPowerSeries;

  console.log(`\n=== ${label} ===  FTP/CP=${cp}  W'=${wPrime}`);
  console.log(`  records: ${parsed.totalRecords}  movingSec: ${ps.length}  movingMin: ${parsed.movingMin}`);

  // Distribution stats
  const sorted = [...ps].sort((a,b)=>a-b);
  const pctile = (p) => sorted[Math.floor(sorted.length * p)];
  const max = Math.max(...ps);
  const zero = ps.filter(p => p === 0).length;
  const aboveCp = ps.filter(p => p > cp).length;
  const farAbove = ps.filter(p => p > cp * 1.5).length;
  const veryFarAbove = ps.filter(p => p > cp * 2).length;

  console.log(`  Distribution:`);
  console.log(`    min=${sorted[0]}  p50=${pctile(0.50)}  p75=${pctile(0.75)}  p90=${pctile(0.90)}  p95=${pctile(0.95)}  p99=${pctile(0.99)}  max=${max}`);
  console.log(`    zeros: ${zero} (${(zero/ps.length*100).toFixed(1)}%)`);
  console.log(`    > CP (${cp}W): ${aboveCp} sec (${(aboveCp/ps.length*100).toFixed(1)}%)`);
  console.log(`    > 1.5×CP (${cp*1.5}W): ${farAbove} sec`);
  console.log(`    > 2×CP (${cp*2}W): ${veryFarAbove} sec`);

  // Mean of "above CP" excursions (energy contribution)
  const aboveCpPowers = ps.filter(p => p > cp);
  const aboveCpMean = aboveCpPowers.length > 0
    ? Math.round(aboveCpPowers.reduce((s,p)=>s+p,0) / aboveCpPowers.length) : 0;
  const totalJoulesAboveCp = aboveCpPowers.reduce((s,p)=>s+(p-cp),0);
  console.log(`    avg power when > CP: ${aboveCpMean}W   total joules above CP: ${totalJoulesAboveCp}J`);
  console.log(`    (W' = ${wPrime}J — total J-above-CP / W' = ${(totalJoulesAboveCp/wPrime).toFixed(2)}× of reservoir capacity)`);

  // Find the top-10 single-second spikes
  const idxs = ps.map((p, i) => ({i, p})).sort((a, b) => b.p - a.p).slice(0, 10);
  console.log(`  Top 10 single-second spikes:`);
  for (const e of idxs) {
    const sec = e.i;
    const minute = Math.floor(sec / 60);
    const window = ps.slice(Math.max(0, sec - 5), Math.min(ps.length, sec + 6));
    console.log(`    sec ${String(sec).padStart(5)} (min ${String(minute).padStart(3)}): ${e.p}W  context [${window.join(',')}]`);
  }

  // 30-sec rolling avg max
  let max30 = 0;
  for (let i = 29; i < ps.length; i++) {
    let s = 0; for (let j = i-29; j <= i; j++) s += ps[j];
    const avg = s/30; if (avg > max30) max30 = avg;
  }
  // 60-sec, 5-min, 20-min rolling avg max
  const peakRoll = (n) => {
    let best = 0;
    for (let i = n-1; i < ps.length; i++) {
      let s = 0; for (let j = i-n+1; j <= i; j++) s += ps[j];
      const avg = s/n; if (avg > best) best = avg;
    }
    return Math.round(best);
  };
  console.log(`  Peak rolling avg:  30s=${Math.round(max30)}W  60s=${peakRoll(60)}W  5min=${peakRoll(300)}W  20min=${peakRoll(1200)}W`);

  // Run simulateWbal step-by-step, find when W'bal first hits 50%, 25%, 0% of W'
  const wbalSeries = simulateWbal(ps, 1, cp, wPrime);
  let half = -1, quarter = -1, zeroBal = -1;
  for (let i = 0; i < wbalSeries.length; i++) {
    if (half === -1 && wbalSeries[i] / wPrime <= 0.5) half = i;
    if (quarter === -1 && wbalSeries[i] / wPrime <= 0.25) quarter = i;
    if (zeroBal === -1 && wbalSeries[i] === 0) zeroBal = i;
  }
  const fmtSec = (s) => s < 0 ? '—' : `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
  console.log(`  W'bal trajectory: hits 50% at ${fmtSec(half)}, 25% at ${fmtSec(quarter)}, 0% at ${fmtSec(zeroBal)}`);

  // Time the largest single-second drops in W'bal
  const drops = [];
  for (let i = 1; i < wbalSeries.length; i++) {
    drops.push({ sec: i, dropJ: Math.max(0, wbalSeries[i-1] - wbalSeries[i]), power: ps[i] });
  }
  drops.sort((a,b) => b.dropJ - a.dropJ);
  console.log(`  Top 10 single-second W'bal drops:`);
  for (const d of drops.slice(0, 10)) {
    const minute = Math.floor(d.sec / 60);
    console.log(`    sec ${String(d.sec).padStart(5)} (min ${String(minute).padStart(3)}): drop ${d.dropJ}J  power ${d.power}W (${d.power-cp}W over CP)`);
  }
}

await inspect('TDL MK_25', '001 TDL MK Ride.fit', 215, 16125);
await inspect('CCRIDE_MK_26', '002 CC MK Ride.fit', 200, 15000);
await inspect('PPRIDE_MK_26', '003 PP MK Ride.fit', 200, 15000);
