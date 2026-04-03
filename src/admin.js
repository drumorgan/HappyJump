import { supabase } from './supabaseClient.js';
import { fetchMarketPrices, updateConfig, adminUpdateStatus, getAvailability, adminUpdateClient, adminRejectAndBlock, adminSyncAllClients, testApiAccess, adminCheckEcstasy, adminCheckPayment } from './api.js';
import { esc, $, getStatusPillClass, formatStatus, showToast as _showToast } from './utils.js';

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
const clientSearch = document.getElementById('client-search');
const refreshClientsBtn = document.getElementById('refresh-clients-btn');
const toastEl = document.getElementById('toast');

function showToast(msg, type) { _showToast(toastEl, msg, type); }

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
    showToast(error.message, 'error');
    return;
  }
  showDashboard();
});

logoutBtn.addEventListener('click', async () => {
  await supabase.auth.signOut();
  dashboard.classList.add('hidden');
  loginSection.classList.remove('hidden');
  toastEl.classList.add('hidden');
});

// --- Dashboard ---
async function showDashboard() {
  loginSection.classList.add('hidden');
  dashboard.classList.remove('hidden');
  await autoCloseExpired();
  await Promise.all([loadStats(), loadTransactions(), loadConfig()]);
}

// --- Auto-close expired transactions (triggers server-side via gateway) ---
async function autoCloseExpired() {
  try {
    await getAvailability();
  } catch (e) {
    // Non-critical; dashboard will still load
  }
}

