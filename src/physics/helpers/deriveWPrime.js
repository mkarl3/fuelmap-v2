// Compute athlete's W' (joules) using best available data source.
//
// Three-tier fallback:
//   Tier 1: CP test fitting via `fitCPModel` (≥ 2 valid efforts)
//   Tier 2: Phenotype lookup (`ftp × phenotype.wMult`)
//   Tier 3: FTP-based default (`ftp × DEFAULTS.wPrimePerWattFtp`)
//
// **Final fallback (no FTP at all)** → bug indicator per spec 3.2 / CC#6:
//   `{ ok: false, reason: 'insufficient_athlete_data' }`
//
// Per spec 3.2 target state changes from legacy:
//  • Tier 1 routes through `fitCPModel` instead of reimplementing math (CC#2)
//  • 5000 J floor → user-fixable warning + return floored value (CC#4)
//  • Magic 75 → DEFAULTS.wPrimePerWattFtp (CC#5)
//  • Final 20,000 J fallback → structured error (CC#6)
//  • 3-parameter CP model deferred to future (see spec 3.2 reasoning)

import { fitCPModel }   from './fitCPModel.js';
import { fitWarn }      from './fitWarn.js';
import { RIDER_PHENOTYPES } from '../constants/referenceData.js';
import { DEFAULTS }     from '../constants/defaults.js';

/**
 * @param {{
 *   cpTests?: Array<{secs: number, watts: number}>,
 *   phenotype?: string,
 *   ftp?: number,
 * }} athlete
 * @returns {number | { ok: false, reason: string }}
 *   On success: W' in joules (rounded to int).
 *   On insufficient data: { ok: false, reason: 'insufficient_athlete_data' }.
 *
 * Floor side-effect: when Tier 1 produces W' below DEFAULTS.wPrimeFloorJ,
 * the floored value is returned and `fitWarn('cp_test_low_wprime')` fires.
 *
 * **3-parameter CP model:** not currently supported. The 2-parameter
 * fit `P = CP + W'/t` is the industry standard (TrainingPeaks, Golden
 * Cheetah, WKO, intervals.icu). Adding 3-parameter would break numerical
 * comparison against reference tools and requires sprint efforts (5s/30s)
 * in test data to constrain `P_max` — typical CP tests don't include those.
 * Flagged for future if user demand surfaces.
 */
export function deriveWPrime(athlete) {
  // ── Tier 1: CP test fitting ─────────────────────────────────────────
  if (athlete && Array.isArray(athlete.cpTests)) {
    const points = athlete.cpTests
      .filter(t => t && t.secs > 0 && t.watts > 0)
      .map(t => ({ durationSec: t.secs, powerW: t.watts }));
    const fit = fitCPModel(points);
    if (fit) {
      const wPrimeRaw = fit.wPrime;
      if (wPrimeRaw < DEFAULTS.wPrimeFloorJ) {
        fitWarn('cp_test_low_wprime',
          `W' below floor (${wPrimeRaw} J) — capping at ${DEFAULTS.wPrimeFloorJ}. CP test data may be unreliable.`,
          { wPrimeRaw });
        return DEFAULTS.wPrimeFloorJ;
      }
      return Math.round(wPrimeRaw);
    }
  }

  // ── Tier 2: Phenotype lookup ────────────────────────────────────────
  if (athlete && athlete.phenotype && athlete.ftp > 0) {
    const ph = RIDER_PHENOTYPES.find(p => p.id === athlete.phenotype);
    if (ph) return Math.round(athlete.ftp * ph.wMult);
  }

  // ── Tier 3: FTP-based default ───────────────────────────────────────
  if (athlete && athlete.ftp > 0) {
    return Math.round(athlete.ftp * DEFAULTS.wPrimePerWattFtp);
  }

  // ── Final: insufficient athlete data → bug indicator (CC#6) ─────────
  return { ok: false, reason: 'insufficient_athlete_data' };
}

// ─── Sanity checks ───────────────────────────────────────────────────────
//
// Tier 1 (CP test fitting):
//   deriveWPrime({ cpTests: [{secs:180, watts:300}, {secs:720, watts:250}], ftp: 250 })
//   → 12000  (from fitCPModel)
//
// Tier 1 with low W' (fires fitWarn, returns floored):
//   deriveWPrime({ cpTests: [{secs:180, watts:200}, {secs:720, watts:199}], ftp: 200 })
//   → 5000  (DEFAULTS.wPrimeFloorJ)
//
// Tier 2 (phenotype):
//   deriveWPrime({ phenotype: 'climber', ftp: 250 })
//   → 250 × 55 = 13750
//
// Tier 3 (FTP fallback):
//   deriveWPrime({ ftp: 250 })
//   → 250 × 75 = 18750
//
// Final (no data):
//   deriveWPrime({})              → { ok: false, reason: 'insufficient_athlete_data' }
//   deriveWPrime(null)            → { ok: false, reason: 'insufficient_athlete_data' }
//   deriveWPrime({ ftp: 0 })      → { ok: false, reason: 'insufficient_athlete_data' }

export default deriveWPrime;
