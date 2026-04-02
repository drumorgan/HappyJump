import { describe, it, expect } from 'vitest';
import {
  computePriceComponents,
  computeOdProbabilities,
  calcPricing,
  calcInsurancePricing,
  calcEcstasyOnlyPricing,
  getPricing,
  computePayoutAmount,
  calcReserveDelta,
  calcAvailability,
  parseOdFromEvents,
  validateOdCoverage,
  stripHtml,
  isValidTransition,
  computeTier,
  computeCleanStreak,
} from '../src/logic.js';

// ── Default config matching CLAUDE.md defaults ──────────────────────

const DEFAULT_CONFIG = {
  xanax_price: 850000,
  edvd_price: 4000000,
  ecstasy_price: 70000,
  xanax_od_pct: 0.03,
  ecstasy_od_pct: 0.05,
  rehab_bonus: 1000000,
};

const DEFAULT_MARGIN = 0.15;

// ── Price Components ────────────────────────────────────────────────

describe('computePriceComponents', () => {
  it('calculates package cost correctly', () => {
    const r = computePriceComponents(DEFAULT_CONFIG);
    // 4×850k + 5×4M + 70k = 3,400,000 + 20,000,000 + 70,000 = 23,470,000
    expect(r.packageCost).toBe(23470000);
  });

  it('calculates xanax payout correctly', () => {
    const r = computePriceComponents(DEFAULT_CONFIG);
    // 4×850k + 1M = 4,400,000
    expect(r.xanaxPayout).toBe(4400000);
  });

  it('calculates ecstasy payout correctly', () => {
    const r = computePriceComponents(DEFAULT_CONFIG);
    // packageCost + 1M = 23,470,000 + 1,000,000 = 24,470,000
    expect(r.ecstasyPayout).toBe(24470000);
  });

  it('handles string values from Supabase bigint columns', () => {
    const stringConfig = {
      xanax_price: '850000',
      edvd_price: '4000000',
      ecstasy_price: '70000',
      rehab_bonus: '1000000',
    };
    const r = computePriceComponents(stringConfig);
    expect(r.packageCost).toBe(23470000);
    expect(r.xanaxPayout).toBe(4400000);
    expect(r.ecstasyPayout).toBe(24470000);
  });

  it('works with different price values', () => {
    const config = {
      xanax_price: 1000000,
      edvd_price: 5000000,
      ecstasy_price: 100000,
      rehab_bonus: 2000000,
    };
    const r = computePriceComponents(config);
    expect(r.packageCost).toBe(4 * 1000000 + 5 * 5000000 + 100000); // 29,100,000
    expect(r.xanaxPayout).toBe(4 * 1000000 + 2000000); // 6,000,000
    expect(r.ecstasyPayout).toBe(29100000 + 2000000); // 31,100,000
  });
});

// ── OD Probabilities ────────────────────────────────────────────────

describe('computeOdProbabilities', () => {
  it('calculates xanax OD probability across 4 pills', () => {
    const r = computeOdProbabilities(DEFAULT_CONFIG);
    // P = 1 - (0.97)^4 ≈ 0.11470719
    expect(r.pXanaxOd).toBeCloseTo(0.11470719, 6);
  });

  it('calculates ecstasy OD probability (conditional on surviving xanax)', () => {
    const r = computeOdProbabilities(DEFAULT_CONFIG);
    // P = (0.97)^4 × 0.05 ≈ 0.04426464
    expect(r.pEcstasyOd).toBeCloseTo(0.04426464, 6);
  });

  it('probabilities sum to less than 1', () => {
    const r = computeOdProbabilities(DEFAULT_CONFIG);
    expect(r.pXanaxOd + r.pEcstasyOd).toBeLessThan(1);
  });

  it('handles zero OD rates', () => {
    const config = { xanax_od_pct: 0, ecstasy_od_pct: 0 };
    const r = computeOdProbabilities(config);
    expect(r.pXanaxOd).toBe(0);
    expect(r.pEcstasyOd).toBe(0);
  });

  it('handles 100% xanax OD rate', () => {
    const config = { xanax_od_pct: 1.0, ecstasy_od_pct: 0.05 };
    const r = computeOdProbabilities(config);
    expect(r.pXanaxOd).toBe(1); // Guaranteed OD
    expect(r.pEcstasyOd).toBe(0); // Can't reach ecstasy step
  });
});

