import { getConfig, validatePlayer, createTransaction, getAvailability, getPlayerTransactions, fetchMarketPrices, reportOd } from './api.js';
import { esc, $, getStatusPillClass, formatStatus, showToast as _showToast } from './utils.js';

// --- DOM refs ---
const toastEl = document.getElementById('toast');
const storefrontEl = document.getElementById('storefront');
const playerViewEl = document.getElementById('player-view');
const loadingEl = document.getElementById('loading');
const form = document.getElementById('api-form');
const input = document.getElementById('api-key');
const submitBtn = document.getElementById('submit-btn');
let currentApiKey = null;
let selectedProduct = 'package'; // 'package' | 'insurance'
const topForm = document.getElementById('api-form-top');
const topInput = document.getElementById('api-key-top');

function showToast(msg, type) { _showToast(toastEl, msg, type); }

// --- Tier definitions (margins loaded from config) ---
const TIERS = [
  { key: 'new', name: 'Standard', min: 0, marginField: 'margin_new', margin: 0.18, css: 'new-client' },
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
  const xanaxPrice = Number(config.xanax_price);
  const edvdPrice = Number(config.edvd_price);
  const ecstasyPrice = Number(config.ecstasy_price);
  const rehabBonus = Number(config.rehab_bonus);

  const packageCost = 4 * xanaxPrice + 5 * edvdPrice + ecstasyPrice;
  const xanaxPayout = 4 * xanaxPrice + rehabBonus;
  const ecstasyPayout = packageCost + rehabBonus;
  const pXanOd = 1 - Math.pow(1 - Number(config.xanax_od_pct), 4);
  const pEcsOd = Math.pow(1 - Number(config.xanax_od_pct), 4) * Number(config.ecstasy_od_pct);
  const expectedLiability = pXanOd * xanaxPayout + pEcsOd * ecstasyPayout;
  const trueCost = packageCost + expectedLiability;
  const suggestedPrice = Math.round(trueCost / (1 - margin));

  return { packageCost, xanaxPayout, ecstasyPayout, trueCost, suggestedPrice };
}

// Insurance-only: no drug cost, just expected liability + margin
function calcInsurancePricing(config, margin) {
  const xanaxPrice = Number(config.xanax_price);
  const edvdPrice = Number(config.edvd_price);
  const ecstasyPrice = Number(config.ecstasy_price);
  const rehabBonus = Number(config.rehab_bonus);

  const packageCost = 4 * xanaxPrice + 5 * edvdPrice + ecstasyPrice;
  const xanaxPayout = 4 * xanaxPrice + rehabBonus;
  const ecstasyPayout = packageCost + rehabBonus;
  const pXanOd = 1 - Math.pow(1 - Number(config.xanax_od_pct), 4);
  const pEcsOd = Math.pow(1 - Number(config.xanax_od_pct), 4) * Number(config.ecstasy_od_pct);
  const expectedLiability = pXanOd * xanaxPayout + pEcsOd * ecstasyPayout;
  const suggestedPrice = Math.round(expectedLiability / (1 - margin));

  return { packageCost: 0, xanaxPayout, ecstasyPayout, trueCost: expectedLiability, suggestedPrice };
}

function getPricing(config, margin, product) {
  return product === 'insurance' ? calcInsurancePricing(config, margin) : calcPricing(config, margin);
}


// --- Product tab switching (storefront) ---
let storefrontConfig = null;
let storefrontAvail = null;

function updateAnonPricing() {
  if (!storefrontConfig) return;
  const pricing = getPricing(storefrontConfig, TIERS[0].margin, selectedProduct);

  document.getElementById('anon-price').textContent = $(pricing.suggestedPrice);
  const priceNote = document.getElementById('anon-price-note');
  if (selectedProduct === 'insurance') {
    priceNote.textContent = 'Current insurance premium — new client rate';
  } else {
    priceNote.textContent = 'Current package price — new client rate';
  }

  // Update tier ladder prices for selected product
  const anonLadder = document.getElementById('anon-tier-ladder');
  if (anonLadder) {
    anonLadder.innerHTML = TIERS.map((t) => {
      const tierPricing = getPricing(storefrontConfig, t.margin, selectedProduct);
      return `<div class="tier-row" data-tier="${t.key}">
        <span class="tier-badge ${t.css}">${esc(t.name)}</span>
        <span class="tier-detail">${t.min}+ clean jumps</span>
        <span class="tier-price">${$(tierPricing.suggestedPrice)}</span>
      </div>`;
    }).join('');
  }
}

function switchProduct(product) {
  selectedProduct = product;

  // Update tab active states in both storefront and player view
  document.querySelectorAll('.product-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.product === product);
  });

  // Toggle product-specific sections in storefront
  document.querySelectorAll('#storefront .product-section').forEach((el) => {
    el.classList.toggle('hidden', el.dataset.product !== product);
  });

  updateAnonPricing();
}

