import { supabase } from './supabaseClient.js';
import { fetchMarketPrices, updateConfig } from './api.js';

// --- DOM refs ---
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
const clientList = document.getElementById('client-list');
const clientTierFilter = document.getElementById('client-tier-filter');
const clientBlockedFilter = document.getElementById('client-blocked-filter');
const refreshClientsBtn = document.getElementById('refresh-clients-btn');

const $ = (v) => '$' + Math.round(Number(v)).toLocaleString();

// --- Tab switching ---
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');

    if (btn.dataset.tab === 'clients') loadClients();
  });
});

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
    console.log(error.message, 'error');
    return;
  }
  showDashboard();
});

logoutBtn.addEventListener('click', async () => {
  await supabase.auth.signOut();
  dashboard.classList.add('hidden');
  loginSection.classList.remove('hidden');
  console.log('Logged out', 'success');
});

// --- Dashboard ---
async function showDashboard() {
  loginSection.classList.add('hidden');
  dashboard.classList.remove('hidden');
  await autoCloseExpired();
  await Promise.all([loadStats(), loadTransactions(), loadConfig()]);
}

// --- Auto-close expired transactions ---
async function autoCloseExpired() {
  const now = new Date().toISOString();
  const { data: expired } = await supabase
    .from('transactions')
    .select('id, torn_id, ecstasy_payout')
    .eq('status', 'purchased')
    .lt('closes_at', now);

  if (!expired || expired.length === 0) return;

  for (const txn of expired) {
    await supabase
      .from('transactions')
      .update({ status: 'closed_clean', closed_at: now })
      .eq('id', txn.id);

    // Release locked reserve
    const { data: cfg } = await supabase.from('config').select('current_reserve').single();
    if (cfg) {
      await supabase
        .from('config')
        .update({ current_reserve: cfg.current_reserve + (txn.ecstasy_payout || 0) })
        .eq('id', 1);
    }

    // Sync client stats
    if (txn.torn_id) await syncClientStats(txn.torn_id);
  }
}

// --- Stats ---
async function loadStats() {
  const { data: txns, error } = await supabase
    .from('transactions')
    .select('status, suggested_price, package_cost, payout_amount, xanax_payout, ecstasy_payout');

  if (error) {
    console.log('Failed to load stats: ' + error.message, 'error');
    return;
  }

  const active = txns.filter((t) => ['requested', 'purchased', 'od_xanax', 'od_ecstasy'].includes(t.status)).length;
  const clean = txns.filter((t) => t.status === 'closed_clean').length;

  // Count ODs including payout_sent transactions (status changed from od_* to payout_sent)
  let xanOd = txns.filter((t) => t.status === 'od_xanax').length;
  let ecsOd = txns.filter((t) => t.status === 'od_ecstasy').length;
  txns.filter((t) => t.status === 'payout_sent' && t.payout_amount).forEach((t) => {
    if (t.payout_amount === t.xanax_payout) xanOd++;
    else if (t.payout_amount === t.ecstasy_payout) ecsOd++;
  });

  const closedStatuses = ['closed_clean', 'od_xanax', 'od_ecstasy', 'payout_sent'];
  const revenue = txns
    .filter((t) => closedStatuses.includes(t.status))
    .reduce((sum, t) => sum + (t.suggested_price || 0), 0);

  const paid = txns.reduce((sum, t) => sum + (t.payout_amount || 0), 0);

  // Net profit = insurance margin (price - drug cost) minus payouts
  const margin = txns
    .filter((t) => closedStatuses.includes(t.status))
    .reduce((sum, t) => sum + ((t.suggested_price || 0) - (t.package_cost || 0)), 0);
  const net = margin - paid;

  document.getElementById('stat-active').textContent = active;
  document.getElementById('stat-clean').textContent = clean;
  document.getElementById('stat-revenue').textContent = $(revenue);
  document.getElementById('stat-paid').textContent = $(paid);
  document.getElementById('stat-net').textContent = $(net);
  document.getElementById('stat-net').style.color = net >= 0 ? '#6bff8e' : '#ff6b81';
}

