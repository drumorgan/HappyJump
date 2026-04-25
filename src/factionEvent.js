// Faction Events — drinking / drug-use leaderboards.
// Independent from the Happy Jump storefront: its own session table
// (faction_event_player_secrets), its own localStorage entry, its own
// gateway actions. Signing out of one does not sign you out of the other.

import {
  feSetApiKey,
  feAutoLogin,
  feRevokeSession,
  createFactionEvent,
  getFactionEvent,
  listFactionEvents,
  updateFactionEvent,
  joinFactionEvent,
  refreshFactionEvent,
  refreshStaleParticipants,
  fetchTornEventStart,
} from './api.js';
import { esc, showToast as _showToast } from './utils.js';

const toastEl = document.getElementById('toast');
const loadingEl = document.getElementById('loading');

// Per-event "I joined this event" memory. Keyed by event id so a user can
// participate in multiple events with the same FE session. Holds only the
// torn_id of the participant row to find on the leaderboard — no key.
const PER_EVENT_PREFIX = 'faction_event_joined:';

// Single FE session — independent from happyjump_session. Stored as
// { player_id, session_token, torn_id, torn_name, torn_faction }.
const FE_SESSION_STORAGE = 'faction_event_session';

let feSession = null;       // { player_id, session_token, torn_id, torn_name, torn_faction } or null
let currentEvent = null;    // { id, title, drug_*, starts_at, ends_at, creator_torn_id }
let sweepInFlight = false;

function toast(msg, type = 'error') {
  _showToast(toastEl, msg, type);
  toastEl.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.add('hidden'), 6000);
}

function setLoading(on) {
  loadingEl.classList.toggle('hidden', !on);
}

function getEventIdFromUrl() {
  return new URLSearchParams(window.location.search).get('id');
}

function setEventIdInUrl(id) {
  const url = new URL(window.location.href);
  url.searchParams.set('id', id);
  window.history.replaceState({}, '', url.toString());
}

// ── Time helpers ─────────────────────────────────────────────────────