// Bind product tabs (both storefront and player view tabs)
document.querySelectorAll('.product-tabs').forEach((tabBar) => {
  tabBar.querySelectorAll('.product-tab').forEach((tab) => {
    tab.addEventListener('click', () => switchProduct(tab.dataset.product));
  });
});

// --- Init: load anonymous storefront data ---
async function initStorefront() {
  try {
    const [config, avail] = await Promise.all([getConfig(), getAvailability()]);
    storefrontConfig = config;
    storefrontAvail = avail;
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
    currentApiKey = key;
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
  const isReturning = (history.transactions || []).length > 0;

  // Welcome
  const greeting = isReturning ? 'Welcome back' : 'Welcome';
  document.getElementById('pv-name').textContent = `${greeting}, ${player.torn_name}`;
  document.getElementById('pv-meta').textContent = `Level ${player.torn_level} | ${player.torn_faction || 'No faction'} | ${cleanCount} clean jump${cleanCount !== 1 ? 's' : ''}`;

  // Tier badge
  document.getElementById('pv-tier-badge').innerHTML =
    `<span class="tier-badge ${tier.css}">${esc(tier.name)}</span>`;

  // When there's an active deal, set selectedProduct to match it and hide the pricing card.
  // Keep product tabs visible so they can browse tier prices for either product.
  const personalPricingCard = document.getElementById('personal-pricing-card');
  const activeTxn = (history.transactions || []).find(
    (t) => ['requested', 'purchased', 'od_xanax', 'od_ecstasy'].includes(t.status),
  );
  if (hasActive && activeTxn) {
    const activeProduct = activeTxn.product_type === 'insurance' ? 'insurance' : 'package';
    switchProduct(activeProduct);
    personalPricingCard.classList.add('hidden');
  } else {
    personalPricingCard.classList.remove('hidden');
  }

  // Helper to update player view pricing and buy button for selected product
  function updatePlayerPricing() {
    const pricing = getPricing(config, tier.margin, selectedProduct);
    const isInsurance = selectedProduct === 'insurance';

    // Price header
    document.getElementById('pv-price-header').textContent =
      isInsurance ? 'Your Shield Premium' : 'Your Package Price';

    // Personal pricing
    document.getElementById('pv-price').textContent = $(pricing.suggestedPrice);
    document.getElementById('pv-price-note').textContent =
      `${tier.name} rate (${Math.round(tier.margin * 100)}% margin)`;

    // Buy button
    const buyBtn = document.getElementById('buy-btn');
    const buyStatus = document.getElementById('buy-status');
    const buySection = document.getElementById('buy-section');

    if (hasActive) {
      buySection.classList.add('hidden');
    } else {
      buySection.classList.remove('hidden');
      buyBtn.disabled = false;

      if (isInsurance) {
        buyBtn.textContent = 'Request Happy Jump Shield — ' + $(pricing.suggestedPrice);
        buyStatus.textContent = 'This submits an insurance request. Giro will collect the premium via in-game trade.';
      } else {
        buyBtn.textContent = 'Request Happy Jump — ' + $(pricing.suggestedPrice);
        buyStatus.textContent = 'This submits a request. Giro will trade with you in-game to deliver the items.';
      }

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
            product_type: selectedProduct,
          });
          const productLabel = selectedProduct === 'insurance' ? 'Shield' : 'package';
          showToast(`Request submitted! Giro will initiate a trade with you in-game.`, 'success');
          buyBtn.textContent = 'Request In Progress';
          buyStatus.textContent = `Your ${productLabel} request has been submitted. Giro will trade with you in-game.`;

          // Refresh history to show active deal
          const updatedHistory = await getPlayerTransactions(player.torn_id);
          renderHistory(updatedHistory.transactions);
          renderActiveDeal(updatedHistory.transactions);
        } catch (err) {
          showToast(err.message, 'error');
          buyBtn.disabled = false;
          updatePlayerPricing();
        }
      };
    }

    // Update tier ladder prices for selected product
    renderTierLadder(cleanCount, config);
  }

  // Bind player view product tabs to update pricing
  document.querySelectorAll('#pv-product-tabs .product-tab').forEach((tab) => {
    tab.onclick = () => {
      switchProduct(tab.dataset.product);
      updatePlayerPricing();
    };
  });

  updatePlayerPricing();

  // Active deal (uses shared renderer that includes Report OD button)
  renderActiveDeal(history.transactions);

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
    (t) => t.status === 'requested' || t.status === 'purchased' || t.status === 'od_xanax' || t.status === 'od_ecstasy'
  );
  if (activeTxn) {
    activeDealSection.classList.remove('hidden');
    const body = document.getElementById('active-deal-body');

    if (activeTxn.status === 'od_xanax' || activeTxn.status === 'od_ecstasy') {
      const drugName = activeTxn.status === 'od_xanax' ? 'Xanax' : 'Ecstasy';
      const payoutDesc = activeTxn.status === 'od_xanax'
        ? '4x Xanax + $1M rehab bonus'
        : '4x Xanax + 5x EDVD + 1x Ecstasy + $1M rehab bonus';
      body.innerHTML = `
        <div class="deal-status od-verified">OD on ${esc(drugName)} verified</div>
        <div class="deal-detail">Giro has been notified and will send your payout shortly.</div>
        <div class="deal-detail">Payout: ${payoutDesc}</div>
        <div class="deal-detail">Current value: ${$(activeTxn.payout_amount || 0)}</div>`;
      return;
    }

    const statusLabel = activeTxn.status === 'requested'
      ? 'Waiting for Giro to initiate the trade in-game'
      : 'Trade complete — insurance window active';
    let details = `<div class="deal-status">${esc(statusLabel)}</div>`;
    details += `<div class="deal-detail">Price: ${$(activeTxn.suggested_price)}</div>`;
    if (activeTxn.status === 'purchased' && activeTxn.closes_at) {
      const closesAt = new Date(activeTxn.closes_at);
      const now = new Date();
      const diff = closesAt - now;
      if (diff > 0) {
        const days = Math.floor(diff / 86400000);
        const hours = Math.floor((diff % 86400000) / 3600000);
        const mins = Math.floor((diff % 3600000) / 60000);
        const parts = [];
        if (days > 0) parts.push(`${days}d`);
        if (hours > 0) parts.push(`${hours}h`);
        parts.push(`${mins}m`);
        details += `<div class="deal-detail">Coverage expires in <strong>${parts.join(' ')}</strong></div>`;
      } else {
        details += `<div class="deal-detail">Coverage window has ended</div>`;
      }
      details += `
        <div class="od-report-section">
          <button id="report-od-btn" class="btn-report-od" data-txn-id="${activeTxn.id}">Report OD &amp; Request Payout</button>
          <div id="od-report-status"></div>
        </div>`;
    }
    body.innerHTML = details;

    // Bind the report OD button
    const reportBtn = document.getElementById('report-od-btn');
    if (reportBtn) {
      reportBtn.addEventListener('click', handleReportOd);
    }
  }
}

