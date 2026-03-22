import { supabase } from './supabaseClient.js';
import { fetchMarketPrices } from './api.js';

// --- DOM refs ---
const toastEl = document.getElementById('toast');
const loginSection = document.getElementById('login-section');
const dashboard = document.getElementById('dashboard');
const loginForm = document.getElementById('login-form');
const logoutBtn = document.getElementById('logout-btn');
const statusFilter = document.getElementById('status-filter');
const refreshBtn = document.getElementById('refresh-btn');
const txnList = document.getElementById('txn-list');
const configForm = document.getElementById('config-form');
const configHeader = document.getElementById('config-header');
const configBody = document.getElementById('config-body');

const $ = (v) => '$' + Math.round(Number(v)).toLocaleString();

// --- Auth ---
async function checkSession() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) {
    showDashboard();
  }
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    showToast(error.message, 'error');
    return;
  }
  showDashboard();
});

logoutBtn.addEventListener('click', async () => {
  await supabase.auth.signOut();
  dashboard.classList.add('hidden');
  loginSection.classList.remove('hidden');
  showToast('Logged out', 'success');
});

// --- Dashboard ---
async function showDashboard() {
  loginSection.classList.add('hidden');
  dashboard.classList.remove('hidden');
  await Promise.all([loadStats(), loadTransactions(), loadConfig()]);
}

// --- Stats ---
async function loadStats() {
  const { data: txns, error } = await supabase
    .from('transactions')
    .select('status, suggested_price, payout_amount');

  if (error) {
    showToast('Failed to load stats: ' + error.message, 'error');
    return;
  }

  const active = txns.filter((t) => t.status === 'requested' || t.status === 'purchased').length;
  const clean = txns.filter((t) => t.status === 'closed_clean').length;
  const xanOd = txns.filter((t) => t.status === 'od_xanax').length;
  const ecsOd = txns.filter((t) => t.status === 'od_ecstasy').length;

  const closedStatuses = ['closed_clean', 'od_xanax', 'od_ecstasy', 'payout_sent'];
  const revenue = txns
    .filter((t) => closedStatuses.includes(t.status))
    .reduce((sum, t) => sum + (t.suggested_price || 0), 0);

  const paid = txns.reduce((sum, t) => sum + (t.payout_amount || 0), 0);

  document.getElementById('stat-active').textContent = active;
  document.getElementById('stat-clean').textContent = clean;
  document.getElementById('stat-xan-od').textContent = xanOd;
  document.getElementById('stat-ecs-od').textContent = ecsOd;
  document.getElementById('stat-revenue').textContent = $(revenue);
  document.getElementById('stat-paid').textContent = $(paid);
}

// --- Transactions ---
async function loadTransactions() {
  const filter = statusFilter.value;
  let query = supabase
    .from('transactions')
    .select('*')
    .order('created_at', { ascending: false });

  if (filter !== 'all') {
    query = query.eq('status', filter);
  }

  const { data: txns, error } = await query;
  if (error) {
    showToast('Failed to load transactions: ' + error.message, 'error');
    return;
  }

  renderTransactions(txns || []);
}

function renderTransactions(txns) {
  if (txns.length === 0) {
    txnList.innerHTML = '<div style="color:#888;text-align:center;padding:2rem">No transactions found.</div>';
    return;
  }

  txnList.innerHTML = txns.map((t) => {
    const pillClass = getStatusPillClass(t.status);
    const label = formatStatus(t.status);
    const date = new Date(t.created_at).toLocaleDateString();
    const faction = t.torn_faction ? ` | ${esc(t.torn_faction)}` : '';

    let actionsHtml = '';
    switch (t.status) {
      case 'requested':
        actionsHtml = `<button class="btn-purchase" data-id="${t.id}" data-action="purchased">Mark Purchased</button>`;
        break;
      case 'purchased':
        actionsHtml = `
          <button class="btn-od-xan" data-id="${t.id}" data-action="od_xanax">Xanax OD</button>
          <button class="btn-od-ecs" data-id="${t.id}" data-action="od_ecstasy">Ecstasy OD</button>
          <button class="btn-close" data-id="${t.id}" data-action="closed_clean">Close Clean</button>`;
        break;
      case 'od_xanax':
      case 'od_ecstasy':
        actionsHtml = `<button class="btn-payout" data-id="${t.id}" data-action="payout_sent">Payout Sent</button>`;
        break;
    }

    const payoutInfo = t.payout_amount ? ` | Payout: ${$(t.payout_amount)}` : '';
    const closesInfo = t.closes_at ? ` | Closes: ${new Date(t.closes_at).toLocaleDateString()}` : '';

    return `<div class="txn-card">
      <div class="txn-top">
        <div>
          <span class="txn-player">${esc(t.torn_name)}</span>
          <span class="txn-player-id">[${esc(t.torn_id)}]</span>
        </div>
        <span class="status-pill ${pillClass}">${esc(label)}</span>
      </div>
      <div class="txn-meta">
        <span>Lvl ${t.torn_level || '?'}${faction}</span>
        <span>Price: ${$(t.suggested_price)}</span>
        <span>${date}${closesInfo}${payoutInfo}</span>
      </div>
      ${actionsHtml ? `<div class="txn-actions">${actionsHtml}</div>` : ''}
    </div>`;
  }).join('');

  // Bind action buttons
  txnList.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => handleAction(btn.dataset.id, btn.dataset.action, btn));
  });
}