// --- Transactions ---
async function loadTransactions() {
  const filter = statusFilter.value;
  let query = supabase
    .from('transactions')
    .select('*')
    .order('created_at', { ascending: false });

  if (filter === 'active') {
    query = query.in('status', ['requested', 'purchased', 'od_xanax', 'od_ecstasy']);
  } else if (filter !== 'all') {
    query = query.eq('status', filter);
  }

  const { data: txns, error } = await query;
  if (error) {
    console.log('Failed to load transactions: ' + error.message, 'error');
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
        actionsHtml = `<div class="collect-banner">Collect: ${$(t.suggested_price)}</div>
          <button class="btn-purchase" data-id="${t.id}" data-torn-id="${esc(t.torn_id)}" data-action="purchased">Mark Purchased</button>`;
        break;
      case 'purchased':
        actionsHtml = `
          <button class="btn-od-xan" data-id="${t.id}" data-torn-id="${esc(t.torn_id)}" data-action="od_xanax">Xanax OD</button>
          <button class="btn-od-ecs" data-id="${t.id}" data-torn-id="${esc(t.torn_id)}" data-action="od_ecstasy">Ecstasy OD</button>
          <button class="btn-close" data-id="${t.id}" data-torn-id="${esc(t.torn_id)}" data-action="closed_clean">Close Clean</button>`;
        break;
      case 'od_xanax':
      case 'od_ecstasy':
        actionsHtml = `<button class="btn-payout" data-id="${t.id}" data-torn-id="${esc(t.torn_id)}" data-action="payout_sent">Payout Sent</button>`;
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
    btn.addEventListener('click', () => handleAction(btn.dataset.id, btn.dataset.tornId, btn.dataset.action, btn));
  });
}

async function handleAction(txnId, tornId, newStatus, btn) {
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
    console.log('Update failed: ' + error.message, 'error');
    btn.disabled = false;
    btn.textContent = btn.dataset.action;
    return;
  }

  // Update reserves: liability was locked at transaction creation (requested status).
  // closed_clean: release full lock | payout_sent: release lock minus actual payout
  if (newStatus === 'closed_clean' || newStatus === 'payout_sent') {
    const { data: txn } = await supabase
      .from('transactions')
      .select('ecstasy_payout, payout_amount')
      .eq('id', txnId)
      .single();

    if (txn) {
      const { data: cfg } = await supabase.from('config').select('current_reserve').single();
      if (cfg) {
        let newReserve = cfg.current_reserve;
        if (newStatus === 'closed_clean') newReserve += (txn.ecstasy_payout || 0);
        if (newStatus === 'payout_sent') newReserve += (txn.ecstasy_payout || 0) - (txn.payout_amount || 0);

        await supabase.from('config').update({ current_reserve: newReserve }).eq('id', 1);
      }
    }
  }

  // Sync client stats after status change
  if (tornId) {
    await syncClientStats(tornId);
  }

  console.log(`Transaction updated to ${formatStatus(newStatus)}`, 'success');
  await Promise.all([loadStats(), loadTransactions(), loadConfig()]);
}

// --- Client stat sync ---
function computeTier(cleanCount) {
  if (cleanCount >= 5) return 'legend';
  if (cleanCount >= 3) return 'road';
  if (cleanCount >= 1) return 'safe';
  return 'new';
}

