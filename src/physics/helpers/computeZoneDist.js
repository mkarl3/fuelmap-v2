// Zone-time distribution across the 6 standard Coggan power zones.
//
// Walks the power stream and counts how much time was spent in each zone.
// Used on PLAN (planned distribution) and ANALYZE (actual distribution)
// sides; the *shape* of effort matters even when NP and TSS match — two
// riders with the same headline numbers can have radically different zone
// distributions.
//
// Per spec 2.9 target state:
//  • Consumes COGGAN_ZONES from referenceData (single source of truth — no
//    more inline thresholds; replaces the legacy POWER_ZONES const which
//    had a latent boundary inconsistency).
//  • Output gains `seconds` per zone (raw count alongside `pct`).
//  • Empty input returns 6 zones with `pct: 0, seconds: 0` (defensible
//    default — empty input means no analysis to do, not an error).
//
// **Known limitation (resolved by CC#7):** equal-counting per stream entry
// produces correct duration weighting only when entries are uniform-duration
// (e.g., 1-second resolution). At mixed resolutions (legacy 1-min PLAN
// blocks vs 1-sec ANALYZE), the bug surfaces. CC#7's 1-sec resampling on
// both sides fixes this. Not addressed here per Prompt 2 scope.
//
// See FuelMAP_Physics_Spec_v0_3 spec 2.9.

import { COGGAN_ZONES } from '../constants/referenceData.js';

/**
 * @param {Array<{power: number}>} powerStream
 * @param {number} ftp
 * @returns {Array<{id: string, name: string, color: string, ftpRangeLow: number, ftpRangeHigh: number, count: number, seconds: number, pct: number}>}
 *   One entry per zone in COGGAN_ZONES order. `seconds` and `count` are
 *   currently identical (assumes 1-second resolution per CC#7 prep);
 *   they're kept distinct in the output for forward-compat with future
 *   per-second weighting if input is downsampled.
 *
 * Edge cases:
 *  - Empty / null powerStream → 6 zones with pct: 0, seconds: 0
 *  - ftp ≤ 0 → returns the same defensible default (avoids NaN in pct = power/ftp)
 *  - Stream entries with non-numeric power are skipped silently
 */
export function computeZoneDist(powerStream, ftp) {
  // Defensible default: empty / invalid input.
  if (!powerStream || powerStream.length === 0 || !(ftp > 0)) {
    return COGGAN_ZONES.map(z => ({
      id:           z.id,
      name:         z.name,
      color:        z.color,
      ftpRangeLow:  z.ftpRangeLow,
      ftpRangeHigh: z.ftpRangeHigh,
      count:        0,
      seconds:      0,
      pct:          0,
    }));
  }

  const counts = COGGAN_ZONES.map(() => 0);
  let total = 0;
  for (const pt of powerStream) {
    if (!pt || typeof pt.power !== 'number') continue;
    const pctFTP = pt.power / ftp;
    // Bins are half-open: ftpRangeLow ≤ pct < ftpRangeHigh.
    for (let z = 0; z < COGGAN_ZONES.length; z++) {
      const zone = COGGAN_ZONES[z];
      if (pctFTP >= zone.ftpRangeLow && pctFTP < zone.ftpRangeHigh) {
        counts[z]++;
        break;
      }
    }
    total++;
  }
  if (total === 0) {
    return COGGAN_ZONES.map(z => ({
      id:           z.id,
      name:         z.name,
      color:        z.color,
      ftpRangeLow:  z.ftpRangeLow,
      ftpRangeHigh: z.ftpRangeHigh,
      count:        0,
      seconds:      0,
      pct:          0,
    }));
  }

  return COGGAN_ZONES.map((z, i) => ({
    id:           z.id,
    name:         z.name,
    color:        z.color,
    ftpRangeLow:  z.ftpRangeLow,
    ftpRangeHigh: z.ftpRangeHigh,
    count:        counts[i],
    seconds:      counts[i],   // 1-second resolution assumption per CC#7
    pct:          Math.round((counts[i] / total) * 100),
  }));
}

// ─── Sanity checks ───────────────────────────────────────────────────────
//
// Three points all in Z2 (200 W at FTP 250 → 80% — wait: 0.80 falls in Z3.
// Use 200/350=0.57 to be in Z2):
//   computeZoneDist([{power: 200}, {power: 200}, {power: 200}], 350)
//   → Z2 has count: 3, seconds: 3, pct: 100; others all 0
//
// Empty input:
//   computeZoneDist([], 250)
//   → 6 zones with pct: 0, seconds: 0
//
// Invalid ftp:
//   computeZoneDist([{power: 200}], 0)   → 6 zones with pct: 0, seconds: 0
//
// Mixed:
//   computeZoneDist([
//     {power: 100},   // Z1 (100/250 = 0.40)
//     {power: 200},   // Z3 (200/250 = 0.80)
//     {power: 250},   // Z4 (250/250 = 1.00)
//   ], 250)
//   → Z1, Z3, Z4 each with count 1, pct 33; Z2/Z5/Z6 all 0

export default computeZoneDist;
