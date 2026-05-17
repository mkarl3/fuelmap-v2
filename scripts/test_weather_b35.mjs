// B-35 Slice B verification. Two parts:
//   1. circularWindStats — deterministic, offline. Asserts the circular math.
//   2. Live fetch — forecast (near date) + normal (historical aggregation)
//      against Open-Meteo for a known location. Network-dependent; prints the
//      structured output for eyeball review.
//
// Run from fuelmap-v2/:  node scripts/test_weather_b35.mjs

import { circularWindStats, weatherMode, fetchRaceWeather, fetchActualWeather, OPEN_METEO_ATTRIBUTION }
  from '../src/weather/openMeteo.js';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}
const near = (a, b, tol) => a != null && Math.abs(a - b) <= tol;

console.log('\n== circularWindStats (deterministic) ==');
{
  const a = circularWindStats([350, 10]);
  check('[350,10] prevailing ≈ 0°', near(a.prevailingDeg, 0, 2) || near(a.prevailingDeg, 360, 2), JSON.stringify(a));
  check('[350,10] confidence high (>0.95)', a.confidence > 0.95, JSON.stringify(a));

  const b = circularWindStats([0, 90, 180, 270]);
  check('[0,90,180,270] confidence ≈ 0 (variable)', b.confidence < 0.05, JSON.stringify(b));

  const c = circularWindStats([270, 280, 260, 275]);
  check('[270,280,260,275] prevailing ≈ 271°', near(c.prevailingDeg, 271, 3), JSON.stringify(c));
  check('[270,280,260,275] confidence high', c.confidence > 0.98, JSON.stringify(c));

  const e = circularWindStats([]);
  check('[] → nulls', e.prevailingDeg === null && e.confidence === null, JSON.stringify(e));

  // Naive average trap: mean(350,10)=180 (wrong); circular ≈ 0 (right).
  const trap = circularWindStats([350, 10]);
  check('circular avoids the 180° naive-average trap', !near(trap.prevailingDeg, 180, 10), JSON.stringify(trap));
}

console.log('\n== weatherMode ==');
{
  const now = new Date('2026-05-15T12:00:00');
  check("+5d → forecast", weatherMode('2026-05-20', now) === 'forecast');
  check(">16d → normal",  weatherMode('2026-06-30', now) === 'normal');
  check("past → normal",  weatherMode('2025-09-01', now) === 'normal');
  check("today → forecast", weatherMode('2026-05-15', now) === 'forecast');
}

console.log('\n== Attribution constant present ==');
check('has text + license + url',
  !!OPEN_METEO_ATTRIBUTION.text && OPEN_METEO_ATTRIBUTION.license === 'CC BY 4.0' && !!OPEN_METEO_ATTRIBUTION.url);

// Live fetch — Boulder, CO. Forecast date = 5 days out from real "now";
// normal date = a fixed past month/day (forces historical aggregation).
const LAT = 40.015, LON = -105.270;
const d = new Date(); d.setDate(d.getDate() + 5);
const forecastDate = d.toISOString().slice(0, 10);

console.log(`\n== Live forecast (${forecastDate}, start 08:00) ==`);
try {
  const f = await fetchRaceWeather({ lat: LAT, lon: LON, dateISO: forecastDate, startTime: '08:00' });
  console.log(JSON.stringify(f, null, 2));
  check('forecast source tagged', f.tempC.source === 'forecast' && f.windDirDeg.source === 'forecast');
  check('forecast wind confidence is null (single day)', f.windDirDeg.confidence === null);
  check('temp value finite', Number.isFinite(f.tempC.value));
  check('temp range present', f.tempC.range && Number.isFinite(f.tempC.range.low));
} catch (e) {
  console.log('  (network) forecast fetch threw:', e.message);
}

console.log('\n== Live normal (2024-08-10 historical aggregation, start 07:00) ==');
try {
  const n = await fetchRaceWeather({ lat: LAT, lon: LON, dateISO: '2024-08-10', startTime: '07:00' });
  console.log(JSON.stringify(n, null, 2));
  check('normal source tagged', n.tempC.source === 'normal');
  check('normal sampled ≥5 years', n.meta.sampleYears >= 5, `got ${n.meta.sampleYears}`);
  check('normal wind confidence in [0,1]', n.windDirDeg.confidence >= 0 && n.windDirDeg.confidence <= 1);
  check('precip probability 0–100', n.precipPct.value >= 0 && n.precipPct.value <= 100);
  check('temp range low < high', n.tempC.range.low < n.tempC.range.high);
} catch (e) {
  console.log('  (network) normal fetch threw:', e.message);
}

console.log('\n== Live actual (Slice D — realized day 2024-08-10, start 07:30) ==');
try {
  const a = await fetchActualWeather({ lat: LAT, lon: LON, dateISO: '2024-08-10', startTime: '07:30' });
  console.log(JSON.stringify(a, null, 2));
  check('actual source tagged', a.tempC.source === 'actual' && a.windDirDeg.source === 'actual');
  check('actual meta.mode === actual', a.meta.mode === 'actual');
  check('temp value finite', Number.isFinite(a.tempC.value));
  check('precip value is 0 or 100 (single realized day)', a.precipPct.value === 0 || a.precipPct.value === 100);
  check('wind confidence in [0,1]', a.windDirDeg.confidence >= 0 && a.windDirDeg.confidence <= 1);
} catch (e) {
  console.log('  (network) actual fetch threw:', e.message);
}

console.log(`\n== ${pass} passed, ${fail} failed ==`);
// Set exit code but let Node drain undici sockets and exit naturally —
// process.exit() here races libuv socket teardown on Windows (harmless
// post-run assertion, but noisy). No explicit exit call.
process.exitCode = fail > 0 ? 1 : 0;