function computeCleanStreak(txns) {
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

async function syncClientStats(tornId) {
  const { data: txns, error } = await supabase
    .from('transactions')
    .select('status, suggested_price, payout_amount, created_at')
    .eq('torn_id', tornId);

  if (error) {
    console.warn('Failed to sync client stats:', error.message);
    return;
  }

  const list = txns || [];
  const cleanCount = computeCleanStreak(list);
  const txnCount = list.length;
  const totalSpent = list
    .filter((t) => ['closed_clean', 'payout_sent'].includes(t.status))
    .reduce((s, t) => s + (t.suggested_price || 0), 0);
  const totalPayouts = list
    .filter((t) => t.status === 'payout_sent')
    .reduce((s, t) => s + (t.payout_amount || 0), 0);

  await supabase.from('clients').update({
    clean_count: cleanCount,
    tier: computeTier(cleanCount),
    transaction_count: txnCount,
    total_spent: totalSpent,
    total_payouts: totalPayouts,
    updated_at: new Date().toISOString(),
  }).eq('torn_id', tornId);
}

// --- Clients tab ---
async function loadClients() {
  let query = supabase
    .from('clients')
    .select('*')
    .order('updated_at', { ascending: false });

  const tierFilter = clientTierFilter.value;
  if (tierFilter !== 'all') {
    query = query.eq('tier', tierFilter);
  }

  if (clientBlockedFilter.checked) {
    query = query.eq('is_blocked', true);
  }

  const { data: clients, error } = await query;
  if (error) {
    console.log('Failed to load clients: ' + error.message, 'error');
    return;
  }

  renderClients(clients || []);
}

function getTierBadgeClass(tier) {
  const map = { new: 'new-client', safe: 'safe-driver', road: 'road-warrior', legend: 'highway-legend' };
  return map[tier] || 'new-client';
}

function getTierName(tier) {
  const map = { new: 'Standard', safe: 'Safe Driver', road: 'Road Warrior', legend: 'Highway Legend' };
  return map[tier] || 'Standard';
}

function renderClients(clients) {
  if (clients.length === 0) {
    clientList.innerHTML = '<div style="color:#888;text-align:center;padding:2rem">No clients found.</div>';
    return;
  }

  clientList.innerHTML = clients.map((c) => {
    const tierClass = getTierBadgeClass(c.tier);
    const tierName = getTierName(c.tier);
    const faction = c.torn_faction ? ` | ${esc(c.torn_faction)}` : '';
    const firstSeen = new Date(c.first_seen_at).toLocaleDateString();
    const blockedClass = c.is_blocked ? 'client-blocked' : '';
    const blockedBtnClass = c.is_blocked ? 'btn-unblock' : 'btn-block';
    const blockedBtnText = c.is_blocked ? 'Unblock' : 'Block';
    const notesValue = esc(c.admin_notes || '');

    return `<div class="client-card ${blockedClass}" data-torn-id="${esc(c.torn_id)}">
      <div class="client-top">
        <div>
          <span class="txn-player">${esc(c.torn_name)}</span>
          <span class="txn-player-id">[${esc(c.torn_id)}]</span>
          ${c.is_blocked ? '<span class="blocked-badge">BLOCKED</span>' : ''}
        </div>
        <span class="tier-badge ${tierClass}">${esc(tierName)}</span>
      </div>
      <div class="client-stats">
        <span>Lvl ${c.torn_level || '?'}${faction}</span>
        <span>Clean: ${c.clean_count}</span>
        <span>Deals: ${c.transaction_count}</span>
        <span>Spent: ${$(c.total_spent)}</span>
        <span>Payouts: ${$(c.total_payouts)}</span>
        <span>Since: ${firstSeen}</span>
      </div>
      <div class="client-notes-row">
        <input type="text" class="client-notes-input" placeholder="Admin notes..."
               value="${notesValue}" data-torn-id="${esc(c.torn_id)}" />
        <button class="btn-save-notes" data-torn-id="${esc(c.torn_id)}">Save</button>
        <button class="${blockedBtnClass}" data-torn-id="${esc(c.torn_id)}" data-blocked="${c.is_blocked}">${blockedBtnText}</button>
      </div>
    </div>`;
  }).join('');

  // Bind save-notes buttons
  clientList.querySelectorAll('.btn-save-notes').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tornId = btn.dataset.tornId;
      const input = clientList.querySelector(`.client-notes-input[data-torn-id="${tornId}"]`);
      const notes = input.value;

      btn.disabled = true;
      btn.textContent = 'Saving...';

      const { error } = await supabase
        .from('clients')
        .update({ admin_notes: notes, updated_at: new Date().toISOString() })
        .eq('torn_id', tornId);

      btn.disabled = false;
      btn.textContent = 'Save';

      if (error) {
        console.log('Failed to save notes: ' + error.message, 'error');
      } else {
        console.log('Notes saved', 'success');
      }
    });
  });

  // Bind block/unblock buttons
  clientList.querySelectorAll('.btn-block, .btn-unblock').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tornId = btn.dataset.tornId;
      const isCurrentlyBlocked = btn.dataset.blocked === 'true';
      const newBlocked = !isCurrentlyBlocked;

      btn.disabled = true;
      btn.textContent = 'Updating...';

      const { error } = await supabase
        .from('clients')
        .update({ is_blocked: newBlocked, updated_at: new Date().toISOString() })
        .eq('torn_id', tornId);

      if (error) {
        console.log('Failed to update: ' + error.message, 'error');
        btn.disabled = false;
        btn.textContent = isCurrentlyBlocked ? 'Unblock' : 'Block';
      } else {
        console.log(newBlocked ? 'Client blocked' : 'Client unblocked', 'success');
        await loadClients();
      }
    });
  });
}