// ── Full Package Pricing (calcPricing) ──────────────────────────────

describe('calcPricing', () => {
  it('calculates suggested price with default values', () => {
    const r = calcPricing(DEFAULT_CONFIG, DEFAULT_MARGIN);
    // expectedLiability = pXanOd*xanPayout + pEcsOd*ecsPayout
    const pXan = 1 - Math.pow(0.97, 4);
    const pEcs = Math.pow(0.97, 4) * 0.05;
    const expected = pXan * 4400000 + pEcs * 24470000;
    const trueCost = 23470000 + expected;
    const suggestedPrice = Math.round(trueCost / (1 - 0.15));

    expect(r.packageCost).toBe(23470000);
    expect(r.xanaxPayout).toBe(4400000);
    expect(r.ecstasyPayout).toBe(24470000);
    expect(r.expectedLiability).toBeCloseTo(expected, 0);
    expect(r.suggestedPrice).toBe(suggestedPrice);
  });

  it('suggested price exceeds true cost by margin', () => {
    const r = calcPricing(DEFAULT_CONFIG, DEFAULT_MARGIN);
    // suggestedPrice * (1 - margin) ≈ trueCost
    expect(r.suggestedPrice * (1 - DEFAULT_MARGIN)).toBeCloseTo(r.trueCost, -1);
  });

  it('higher margin produces higher suggested price', () => {
    const low = calcPricing(DEFAULT_CONFIG, 0.10);
    const high = calcPricing(DEFAULT_CONFIG, 0.20);
    expect(high.suggestedPrice).toBeGreaterThan(low.suggestedPrice);
  });
});

// ── Insurance-Only Pricing ──────────────────────────────────────────

describe('calcInsurancePricing', () => {
  it('has zero package cost', () => {
    const r = calcInsurancePricing(DEFAULT_CONFIG, DEFAULT_MARGIN);
    expect(r.packageCost).toBe(0);
  });

  it('still covers both xanax and ecstasy payouts', () => {
    const r = calcInsurancePricing(DEFAULT_CONFIG, DEFAULT_MARGIN);
    expect(r.xanaxPayout).toBe(4400000);
    expect(r.ecstasyPayout).toBe(24470000);
  });

  it('suggested price is lower than full package', () => {
    const full = calcPricing(DEFAULT_CONFIG, DEFAULT_MARGIN);
    const ins = calcInsurancePricing(DEFAULT_CONFIG, DEFAULT_MARGIN);
    expect(ins.suggestedPrice).toBeLessThan(full.suggestedPrice);
  });

  it('true cost equals expected liability (no drug cost)', () => {
    const r = calcInsurancePricing(DEFAULT_CONFIG, DEFAULT_MARGIN);
    expect(r.trueCost).toBe(r.expectedLiability);
  });
});

// ── Ecstasy-Only Pricing ────────────────────────────────────────────