// --- Stats ---
async function loadStats() {
  const { data: txns, error } = await supabase
    .from('transactions')
    .select('status, suggested_price, package_cost, payout_amount, xanax_payout, ecstasy_payout');

  if (error) {
    showToast('Failed to load stats: ' + error.message, 'error');
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

  const closedStatuses = ['closed_clean', 'payout_sent'];
  const revenue = txns
    .filter((t) => closedStatuses.includes(t.status))
    .reduce((sum, t) => sum + Number(t.suggested_price || 0), 0);

  const paid = txns
    .filter((t) => t.status === 'payout_sent')
    .reduce((sum, t) => sum + Number(t.payout_amount || 0), 0);

  // Net profit = insurance margin (price - drug cost) minus payouts
  const margin = txns
    .filter((t) => closedStatuses.includes(t.status))
    .reduce((sum, t) => sum + (Number(t.suggested_price || 0) - Number(t.package_cost || 0)), 0);
  const net = margin - paid;

  const totalOd = xanOd + ecsOd;
  const totalCompleted = clean + totalOd;
  const expectedPct = 84.1;
  const actualPct = totalCompleted > 0 ? (clean / totalCompleted) * 100 : null;

  document.getElementById('stat-active').textContent = active;

  if (actualPct !== null) {
    document.getElementById('stat-clean').innerHTML =
      `<span style="color:${actualPct >= expectedPct ? '#6bff8e' : '#ff6b81'}">${actualPct.toFixed(1)}%</span>` +
      ` <span style="font-size:0.8rem;color:#888">/</span> ` +
      `<span style="font-size:0.9rem;color:#6bff8e">${expectedPct}%</span>`;
    document.getElementById('stat-success-detail').textContent =
      `${clean} clean · ${totalOd} OD · ${totalCompleted} total`;
  } else {
    document.getElementById('stat-clean').textContent = '—';
    document.getElementById('stat-success-detail').textContent = '';
  }

  const successCard = document.getElementById('stat-success-card');
  if (actualPct !== null && actualPct >= expectedPct) {
    successCard.style.borderColor = '#2a4a2e';
  } else if (actualPct !== null) {
    successCard.style.borderColor = '#4a2a2e';
  }
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
    showToast('Failed to load transactions: ' + error.message, 'error');
    return;
  }

  // Hide blocked players' transactions from active view
  let filtered = txns || [];
  if (filter === 'active') {
    const { data: blockedClients } = await supabase
      .from('clients')
      .select('torn_id')
      .eq('is_blocked', true);
    const blockedIds = new Set((blockedClients || []).map((c) => c.torn_id));
    if (blockedIds.size > 0) {
      filtered = filtered.filter((t) => !blockedIds.has(t.torn_id));
    }
  }

  renderTransactions(filtered);
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
    const productBadge = t.product_type === 'ecstasy_only'
      ? '<span class="product-badge ecstasy-only">Ultimo Miglio</span>'
      : t.product_type === 'insurance'
      ? '<span class="product-badge shield">Protezione</span>'
      : '<span class="product-badge package">Bella Vita</span>';

    let actionsHtml = '';
    switch (t.status) {
      case 'requested':
        actionsHtml = `<div class="collect-banner">Collect: ${$(t.suggested_price)}</div>
          <button class="btn-purchase" data-id="${t.id}" data-torn-id="${esc(t.torn_id)}" data-action="purchased">Mark Purchased</button>
          <button class="btn-reject" data-id="${t.id}" data-torn-id="${esc(t.torn_id)}" data-action="rejected">Reject</button>
          <button class="btn-reject-block" data-id="${t.id}" data-torn-id="${esc(t.torn_id)}" data-reject-block="true">Reject &amp; Block</button>`;
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
          ${productBadge}
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

  // Bind reject & block buttons
  txnList.querySelectorAll('[data-reject-block]').forEach((btn) => {
    btn.addEventListener('click', () => handleRejectAndBlock(btn.dataset.tornId, btn));
  });
}

async function handleAction(txnId, tornId, newStatus, btn) {
  btn.disabled = true;
  btn.textContent = 'Updating...';

  try {
    await adminUpdateStatus(txnId, tornId, newStatus);
  } catch (err) {
    showToast('Update failed: ' + err.message, 'error');
    btn.disabled = false;
    btn.textContent = btn.dataset.action;
    return;
  }

  showToast(`Transaction updated to ${formatStatus(newStatus)}`, 'success');
  await Promise.all([loadStats(), loadTransactions(), loadConfig()]);
}

async function handleRejectAndBlock(tornId, btn) {
  btn.disabled = true;
  btn.textContent = 'Updating...';

  try {
    const result = await adminRejectAndBlock(tornId);
    showToast(`Rejected ${result.rejected_count || 0} transaction(s) and blocked player`, 'success');
  } catch (err) {
    showToast('Reject & block failed: ' + err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Reject & Block';
    return;
  }

  await Promise.all([loadStats(), loadTransactions(), loadConfig()]);
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
    query = query.or('is_blocked.is.null,is_blocked.eq.false');
  }

  const { data: clients, error } = await query;
  if (error) {
    showToast('Failed to load clients: ' + error.message, 'error');
    return;
  }

  let filtered = clients || [];
  const searchTerm = (clientSearch.value || '').trim().toLowerCase();
  if (searchTerm) {
    filtered = filtered.filter((c) =>
      (c.torn_name || '').toLowerCase().includes(searchTerm) ||
      String(c.torn_id).includes(searchTerm)
    );
  }

  renderClients(filtered);
}

function getTierBadgeClass(tier) {
  const map = { new: 'straniero', safe: 'amico', road: 'braccio-destro', legend: 'famiglia' };
  return map[tier] || 'straniero';
}

function getTierName(tier) {
  const map = { new: 'Straniero', safe: 'Amico', road: 'Braccio Destro', legend: 'Famiglia' };
  return map[tier] || 'Straniero';
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
        <span class="tier-badge ${tierClass}">${esc(tierName)}</span>${c.famiglia_permanent ? '<span class="famiglia-permanent-tag">Permanent</span>' : ''}
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

      try {
        await adminUpdateClient(tornId, { admin_notes: notes });
        btn.disabled = false;
        btn.textContent = 'Save';
        showToast('Notes saved', 'success');
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Save';
        showToast('Failed to save notes: ' + err.message, 'error');
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

      try {
        await adminUpdateClient(tornId, { is_blocked: newBlocked });
        showToast(newBlocked ? 'Client blocked' : 'Client unblocked', 'success');
        await loadClients();
      } catch (err) {
        showToast('Failed to update: ' + err.message, 'error');
        btn.disabled = false;
        btn.textContent = isCurrentlyBlocked ? 'Unblock' : 'Block';
      }
    });
  });
}