// Client filters
clientTierFilter.addEventListener('change', loadClients);
clientBlockedFilter.addEventListener('change', loadClients);
refreshClientsBtn.addEventListener('click', loadClients);

// --- Config ---
async function loadConfig() {
  const { data, error } = await supabase
    .from('config')
    .select('*')
    .single();

  if (error) {
    console.log('Failed to load config: ' + error.message, 'error');
    return;
  }

  document.getElementById('cfg-xanax-price').value = '$' + Number(data.xanax_price).toLocaleString();
  document.getElementById('cfg-edvd-price').value = '$' + Number(data.edvd_price).toLocaleString();
  document.getElementById('cfg-ecstasy-price').value = '$' + Number(data.ecstasy_price).toLocaleString();
  document.getElementById('cfg-xanax-od').value = data.xanax_od_pct;
  document.getElementById('cfg-ecstasy-od').value = data.ecstasy_od_pct;
  document.getElementById('cfg-rehab').value = '$' + Number(data.rehab_bonus).toLocaleString();
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
    xanax_price: Number(document.getElementById('cfg-xanax-price').value.replace(/[^0-9]/g, '')),
    edvd_price: Number(document.getElementById('cfg-edvd-price').value.replace(/[^0-9]/g, '')),
    ecstasy_price: Number(document.getElementById('cfg-ecstasy-price').value.replace(/[^0-9]/g, '')),
    xanax_od_pct: Number(document.getElementById('cfg-xanax-od').value),
    ecstasy_od_pct: Number(document.getElementById('cfg-ecstasy-od').value),
    rehab_bonus: Number(document.getElementById('cfg-rehab').value.replace(/[^0-9]/g, '')),
    margin_new: Number(document.getElementById('cfg-margin-new').value),
    margin_safe: Number(document.getElementById('cfg-margin-safe').value),
    margin_road: Number(document.getElementById('cfg-margin-road').value),
    margin_legend: Number(document.getElementById('cfg-margin-legend').value),
    current_reserve: Number(document.getElementById('cfg-reserve').value.replace(/[^0-9]/g, '')),
  };

  try {
    await updateConfig(updates);
    saveBtn.disabled = false;
    statusEl.textContent = 'Saved';
    statusEl.style.color = '#6bff8e';
    console.log('Config updated', 'success');
  } catch (e) {
    saveBtn.disabled = false;
    statusEl.textContent = 'Save failed';
    statusEl.style.color = '#ff6b81';
    console.log('Config save failed: ' + e.message, 'error');
  }
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
  await autoCloseExpired();
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

function esc(str) {
  const el = document.createElement('span');
  el.textContent = str ?? '';
  return el.innerHTML;
}

// --- Fetch Live Prices ---
document.getElementById('fetch-prices-btn').addEventListener('click', async () => {
  const apiKey = document.getElementById('cfg-api-key').value.trim();
  if (!apiKey) {
    console.log('Enter your Torn API key to fetch live prices', 'error');
    return;
  }

  const btn = document.getElementById('fetch-prices-btn');
  btn.disabled = true;
  btn.textContent = 'Fetching...';

  try {
    const prices = await fetchMarketPrices(apiKey);
    if (prices.xanax) document.getElementById('cfg-xanax-price').value = '$' + Number(prices.xanax.market_value).toLocaleString();
    if (prices.edvd) document.getElementById('cfg-edvd-price').value = '$' + Number(prices.edvd.market_value).toLocaleString();
    if (prices.ecstasy) document.getElementById('cfg-ecstasy-price').value = '$' + Number(prices.ecstasy.market_value).toLocaleString();
    console.log('Prices updated from Torn market — click Save Config to apply', 'success');
  } catch (err) {
    console.log('Failed to fetch prices: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Fetch Live Prices';
  }
});

// --- Init ---
checkSession();
