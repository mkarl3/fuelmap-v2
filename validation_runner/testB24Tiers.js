// B-24 spot-check: 5-state W' tier walk via deriveWPrime.
// Mirrors the manual UI test in the prompt — at the math layer.
//
// State 1: Fresh athlete (FTP 250, allrounder, no override, no CP tests) → Tier 2 (phenotype × FTP = 18750)
// State 2: Add CP test data deriving ~22 kJ                                → Tier 1 (CP fit ≈ 22000)
// State 3: Set override to 15000 (CP tests still present)                  → Tier 0 (override = 15000)
// State 4: Clear override (CP tests still present)                         → Tier 1 (CP fit, restored)
// State 5: Remove CP tests, no override                                    → Tier 2 (phenotype × FTP, restored)

import { deriveWPrime } from '../src/physics/index.js';

const athleteBase = {
  id: 99, name: 'Test', ftp: 250, weight: 75, phenotype: 'allrounder',
};

const cpTestsTier1 = [
  { secs: 180, watts: 350 },   // 3-min effort
  { secs: 720, watts: 280 },   // 12-min effort
];
// Hand-computed fit: P = CP + W'/t
//   350 = CP + W'/180  → 350 = CP + W'/180
//   280 = CP + W'/720  → 280 = CP + W'/720
//   subtract: 70 = W'×(1/180 - 1/720) = W' × (4-1)/720 = W' × 3/720 = W'/240
//   W' = 70 × 240 = 16800 J  (so closer to 17 kJ than 22; whatever, fit returns this)
//   CP = 350 − 16800/180 = 350 − 93.33 = 256.67

function check(label, expectTier, expectMin, expectMax, athlete) {
  const wp = deriveWPrime(athlete);
  const wpJ = (wp && typeof wp === 'object') ? null : wp;
  const ok = wpJ != null && wpJ >= expectMin && wpJ <= expectMax;
  const status = ok ? 'OK' : 'FAIL';
  console.log(`  [${status}] ${label}: wPrime=${wpJ}J (expected ${expectTier}, range ${expectMin}–${expectMax})`);
  return ok;
}

console.log('=== B-24 5-state W\' tier walk ===');

// Saved athlete starts fresh: no override (wPrime: undefined), no CP tests.
let a = { ...athleteBase };
check('State 1 (no override, no CP)', 'Tier 2 (250×75=18750)', 18750, 18750, a);

// Add CP test data → Tier 1 fires (deriveWPrime walks Tier 1 because Tier 0 skips on missing wPrime)
a = { ...athleteBase, cpTests: cpTestsTier1 };
check('State 2 (no override, CP tests added)', 'Tier 1 (CP fit ~16800)', 15000, 20000, a);

// Set override to 15000 → Tier 0 wins
a = { ...athleteBase, cpTests: cpTestsTier1, wPrime: 15000 };
check('State 3 (override 15000 + CP tests)', 'Tier 0 (15000)', 15000, 15000, a);

// Clear override (wPrime: null) → CP tests still active → Tier 1 restored
a = { ...athleteBase, cpTests: cpTestsTier1, wPrime: null };
check('State 4 (override cleared, CP tests still present)', 'Tier 1 (~16800)', 15000, 20000, a);

// Remove CP tests, no override → Tier 2 phenotype
a = { ...athleteBase, wPrime: null };
check('State 5 (override cleared, CP tests removed)', 'Tier 2 (250×75=18750)', 18750, 18750, a);

console.log('\n=== Tier 0 guard sanity check (B-24 requirement) ===');
const guardCases = [
  { label: 'wPrime: null',      v: null,      shouldFireT0: false },
  { label: 'wPrime: undefined', v: undefined, shouldFireT0: false },
  { label: 'wPrime: 0',         v: 0,         shouldFireT0: false },
  { label: 'wPrime: ""',        v: "",        shouldFireT0: false },
  { label: 'wPrime: NaN',       v: NaN,       shouldFireT0: false },
  { label: 'wPrime: 22000',     v: 22000,     shouldFireT0: true  },
];
for (const c of guardCases) {
  const a = { ...athleteBase, wPrime: c.v };
  const result = deriveWPrime(a);
  const value = (result && typeof result === 'object') ? null : result;
  // Tier 0 fired iff result === 22000 exactly (the explicit value); else Tier 2 returned 18750.
  const t0Fired = value === 22000;
  const expected = c.shouldFireT0;
  const ok = t0Fired === expected;
  console.log(`  [${ok ? 'OK' : 'FAIL'}] ${c.label.padEnd(22)} → ${value}J  (T0 ${t0Fired ? 'fired' : 'skipped'}, expected ${expected ? 'fired' : 'skipped'})`);
}