// Client filters
clientTierFilter.addEventListener('change', loadClients);
clientBlockedFilter.addEventListener('change', loadClients);
clientSearch.addEventListener('input', loadClients);
refreshClientsBtn.addEventListener('click', loadClients);

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
  // Reset dirty flag — reserve was just loaded from DB, not manually edited
  window._reserveManuallyEdited = false;
}

// Track manual edits to the reserve field so config saves don't overwrite
// reserve changes made automatically by transaction creates/closes
document.getElementById('cfg-reserve').addEventListener('input', () => {
  window._reserveManuallyEdited = true;
});

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
  };
  // Only include reserve if admin explicitly edited it — prevents stale form
  // values from overwriting reserve changes made by transaction locks/releases
  if (window._reserveManuallyEdited) {
    updates.current_reserve = Number(document.getElementById('cfg-reserve').value.replace(/[^0-9]/g, ''));
  }

  try {
    await updateConfig(updates);
    saveBtn.disabled = false;
    statusEl.textContent = 'Saved';
    statusEl.style.color = '#6bff8e';
    showToast('Config updated', 'success');
    window._reserveManuallyEdited = false;
  } catch (e) {
    saveBtn.disabled = false;
    statusEl.textContent = 'Save failed';
    statusEl.style.color = '#ff6b81';
    showToast('Config save failed: ' + e.message, 'error');
  }
});

// Test Email button
document.getElementById('test-email-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('test-email-btn');
  const statusEl = document.getElementById('config-status');
  btn.disabled = true;
  btn.textContent = 'Sending...';
  statusEl.textContent = '';

  try {
    const { data: { session } } = await supabase.auth.getSession();
    const { data, error } = await supabase.functions.invoke('gateway', {
      body: { action: 'test-email' },
      headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
    });
    if (error) {
      const text = error.context?.body instanceof ReadableStream
        ? await new Response(error.context.body).text()
        : error.message;
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = { error: text }; }
      const envInfo = parsed.envStatus
        ? '\n\nEnv status:\n' + Object.entries(parsed.envStatus).map(([k,v]) => `  ${k}: ${v}`).join('\n')
        : '';
      statusEl.textContent = (parsed.error || 'Failed') + envInfo;
      statusEl.style.color = '#ff6b81';
      showToast('Test email failed: ' + (parsed.error || text), 'error');
    } else if (data?.error) {
      const envInfo = data.envStatus
        ? '\n\nEnv status:\n' + Object.entries(data.envStatus).map(([k,v]) => `  ${k}: ${v}`).join('\n')
        : '';
      statusEl.textContent = data.error + envInfo;
      statusEl.style.color = '#ff6b81';
      showToast('Test email failed: ' + data.error, 'error');
    } else {
      statusEl.textContent = 'Test email sent!';
      statusEl.style.color = '#6bff8e';
      showToast('Test email sent successfully', 'success');
    }
  } catch (e) {
    statusEl.textContent = 'Test email failed: ' + e.message;
    statusEl.style.color = '#ff6b81';
    showToast('Test email failed: ' + e.message, 'error');
  }

  btn.disabled = false;
  btn.textContent = 'Test Email';
});