describe('calcEcstasyOnlyPricing', () => {
  it('has zero xanax payout (not covered)', () => {
    const r = calcEcstasyOnlyPricing(DEFAULT_CONFIG, DEFAULT_MARGIN);
    expect(r.xanaxPayout).toBe(0);
  });

  it('has zero package cost', () => {
    const r = calcEcstasyOnlyPricing(DEFAULT_CONFIG, DEFAULT_MARGIN);
    expect(r.packageCost).toBe(0);
  });

  it('uses flat ecstasy OD rate (not conditional)', () => {
    const r = calcEcstasyOnlyPricing(DEFAULT_CONFIG, DEFAULT_MARGIN);
    // expectedLiability = ecstasy_od_pct * ecstasyPayout (flat, not conditional)
    expect(r.expectedLiability).toBeCloseTo(0.05 * 24470000, 0);
  });

  it('is cheapest product type', () => {
    const full = calcPricing(DEFAULT_CONFIG, DEFAULT_MARGIN);
    const ins = calcInsurancePricing(DEFAULT_CONFIG, DEFAULT_MARGIN);
    const eco = calcEcstasyOnlyPricing(DEFAULT_CONFIG, DEFAULT_MARGIN);
    expect(eco.suggestedPrice).toBeLessThan(ins.suggestedPrice);
    expect(eco.suggestedPrice).toBeLessThan(full.suggestedPrice);
  });
});

// ── getPricing router ───────────────────────────────────────────────

describe('getPricing', () => {
  it('routes to full package by default', () => {
    const r = getPricing(DEFAULT_CONFIG, DEFAULT_MARGIN, 'full');
    const expected = calcPricing(DEFAULT_CONFIG, DEFAULT_MARGIN);
    expect(r.suggestedPrice).toBe(expected.suggestedPrice);
  });

  it('routes to insurance-only', () => {
    const r = getPricing(DEFAULT_CONFIG, DEFAULT_MARGIN, 'insurance');
    const expected = calcInsurancePricing(DEFAULT_CONFIG, DEFAULT_MARGIN);
    expect(r.suggestedPrice).toBe(expected.suggestedPrice);
  });

  it('routes to ecstasy-only', () => {
    const r = getPricing(DEFAULT_CONFIG, DEFAULT_MARGIN, 'ecstasy_only');
    const expected = calcEcstasyOnlyPricing(DEFAULT_CONFIG, DEFAULT_MARGIN);
    expect(r.suggestedPrice).toBe(expected.suggestedPrice);
  });
});

// ── computePayoutAmount ─────────────────────────────────────────────

describe('computePayoutAmount', () => {
  const snapshots = { xanax_payout: 4400000, ecstasy_payout: 24470000 };

  it('returns xanax payout for xanax OD', () => {
    expect(computePayoutAmount('xanax', snapshots)).toBe(4400000);
  });

  it('returns ecstasy payout for ecstasy OD', () => {
    expect(computePayoutAmount('ecstasy', snapshots)).toBe(24470000);
  });

  it('returns 0 for unknown OD type', () => {
    expect(computePayoutAmount('unknown', snapshots)).toBe(0);
    expect(computePayoutAmount(null, snapshots)).toBe(0);
  });

  it('handles string values from Supabase bigint columns', () => {
    const strSnapshots = { xanax_payout: '4400000', ecstasy_payout: '24470000' };
    expect(computePayoutAmount('xanax', strSnapshots)).toBe(4400000);
    expect(computePayoutAmount('ecstasy', strSnapshots)).toBe(24470000);
  });

  it('ecstasy payout is always larger than xanax payout', () => {
    // Ecstasy payout = package + rehab, Xanax payout = 4×xanax + rehab
    // Package includes xanax cost + more, so ecstasy > xanax always
    expect(computePayoutAmount('ecstasy', snapshots))
      .toBeGreaterThan(computePayoutAmount('xanax', snapshots));
  });
});

// ── Reserve Management ──────────────────────────────────────────────