async function handleAction(txnId, newStatus, btn) {
  btn.disabled = true;
  btn.textContent = 'Updating...';

  const updates = { status: newStatus };

  if (newStatus === 'purchased') {
    const now = new Date().toISOString();
    const closesAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    updates.purchased_at = now;
    updates.closes_at = closesAt;
  }

  if (newStatus === 'closed_clean' || newStatus === 'payout_sent') {
    updates.closed_at = new Date().toISOString();
  }

  // For OD statuses, calculate payout amount from the transaction's snapshots
  if (newStatus === 'od_xanax' || newStatus === 'od_ecstasy') {
    const { data: txn } = await supabase
      .from('transactions')
      .select('xanax_payout, ecstasy_payout')
      .eq('id', txnId)
      .single();

    if (txn) {
      updates.payout_amount = newStatus === 'od_xanax' ? txn.xanax_payout : txn.ecstasy_payout;
    }
  }

  const { error } = await supabase
    .from('transactions')
    .update(updates)
    .eq('id', txnId);

  if (error) {
    showToast('Update failed: ' + error.message, 'error');
    btn.disabled = false;
    btn.textContent = btn.dataset.action;
    return;
  }

  showToast(`Transaction updated to ${formatStatus(newStatus)}`, 'success');
  await Promise.all([loadStats(), loadTransactions()]);
}

// --- Config ---
async function loadConfig() {
  const { data, error } = await supabase
    .from('config')
    .select('*')
    .single();

  if (error) {
    showToast('Failed to load config: ' + error.message, 'error');
    return;
  }

  document.getElementById('cfg-xanax-price').value = data.xanax_price;
  document.getElementById('cfg-edvd-price').value = data.edvd_price;
  document.getElementById('cfg-ecstasy-price').value = data.ecstasy_price;
  document.getElementById('cfg-xanax-od').value = data.xanax_od_pct;
  document.getElementById('cfg-ecstasy-od').value = data.ecstasy_od_pct;
  document.getElementById('cfg-rehab').value = data.rehab_bonus;
  document.getElementById('cfg-margin-new').value = data.margin_new;
  document.getElementById('cfg-margin-safe').value = data.margin_safe;
  document.getElementById('cfg-margin-road').value = data.margin_road;
  document.getElementById('cfg-margin-legend').value = data.margin_legend;
  document.getElementById('cfg-reserve').value = '$' + Number(data.current_reserve).toLocaleString();
}

configForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const saveBtn = document.getElementById('config-save-btn');
  const statusEl = document.getElementById('config-status');
  saveBtn.disabled = true;
  statusEl.textContent = 'Saving...';
  statusEl.style.color = '#888';

  const updates = {
    xanax_price: Number(document.getElementById('cfg-xanax-price').value),
    edvd_price: Number(document.getElementById('cfg-edvd-price').value),
    ecstasy_price: Number(document.getElementById('cfg-ecstasy-price').value),
    xanax_od_pct: Number(document.getElementById('cfg-xanax-od').value),
    ecstasy_od_pct: Number(document.getElementById('cfg-ecstasy-od').value),
    rehab_bonus: Number(document.getElementById('cfg-rehab').value),
    margin_new: Number(document.getElementById('cfg-margin-new').value),
    margin_safe: Number(document.getElementById('cfg-margin-safe').value),
    margin_road: Number(document.getElementById('cfg-margin-road').value),
    margin_legend: Number(document.getElementById('cfg-margin-legend').value),
    current_reserve: Number(document.getElementById('cfg-reserve').value.replace(/[^0-9]/g, '')),
  };

  const { data, error } = await supabase.functions.invoke('update-config', {
    body: updates,
  });

  saveBtn.disabled = false;

  if (error || data?.error) {
    statusEl.textContent = 'Save failed';
    statusEl.style.color = '#ff6b81';
    showToast('Config save failed: ' + (data?.error || error.message), 'error');
    return;
  }

  statusEl.textContent = 'Saved';
  statusEl.style.color = '#6bff8e';
  showToast('Config updated', 'success');
});

// Config panel toggle
configHeader.addEventListener('click', () => {
  configBody.classList.toggle('collapsed');
  configHeader.querySelector('.toggle').textContent =
    configBody.classList.contains('collapsed') ? '▸ show' : '▾ hide';
});

// Filter + refresh
statusFilter.addEventListener('change', loadTransactions);
refreshBtn.addEventListener('click', async () => {
  await Promise.all([loadStats(), loadTransactions(), loadConfig()]);
});

// --- Helpers ---
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

function showToast(msg, type = 'error') {
  toastEl.textContent = msg;
  toastEl.className = `toast ${type}`;
}

function esc(str) {
  const el = document.createElement('span');
  el.textContent = str ?? '';
  return el.innerHTML;
}

// --- Fetch Live Prices ---
document.getElementById('fetch-prices-btn').addEventListener('click', async () => {
  const apiKey = document.getElementById('cfg-api-key').value.trim();
  if (!apiKey) {
    showToast('Enter your Torn API key to fetch live prices', 'error');
    return;
  }

  const btn = document.getElementById('fetch-prices-btn');
  btn.disabled = true;
  btn.textContent = 'Fetching...';

  try {
    const prices = await fetchMarketPrices(apiKey);
    if (prices.xanax) document.getElementById('cfg-xanax-price').value = prices.xanax.market_value;
    if (prices.edvd) document.getElementById('cfg-edvd-price').value = prices.edvd.market_value;
    if (prices.ecstasy) document.getElementById('cfg-ecstasy-price').value = prices.ecstasy.market_value;
    showToast('Prices updated from Torn market — click Save Config to apply', 'success');
  } catch (err) {
    showToast('Failed to fetch prices: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Fetch Live Prices';
  }
});

// --- Init ---
checkSession();
