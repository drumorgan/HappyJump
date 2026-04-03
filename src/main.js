import { getConfig, validatePlayer, createTransaction, getAvailability, getPlayerTransactions, fetchMarketPrices, reportOd, checkEcstasyUsage, verifyPayment, getPublicStats } from './api.js';
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
let selectedProduct = 'package'; // 'package' | 'insurance' | 'ecstasy_only'
const topForm = document.getElementById('api-form-top');
const topInput = document.getElementById('api-key-top');

function showToast(msg, type) { _showToast(toastEl, msg, type); }

// --- Tier definitions (margins loaded from config) ---
const TIERS = [
  { key: 'new', name: 'Straniero', min: 0, marginField: 'margin_new', margin: 0.18, css: 'straniero' },
  { key: 'safe', name: 'Amico', min: 1, marginField: 'margin_safe', margin: 0.15, css: 'amico' },
  { key: 'road', name: 'Braccio Destro', min: 3, marginField: 'margin_road', margin: 0.12, css: 'braccio-destro' },
  { key: 'legend', name: 'Famiglia', min: 5, marginField: 'margin_legend', margin: 0.10, css: 'famiglia' },
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

// Ecstasy-only insurance: covers only the Ecstasy step (5% OD rate, flat)
function calcEcstasyOnlyPricing(config, margin) {
  const xanaxPrice = Number(config.xanax_price);
  const edvdPrice = Number(config.edvd_price);
  const ecstasyPrice = Number(config.ecstasy_price);
  const rehabBonus = Number(config.rehab_bonus);

  const packageCost = 4 * xanaxPrice + 5 * edvdPrice + ecstasyPrice;
  const ecstasyPayout = packageCost + rehabBonus;
  const expectedLiability = Number(config.ecstasy_od_pct) * ecstasyPayout;
  const suggestedPrice = Math.round(expectedLiability / (1 - margin));

  return { packageCost: 0, xanaxPayout: 0, ecstasyPayout, trueCost: expectedLiability, suggestedPrice };
}

function getPricing(config, margin, product) {
  if (product === 'insurance') return calcInsurancePricing(config, margin);
  if (product === 'ecstasy_only') return calcEcstasyOnlyPricing(config, margin);
  return calcPricing(config, margin);
}

// --- Coverage breakdown HTML builder ---
function buildCoverageHTML(product, pricing, config) {
  const rehabBonus = $(Number(config.rehab_bonus));
  const xanPayout = `4x Xanax + ${rehabBonus} rehab bonus`;
  const ecsPayout = `4x Xanax + 5x EDVD + 1x Ecstasy + ${rehabBonus} rehab bonus`;

  let rows = '';

  if (product === 'package') {
    rows = `
      <tr>
        <td class="cov-condition">OD on Xanax (pills 1-4)</td>
        <td class="cov-payout">${xanPayout}</td>
      </tr>
      <tr>
        <td class="cov-condition">OD on Ecstasy</td>
        <td class="cov-payout">${ecsPayout}</td>
      </tr>
      <tr>
        <td class="cov-clean">No OD (clean jump)</td>
        <td class="cov-clean">You keep your Happy Jump profits</td>
      </tr>`;
  } else if (product === 'insurance') {
    rows = `
      <tr>
        <td class="cov-condition">OD on Xanax (pills 1-4)</td>
        <td class="cov-payout">${xanPayout}</td>
      </tr>
      <tr>
        <td class="cov-condition">OD on Ecstasy</td>
        <td class="cov-payout">${ecsPayout}</td>
      </tr>
      <tr>
        <td class="cov-clean">No OD (clean jump)</td>
        <td class="cov-clean">Insurance expires after 7 days</td>
      </tr>`;
  } else {
    // ecstasy_only
    rows = `
      <tr>
        <td class="cov-condition">OD on Ecstasy</td>
        <td class="cov-payout">${ecsPayout}</td>
      </tr>
      <tr>
        <td class="cov-condition">OD on Xanax</td>
        <td class="cov-not-covered">NOT COVERED</td>
      </tr>
      <tr>
        <td class="cov-clean">No OD (clean jump)</td>
        <td class="cov-clean">Insurance expires after 7 days</td>
      </tr>`;
  }

  let html = `<table class="coverage-table">
    <thead><tr><th>Outcome</th><th>What You Get</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;

  html += `<p class="coverage-note">Coverage is valid for <strong style="color:#c8aa6e">7 days</strong> from purchase. Report any OD within that window and you're fully covered.</p>`;

  return html;
}


// --- Product tab switching (storefront) ---
let storefrontConfig = null;
let storefrontAvail = null;

function updateAnonPricing() {
  if (!storefrontConfig) return;
  const pricing = getPricing(storefrontConfig, TIERS[0].margin, selectedProduct);

  document.getElementById('anon-price').textContent = $(pricing.suggestedPrice);

  // Header, note, and contents per product
  const priceHeader = document.getElementById('anon-price-header');
  const priceNote = document.getElementById('anon-price-note');
  const contentsEl = document.getElementById('anon-contents');
  if (selectedProduct === 'ecstasy_only') {
    priceHeader.textContent = 'Premium';
    priceNote.textContent = 'Current premium — Straniero rate';
    contentsEl.textContent = 'Ecstasy OD insurance only — covers the final step';
  } else if (selectedProduct === 'insurance') {
    priceHeader.textContent = 'Premium';
    priceNote.textContent = 'Current premium — Straniero rate';
    contentsEl.textContent = 'Full OD insurance — no items included';
  } else {
    priceHeader.textContent = 'Package Price';
    priceNote.textContent = 'Current package price — Straniero rate';
    contentsEl.textContent = '4x Xanax + 5x Erotic DVD + 1x Ecstasy';
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

  // Update storefront coverage breakdown
  const anonCoverageBody = document.getElementById('anon-coverage-body');
  if (anonCoverageBody) {
    anonCoverageBody.innerHTML = buildCoverageHTML(selectedProduct, pricing, storefrontConfig);
  }
}

function switchProduct(product) {
  selectedProduct = product;

  // Update tab active states in both storefront and player view
  document.querySelectorAll('.product-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.product === product);
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

    // Load public stats (non-blocking)
    getPublicStats().then((stats) => {
      document.getElementById('stat-customers').textContent = stats.happy_customers;
      document.getElementById('stat-jumps').textContent = stats.total_jumps;
      document.getElementById('stat-paid').textContent = $(stats.total_paid_out);

      // Dynamically apply best-seller badge
      if (stats.best_seller) {
        document.querySelectorAll('.product-tab').forEach(tab => {
          tab.classList.remove('best-seller');
          const existingTag = tab.querySelector('.best-seller-tag');
          if (existingTag) existingTag.remove();
        });
        document.querySelectorAll(`.product-tab[data-product="${stats.best_seller}"]`).forEach(tab => {
          tab.classList.add('best-seller');
          const tag = document.createElement('span');
          tag.className = 'best-seller-tag';
          tag.textContent = 'Best Seller';
          tab.prepend(tag);
        });
      }
    }).catch(() => {});

    // Populate all storefront pricing/coverage/tiers via the shared updater
    updateAnonPricing();

    const availEl = document.getElementById('anon-availability');
    if (avail.available > 0) {
      availEl.textContent = `Current Reserves: ${avail.available}`;
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
  const isFamigliaPermanent = history.famiglia_permanent === true;
  const tier = getTier(cleanCount);
  const isReturning = (history.transactions || []).length > 0;

  // Welcome
  const greeting = isReturning ? 'Welcome back' : 'Welcome';
  document.getElementById('pv-name').textContent = `${greeting}, ${player.torn_name}`;
  document.getElementById('pv-meta').textContent = `Level ${player.torn_level} | ${player.torn_faction || 'No faction'} | ${cleanCount} clean jump${cleanCount !== 1 ? 's' : ''}`;

  // Tier badge — Famiglia members get a permanent marker
  const permanentTag = isFamigliaPermanent ? ' <span class="famiglia-permanent-tag">Permanent</span>' : '';
  document.getElementById('pv-tier-badge').innerHTML =
    `<span class="tier-badge ${tier.css}">${esc(tier.name)}</span>${permanentTag}`;

  // When there's an active deal, set selectedProduct to match it and hide the pricing card.
  // Keep product tabs visible so they can browse tier prices for either product.
  const personalPricingCard = document.getElementById('personal-pricing-card');
  const activeTxn = (history.transactions || []).find(
    (t) => ['requested', 'purchased', 'od_xanax', 'od_ecstasy'].includes(t.status),
  );
  if (hasActive && activeTxn) {
    const activeProduct = activeTxn.product_type === 'ecstasy_only' ? 'ecstasy_only'
      : activeTxn.product_type === 'insurance' ? 'insurance' : 'package';
    switchProduct(activeProduct);
    personalPricingCard.classList.add('hidden');
  } else {
    personalPricingCard.classList.remove('hidden');
  }

  // Helper to update player view pricing and buy button for selected product
  function updatePlayerPricing() {
    const pricing = getPricing(config, tier.margin, selectedProduct);
    const isInsurance = selectedProduct === 'insurance';
    const isEcstasyOnly = selectedProduct === 'ecstasy_only';

    // Price header
    const headers = { package: 'Your Package Price', insurance: 'Your Premium', ecstasy_only: 'Your Premium' };
    document.getElementById('pv-price-header').textContent = headers[selectedProduct] || headers.package;

    // Personal pricing
    document.getElementById('pv-price').textContent = $(pricing.suggestedPrice);
    document.getElementById('pv-price-note').textContent =
      `${tier.name} rate (${Math.round(tier.margin * 100)}% margin)`;

    // Package contents
    const contentsEl = document.getElementById('pv-contents');
    if (isEcstasyOnly) {
      contentsEl.textContent = 'Ecstasy OD insurance only — covers the final step';
    } else if (isInsurance) {
      contentsEl.textContent = 'Full OD insurance — no items included';
    } else {
      contentsEl.textContent = '4x Xanax + 5x Erotic DVD + 1x Ecstasy';
    }

    // Coverage breakdown
    const pvCoverageBody = document.getElementById('pv-coverage-body');
    if (pvCoverageBody) {
      pvCoverageBody.innerHTML = buildCoverageHTML(selectedProduct, pricing, config);
    }

    // Buy button
    const buyBtn = document.getElementById('buy-btn');
    const buyStatus = document.getElementById('buy-status');
    const buySection = document.getElementById('buy-section');

    if (hasActive) {
      buySection.classList.add('hidden');
    } else {
      buySection.classList.remove('hidden');
      buyBtn.disabled = false;

      if (isEcstasyOnly) {
        buyBtn.textContent = "Request L'Ultimo Miglio — " + $(pricing.suggestedPrice);
        buyStatus.textContent = 'This submits an insurance request for Ecstasy OD only. Giro will collect the premium via in-game trade.';
      } else if (isInsurance) {
        buyBtn.textContent = 'Request Protezione Totale — ' + $(pricing.suggestedPrice);
        buyStatus.textContent = 'This submits a full insurance request. Giro will collect the premium via in-game trade.';
      } else {
        buyBtn.textContent = 'Request La Bella Vita — ' + $(pricing.suggestedPrice);
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
          const productLabels = { package: 'La Bella Vita', insurance: 'Protezione Totale', ecstasy_only: "L'Ultimo Miglio" };
          const productLabel = productLabels[selectedProduct] || 'package';
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
      ? 'Waiting for payment'
      : 'Trade complete — insurance window active';
    let details = `<div class="deal-status">${esc(statusLabel)}</div>`;
    details += `<div class="deal-detail">Price: ${$(activeTxn.suggested_price)}</div>`;

    // Payment section for requested transactions
    if (activeTxn.status === 'requested') {
      const isPackage = activeTxn.product_type === 'package';
      const amountPaid = Number(activeTxn.amount_paid || 0);
      const owed = Number(activeTxn.suggested_price);
      const balanceDue = owed - amountPaid;

      if (isPackage) {
        // Package: client must initiate an in-game trade (operator delivers items)
        details += `
          <div class="payment-verify-section">
            <p class="deal-detail">Initiate a Trade with <strong>GiroVagabondo [3667375]</strong> for <strong>${$(owed)}</strong></p>
            <p class="deal-detail" style="opacity:0.7">Giro will accept the trade and deliver your items in-game.</p>
            <div id="payment-verify-status"></div>
          </div>`;
      } else if (amountPaid > 0 && balanceDue > 0) {
        // Underpaid — show balance due with updated button
        details += `
          <div class="payment-verify-section">
            <p class="deal-detail" style="color:#e8a735">Balance due — please send <strong>${$(balanceDue)}</strong> to <strong>GiroVagabondo [3667375]</strong> and then click here →</p>
            <button id="verify-payment-btn" class="btn-verify-payment" data-txn-id="${activeTxn.id}">I Paid</button>
            <div id="payment-verify-status"></div>
          </div>`;
      } else {
        // Insurance/ecstasy_only: client sends money, then verifies
        details += `
          <div class="payment-verify-section">
            <p class="deal-detail">Please send <strong>${$(owed)}</strong> to <strong>GiroVagabondo [3667375]</strong> and then click here →</p>
            <button id="verify-payment-btn" class="btn-verify-payment" data-txn-id="${activeTxn.id}">I Paid</button>
            <div id="payment-verify-status"></div>
          </div>`;
      }
    }

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

    // Bind the verify payment button
    const verifyBtn = document.getElementById('verify-payment-btn');
    if (verifyBtn) {
      verifyBtn.addEventListener('click', handleVerifyPayment);
    }

    // Proactive check: if purchased, see if Ecstasy was already taken (auto-close policy)
    if (activeTxn.status === 'purchased' && currentApiKey) {
      checkEcstasyUsage(currentApiKey, activeTxn.id).then((result) => {
        if (result && result.policy_closed) {
          showToast(result.detail || 'Policy closed — Ecstasy taken successfully!', 'success');
          // Refresh to show updated status
          getPlayerTransactions(activeTxn.torn_id || '').then((h) => {
            renderActiveDeal(h.transactions);
            renderHistory(h.transactions);
          });
        }
      }).catch(() => { /* silent — non-critical check */ });
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
    } else if (result.policy_closed) {
      // Ecstasy was already taken — policy auto-closed
      statusEl.textContent = result.detail;
      statusEl.className = 'od-report-success';
      showToast(result.detail, 'success');
      const history = await getPlayerTransactions(result.torn_id || '');
      renderActiveDeal(history.transactions);
      renderHistory(history.transactions);
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

async function handleVerifyPayment(e) {
  const btn = e.target;
  const txnId = btn.dataset.txnId;
  const statusEl = document.getElementById('payment-verify-status');

  if (!currentApiKey) {
    statusEl.textContent = 'Session expired — please re-enter your API key.';
    statusEl.className = 'od-report-error';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Verifying...';
  statusEl.textContent = '';

  try {
    const result = await verifyPayment(currentApiKey, txnId);
    if (result.verified) {
      statusEl.textContent = result.detail;
      statusEl.className = 'od-report-success';
      showToast(result.detail, 'success');
      // Refresh the active deal view to show purchased state
      const history = await getPlayerTransactions(result.torn_id || '');
      renderActiveDeal(history.transactions);
      renderHistory(history.transactions);
    } else if (result.underpaid) {
      // Underpaid — refresh deal view to show balance due UI
      statusEl.textContent = '';
      const history = await getPlayerTransactions(result.torn_id || btn.dataset.tornId || '');
      // Update the transaction's amount_paid in local data so renderActiveDeal shows balance
      const txn = (history.transactions || []).find(t => t.id === txnId);
      if (txn) txn.amount_paid = result.amount_paid;
      renderActiveDeal(history.transactions);
      showToast(result.detail, 'error');
    } else {
      let msg = result.detail;
      if (result.debug_entries && result.debug_entries.length > 0) {
        msg += '\n\nRecent log entries found:\n' + result.debug_entries.map((e, i) => `${i + 1}. ${e}`).join('\n');
      }
      statusEl.textContent = msg;
      statusEl.style.whiteSpace = 'pre-wrap';
      statusEl.className = 'od-report-error';
      btn.disabled = false;
      btn.textContent = btn.textContent; // preserve current label
    }
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.className = 'od-report-error';
    btn.disabled = false;
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
    const productLabels = { package: 'Bella Vita', insurance: 'Protezione', ecstasy_only: 'Ultimo Miglio' };
    const productLabel = productLabels[txn.product_type] || 'Package';
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