describe('calcReserveDelta', () => {
  const ecsPayout = 24470000;

  it('locks worst-case on creation (negative delta)', () => {
    expect(calcReserveDelta('created', ecsPayout, 0)).toBe(-24470000);
  });

  it('fully releases on clean close', () => {
    expect(calcReserveDelta('closed_clean', ecsPayout, 0)).toBe(24470000);
  });

  it('fully releases on rejection', () => {
    expect(calcReserveDelta('rejected', ecsPayout, 0)).toBe(24470000);
  });

  it('net releases on payout_sent (xanax OD — partial release)', () => {
    const xanaxPayoutAmt = 4400000;
    const delta = calcReserveDelta('payout_sent', ecsPayout, xanaxPayoutAmt);
    // Release ecstasy lock minus actual xanax payout
    expect(delta).toBe(24470000 - 4400000); // 20,070,000
  });

  it('net releases on payout_sent (ecstasy OD — minimal release)', () => {
    const ecstasyPayoutAmt = 24470000;
    const delta = calcReserveDelta('payout_sent', ecsPayout, ecstasyPayoutAmt);
    // Release equals lock minus payout — 0 net release
    expect(delta).toBe(0);
  });

  it('no change for intermediate statuses', () => {
    expect(calcReserveDelta('purchased', ecsPayout, 0)).toBe(0);
    expect(calcReserveDelta('od_xanax', ecsPayout, 0)).toBe(0);
    expect(calcReserveDelta('od_ecstasy', ecsPayout, 0)).toBe(0);
  });

  it('handles string values from Supabase', () => {
    expect(calcReserveDelta('created', '24470000', '0')).toBe(-24470000);
    expect(calcReserveDelta('payout_sent', '24470000', '4400000')).toBe(20070000);
  });
});

describe('calcAvailability', () => {
  it('calculates max simultaneous packages', () => {
    // 100M reserve / 24.47M per package = 4.08 → floor to 4
    expect(calcAvailability(100000000, 24470000)).toBe(4);
  });

  it('returns 0 when reserve is insufficient', () => {
    expect(calcAvailability(1000000, 24470000)).toBe(0);
  });

  it('returns 0 for zero reserve', () => {
    expect(calcAvailability(0, 24470000)).toBe(0);
  });

  it('handles string values from Supabase', () => {
    expect(calcAvailability('100000000', '24470000')).toBe(4);
  });

  it('never returns negative', () => {
    expect(calcAvailability(-5000000, 24470000)).toBe(0);
  });
});

// ── OD Event Parsing ────────────────────────────────────────────────

