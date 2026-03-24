// logic.js — Pure business logic for Happy Jump Insurance.
// Shared between frontend, gateway, and tests.
// No external dependencies — all functions are pure computations.

// ── Tier System ──────────────────────────────────────────────────────

export function computeTier(cleanCount) {
  if (cleanCount >= 5) return 'legend';
  if (cleanCount >= 3) return 'road';
  if (cleanCount >= 1) return 'safe';
  return 'new';
}

/**
 * Count consecutive clean closes from most recent backward.
 * Streak resets on any OD (od_xanax, od_ecstasy, payout_sent).
 * Only considers completed transactions.
 */
export function computeCleanStreak(txns) {
  const completed = txns
    .filter((t) => ['closed_clean', 'od_xanax', 'od_ecstasy', 'payout_sent'].includes(t.status))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  let streak = 0;
  for (const t of completed) {
    if (t.status === 'closed_clean') streak++;
    else break;
  }
  return streak;
}

// ── Pricing Calculations ─────────────────────────────────────────────

/**
 * Core price components from config values.
 * All config values must already be numbers (not strings).
 */
export function computePriceComponents(config) {
  const xanaxPrice = Number(config.xanax_price);
  const edvdPrice = Number(config.edvd_price);
  const ecstasyPrice = Number(config.ecstasy_price);
  const rehabBonus = Number(config.rehab_bonus);

  const packageCost = 4 * xanaxPrice + 5 * edvdPrice + ecstasyPrice;
  const xanaxPayout = 4 * xanaxPrice + rehabBonus;
  const ecstasyPayout = packageCost + rehabBonus;

  return { xanaxPrice, edvdPrice, ecstasyPrice, rehabBonus, packageCost, xanaxPayout, ecstasyPayout };
}

/**
 * OD probability calculations.
 */
export function computeOdProbabilities(config) {
  const xanaxOdPct = Number(config.xanax_od_pct);
  const ecstasyOdPct = Number(config.ecstasy_od_pct);

  const pXanaxOd = 1 - Math.pow(1 - xanaxOdPct, 4);
  const pEcstasyOd = Math.pow(1 - xanaxOdPct, 4) * ecstasyOdPct;

  return { xanaxOdPct, ecstasyOdPct, pXanaxOd, pEcstasyOd };
}

/**
 * Full package pricing: drugs + OD insurance.
 */
export function calcPricing(config, margin) {
  const { packageCost, xanaxPayout, ecstasyPayout } = computePriceComponents(config);
  const { pXanaxOd, pEcstasyOd } = computeOdProbabilities(config);

  const expectedLiability = pXanaxOd * xanaxPayout + pEcstasyOd * ecstasyPayout;
  const trueCost = packageCost + expectedLiability;
  const suggestedPrice = Math.round(trueCost / (1 - margin));

  return { packageCost, xanaxPayout, ecstasyPayout, expectedLiability, trueCost, suggestedPrice };
}

/**
 * Insurance-only pricing: no drug cost, full OD coverage.
 */
export function calcInsurancePricing(config, margin) {
  const { xanaxPayout, ecstasyPayout } = computePriceComponents(config);
  const { pXanaxOd, pEcstasyOd } = computeOdProbabilities(config);

  const expectedLiability = pXanaxOd * xanaxPayout + pEcstasyOd * ecstasyPayout;
  const suggestedPrice = Math.round(expectedLiability / (1 - margin));

  return { packageCost: 0, xanaxPayout, ecstasyPayout, expectedLiability, trueCost: expectedLiability, suggestedPrice };
}

/**
 * Ecstasy-only insurance: covers only the Ecstasy step (flat OD rate).
 */
export function calcEcstasyOnlyPricing(config, margin) {
  const { ecstasyPayout } = computePriceComponents(config);
  const ecstasyOdPct = Number(config.ecstasy_od_pct);

  const expectedLiability = ecstasyOdPct * ecstasyPayout;
  const suggestedPrice = Math.round(expectedLiability / (1 - margin));

  return { packageCost: 0, xanaxPayout: 0, ecstasyPayout, expectedLiability, trueCost: expectedLiability, suggestedPrice };
}

/**
 * Get pricing for any product type.
 */
