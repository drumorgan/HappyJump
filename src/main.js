import { getConfig, validatePlayer, createTransaction, getAvailability, getPlayerTransactions, fetchMarketPrices } from './api.js';

// --- DOM refs ---
const toastEl = document.getElementById('toast');
const storefrontEl = document.getElementById('storefront');
const playerViewEl = document.getElementById('player-view');
const loadingEl = document.getElementById('loading');
const form = document.getElementById('api-form');
const input = document.getElementById('api-key');
const submitBtn = document.getElementById('submit-btn');
const topForm = document.getElementById('api-form-top');
const topInput = document.getElementById('api-key-top');

// --- Tier definitions (margins loaded from config) ---
const TIERS = [
  { key: 'new', name: 'New Client', min: 0, marginField: 'margin_new', margin: 0.18, css: 'new-client' },
  { key: 'safe', name: 'Safe Driver', min: 1, marginField: 'margin_safe', margin: 0.15, css: 'safe-driver' },
  { key: 'road', name: 'Road Warrior', min: 3, marginField: 'margin_road', margin: 0.12, css: 'road-warrior' },
  { key: 'legend', name: 'Highway Legend', min: 5, marginField: 'margin_legend', margin: 0.10, css: 'highway-legend' },
];

function loadTierMargins(config) {
  for (const tier of TIERS) {
    if (config[tier.marginField] !== undefined) {
      tier.margin = Number(config[tier.marginField]);
    }
  }
}

function getTier(cleanCount) {
  for (let i = TIERS.length - 1; i >= 0; i--) {
    if (cleanCount >= TIERS[i].min) return TIERS[i];
  }
  return TIERS[0];
}

// --- Price calculation ---
function calcPricing(config, margin) {
  const packageCost = 4 * config.xanax_price + 5 * config.edvd_price + config.ecstasy_price;
  const xanaxPayout = 4 * config.xanax_price + config.rehab_bonus;
  const ecstasyPayout = packageCost + config.rehab_bonus;
  const pXanOd = 1 - Math.pow(1 - Number(config.xanax_od_pct), 4);
  const pEcsOd = Math.pow(1 - Number(config.xanax_od_pct), 4) * Number(config.ecstasy_od_pct);
  const expectedLiability = pXanOd * xanaxPayout + pEcsOd * ecstasyPayout;
  const trueCost = packageCost + expectedLiability;
  const suggestedPrice = Math.round(trueCost / (1 - margin));

  return { packageCost, xanaxPayout, ecstasyPayout, trueCost, suggestedPrice };
}

const $ = (v) => '$' + Math.round(v).toLocaleString();