describe('parseOdFromEvents', () => {
  it('detects xanax OD from events', () => {
    const events = {
      events: {
        '1': { timestamp: 1000, event: 'You <b>overdosed</b> on Xanax and were hospitalized' },
      },
    };
    const r = parseOdFromEvents(events);
    expect(r.odDrug).toBe('xanax');
    expect(r.odEventTimestamp).toBe(1000);
  });

  it('detects ecstasy OD from events', () => {
    const events = {
      events: {
        '1': { timestamp: 2000, event: 'You <b>overdosed</b> on Ecstasy and were hospitalized' },
      },
    };
    const r = parseOdFromEvents(events);
    expect(r.odDrug).toBe('ecstasy');
    expect(r.odEventTimestamp).toBe(2000);
  });

  it('returns null when no OD found', () => {
    const events = {
      events: {
        '1': { timestamp: 1000, event: 'You used a Xanax' },
      },
    };
    const r = parseOdFromEvents(events);
    expect(r.odDrug).toBeNull();
    expect(r.odEventTimestamp).toBeNull();
  });

  it('picks most recent OD when multiple exist', () => {
    const events = {
      events: {
        '1': { timestamp: 1000, event: 'You overdosed on Xanax' },
        '2': { timestamp: 3000, event: 'You overdosed on Ecstasy' },
        '3': { timestamp: 2000, event: 'You overdosed on Xanax' },
      },
    };
    const r = parseOdFromEvents(events);
    // Most recent (ts=3000) is ecstasy
    expect(r.odDrug).toBe('ecstasy');
    expect(r.odEventTimestamp).toBe(3000);
  });

  it('handles null/undefined/error events data', () => {
    expect(parseOdFromEvents(null).odDrug).toBeNull();
    expect(parseOdFromEvents(undefined).odDrug).toBeNull();
    expect(parseOdFromEvents({ error: 'bad key' }).odDrug).toBeNull();
    expect(parseOdFromEvents({}).odDrug).toBeNull();
  });

  it('strips HTML tags before matching', () => {
    const events = {
      events: {
        '1': { timestamp: 500, event: 'You <b>overdos</b>ed on <a href="#">Xanax</a>' },
      },
    };
    const r = parseOdFromEvents(events);
    expect(r.odDrug).toBe('xanax');
  });

  it('detects successful ecstasy usage', () => {
    const events = {
      events: {
        '1': { timestamp: 1000, event: 'You used some Ecstasy gaining 15,850 happiness' },
      },
    };
    const r = parseOdFromEvents(events);
    expect(r.odDrug).toBeNull();
    expect(r.ecstasyUsedTimestamp).toBe(1000);
  });

  it('detects ecstasy usage even when OD also present', () => {
    const events = {
      events: {
        '1': { timestamp: 1000, event: 'You used some Ecstasy gaining 15,850 happiness' },
        '2': { timestamp: 2000, event: 'You <b>overdosed</b> on Ecstasy' },
      },
    };
    const r = parseOdFromEvents(events);
    expect(r.odDrug).toBe('ecstasy');
    expect(r.ecstasyUsedTimestamp).toBe(1000);
  });

  it('finds earliest ecstasy usage when multiple uses', () => {
    const events = {
      events: {
        '1': { timestamp: 1000, event: 'You used some Ecstasy gaining 12,000 happiness' },
        '2': { timestamp: 3000, event: 'You used some Ecstasy gaining 15,850 happiness' },
      },
    };
    const r = parseOdFromEvents(events);
    expect(r.ecstasyUsedTimestamp).toBe(1000);
  });

  it('returns null ecstasyUsedTimestamp when no usage', () => {
    const events = {
      events: {
        '1': { timestamp: 1000, event: 'You <b>overdosed</b> on Ecstasy' },
      },
    };
    const r = parseOdFromEvents(events);
    expect(r.ecstasyUsedTimestamp).toBeNull();
  });

  it('handles ecstasy usage with HTML tags', () => {
    const events = {
      events: {
        '1': { timestamp: 500, event: 'You <a href="#">used</a> some <b>Ecstasy</b> gaining 15,850 happiness' },
      },
    };
    const r = parseOdFromEvents(events);
    expect(r.ecstasyUsedTimestamp).toBe(500);
  });
});

// ── OD Coverage Validation ──────────────────────────────────────────

describe('validateOdCoverage', () => {
  it('full package covers xanax OD', () => {
    expect(validateOdCoverage('full', 'xanax')).toEqual({ covered: true });
  });

  it('full package covers ecstasy OD', () => {
    expect(validateOdCoverage('full', 'ecstasy')).toEqual({ covered: true });
  });

  it('insurance covers xanax OD', () => {
    expect(validateOdCoverage('insurance', 'xanax')).toEqual({ covered: true });
  });

  it('insurance covers ecstasy OD', () => {
    expect(validateOdCoverage('insurance', 'ecstasy')).toEqual({ covered: true });
  });

  it('ecstasy-only does NOT cover xanax OD', () => {
    const r = validateOdCoverage('ecstasy_only', 'xanax');
    expect(r.covered).toBe(false);
    expect(r.reason).toContain('not covered');
  });

  it('ecstasy-only covers ecstasy OD', () => {
    expect(validateOdCoverage('ecstasy_only', 'ecstasy')).toEqual({ covered: true });
  });

  it('no OD detected returns not covered', () => {
    const r = validateOdCoverage('full', null);
    expect(r.covered).toBe(false);
    expect(r.reason).toContain('No OD');
  });

  it('unknown drug returns not covered', () => {
    const r = validateOdCoverage('full', 'vicodin');
    expect(r.covered).toBe(false);
    expect(r.reason).toContain('not covered');
  });
});

// ── Status Transitions ──────────────────────────────────────────────