export function getPricing(config, margin, productType) {
  if (productType === 'insurance') return calcInsurancePricing(config, margin);
  if (productType === 'ecstasy_only') return calcEcstasyOnlyPricing(config, margin);
  return calcPricing(config, margin);
}

// ── OD Verification Logic ────────────────────────────────────────────

/**
 * Strip HTML tags from Torn API event text.
 */
export function stripHtml(s) {
  return s.replace(/<[^>]*>/g, '');
}

/**
 * Parse Torn events to find the most recent OD on Xanax or Ecstasy.
 * Returns { odDrug, odEventTimestamp } or { odDrug: null } if no OD found.
 *
 * @param {Object} eventsData - Raw Torn API events response
 * @returns {{ odDrug: string|null, odEventTimestamp: number|null }}
 */
export function parseOdFromEvents(eventsData) {
  let odDrug = null;
  let odEventTimestamp = null;

  if (!eventsData?.error && eventsData?.events) {
    const events = Object.values(eventsData.events);
    // Sort by timestamp descending (most recent first)
    events.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    for (const evt of events) {
      const evtText = stripHtml(evt.event || '').toLowerCase();
      if (evtText.includes('overdos')) {
        if (evtText.includes('xanax')) {
          odDrug = 'xanax';
          odEventTimestamp = evt.timestamp;
          break;
        }
        if (evtText.includes('ecstasy')) {
          odDrug = 'ecstasy';
          odEventTimestamp = evt.timestamp;
          break;
        }
      }
    }
  }

  return { odDrug, odEventTimestamp };
}

/**
 * Validate that the detected OD is covered by the product type.
 * Returns { covered: true } or { covered: false, reason: string }.
 */
export function validateOdCoverage(productType, odDrug) {
  if (!odDrug) {
    return { covered: false, reason: 'No OD detected' };
  }

  if (odDrug !== 'xanax' && odDrug !== 'ecstasy') {
    return { covered: false, reason: `Overdose on ${odDrug} is not covered by Happy Jump insurance` };
  }

  if (productType === 'ecstasy_only' && odDrug === 'xanax') {
    return { covered: false, reason: 'Xanax OD not covered under ecstasy-only policy' };
  }

  return { covered: true };
}

/**
 * Determine payout amount based on OD type and transaction snapshots.
 */
export function computePayoutAmount(odDrug, txnSnapshots) {
  if (odDrug === 'xanax') return Number(txnSnapshots.xanax_payout);
  if (odDrug === 'ecstasy') return Number(txnSnapshots.ecstasy_payout);
  return 0;
}

// ── Reserve Management ───────────────────────────────────────────────

/**
 * Calculate availability from current reserve and worst-case payout.
 */
export function calcAvailability(currentReserve, ecstasyPayout) {
  return Math.max(0, Math.floor(Number(currentReserve) / Number(ecstasyPayout)));
}

/**
 * Calculate reserve change for a status transition.
 * Returns the delta to add to current_reserve (positive = release, negative = lock).
 */
export function calcReserveDelta(newStatus, ecstasyPayout, payoutAmount) {
  const ecsP = Number(ecstasyPayout || 0);
  const payAmt = Number(payoutAmount || 0);

  switch (newStatus) {
    case 'created':       return -ecsP;                  // Lock worst-case on creation
    case 'closed_clean':  return ecsP;                   // Full release
    case 'rejected':      return ecsP;                   // Full release
    case 'payout_sent':   return ecsP - payAmt;          // Net release (keep what was paid)
    default:              return 0;                       // No change for purchased, od_xanax, od_ecstasy
  }
}

// ── Status Transition Validation ─────────────────────────────────────

const VALID_TRANSITIONS = {
  'requested':   ['purchased', 'rejected'],
  'purchased':   ['closed_clean', 'od_xanax', 'od_ecstasy'],
  'od_xanax':    ['payout_sent'],
  'od_ecstasy':  ['payout_sent'],
  'closed_clean': [],
  'payout_sent':  [],
  'rejected':     [],
};

/**
 * Check if a status transition is valid.
 */
export function isValidTransition(currentStatus, newStatus) {
  const allowed = VALID_TRANSITIONS[currentStatus];
  return allowed ? allowed.includes(newStatus) : false;
}