// Client API Key Diagnostics
document.getElementById('diag-test-btn')?.addEventListener('click', async () => {
  const keyInput = document.getElementById('diag-api-key');
  const resultsEl = document.getElementById('diag-results');
  const btn = document.getElementById('diag-test-btn');
  const apiKey = keyInput.value.trim();

  if (!apiKey) {
    resultsEl.innerHTML = '<span style="color:#ff6b81">Enter a client API key first.</span>';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Testing...';
  resultsEl.textContent = '';

  try {
    const result = await testApiAccess(apiKey);
    const r = result.results;
    const icon = (ok) => ok ? '<span style="color:#6bff8e">✓</span>' : '<span style="color:#ff6b81">✗</span>';

    resultsEl.innerHTML = [
      `${icon(r.basic?.ok)} <strong>Basic/Profile:</strong> ${r.basic?.ok ? r.basic.detail : r.basic?.detail || 'Failed'}`,
      `${icon(r.events?.ok)} <strong>Events</strong> (OD reporting): ${r.events?.detail || 'Failed'}`,
      `${icon(r.log?.ok)} <strong>Log</strong> (payment verification): ${r.log?.detail || 'Failed'}`,
      result.ok
        ? '<span style="color:#6bff8e">All permissions OK</span>'
        : '<span style="color:#ff6b81">Key is missing required permissions</span>',
    ].join('<br>');
  } catch (e) {
    resultsEl.innerHTML = `<span style="color:#ff6b81">Test failed: ${e.message}</span>`;
  }

  btn.disabled = false;
  btn.textContent = 'Test Permissions';
});

// Check Ecstasy Usage (admin diagnostics)
document.getElementById('diag-ecstasy-btn')?.addEventListener('click', async () => {
  const keyInput = document.getElementById('diag-api-key');
  const resultsEl = document.getElementById('diag-results');
  const btn = document.getElementById('diag-ecstasy-btn');
  const apiKey = keyInput.value.trim();

  if (!apiKey) {
    resultsEl.innerHTML = '<span style="color:#ff6b81">Enter a client API key first.</span>';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Checking...';
  resultsEl.textContent = '';

  try {
    const result = await adminCheckEcstasy(apiKey);
    const lines = [`<strong>${esc(result.player)}</strong>`];

    if (result.ecstasy_events.length === 0) {
      lines.push('<span style="color:#888">No Ecstasy events found in recent history.</span>');
    } else {
      for (const evt of result.ecstasy_events) {
        const date = new Date(evt.timestamp * 1000).toLocaleString();
        const color = evt.type === 'od' ? '#ff6b81' : '#6bff8e';
        const label = evt.type === 'od' ? 'OD' : 'USED';
        lines.push(`<span style="color:${color}">[${label}]</span> ${date} — ${esc(evt.text)}`);
      }
    }

    if (result.has_usage) {
      lines.push('<br><span style="color:#e8a735;font-weight:bold">Ecstasy was taken — policy should auto-close if active.</span>');
    }

    // Debug info
    if (result.debug) {
      const d = result.debug;
      lines.push(`<br><span style="color:#666;font-size:0.8rem">DEBUG: ${d.total_combined} total (${d.events_count} events, ${d.log_count} log, ${d.log_pages_scanned} pages scanned)</span>`);
      lines.push(`<span style="color:#666;font-size:0.75rem">Ecstasy mentions: ${d.ecstasy_mentions?.length > 0 ? d.ecstasy_mentions.join(', ') : 'none'}</span>`);
      if (d.sample_log_entry) {
        lines.push(`<span style="color:#666;font-size:0.75rem">Sample log: ${esc(JSON.stringify(d.sample_log_entry).slice(0, 500))}</span>`);
      }
    }

    resultsEl.innerHTML = lines.join('<br>');
  } catch (e) {
    resultsEl.innerHTML = `<span style="color:#ff6b81">Check failed: ${esc(e.message)}</span>`;
  }

  btn.disabled = false;
  btn.textContent = 'Check Ecstasy Usage';
});

// Check Payment diagnostics — scans API key owner's events/log for outgoing payments
document.getElementById('diag-payment-btn')?.addEventListener('click', async () => {
  const keyInput = document.getElementById('diag-api-key');
  const recipientInput = document.getElementById('diag-recipient');
  const resultsEl = document.getElementById('diag-results');
  const btn = document.getElementById('diag-payment-btn');
  const apiKey = keyInput.value.trim();
  const recipient = recipientInput?.value.trim() || null;

  if (!apiKey) {
    resultsEl.innerHTML = '<span style="color:#ff6b81">Enter an API key first.</span>';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Checking...';
  resultsEl.textContent = '';

  try {
    const result = await adminCheckPayment(apiKey, recipient);
    if (result.error) {
      resultsEl.innerHTML = `<span style="color:#ff6b81">${esc(result.error)}</span>`;
      btn.disabled = false;
      btn.textContent = 'Check Payments';
      return;
    }

    const lines = [`<strong>${esc(result.player)}</strong>`];
    lines.push(`<span style="color:#888;font-size:0.8rem">Searching for payments to: <strong>${esc(result.recipient)}</strong> | ${result.total_entries} entries (${result.events_count} events, ${result.log_count} log, ${result.pages_scanned || 1} pages)</span>`);

    if (result.matched_payments && result.matched_payments.length > 0) {
      lines.push('<br><span style="color:#6bff8e;font-weight:bold">Matched payments:</span>');
      for (const m of result.matched_payments) {
        const date = m.timestamp ? new Date(m.timestamp * 1000).toLocaleString() : '?';
        lines.push(`<span style="color:#6bff8e">&#10003;</span> <strong>$${Number(m.amount).toLocaleString()}</strong> — ${date} [${m.source}] — ${esc(m.text)}`);
      }
      lines.push(`<br><span style="color:#6bff8e;font-weight:bold">Total: $${Number(result.total_matched).toLocaleString()}</span>`);
    } else {
      lines.push(`<br><span style="color:#ff6b81;font-weight:bold">No payments to ${esc(result.recipient)} found.</span>`);
    }

    if (result.money_log_entries && result.money_log_entries.length > 0) {
      lines.push('<br><span style="color:#e8a735">Money-related log entries (structured):</span>');
      for (const m of result.money_log_entries) {
        const date = m.timestamp ? new Date(m.timestamp * 1000).toLocaleString() : '?';
        lines.push(`<span style="color:#888;font-size:0.8rem">${date} — title: ${esc(m.title)} | data: ${esc(m.data)}</span>`);
      }
    }

    if (result.money_event_entries && result.money_event_entries.length > 0) {
      lines.push('<br><span style="color:#e8a735">Money-related event entries (text):</span>');
      for (const m of result.money_event_entries) {
        const date = m.timestamp ? new Date(m.timestamp * 1000).toLocaleString() : '?';
        lines.push(`<span style="color:#888;font-size:0.8rem">[event] ${date} — ${esc(m.text)}</span>`);
      }
    }

    if (!result.matched_payments || result.matched_payments.length === 0) {
      if (result.sample_log_entries && result.sample_log_entries.length > 0) {
        lines.push('<br><span style="color:#666">Sample log entries (first 5):</span>');
        for (const s of result.sample_log_entries) {
          const date = s.timestamp ? new Date(s.timestamp * 1000).toLocaleString() : '?';
          lines.push(`<span style="color:#666;font-size:0.75rem">${date} — title: ${esc(s.title)}${s.data ? ' | data: ' + esc(s.data) : ''}</span>`);
        }
      }
      if (result.sample_entries && result.sample_entries.length > 0) {
        lines.push('<br><span style="color:#666">Sample event entries (first 5):</span>');
        for (const s of result.sample_entries) {
          const date = s.timestamp ? new Date(s.timestamp * 1000).toLocaleString() : '?';
          lines.push(`<span style="color:#666;font-size:0.75rem">[event] ${date} — ${esc(s.text)}</span>`);
        }
      }
    }

    resultsEl.innerHTML = lines.join('<br>');
  } catch (e) {
    resultsEl.innerHTML = `<span style="color:#ff6b81">Check failed: ${esc(e.message)}</span>`;
  }

  btn.disabled = false;
  btn.textContent = 'Check Payments';
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
    if (prices.xanax) document.getElementById('cfg-xanax-price').value = '$' + Number(prices.xanax.market_value).toLocaleString();
    if (prices.edvd) document.getElementById('cfg-edvd-price').value = '$' + Number(prices.edvd.market_value).toLocaleString();
    if (prices.ecstasy) document.getElementById('cfg-ecstasy-price').value = '$' + Number(prices.ecstasy.market_value).toLocaleString();
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