describe('isValidTransition', () => {
  it('allows requested → purchased', () => {
    expect(isValidTransition('requested', 'purchased')).toBe(true);
  });

  it('allows requested → rejected', () => {
    expect(isValidTransition('requested', 'rejected')).toBe(true);
  });

  it('allows purchased → od_xanax', () => {
    expect(isValidTransition('purchased', 'od_xanax')).toBe(true);
  });

  it('allows purchased → od_ecstasy', () => {
    expect(isValidTransition('purchased', 'od_ecstasy')).toBe(true);
  });

  it('allows purchased → closed_clean', () => {
    expect(isValidTransition('purchased', 'closed_clean')).toBe(true);
  });

  it('allows od_xanax → payout_sent', () => {
    expect(isValidTransition('od_xanax', 'payout_sent')).toBe(true);
  });

  it('allows od_ecstasy → payout_sent', () => {
    expect(isValidTransition('od_ecstasy', 'payout_sent')).toBe(true);
  });

  it('blocks skipping steps (requested → od_xanax)', () => {
    expect(isValidTransition('requested', 'od_xanax')).toBe(false);
  });

  it('blocks reverse transitions (od_xanax → purchased)', () => {
    expect(isValidTransition('od_xanax', 'purchased')).toBe(false);
  });

  it('terminal states have no transitions', () => {
    expect(isValidTransition('closed_clean', 'purchased')).toBe(false);
    expect(isValidTransition('payout_sent', 'purchased')).toBe(false);
    expect(isValidTransition('rejected', 'purchased')).toBe(false);
  });
});

// ── Tier System ─────────────────────────────────────────────────────

describe('computeTier', () => {
  it('new tier for 0 clean closes', () => {
    expect(computeTier(0)).toBe('new');
  });

  it('safe tier for 1-2 clean closes', () => {
    expect(computeTier(1)).toBe('safe');
    expect(computeTier(2)).toBe('safe');
  });

  it('road tier for 3-4 clean closes', () => {
    expect(computeTier(3)).toBe('road');
    expect(computeTier(4)).toBe('road');
  });

  it('legend tier for 5+ clean closes', () => {
    expect(computeTier(5)).toBe('legend');
    expect(computeTier(100)).toBe('legend');
  });
});

describe('computeCleanStreak', () => {
  it('counts consecutive clean closes from most recent', () => {
    const txns = [
      { status: 'closed_clean', created_at: '2026-03-20T00:00:00Z' },
      { status: 'closed_clean', created_at: '2026-03-21T00:00:00Z' },
      { status: 'closed_clean', created_at: '2026-03-22T00:00:00Z' },
    ];
    expect(computeCleanStreak(txns)).toBe(3);
  });

  it('streak resets on OD', () => {
    const txns = [
      { status: 'closed_clean', created_at: '2026-03-20T00:00:00Z' },
      { status: 'od_xanax', created_at: '2026-03-21T00:00:00Z' },
      { status: 'closed_clean', created_at: '2026-03-22T00:00:00Z' },
      { status: 'closed_clean', created_at: '2026-03-23T00:00:00Z' },
    ];
    // Most recent two are clean, then OD breaks streak
    expect(computeCleanStreak(txns)).toBe(2);
  });

  it('streak resets on payout_sent', () => {
    const txns = [
      { status: 'payout_sent', created_at: '2026-03-22T00:00:00Z' },
      { status: 'closed_clean', created_at: '2026-03-23T00:00:00Z' },
    ];
    expect(computeCleanStreak(txns)).toBe(1);
  });

  it('returns 0 for empty history', () => {
    expect(computeCleanStreak([])).toBe(0);
  });

  it('ignores non-completed statuses', () => {
    const txns = [
      { status: 'requested', created_at: '2026-03-23T00:00:00Z' },
      { status: 'purchased', created_at: '2026-03-22T00:00:00Z' },
      { status: 'closed_clean', created_at: '2026-03-21T00:00:00Z' },
    ];
    expect(computeCleanStreak(txns)).toBe(1);
  });
});