// --- Init: load anonymous storefront data ---
async function initStorefront() {
  try {
    const [config, avail] = await Promise.all([getConfig(), getAvailability()]);
    loadTierMargins(config);
    const pricing = calcPricing(config, TIERS[0].margin); // new client rate for anonymous view

    document.getElementById('anon-price').textContent = $(pricing.suggestedPrice);
    document.getElementById('anon-loss-cost').textContent = $(pricing.packageCost) + '+';
    document.getElementById('anon-xan-rehab').textContent = $(config.rehab_bonus);
    document.getElementById('anon-ecs-rehab').textContent = $(config.rehab_bonus);
    document.getElementById('anon-rehab').textContent = $(config.rehab_bonus);

    // Render anonymous tier ladder with calculated prices
    const anonLadder = document.getElementById('anon-tier-ladder');
    if (anonLadder) {
      anonLadder.innerHTML = TIERS.map((t) => {
        const tierPricing = calcPricing(config, t.margin);
        return `<div class="tier-row" data-tier="${t.key}">
          <span class="tier-badge ${t.css}">${esc(t.name)}</span>
          <span class="tier-detail">${t.min}+ clean jumps</span>
          <span class="tier-price">${$(tierPricing.suggestedPrice)}</span>
        </div>`;
      }).join('');
    }

    const availEl = document.getElementById('anon-availability');
    if (avail.available > 0) {
      availEl.textContent = `${avail.available} package${avail.available !== 1 ? 's' : ''} available`;
    } else {
      let soldOutMsg = 'Sold out';
      if (avail.nextCloseAt) {
        const closeDate = new Date(avail.nextCloseAt);
        const now = new Date();
        const daysUntil = Math.max(0, Math.ceil((closeDate - now) / (1000 * 60 * 60 * 24)));
        if (daysUntil > 0) {
          soldOutMsg += ` — next stock expected in ~${daysUntil} day${daysUntil !== 1 ? 's' : ''}`;
        } else {
          soldOutMsg += ' — stock expected soon';
        }
      } else {
        soldOutMsg += ' — check back later';
      }
      availEl.textContent = soldOutMsg;
      availEl.classList.add('sold-out');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

initStorefront();

// --- Form submit: validate player ---
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = input.value.trim();
  if (!key) return showToast('Please enter an API key.', 'error');

  submitBtn.disabled = true;
  loadingEl.classList.remove('hidden');
  toastEl.classList.add('hidden');

  try {
    const [player, config] = await Promise.all([validatePlayer(key), getConfig()]);
    loadTierMargins(config);

    // Fetch live prices and history in parallel — both non-critical
    let history = { transactions: [], clean_count: 0, has_active_deal: false };
    try {
      const [histResult, prices] = await Promise.all([
        getPlayerTransactions(player.torn_id),
        fetchMarketPrices(key).catch(() => null),
      ]);
      history = histResult;

      // Update config with live market prices if available
      if (prices) {
        if (prices.xanax) config.xanax_price = prices.xanax.market_value;
        if (prices.edvd) config.edvd_price = prices.edvd.market_value;
        if (prices.ecstasy) config.ecstasy_price = prices.ecstasy.market_value;
      }
    } catch (histErr) {
      console.warn('History/prices fetch failed:', histErr.message);
    }

    // Check if player is blocked
    if (history.is_blocked) {
      loadingEl.classList.add('hidden');
      showToast('Your account has been blocked. Contact Giro for details.', 'error');
      submitBtn.disabled = false;
      return;
    }

    loadingEl.classList.add('hidden');
    showPlayerView(player, config, history, key);
  } catch (err) {
    loadingEl.classList.add('hidden');
    showToast(err.message, 'error');
  } finally {
    submitBtn.disabled = false;
  }
});

// --- Show personalized player view ---
function showPlayerView(player, config, history, apiKey) {
  storefrontEl.classList.add('hidden');
  playerViewEl.classList.remove('hidden');

  const cleanCount = history.clean_count || 0;
  const hasActive = history.has_active_deal;
  const tier = getTier(cleanCount);
  const pricing = calcPricing(config, tier.margin);
  const isReturning = (history.transactions || []).length > 0;

  // Welcome
  const greeting = isReturning ? 'Welcome back' : 'Welcome';
  document.getElementById('pv-name').textContent = `${greeting}, ${player.torn_name}`;
  document.getElementById('pv-meta').textContent = `Level ${player.torn_level} | ${player.torn_faction || 'No faction'} | ${cleanCount} clean jump${cleanCount !== 1 ? 's' : ''}`;

  // Tier badge
  document.getElementById('pv-tier-badge').innerHTML =
    `<span class="tier-badge ${tier.css}">${esc(tier.name)}</span>`;

  // Personal pricing
  document.getElementById('pv-price').textContent = $(pricing.suggestedPrice);
  document.getElementById('pv-price-note').textContent =
    `${tier.name} rate (${Math.round(tier.margin * 100)}% margin)`;

  // Active deal
  const activeDealSection = document.getElementById('active-deal-section');
  const activeTxn = (history.transactions || []).find(
    (t) => t.status === 'requested' || t.status === 'purchased'
  );

  if (activeTxn) {
    activeDealSection.classList.remove('hidden');
    const body = document.getElementById('active-deal-body');
    const statusLabel = activeTxn.status === 'requested'
      ? 'Waiting for Giro to initiate the trade in-game'
      : 'Trade complete — insurance window active';
    let details = `<div class="deal-status">${esc(statusLabel)}</div>`;
    details += `<div class="deal-detail">Price: ${$(activeTxn.suggested_price)}</div>`;
    if (activeTxn.purchased_at) {
      const closesAt = new Date(activeTxn.closes_at);
      const now = new Date();
      const daysLeft = Math.max(0, Math.ceil((closesAt - now) / (1000 * 60 * 60 * 24)));
      details += `<div class="deal-detail">Insurance closes in ${daysLeft} day${daysLeft !== 1 ? 's' : ''} — closes clean if no OD reported</div>`;
    }
    body.innerHTML = details;
  } else {
    activeDealSection.classList.add('hidden');
  }

  // Buy button
  const buyBtn = document.getElementById('buy-btn');
  const buyStatus = document.getElementById('buy-status');

  if (hasActive) {
    buyBtn.disabled = true;
    buyBtn.textContent = 'Request In Progress';
    buyStatus.textContent = 'You have an active deal. Wait for it to close before requesting again.';
  } else {
    buyBtn.disabled = false;
    buyBtn.textContent = 'Request Happy Jump — ' + $(pricing.suggestedPrice);
    buyStatus.textContent = 'This submits a request. Giro will trade with you in-game to deliver the items.';

    // Wire up buy action (replace handler each time)
    buyBtn.onclick = async () => {
      buyBtn.disabled = true;
      buyBtn.textContent = 'Processing...';
      try {
        const txn = await createTransaction({
          torn_id: player.torn_id,
          torn_name: player.torn_name,
          torn_faction: player.torn_faction,
          torn_level: player.torn_level,
        });
        showToast('Request submitted! Giro will initiate a trade with you in-game.', 'success');
        buyBtn.textContent = 'Request In Progress';
        buyStatus.textContent = 'Your request has been submitted. Giro will trade with you in-game to deliver the package and collect payment.';

        // Refresh history to show active deal
        const updatedHistory = await getPlayerTransactions(player.torn_id);
        renderHistory(updatedHistory.transactions);
        renderActiveDeal(updatedHistory.transactions);
      } catch (err) {
        showToast(err.message, 'error');
        buyBtn.disabled = false;
        buyBtn.textContent = 'Request Happy Jump — ' + $(pricing.suggestedPrice);
      }
    };
  }

  // History
  renderHistory(history.transactions);

  // Tier ladder with current highlight
  renderTierLadder(cleanCount, config);

  // Back button
  document.getElementById('back-btn').onclick = () => {
    playerViewEl.classList.add('hidden');
    storefrontEl.classList.remove('hidden');
    toastEl.classList.add('hidden');
  };
}

// --- Top form: copy value into main form and submit ---
topForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const key = topInput.value.trim();
  if (!key) return showToast('Please enter an API key.', 'error');
  input.value = key;
  form.dispatchEvent(new Event('submit', { cancelable: true }));
});