async function handleReportOd(e) {
  const btn = e.target;
  const txnId = btn.dataset.txnId;
  const statusEl = document.getElementById('od-report-status');

  if (!currentApiKey) {
    statusEl.textContent = 'Session expired — please re-enter your API key.';
    statusEl.className = 'od-report-error';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Verifying...';
  statusEl.textContent = '';

  try {
    const result = await reportOd(currentApiKey, txnId);
    if (result.verified) {
      statusEl.textContent = result.detail;
      statusEl.className = 'od-report-success';
      // Refresh the active deal view
      const history = await getPlayerTransactions(result.torn_id || '');
      renderActiveDeal(history.transactions);
    } else {
      statusEl.textContent = result.detail;
      statusEl.className = 'od-report-error';
      btn.disabled = false;
      btn.textContent = 'Report OD & Request Payout';
    }
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.className = 'od-report-error';
    btn.disabled = false;
    btn.textContent = 'Report OD & Request Payout';
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

  let html = '<table class="history-table"><thead><tr><th>Date</th><th>Type</th><th>Status</th><th>Price</th></tr></thead><tbody>';

  for (const txn of transactions) {
    const date = new Date(txn.created_at).toLocaleDateString();
    const pillClass = getStatusPillClass(txn.status);
    const label = formatStatus(txn.status);
    const productLabel = txn.product_type === 'insurance' ? 'Shield' : 'Package';
    html += `<tr>
      <td>${esc(date)}</td>
      <td>${esc(productLabel)}</td>
      <td><span class="status-pill ${pillClass}">${esc(label)}</span></td>
      <td>${$(txn.suggested_price)}</td>
    </tr>`;
  }

  html += '</tbody></table>';
  body.innerHTML = html;
}


function renderTierLadder(cleanCount, config) {
  const ladder = document.getElementById('pv-tier-ladder');
  const currentTier = getTier(cleanCount);

  ladder.innerHTML = TIERS.map((t) => {
    const isCurrent = t.key === currentTier.key;
    const isAchieved = cleanCount >= t.min;
    const tierPricing = getPricing(config, t.margin, selectedProduct);
    return `<div class="tier-row ${isCurrent ? 'current-tier' : ''}">
      <span class="tier-badge ${t.css}">${esc(t.name)}</span>
      <span class="tier-detail">${t.min}+ clean jumps</span>
      <span class="tier-price">${$(tierPricing.suggestedPrice)}</span>
      ${isAchieved ? '<span class="tier-check">&#10003;</span>' : ''}
    </div>`;
  }).join('');
}