function localInputToIso(localValue) {
  if (!localValue) return null;
  const d = new Date(localValue);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtRelative(ms) {
  const sec = Math.round(ms / 1000);
  if (Math.abs(sec) < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (Math.abs(min) < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (Math.abs(hr) < 24) return `${hr}h`;
  return `${Math.round(hr / 24)}d`;
}

function fmtDateTime(iso) {
  return new Date(iso).toLocaleString();
}

function fmtSlotLabel(d) {
  // "Sat, Apr 25, 9:15 AM"
  return d.toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

// ── Slot picker ──────────────────────────────────────────────────────
// 15-minute slots between event start and end, in viewer-local time.
// Returns [{ value: ISO string, label: viewer-local label }].
function generateSlots(startIso, endIso) {
  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];

  const SLOT_MS = 15 * 60 * 1000;
  // First slot = ceil(start to next 15-min boundary in local time).
  const startD = new Date(startMs);
  const startMin = startD.getMinutes();
  const ceilMin = Math.ceil(startMin / 15) * 15;
  startD.setMinutes(ceilMin, 0, 0);
  let cursor = startD.getTime();
  // If ceiling pushed us before the actual start (rare edge), bump forward.
  while (cursor < startMs) cursor += SLOT_MS;

  const slots = [];
  while (cursor <= endMs && slots.length < 4 * 24 * 31) { // safety cap
    const d = new Date(cursor);
    slots.push({ value: d.toISOString(), label: fmtSlotLabel(d) });
    cursor += SLOT_MS;
  }
  return slots;
}

// Default selection = the slot at-or-before now, clamped into [start, end].
function defaultSlotIso(startIso, endIso, slots) {
  if (slots.length === 0) return '';
  const nowMs = Date.now();
  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();
  const target = Math.min(Math.max(nowMs, startMs), endMs);
  // Find the latest slot <= target, else the first slot.
  let best = slots[0].value;
  for (const s of slots) {
    if (new Date(s.value).getTime() <= target) best = s.value;
    else break;
  }
  return best;
}

function fillSlotPicker(selectEl, startIso, endIso, preferredIso) {
  const slots = generateSlots(startIso, endIso);
  if (slots.length === 0) {
    selectEl.innerHTML = '<option value="">— event window invalid —</option>';
    return;
  }
  selectEl.innerHTML = slots
    .map((s) => `<option value="${esc(s.value)}">${esc(s.label)}</option>`)
    .join('');
  let pick = '';
  if (preferredIso) {
    // Snap to nearest slot
    const tMs = new Date(preferredIso).getTime();
    if (Number.isFinite(tMs)) {
      let bestDiff = Infinity;
      for (const s of slots) {
        const diff = Math.abs(new Date(s.value).getTime() - tMs);
        if (diff < bestDiff) { bestDiff = diff; pick = s.value; }
      }
    }
  }
  if (!pick) pick = defaultSlotIso(startIso, endIso, slots);
  selectEl.value = pick;
}

// ── FE session storage ───────────────────────────────────────────────

function loadFeSession() {
  try {
    const raw = localStorage.getItem(FE_SESSION_STORAGE);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.player_id && parsed.session_token) return parsed;
  } catch {}
  return null;
}

function saveFeSession(s) {
  try { localStorage.setItem(FE_SESSION_STORAGE, JSON.stringify(s)); } catch {}
}

function clearFeSession() {
  try { localStorage.removeItem(FE_SESSION_STORAGE); } catch {}
}

function feAuth() {
  return feSession
    ? { player_id: feSession.player_id, session_token: feSession.session_token }
    : null;
}

// Per-event "did I join" hint — pure UX so we know which leaderboard row is
// "me" without needing the FE session (you stay on the leaderboard even if
// you sign out, per spec). Stores only the torn_id.
function loadJoinedTornId(eventId) {
  try { return localStorage.getItem(PER_EVENT_PREFIX + eventId) || null; } catch { return null; }
}

function saveJoinedTornId(eventId, tornId) {
  try { localStorage.setItem(PER_EVENT_PREFIX + eventId, String(tornId)); } catch {}
}

function clearJoinedTornId(eventId) {
  try { localStorage.removeItem(PER_EVENT_PREFIX + eventId); } catch {}
}

// ── Identity bar / sign-in card ──────────────────────────────────────

function renderIdentityBar() {
  const bar = document.getElementById('fe-identity-bar');
  const signInView = document.getElementById('sign-in-view');
  if (feSession) {
    bar.classList.remove('hidden');
    signInView.classList.add('hidden');
    document.getElementById('fe-identity-name').textContent = feSession.torn_name || '—';
    const factionEl = document.getElementById('fe-identity-faction');
    factionEl.textContent = feSession.torn_faction ? `· ${feSession.torn_faction}` : '';
  } else {
    bar.classList.add('hidden');
    signInView.classList.remove('hidden');
  }
}

function wireIdentityBar() {
  document.getElementById('fe-sign-out-btn').onclick = async () => {
    if (!feSession) return;
    const prev = feSession;
    setLoading(true);
    try {
      await feRevokeSession(prev.player_id, prev.session_token);
    } catch {
      // Idempotent on the server; failure here doesn't matter.
    } finally {
      setLoading(false);
    }
    feSession = null;
    clearFeSession();
    toast('Signed out — your key has been deleted from our server.', 'success');
    renderIdentityBar();
    refreshAllViewsForAuth();
  };

  document.getElementById('fe-sign-in-form').onsubmit = async (e) => {
    e.preventDefault();
    const key = document.getElementById('fe-sign-in-key').value.trim();
    if (!key) { toast('API key is required'); return; }
    setLoading(true);
    try {
      const res = await feSetApiKey(key);
      if (!res?.success) throw new Error(res?.error || 'Sign-in failed');
      feSession = {
        player_id: String(res.player_id),
        session_token: res.session_token,
        torn_id: String(res.torn_id),
        torn_name: res.torn_name,
        torn_faction: res.torn_faction || null,
      };
      saveFeSession(feSession);
      document.getElementById('fe-sign-in-key').value = '';
      toast(`Signed in as ${feSession.torn_name}`, 'success');
      renderIdentityBar();
      refreshAllViewsForAuth();
    } catch (err) {
      toast(err.message || 'Sign-in failed');
    } finally {
      setLoading(false);
    }
  };
}

// Re-render whichever view is currently active so its "signed in?" branches
// (hide the API key input, show the edit pencils, etc.) reflect the new
// auth state without a full reload.
function refreshAllViewsForAuth() {
  const id = getEventIdFromUrl();
  if (id && currentEvent && currentEvent.id === id) {
    renderEventHeader(currentEvent);
    renderJoinOrMe(currentEvent, lastParticipants);
  } else if (!id) {
    // Picker view — reflect "API key field hidden when signed in" (currently
    // we don't show one in the create form; nothing to do).
  }
}

// ── Picker view (no ?id=) ────────────────────────────────────────────

function showPickerView() {
  document.getElementById('picker-view').classList.remove('hidden');
  document.getElementById('event-view').classList.add('hidden');
  wireCreateForm();
  loadRecentEvents();
}

// Recompute the personal-start slot picker on the create form whenever the
// start date or duration changes. Preserves the current selection if it is
// still valid; otherwise falls back to the default (slot at-or-before now).
function refreshCreateSlotPicker() {
  const startsLocal = document.getElementById('ce-starts-at').value;
  const durHours = Number(document.getElementById('ce-duration-hours').value);
  const personalSel = document.getElementById('ce-personal-start');
  if (!startsLocal || !Number.isFinite(durHours) || durHours <= 0) {
    personalSel.innerHTML = '<option value="">— set start date and duration first —</option>';
    return;
  }
  const startsIso = localInputToIso(startsLocal);
  const endsIso = new Date(new Date(startsIso).getTime() + durHours * 3600 * 1000).toISOString();
  const previous = personalSel.value;
  fillSlotPicker(personalSel, startsIso, endsIso, previous || null);
}

function wireCreateForm() {
  const presetSel = document.getElementById('ce-drug-preset');
  const customRow = document.getElementById('ce-custom-row');
  const customName = document.getElementById('ce-drug-name');
  const customId = document.getElementById('ce-drug-item-id');

  presetSel.onchange = () => {
    if (presetSel.value === 'custom') {
      customRow.classList.remove('hidden');
      customName.required = true;
      customId.required = true;
    } else {
      customRow.classList.add('hidden');
      customName.required = false;
      customId.required = false;
    }
  };

  // Default start = the next round 15-min boundary.
  const startsInput = document.getElementById('ce-starts-at');
  if (!startsInput.value) {
    const now = new Date();
    now.setMinutes(Math.ceil(now.getMinutes() / 15) * 15, 0, 0);
    startsInput.value = isoToLocalInput(now.toISOString());
  }
  startsInput.oninput = refreshCreateSlotPicker;

  const durInput = document.getElementById('ce-duration-hours');
  durInput.oninput = refreshCreateSlotPicker;

  refreshCreateSlotPicker();

  document.getElementById('create-event-form').onsubmit = async (e) => {
    e.preventDefault();

    if (!feSession) {
      toast('Sign in above before creating an event');
      return;
    }

    const title = document.getElementById('ce-title').value.trim();
    const presetVal = presetSel.value;
    let drug_item_id, drug_name;
    if (presetVal === 'custom') {
      drug_item_id = Number(customId.value);
      drug_name = customName.value.trim();
    } else if (presetVal && presetVal.includes('|')) {
      const [idStr, name] = presetVal.split('|');
      drug_item_id = Number(idStr);
      drug_name = name;
    } else {
      toast('Pick what to count');
      return;
    }
    if (!Number.isFinite(drug_item_id) || drug_item_id <= 0) {
      toast('Item ID must be a positive number');
      return;
    }
    if (!drug_name) {
      toast('Drug / item name is required');
      return;
    }

    const startsLocal = document.getElementById('ce-starts-at').value;
    const durationHours = Number(document.getElementById('ce-duration-hours').value);
    if (!startsLocal) { toast('Pick a start time'); return; }
    if (!Number.isFinite(durationHours) || durationHours <= 0) {
      toast('Duration must be a positive number of hours');
      return;
    }

    const startsAtIso = localInputToIso(startsLocal);
    const endsAtIso = new Date(new Date(startsAtIso).getTime() + durationHours * 3600 * 1000).toISOString();

    const personalIso = document.getElementById('ce-personal-start').value;
    if (!personalIso) { toast('Pick your personal start time'); return; }

    setLoading(true);
    try {
      const res = await createFactionEvent({
        title,
        drug_item_id,
        drug_name,
        starts_at: startsAtIso,
        ends_at: endsAtIso,
        personalStartAt: personalIso,
        auth: feAuth(),
      });
      saveJoinedTornId(res.event.id, res.participant.torn_id);
      toast('Event created', 'success');
      setEventIdInUrl(res.event.id);
      showEventView(res.event.id);
    } catch (err) {
      toast(err.message || 'Failed to create event');
    } finally {
      setLoading(false);
    }
  };
}

async function loadRecentEvents() {
  const body = document.getElementById('recent-events-body');
  try {
    const { events } = await listFactionEvents();
    if (!events || events.length === 0) {
      body.innerHTML = '<p class="form-intro" style="color:#888">No events yet — create the first one above.</p>';
      return;
    }
    const now = Date.now();
    body.innerHTML = events.map((ev) => {
      const startsMs = new Date(ev.starts_at).getTime();
      const endsMs = new Date(ev.ends_at).getTime();
      let status;
      if (now < startsMs) status = `starts in ${fmtRelative(startsMs - now)}`;
      else if (now < endsMs) status = `live — ${fmtRelative(endsMs - now)} left`;
      else status = `ended ${fmtRelative(now - endsMs)} ago`;
      return `
        <div class="recent-row">
          <div>
            <a href="?id=${encodeURIComponent(ev.id)}">${esc(ev.title)}</a>
            <div class="recent-meta">${esc(ev.drug_name)} · ${esc(status)}</div>
          </div>
          <div class="recent-meta">${fmtDateTime(ev.starts_at)}</div>
        </div>
      `;
    }).join('');
  } catch (err) {
    body.innerHTML = `<p class="form-intro" style="color:#e94560">Failed to load: ${esc(err.message || String(err))}</p>`;
  }
}

// ── Event view (?id=<uuid>) ──────────────────────────────────────────

let lastParticipants = [];

async function showEventView(eventId) {
  document.getElementById('picker-view').classList.add('hidden');
  document.getElementById('event-view').classList.remove('hidden');
  await refreshEventView(eventId);
  wireEventControls(eventId);
  // Self-healing leaderboard: kick off a background sweep, then re-render.
  scheduleSweep(eventId);
}

async function refreshEventView(eventId) {
  setLoading(true);
  try {
    const { event, participants } = await getFactionEvent(eventId);
    currentEvent = event;
    lastParticipants = participants || [];
    renderEventHeader(event);
    renderLeaderboard(event, lastParticipants);
    renderJoinOrMe(event, lastParticipants);
  } catch (err) {
    toast(err.message || 'Failed to load event');
  } finally {
    setLoading(false);
  }
}

function isCreator(event) {
  return !!(event && feSession && String(event.creator_torn_id) === String(feSession.torn_id));
}

function renderEventHeader(event) {
  document.getElementById('ev-title').textContent = event.title;
  document.getElementById('ev-drug').textContent = event.drug_name;
  document.getElementById('ev-window').textContent =
    `${fmtDateTime(event.starts_at)} → ${fmtDateTime(event.ends_at)}`;

  const now = Date.now();
  const startsMs = new Date(event.starts_at).getTime();
  const endsMs = new Date(event.ends_at).getTime();
  let status;
  if (now < startsMs) status = `Starts in ${fmtRelative(startsMs - now)}`;
  else if (now < endsMs) status = `Live — ${fmtRelative(endsMs - now)} remaining`;
  else status = `Ended ${fmtRelative(now - endsMs)} ago — final leaderboard`;
  document.getElementById('ev-status').textContent = status;

  // Edit pencils only visible to the creator.
  const showPencils = isCreator(event);
  for (const id of ['ev-edit-title-btn', 'ev-edit-drug-btn', 'ev-edit-window-btn']) {
    document.getElementById(id).classList.toggle('hidden', !showPencils);
  }
  // Hide any open edit forms when auth changes (e.g. sign-out).
  if (!showPencils) {
    for (const id of ['ev-edit-title-form', 'ev-edit-drug-form', 'ev-edit-window-form']) {
      document.getElementById(id).classList.add('hidden');
    }
  }

  const shareUrl = `${window.location.origin}${window.location.pathname}?id=${event.id}`;
  document.getElementById('ev-share-link').value = shareUrl;
}

function renderLeaderboard(event, participants) {
  const body = document.getElementById('leaderboard-body');
  if (participants.length === 0) {
    body.innerHTML = '<p class="form-intro" style="color:#888">No participants yet — share the link to get started.</p>';
    return;
  }
  const sorted = [...participants].sort((a, b) => {
    const ac = Number(a.last_count) || 0;
    const bc = Number(b.last_count) || 0;
    if (bc !== ac) return bc - ac;
    return new Date(a.personal_start_at).getTime() - new Date(b.personal_start_at).getTime();
  });

  // "Me" row = either the FE-signed-in user OR the per-event joined torn_id
  // we stashed when this browser joined (so the highlight survives sign-out).
  const myTornId = feSession?.torn_id || loadJoinedTornId(event.id) || null;

  const rows = sorted.map((p, i) => {
    const isMe = String(p.torn_id) === String(myTornId);
    const checked = p.last_checked_at
      ? fmtRelative(Date.now() - new Date(p.last_checked_at).getTime()) + ' ago'
      : 'pending';
    return `
      <tr class="${isMe ? 'me-row' : ''}">
        <td class="lb-rank">${i + 1}</td>
        <td>
          <strong>${esc(p.torn_name)}</strong>
          <div class="recent-meta">${esc(p.torn_faction || 'No faction')}</div>
        </td>
        <td class="recent-meta">since ${fmtDateTime(p.personal_start_at)}</td>
        <td class="recent-meta">${esc(checked)}</td>
        <td class="lb-count">${Number(p.last_count) || 0}</td>
      </tr>
    `;
  }).join('');

  body.innerHTML = `
    <table class="lb-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Player</th>
          <th>Started</th>
          <th>Last refresh</th>
          <th style="text-align:right">${esc(event.drug_name)}</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  document.getElementById('lb-refreshed').textContent = `updated ${new Date().toLocaleTimeString()}`;
}

function renderJoinOrMe(event, participants) {
  // Determine whether THIS user (FE-signed-in) is on the leaderboard.
  const myTornId = feSession?.torn_id || loadJoinedTornId(event.id) || null;
  const myRow = myTornId ? participants.find((p) => String(p.torn_id) === String(myTornId)) : null;

  const joinCard = document.getElementById('join-card');
  const meCard = document.getElementById('me-card');
  const keyRow = document.querySelector('.fe-join-key-row');
  const apiInput = document.getElementById('join-api-key');

  if (myRow) {
    joinCard.classList.add('hidden');
    meCard.classList.remove('hidden');
    document.getElementById('me-count').textContent = Number(myRow.last_count) || 0;
    document.getElementById('me-meta').textContent =
      `${myRow.torn_name} · ${myRow.torn_faction || 'No faction'} · since ${fmtDateTime(myRow.personal_start_at)}`;
    // Refresh button only works while signed in (server needs the key).
    const refreshBtn = document.getElementById('me-refresh');
    refreshBtn.disabled = !feSession;
    refreshBtn.title = feSession ? '' : 'Sign in above to refresh your count';
  } else {
    joinCard.classList.remove('hidden');
    meCard.classList.add('hidden');

    // Slot picker reflects this event's window.
    const slotSel = document.getElementById('join-personal-start');
    fillSlotPicker(slotSel, event.starts_at, event.ends_at, slotSel.value || null);

    // Hide the API key row when the user is FE-signed-in. The join handler
    // will use the FE session instead of asking for a key.
    if (feSession) {
      keyRow.classList.add('hidden');
      apiInput.required = false;
      apiInput.value = '';
      document.getElementById('join-intro').textContent =
        'Pick your personal start time below — we already have your encrypted key.';
    } else {
      keyRow.classList.remove('hidden');
      apiInput.required = true;
      document.getElementById('join-intro').textContent =
        'Sign in above with your Torn API key, then pick your personal start time below. We only read your name, faction, log, and calendar.';
    }
  }
}

// ── Edit pencils (creator only) ──────────────────────────────────────

function openEditForm(which) {
  for (const w of ['title', 'drug', 'window']) {
    const form = document.getElementById(`ev-edit-${w}-form`);
    if (!form) continue;
    if (w === which) form.classList.remove('hidden');
    else form.classList.add('hidden');
  }
}

function closeEditForms() {
  for (const w of ['title', 'drug', 'window']) {
    document.getElementById(`ev-edit-${w}-form`)?.classList.add('hidden');
  }
}

function wireEditPencils(eventId) {
  document.getElementById('ev-edit-title-btn').onclick = () => {
    document.getElementById('ev-edit-title-input').value = currentEvent?.title || '';
    openEditForm('title');
  };

  document.getElementById('ev-edit-drug-btn').onclick = () => {
    const presetSel = document.getElementById('ev-edit-drug-preset');
    const customWrap = document.getElementById('ev-edit-drug-custom');
    const id = String(currentEvent?.drug_item_id || '');
    const name = currentEvent?.drug_name || '';
    // Try matching against the presets.
    let matched = false;
    for (const opt of presetSel.options) {
      if (opt.value && opt.value.includes('|')) {
        const [optId] = opt.value.split('|');
        if (optId === id) { presetSel.value = opt.value; matched = true; break; }
      }
    }
    if (!matched) {
      presetSel.value = 'custom';
      customWrap.classList.remove('hidden');
      document.getElementById('ev-edit-drug-name').value = name;
      document.getElementById('ev-edit-drug-item-id').value = id;
    } else {
      customWrap.classList.add('hidden');
    }
    openEditForm('drug');
  };

  document.getElementById('ev-edit-drug-preset').onchange = (e) => {
    const customWrap = document.getElementById('ev-edit-drug-custom');
    if (e.target.value === 'custom') customWrap.classList.remove('hidden');
    else customWrap.classList.add('hidden');
  };

  document.getElementById('ev-edit-window-btn').onclick = () => {
    if (currentEvent) {
      document.getElementById('ev-edit-starts-at').value = isoToLocalInput(currentEvent.starts_at);
      const startMs = new Date(currentEvent.starts_at).getTime();
      const endMs = new Date(currentEvent.ends_at).getTime();
      const hours = Math.max(1, Math.round((endMs - startMs) / 3600000));
      document.getElementById('ev-edit-duration-hours').value = hours;
    }
    openEditForm('window');
  };

  document.querySelectorAll('.fe-edit-cancel').forEach((btn) => {
    btn.onclick = () => closeEditForms();
  });

  document.getElementById('ev-edit-title-save').onclick = async () => {
    const title = document.getElementById('ev-edit-title-input').value.trim();
    if (!title) { toast('Title cannot be empty'); return; }
    setLoading(true);
    try {
      await updateFactionEvent({ eventId, auth: feAuth(), title });
      closeEditForms();
      await refreshEventView(eventId);
      toast('Title updated', 'success');
    } catch (err) {
      toast(err.message || 'Update failed');
    } finally {
      setLoading(false);
    }
  };

  document.getElementById('ev-edit-drug-save').onclick = async () => {
    const presetSel = document.getElementById('ev-edit-drug-preset');
    let drug_item_id, drug_name;
    if (presetSel.value === 'custom') {
      drug_item_id = Number(document.getElementById('ev-edit-drug-item-id').value);
      drug_name = document.getElementById('ev-edit-drug-name').value.trim();
    } else if (presetSel.value && presetSel.value.includes('|')) {
      const [idStr, name] = presetSel.value.split('|');
      drug_item_id = Number(idStr);
      drug_name = name;
    } else {
      toast('Pick a drug'); return;
    }
    if (!Number.isFinite(drug_item_id) || drug_item_id <= 0) {
      toast('Item ID must be a positive number'); return;
    }
    if (!drug_name) { toast('Drug name is required'); return; }

    setLoading(true);
    try {
      await updateFactionEvent({ eventId, auth: feAuth(), drug_item_id, drug_name });
      closeEditForms();
      await refreshEventView(eventId);
      scheduleSweep(eventId);
      toast('Drug updated — counts will refresh', 'success');
    } catch (err) {
      toast(err.message || 'Update failed');
    } finally {
      setLoading(false);
    }
  };

  document.getElementById('ev-edit-window-save').onclick = async () => {
    const startsLocal = document.getElementById('ev-edit-starts-at').value;
    const durationHours = Number(document.getElementById('ev-edit-duration-hours').value);
    if (!startsLocal) { toast('Pick a start time'); return; }
    if (!Number.isFinite(durationHours) || durationHours <= 0) {
      toast('Duration must be a positive number of hours'); return;
    }
    const starts_at = localInputToIso(startsLocal);
    const ends_at = new Date(new Date(starts_at).getTime() + durationHours * 3600 * 1000).toISOString();

    setLoading(true);
    try {
      await updateFactionEvent({ eventId, auth: feAuth(), starts_at, ends_at });
      closeEditForms();
      await refreshEventView(eventId);
      scheduleSweep(eventId);
      toast('Window updated — counts will refresh', 'success');
    } catch (err) {
      toast(err.message || 'Update failed');
    } finally {
      setLoading(false);
    }
  };
}

// ── Join / refresh / leave ───────────────────────────────────────────

function wireEventControls(eventId) {
  document.getElementById('ev-copy-link').onclick = async () => {
    const input = document.getElementById('ev-share-link');
    try {
      await navigator.clipboard.writeText(input.value);
      toast('Link copied', 'success');
    } catch {
      input.select();
      toast('Copy failed — link is selected, press Cmd/Ctrl+C');
    }
  };

  document.getElementById('back-to-picker').onclick = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('id');
    window.history.pushState({}, '', url.toString());
    currentEvent = null;
    showPickerView();
  };

  document.getElementById('join-fetch-calendar').onclick = async () => {
    // Calendar autofill needs a Torn key. Prefer the FE session if available;
    // otherwise read the API key the user is about to submit.
    let auth = feAuth();
    if (!auth) {
      const k = document.getElementById('join-api-key').value.trim();
      if (!k) {
        toast('Sign in above, or enter your API key first, before pulling from Torn');
        return;
      }
      auth = k;
    }
    setLoading(true);
    try {
      const res = await fetchTornEventStart(auth);
      const slotSel = document.getElementById('join-personal-start');
      let preferredIso = null;
      if (res.guess_start_unix) {
        preferredIso = new Date(res.guess_start_unix * 1000).toISOString();
      } else if (res.guess_start_label) {
        const [h, m] = res.guess_start_label.split(':').map(Number);
        if (Number.isFinite(h) && Number.isFinite(m)) {
          const d = new Date();
          d.setHours(h, m, 0, 0);
          preferredIso = d.toISOString();
        }
      }
      if (preferredIso && currentEvent) {
        fillSlotPicker(slotSel, currentEvent.starts_at, currentEvent.ends_at, preferredIso);
        toast('Snapped picker to your Torn calendar preference', 'success');
      } else {
        toast('Torn did not surface an event start time — pick manually');
      }
    } catch (err) {
      toast(err.message || 'Calendar fetch failed');
    } finally {
      setLoading(false);
    }
  };

  document.getElementById('join-form').onsubmit = async (e) => {
    e.preventDefault();
    const slotIso = document.getElementById('join-personal-start').value;
    if (!slotIso) { toast('Pick your personal start time'); return; }

    let auth;
    if (feSession) {
      auth = feAuth();
    } else {
      const apiKey = document.getElementById('join-api-key').value.trim();
      if (!apiKey) { toast('Sign in above or enter your API key'); return; }
      auth = apiKey;
    }

    setLoading(true);
    try {
      const res = await joinFactionEvent({ eventId, auth, personalStartAt: slotIso });
      saveJoinedTornId(eventId, res.participant.torn_id);
      // If this was a manual-key join (no FE session), silently upgrade the
      // user to a real FE session in the background so subsequent visits
      // don't ask for the key again.
      if (!feSession) {
        const apiKey = document.getElementById('join-api-key').value.trim();
        if (apiKey) {
          feSetApiKey(apiKey).then((sres) => {
            if (sres?.success && sres.player_id && sres.session_token) {
              feSession = {
                player_id: String(sres.player_id),
                session_token: sres.session_token,
                torn_id: String(sres.torn_id),
                torn_name: sres.torn_name,
                torn_faction: sres.torn_faction || null,
              };
              saveFeSession(feSession);
              renderIdentityBar();
              if (currentEvent) renderEventHeader(currentEvent);
            }
          }).catch(() => {});
        }
      }
      toast(`Joined — ${res.count} ${res.event.drug_name} found so far`, 'success');
      await refreshEventView(eventId);
    } catch (err) {
      toast(err.message || 'Failed to join');
    } finally {
      setLoading(false);
    }
  };

  document.getElementById('me-refresh').onclick = async () => {
    if (!feSession) {
      toast('Sign in above to refresh your count');
      return;
    }
    setLoading(true);
    try {
      await refreshFactionEvent({ eventId, auth: feAuth() });
      await refreshEventView(eventId);
      toast('Refreshed', 'success');
    } catch (err) {
      toast(err.message || 'Refresh failed');
    } finally {
      setLoading(false);
    }
  };

  document.getElementById('me-leave').onclick = async () => {
    // Same as the identity-bar Sign Out — revoke the FE session globally.
    if (feSession) {
      const prev = feSession;
      try { await feRevokeSession(prev.player_id, prev.session_token); } catch {}
      feSession = null;
      clearFeSession();
      renderIdentityBar();
      toast('Signed out — your key has been deleted from our server.', 'success');
    } else {
      toast('Already signed out.', 'success');
    }
    refreshEventView(eventId);
  };

  wireEditPencils(eventId);
}

// ── Background sweep ─────────────────────────────────────────────────
// Fires after every event view load so stale counts heal without each
// viewer holding everyone's API key. Sweep is best-effort — failures are
// silent so they don't spam the toast UI for every visitor.
function scheduleSweep(eventId) {
  if (sweepInFlight) return;
  sweepInFlight = true;
  // Small delay so the initial render paints first.
  setTimeout(async () => {
    try {
      const res = await refreshStaleParticipants(eventId);
      // Only re-render if something actually changed.
      if (res && (res.refreshed > 0 || res.deleted > 0)) {
        try {
          const { event, participants } = await getFactionEvent(eventId);
          if (event && getEventIdFromUrl() === eventId) {
            currentEvent = event;
            lastParticipants = participants || [];
            renderLeaderboard(event, lastParticipants);
            renderJoinOrMe(event, lastParticipants);
          }
        } catch {}
      }
    } catch {
      // Ignore — sweep is opportunistic.
    } finally {
      sweepInFlight = false;
    }
  }, 250);
}

// ── Boot ─────────────────────────────────────────────────────────────

window.addEventListener('popstate', () => boot());

async function boot() {
  // Try auto-login first so the rest of the boot can branch on auth state.
  const stored = loadFeSession();
  if (stored) {
    try {
      const res = await feAutoLogin(stored.player_id, stored.session_token);
      if (res?.success) {
        feSession = {
          ...stored,
          torn_id: String(res.torn_id),
          torn_name: res.torn_name,
          torn_faction: res.torn_faction || null,
        };
        saveFeSession(feSession);
      } else {
        feSession = null;
        clearFeSession();
      }
    } catch (err) {
      // session_invalid / Torn rejected → drop it; transient → keep it but
      // treat as logged-out for this load so the UI still works.
      const msg = (err && err.message) || '';
      if (/session_invalid|key_invalid|invalid|locked|not_found/i.test(msg)) {
        feSession = null;
        clearFeSession();
      } else {
        // Transient — keep stored creds but render as not-signed-in for now.
        feSession = null;
      }
    }
  }

  renderIdentityBar();
  wireIdentityBar();

  const id = getEventIdFromUrl();
  if (id) {
    showEventView(id);
  } else {
    showPickerView();
  }
}

boot();