function renderActiveDeal(transactions) {
  const activeDealSection = document.getElementById('active-deal-section');
  const activeTxn = (transactions || []).find(
    (t) => t.status === 'requested' || t.status === 'purchased'
  );
  if (activeTxn) {
    activeDealSection.classList.remove('hidden');
    const body = document.getElementById('active-deal-body');
    const statusLabel = activeTxn.status === 'requested'
      ? 'Waiting for Giro to initiate the trade in-game'
      : 'Trade complete — insurance window active';
    let details = `<div class="deal-status">${esc(statusLabel)}</div>`;
    details += `<div class="deal-detail">Price: ${$(activeTxn.suggested_price)}</div>`;
    body.innerHTML = details;
  }
}

function renderHistory(transactions) {
  const section = document.getElementById('history-section');
  const body = document.getElementById('history-body');
  const header = section.querySelector('.card-header');

  if (!transactions || transactions.length === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');

  // Toggle collapse
  if (!header.dataset.bound) {
    header.dataset.bound = '1';
    const toggle = header.querySelector('.toggle');
    header.addEventListener('click', () => {
      body.classList.toggle('collapsed');
      toggle.textContent = body.classList.contains('collapsed') ? '▸ show' : '▾ hide';
    });
  }

  let html = '<table class="history-table"><thead><tr><th>Date</th><th>Status</th><th>Price</th></tr></thead><tbody>';

  for (const txn of transactions) {
    const date = new Date(txn.created_at).toLocaleDateString();
    const pillClass = getStatusPillClass(txn.status);
    const label = formatStatus(txn.status);
    html += `<tr>
      <td>${esc(date)}</td>
      <td><span class="status-pill ${pillClass}">${esc(label)}</span></td>
      <td>${$(txn.suggested_price)}</td>
    </tr>`;
  }

  html += '</tbody></table>';
  body.innerHTML = html;
}

function getStatusPillClass(status) {
  if (status === 'closed_clean') return 'clean';
  if (status === 'requested') return 'requested';
  if (status === 'purchased') return 'purchased';
  if (status === 'od_xanax' || status === 'od_ecstasy') return 'od';
  if (status === 'payout_sent') return 'payout';
  return '';
}

function formatStatus(status) {
  const map = {
    requested: 'Requested',
    purchased: 'In Progress',
    closed_clean: 'Clean',
    od_xanax: 'Xanax OD',
    od_ecstasy: 'Ecstasy OD',
    payout_sent: 'Paid Out',
  };
  return map[status] || status;
}

function renderTierLadder(cleanCount, config) {
  const ladder = document.getElementById('pv-tier-ladder');
  const currentTier = getTier(cleanCount);

  ladder.innerHTML = TIERS.map((t) => {
    const isCurrent = t.key === currentTier.key;
    const isAchieved = cleanCount >= t.min;
    const tierPricing = calcPricing(config, t.margin);
    return `<div class="tier-row ${isCurrent ? 'current-tier' : ''}">
      <span class="tier-badge ${t.css}">${esc(t.name)}</span>
      <span class="tier-detail">${t.min}+ clean jumps</span>
      <span class="tier-price">${$(tierPricing.suggestedPrice)}</span>
      ${isAchieved ? '<span class="tier-check">&#10003;</span>' : ''}
    </div>`;
  }).join('');
}

// --- Helpers ---

function showToast(msg, type = 'error') {
  toastEl.textContent = msg;
  toastEl.className = `toast ${type}`;
}

function esc(str) {
  const el = document.createElement('span');
  el.textContent = str ?? '';
  return el.innerHTML;
}