// ── stripHtml ───────────────────────────────────────────────────────

describe('stripHtml', () => {
  it('removes HTML tags', () => {
    expect(stripHtml('You <b>overdosed</b> on <a href="#">Xanax</a>')).toBe('You overdosed on Xanax');
  });

  it('handles plain text', () => {
    expect(stripHtml('no tags here')).toBe('no tags here');
  });

  it('handles empty string', () => {
    expect(stripHtml('')).toBe('');
  });
});

// ── End-to-End Payout Scenarios ─────────────────────────────────────

describe('end-to-end payout scenarios', () => {
  it('xanax OD full lifecycle: create → lock → OD → payout → net release', () => {
    const { ecstasyPayout, xanaxPayout } = computePriceComponents(DEFAULT_CONFIG);

    // 1. Creation locks worst-case (ecstasy payout)
    const lockDelta = calcReserveDelta('created', ecstasyPayout, 0);
    expect(lockDelta).toBe(-ecstasyPayout);

    // 2. OD detected as xanax
    const payoutAmt = computePayoutAmount('xanax', { xanax_payout: xanaxPayout, ecstasy_payout: ecstasyPayout });
    expect(payoutAmt).toBe(xanaxPayout);

    // 3. Payout sent releases net
    const releaseDelta = calcReserveDelta('payout_sent', ecstasyPayout, payoutAmt);
    expect(releaseDelta).toBe(ecstasyPayout - xanaxPayout);

    // Net impact on reserve: lock + release = -ecstasyPayout + (ecstasyPayout - xanaxPayout) = -xanaxPayout
    expect(lockDelta + releaseDelta).toBe(-xanaxPayout);
  });

  it('ecstasy OD full lifecycle: net reserve impact equals ecstasy payout', () => {
    const { ecstasyPayout } = computePriceComponents(DEFAULT_CONFIG);

    const lockDelta = calcReserveDelta('created', ecstasyPayout, 0);
    const payoutAmt = computePayoutAmount('ecstasy', { xanax_payout: 4400000, ecstasy_payout: ecstasyPayout });
    const releaseDelta = calcReserveDelta('payout_sent', ecstasyPayout, payoutAmt);

    // Net impact = -ecstasyPayout + 0 = -ecstasyPayout (entire lock consumed)
    expect(lockDelta + releaseDelta).toBe(-ecstasyPayout);
  });

  it('clean close lifecycle: reserve fully restored', () => {
    const { ecstasyPayout } = computePriceComponents(DEFAULT_CONFIG);

    const lockDelta = calcReserveDelta('created', ecstasyPayout, 0);
    const releaseDelta = calcReserveDelta('closed_clean', ecstasyPayout, 0);

    // Net impact = 0 (fully restored)
    expect(lockDelta + releaseDelta).toBe(0);
  });

  it('ecstasy-only product: xanax OD is not covered', () => {
    const events = {
      events: {
        '1': { timestamp: 1000, event: 'You overdosed on Xanax' },
      },
    };
    const { odDrug } = parseOdFromEvents(events);
    const coverage = validateOdCoverage('ecstasy_only', odDrug);
    expect(coverage.covered).toBe(false);
  });

  it('ecstasy-only product: ecstasy OD is covered with correct payout', () => {
    const events = {
      events: {
        '1': { timestamp: 1000, event: 'You overdosed on Ecstasy' },
      },
    };
    const { odDrug } = parseOdFromEvents(events);
    const coverage = validateOdCoverage('ecstasy_only', odDrug);
    expect(coverage.covered).toBe(true);

    const { ecstasyPayout } = computePriceComponents(DEFAULT_CONFIG);
    const payout = computePayoutAmount(odDrug, { xanax_payout: 0, ecstasy_payout: ecstasyPayout });
    expect(payout).toBe(ecstasyPayout);
  });
});
