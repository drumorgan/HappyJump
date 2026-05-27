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
  deleteFactionEvent,
  removeFactionEventParticipant,
  joinFactionEvent,
  refreshFactionEvent,
  refreshStaleParticipants,
  fetchTornEventStart,
  getParticipantScrapeLog,
  adminRescrapeParticipant,
  forceRefreshAllParticipants,
  startBulkRefresh,
  scrapeNextPending,
  feTestCountDrugs,
  feTestCountAttacks,
  listFeFactions,
} from './api.js';
import { supabase } from './supabaseClient.js';
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
// Operator backdoor — populated on boot if the visitor is signed in to
// Happy Jump admin (Supabase Auth). When true, the Delete event button
// is shown on every event regardless of creator_torn_id; the gateway
// checks the same Supabase Auth header to authorize.
let isHjAdmin = false;

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
  if (id) url.searchParams.set('id', id);
  else url.searchParams.delete('id');
  window.history.replaceState({}, '', url.toString());
}

// ── Time helpers ─────────────────────────────────────────────────────
// TCT (Torn City Time) = UTC. Events anchor at 10:00 TCT on the chosen
// start date and run for a per-event duration in hours (default 48h, cap
// 30 days). Personal start slots are 15-min increments spanning the
// event's full window.

const EVENT_START_HOUR_TCT = 10;
const DEFAULT_EVENT_DURATION_HOURS = 48;
const MAX_EVENT_DURATION_HOURS = 30 * 24; // backend caps at 30 days
const SLOT_MS = 15 * 60 * 1000;

function pad2(n) { return String(n).padStart(2, '0'); }

// "YYYY-MM-DD" (UTC) → ISO at 10:00:00 TCT that day.
function dateInputToStartIso(dateStr) {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return null;
  return `${dateStr}T${pad2(EVENT_START_HOUR_TCT)}:00:00.000Z`;
}

// "YYYY-MM-DD" + "HH:MM" (TCT) → ISO. Used for attack events where the
// creator picks the exact start time rather than anchoring at 10:00 TCT.
function dateAndTimeToStartIso(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const md = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  const mt = /^(\d{1,2}):(\d{2})$/.exec(timeStr);
  if (!md || !mt) return null;
  return `${dateStr}T${pad2(Number(mt[1]))}:${pad2(Number(mt[2]))}:00.000Z`;
}

// ISO → "HH:MM" in UTC (TCT). Used to seed the time inputs from an
// existing event's starts_at.
function isoToTimeInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

// "YYYY-MM-DD" (UTC) + duration in hours → ISO at start + duration.
function dateInputToEndIso(dateStr, durationHours = DEFAULT_EVENT_DURATION_HOURS) {
  const startIso = dateInputToStartIso(dateStr);
  if (!startIso) return null;
  const startMs = new Date(startIso).getTime();
  const hours = Number(durationHours);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  return new Date(startMs + hours * 60 * 60 * 1000).toISOString();
}

// Hours between two ISO timestamps, rounded to nearest integer (defaults to
// DEFAULT_EVENT_DURATION_HOURS when either is missing).
function durationHoursFromIsos(startIso, endIso) {
  if (!startIso || !endIso) return DEFAULT_EVENT_DURATION_HOURS;
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_EVENT_DURATION_HOURS;
  return Math.round(ms / (60 * 60 * 1000));
}

// ISO → "YYYY-MM-DD" in UTC (TCT). Used to seed the date inputs.
function isoToDateInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// Today's date in TCT (UTC), formatted YYYY-MM-DD.
function todayTctDateInput() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`;
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

// Compact "HH:MM TCT" for leaderboard cells. The event's full start
// date is already in the header, so showing it on every row just
// burns horizontal space (especially on iPad with 4 attack columns).
function fmtSlotShort(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} TCT`;
}

function fmtSlotLabel(d) {
  // Time-only label in TCT, e.g. "10:15 TCT". All slots are on the event's
  // start date — no need to disambiguate by day.
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} TCT`;
}

// ── Slot picker ──────────────────────────────────────────────────────
// Personal start time is always a TIME OF DAY between 10:00 and 16:00 TCT
// (25 fixed 15-minute slots) anchored to the event's start date — even
// when the event runs for 72h or more. The count window is then
// [personal_start, event.ends_at]: pick 12:00 TCT on a 3-day event
// starting Saturday and you count from Sat 12:00 through Tue 10:00.
const PERSONAL_START_FIRST_HOUR_TCT = 10;
const PERSONAL_START_LAST_HOUR_TCT = 16;

function generateSlots(startIso /* event starts_at */, _endIso) {
  if (!startIso) return [];
  const dateStr = isoToDateInput(startIso);
  if (!dateStr) return [];
  const firstSlot = new Date(`${dateStr}T${pad2(PERSONAL_START_FIRST_HOUR_TCT)}:00:00.000Z`).getTime();
  const lastSlot = new Date(`${dateStr}T${pad2(PERSONAL_START_LAST_HOUR_TCT)}:00:00.000Z`).getTime();
  if (!Number.isFinite(firstSlot) || !Number.isFinite(lastSlot) || lastSlot <= firstSlot) return [];

  const slots = [];
  for (let cursor = firstSlot; cursor <= lastSlot; cursor += SLOT_MS) {
    const d = new Date(cursor);
    slots.push({ value: d.toISOString(), label: fmtSlotLabel(d) });
  }
  return slots;
}

// Default selection: the slot at-or-before now, clamped into the event
// window. If now is before the event starts, falls back to the first slot.
function defaultSlotIso(startIso, _endIso, slots) {
  if (slots.length === 0) return '';
  const nowMs = Date.now();
  const startMs = new Date(slots[0].value).getTime();
  const endMs = new Date(slots[slots.length - 1].value).getTime();
  const target = Math.min(Math.max(nowMs, startMs), endMs);
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
    selectEl.innerHTML = '<option value="">— invalid event date —</option>';
    return;
  }
  selectEl.innerHTML = slots
    .map((s) => `<option value="${esc(s.value)}">${esc(s.label)}</option>`)
    .join('');
  let pick = '';
  if (preferredIso) {
    // Snap to nearest slot by time-of-day in TCT (ignore date — slot list is
    // anchored to the event's date, but `preferredIso` may carry today's date
    // from the calendar autofill on a different day).
    const pref = new Date(preferredIso);
    if (!isNaN(pref.getTime())) {
      const prefMinutes = pref.getUTCHours() * 60 + pref.getUTCMinutes();
      let bestDiff = Infinity;
      for (const s of slots) {
        const sd = new Date(s.value);
        const sMinutes = sd.getUTCHours() * 60 + sd.getUTCMinutes();
        const diff = Math.abs(sMinutes - prefMinutes);
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
    // Picker view — the recent-events list is auth-scoped (sees own/joined
    // for FE users, all for HJ admin, none for anon), so re-fetch when the
    // caller signs in or out.
    loadRecentEvents();
  }
}

// ── Picker view (no ?id=) ────────────────────────────────────────────

function showPickerView() {
  document.getElementById('picker-view').classList.remove('hidden');
  document.getElementById('event-view').classList.add('hidden');
  wireCreateForm();
  loadRecentEvents();
}

function wireCreateForm() {
  const presetSel = document.getElementById('ce-drug-preset');
  const eventTypeSel = document.getElementById('ce-event-type');
  const drugRow = document.getElementById('ce-drug-row');
  const attacksHelp = document.getElementById('ce-attacks-help');
  const timeRow = document.getElementById('ce-time-row');
  const drugWindowHelp = document.getElementById('ce-window-help-drug');
  const attacksWindowHelp = document.getElementById('ce-window-help-attacks');

  // Toggle drug picker + start-time picker based on event_type. Attacks
  // events don't carry a drug AND have a creator-set exact start time
  // (no per-participant slot pickers later), so we show the time input
  // here and hide the drug row.
  function syncEventTypeUi() {
    const isAttacks = eventTypeSel.value === 'attacks';
    if (drugRow) drugRow.style.display = isAttacks ? 'none' : '';
    if (attacksHelp) attacksHelp.style.display = isAttacks ? '' : 'none';
    if (timeRow) timeRow.style.display = isAttacks ? '' : 'none';
    if (drugWindowHelp) drugWindowHelp.style.display = isAttacks ? 'none' : '';
    if (attacksWindowHelp) attacksWindowHelp.style.display = isAttacks ? '' : 'none';
  }
  if (eventTypeSel) {
    eventTypeSel.addEventListener('change', syncEventTypeUi);
    syncEventTypeUi();
  }

  // Default date = today in TCT.
  const startsInput = document.getElementById('ce-starts-at');
  if (!startsInput.value) startsInput.value = todayTctDateInput();

  // Populate the auto-seed faction list. Caller's own faction is
  // pre-checked when an FE session is present (the `mine: true` flag);
  // others are unchecked but selectable.
  loadFactionPicker();

  document.getElementById('create-event-form').onsubmit = async (e) => {
    e.preventDefault();

    if (!feSession) {
      toast('Sign in above before creating an event');
      return;
    }

    const title = document.getElementById('ce-title').value.trim();
    const event_type = eventTypeSel ? eventTypeSel.value : 'drug_use';
    let drug_item_id, drug_name;
    if (event_type === 'drug_use') {
      const presetVal = presetSel.value;
      if (presetVal && presetVal.includes('|')) {
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
    }

    const dateStr = document.getElementById('ce-starts-at').value;
    if (!dateStr) { toast('Pick an event date'); return; }

    const durationHours = Number(document.getElementById('ce-duration-hours').value);
    if (!Number.isFinite(durationHours) || durationHours <= 0 || durationHours > MAX_EVENT_DURATION_HOURS) {
      toast(`Duration must be 1–${MAX_EVENT_DURATION_HOURS} hours`);
      return;
    }

    // Attack events let the creator set an exact start time (in TCT);
    // drug events anchor at 10:00 TCT and the slot picker handles
    // per-participant offsets.
    const timeStr = event_type === 'attacks'
      ? (document.getElementById('ce-starts-time').value || '10:00')
      : null;
    const startsAtIso = timeStr
      ? dateAndTimeToStartIso(dateStr, timeStr)
      : dateInputToStartIso(dateStr);
    const endsAtIso = startsAtIso
      ? new Date(new Date(startsAtIso).getTime() + durationHours * 60 * 60 * 1000).toISOString()
      : null;
    if (!startsAtIso || !endsAtIso) { toast('Invalid event date, time, or duration'); return; }

    setLoading(true);
    try {
      // No personal_start_at on create — backend defaults the creator's
      // personal start to event_start. Creator picks their slot from the
      // me-card's "Change my start time" UI after the event exists.
      const autoSeedFactionIds = Array.from(factionPicker.selectedIds)
        .map((id) => Number(id))
        .filter((n) => Number.isFinite(n) && n > 0);
      const res = await createFactionEvent({
        title,
        event_type,
        drug_item_id,
        drug_name,
        starts_at: startsAtIso,
        ends_at: endsAtIso,
        autoSeedFactionIds,
        auth: feAuth(),
      });
      saveJoinedTornId(res.event.id, res.participant.torn_id);
      const autoAdded = Number(res.auto_added) || 0;
      toast(
        autoAdded > 0
          ? `Event created — auto-added ${autoAdded} faction member${autoAdded === 1 ? '' : 's'}`
          : 'Event created',
        'success',
      );
      setEventIdInUrl(res.event.id);
      showEventView(res.event.id);
    } catch (err) {
      toast(err.message || 'Failed to create event');
    } finally {
      setLoading(false);
    }
  };
}

// Auto-seed factions picker: typeahead chip-based selector. Keeps the
// list scalable past ~20 factions (the original checkbox list got
// unwieldy). State lives on the closure so multiple form open/closes
// retain selections within the same page load.
const factionPicker = {
  all: [], // [{ torn_faction_id, torn_faction_name, member_count, mine }]
  selectedIds: new Set(), // string ids of chosen factions
  loaded: false,
};

async function loadFactionPicker() {
  const chipRow = document.getElementById('ce-faction-chips');
  const search = document.getElementById('ce-faction-search');
  const results = document.getElementById('ce-faction-results');
  if (!chipRow || !search || !results) return;

  if (!factionPicker.loaded) {
    try {
      const { factions } = await listFeFactions(feAuth());
      factionPicker.all = factions || [];
      // Pre-select caller's own faction.
      const mine = factionPicker.all.find((f) => f.mine);
      if (mine) factionPicker.selectedIds.add(String(mine.torn_faction_id));
      factionPicker.loaded = true;
    } catch (err) {
      results.removeAttribute('hidden');
      results.innerHTML = `<p class="fe-faction-empty">Failed to load factions: ${esc(err.message || String(err))}</p>`;
      return;
    }
  }

  renderFactionChips();
  // Wire input only once per page; the input element is stable.
  if (!search.dataset.wired) {
    search.dataset.wired = '1';
    search.addEventListener('focus', () => renderFactionResults(search.value));
    search.addEventListener('input', () => renderFactionResults(search.value));
    search.addEventListener('blur', () => {
      // Small delay so result-button clicks register before we hide.
      setTimeout(() => {
        if (!search.value.trim()) results.setAttribute('hidden', '');
      }, 150);
    });
  }
}

function renderFactionChips() {
  const chipRow = document.getElementById('ce-faction-chips');
  if (!chipRow) return;
  const ids = Array.from(factionPicker.selectedIds);
  if (ids.length === 0) {
    chipRow.innerHTML = '<span class="recent-meta">No factions selected — only you will be on the leaderboard until people join the share link.</span>';
    return;
  }
  chipRow.innerHTML = ids
    .map((id) => {
      const f = factionPicker.all.find((x) => String(x.torn_faction_id) === String(id));
      if (!f) return '';
      const klass = f.mine ? 'fe-chip fe-chip-mine' : 'fe-chip';
      return `<span class="${klass}">
        ${esc(f.torn_faction_name)}
        <button type="button" class="fe-chip-x" data-id="${esc(String(f.torn_faction_id))}" aria-label="Remove ${esc(f.torn_faction_name)}">×</button>
      </span>`;
    })
    .join('');
  chipRow.querySelectorAll('.fe-chip-x').forEach((btn) => {
    btn.addEventListener('click', () => {
      factionPicker.selectedIds.delete(btn.dataset.id);
      renderFactionChips();
      const search = document.getElementById('ce-faction-search');
      renderFactionResults(search?.value || '');
    });
  });
}

function renderFactionResults(query) {
  const results = document.getElementById('ce-faction-results');
  const search = document.getElementById('ce-faction-search');
  if (!results) return;
  const q = (query || '').trim().toLowerCase();
  const matches = factionPicker.all
    .filter((f) => !factionPicker.selectedIds.has(String(f.torn_faction_id)))
    .filter((f) => !q || f.torn_faction_name.toLowerCase().includes(q))
    .slice(0, 20);

  // Hide entirely when there's no query AND no focus reason to show.
  if (!q && document.activeElement !== search) {
    results.setAttribute('hidden', '');
    return;
  }
  results.removeAttribute('hidden');

  if (matches.length === 0) {
    results.innerHTML = `<p class="fe-faction-empty">${q ? 'No matching factions.' : 'No more factions signed in.'}</p>`;
    return;
  }
  results.innerHTML = matches
    .map(
      (f) => `<button type="button" class="fe-faction-result" data-id="${esc(String(f.torn_faction_id))}">
        <span>${esc(f.torn_faction_name)}</span>
        <span class="recent-meta">${f.member_count} signed in</span>
      </button>`,
    )
    .join('');
  results.querySelectorAll('.fe-faction-result').forEach((btn) => {
    btn.addEventListener('mousedown', (e) => {
      // mousedown (not click) so blur on the input doesn't fire first
      // and tear down the dropdown before we add the chip.
      e.preventDefault();
      factionPicker.selectedIds.add(btn.dataset.id);
      if (search) search.value = '';
      renderFactionChips();
      renderFactionResults('');
      if (search) search.focus();
    });
  });
}

async function loadRecentEvents() {
  const body = document.getElementById('recent-events-body');
  try {
    // Backend filters: HJ admin sees all, FE-signed-in sees own/joined,
    // anon sees []. feAuth() returns null when signed-out, which authPayload
    // turns into {} — supabase-js still attaches the Supabase Auth header
    // automatically for the admin path.
    const { events } = await listFactionEvents(feAuth());
    if (!events || events.length === 0) {
      let msg;
      if (isHjAdmin) {
        msg = 'No events yet — create the first one above.';
      } else if (feSession) {
        msg = 'No events yet — events you create or join will show up here.';
      } else {
        msg = 'Sign in above to see events you’ve created or joined.';
      }
      body.innerHTML = `<p class="form-intro" style="color:#888">${esc(msg)}</p>`;
      return;
    }
    const now = Date.now();
    const myTornId = feSession?.torn_id || null;
    body.innerHTML = events.map((ev) => {
      const startsMs = new Date(ev.starts_at).getTime();
      const endsMs = new Date(ev.ends_at).getTime();
      let status;
      if (now < startsMs) status = `starts in ${fmtRelative(startsMs - now)}`;
      else if (now < endsMs) status = `live — ${fmtRelative(endsMs - now)} left`;
      else status = `ended ${fmtRelative(now - endsMs)} ago`;
      // Delete affordance: creator (FE torn_id matches) OR HJ admin.
      // Gateway re-authorizes regardless — this is just UI gating.
      const canDelete = isHjAdmin || (myTornId && String(ev.creator_torn_id) === String(myTornId));
      const delBtn = canDelete
        ? `<button type="button" class="recent-delete-btn" data-event-id="${esc(ev.id)}" data-event-title="${esc(ev.title)}" title="Delete this event">×</button>`
        : '';
      return `
        <div class="recent-row">
          <div>
            <a href="?id=${encodeURIComponent(ev.id)}">${esc(ev.title)}</a>
            <div class="recent-meta">${esc(ev.event_type === 'attacks' ? 'Attacks' : (ev.drug_name || ''))} · ${esc(status)}</div>
          </div>
          <div class="recent-meta">${fmtDateTime(ev.starts_at)}</div>
          ${delBtn}
        </div>
      `;
    }).join('');
    body.querySelectorAll('.recent-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const eventId = btn.dataset.eventId;
        const title = btn.dataset.eventTitle || 'this event';
        if (!eventId) return;
        if (!confirm(`Delete "${title}"?\n\nThis removes the event and every participant row. Cannot be undone.`)) return;
        btn.disabled = true;
        try {
          await deleteFactionEvent({ eventId, auth: feAuth() });
          toast('Event deleted', 'success');
          loadRecentEvents();
        } catch (err) {
          toast(err.message || 'Delete failed');
          btn.disabled = false;
        }
      });
    });
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
  // If a prior bulk-refresh batch was interrupted (page reloaded mid-loop),
  // any rows still flagged scrape_status='pending' will auto-resume here.
  // No-op when the operator isn't authorized to drive the queue.
  maybeResumePendingScrape();
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
  const isAttacks = event.event_type === 'attacks';
  document.getElementById('ev-drug').textContent = isAttacks
    ? 'Attacks · Respect Gained · Avg Respect'
    : (event.drug_name || '—');
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

  // Edit pencils only visible to the creator. Drug pencil is hidden for
  // attack events since the gateway rejects drug changes on those.
  const showPencils = isCreator(event);
  for (const id of ['ev-edit-title-btn', 'ev-edit-window-btn']) {
    document.getElementById(id).classList.toggle('hidden', !showPencils);
  }
  document.getElementById('ev-edit-drug-btn').classList.toggle('hidden', !showPencils || isAttacks);
  // Hide any open edit forms when auth changes (e.g. sign-out).
  if (!showPencils) {
    for (const id of ['ev-edit-title-form', 'ev-edit-drug-form', 'ev-edit-window-form']) {
      document.getElementById(id).classList.add('hidden');
    }
  }

  // Delete event — visible to creator OR HJ admin (operator backdoor).
  // Confirm sub-form is collapsed by default; reset whenever we re-render.
  const showDelete = showPencils || isHjAdmin;
  document.getElementById('ev-delete-block').classList.toggle('hidden', !showDelete);
  document.getElementById('ev-delete-confirm').classList.add('hidden');

  const shareUrl = `${window.location.origin}${window.location.pathname}?id=${event.id}`;
  document.getElementById('ev-share-link').value = shareUrl;
}

// Per-event leaderboard sort: which column drives the order. Persists in
// memory only — clicking a header re-sorts without a server round trip.
let lbSortKey = null; // for attacks: 'attacks' | 'respect' | 'avg'

function leaderboardAttackStats(p) {
  const attacks = Number(p.last_count) || 0;
  const respect = Number(p.last_respect_total) || 0;
  const avg = attacks > 0 ? respect / attacks : 0;
  const best = Number(p.last_best_single_respect) || 0;
  return { attacks, respect, avg, best };
}

function renderLeaderboard(event, participants) {
  const body = document.getElementById('leaderboard-body');
  if (participants.length === 0) {
    body.innerHTML = '<p class="form-intro" style="color:#888">No participants yet — share the link to get started.</p>';
    return;
  }
  const isAttacks = event.event_type === 'attacks';
  // Default sort key per event type. Attacks default to respect gained
  // (most cross-level-fair metric); drug events use their single count.
  if (isAttacks && lbSortKey === null) lbSortKey = 'respect';

  const sorted = [...participants].sort((a, b) => {
    if (isAttacks) {
      const A = leaderboardAttackStats(a);
      const B = leaderboardAttackStats(b);
      const key = lbSortKey || 'respect';
      const pick = (s) => key === 'attacks' ? s.attacks
        : key === 'avg' ? s.avg
        : key === 'best' ? s.best
        : s.respect;
      const av = pick(A);
      const bv = pick(B);
      if (bv !== av) return bv - av;
      return new Date(a.personal_start_at).getTime() - new Date(b.personal_start_at).getTime();
    }
    const ac = Number(a.last_count) || 0;
    const bc = Number(b.last_count) || 0;
    if (bc !== ac) return bc - ac;
    return new Date(a.personal_start_at).getTime() - new Date(b.personal_start_at).getTime();
  });

  // "Me" row = either the FE-signed-in user OR the per-event joined torn_id
  // we stashed when this browser joined (so the highlight survives sign-out).
  const myTornId = feSession?.torn_id || loadJoinedTornId(event.id) || null;

  // Scrape-log column appears only for authorized viewers (HJ admin or
  // event creator). Mirrors the gateway authorization for
  // get-participant-scrape-log so we don't render a button that would 403.
  const showScrapeLog = canViewScrapeLog(event);
  // Same gating for the per-row remove button — creator or HJ admin can
  // kick a participant off the leaderboard. Mirrors the gateway auth on
  // remove-faction-event-participant.
  const showRemove = showScrapeLog;

  const rows = sorted.map((p, i) => {
    const isMe = String(p.torn_id) === String(myTornId);
    const isPending = p.scrape_status === 'pending';
    const checkedBase = p.last_checked_at
      ? fmtRelative(Date.now() - new Date(p.last_checked_at).getTime()) + ' ago'
      : 'pending';
    // Pending badge takes priority — that's the "actively in the bulk-
    // refresh queue" state. The relative timestamp underneath shows the
    // last successful scrape so the operator can tell how stale the
    // current count is even while the refresh is in progress.
    const checkedCell = isPending
      ? `<span class="lb-pending-badge">⏳ pending</span><div class="recent-meta">${esc(checkedBase)}</div>`
      : esc(checkedBase);
    const rowClasses = [];
    if (isMe) rowClasses.push('me-row');
    if (isPending) rowClasses.push('pending-row');
    const scrapeBtn = showScrapeLog
      ? `<td class="lb-scrape"><button type="button" class="lb-scrape-btn" data-torn-id="${esc(String(p.torn_id))}" title="View scrape log">view</button></td>`
      : '';
    const removeBtn = showRemove
      ? `<td class="lb-remove"><button type="button" class="lb-remove-btn" data-torn-id="${esc(String(p.torn_id))}" data-torn-name="${esc(String(p.torn_name))}" title="Remove from this event">×</button></td>`
      : '';

    if (isAttacks) {
      const { attacks, respect, avg, best } = leaderboardAttackStats(p);
      return `
        <tr class="${rowClasses.join(' ')}">
          <td class="lb-rank">${i + 1}</td>
          <td>
            <strong>${esc(p.torn_name)}</strong>
            <div class="recent-meta">${esc(p.torn_faction || 'No faction')}</div>
          </td>
          <td class="recent-meta lb-started">${fmtSlotShort(p.personal_start_at)}</td>
          <td class="recent-meta">${checkedCell}</td>
          <td class="lb-count">${attacks}</td>
          <td class="lb-count">${respect.toFixed(2)}</td>
          <td class="lb-count">${avg.toFixed(2)}</td>
          <td class="lb-count">${best.toFixed(2)}</td>
          ${scrapeBtn}
          ${removeBtn}
        </tr>
      `;
    }
    return `
      <tr class="${rowClasses.join(' ')}">
        <td class="lb-rank">${i + 1}</td>
        <td>
          <strong>${esc(p.torn_name)}</strong>
          <div class="recent-meta">${esc(p.torn_faction || 'No faction')}</div>
        </td>
        <td class="recent-meta lb-started">${fmtSlotShort(p.personal_start_at)}</td>
        <td class="recent-meta">${checkedCell}</td>
        <td class="lb-count">${Number(p.last_count) || 0}</td>
        ${scrapeBtn}
        ${removeBtn}
      </tr>
    `;
  }).join('');

  const sortMarker = (key, label) => {
    const active = lbSortKey === key;
    return `<th class="lb-sort-th" data-sort="${key}" style="text-align:right${active ? ';color:#9ad' : ''}">${label}${active ? ' ▼' : ''}</th>`;
  };
  const attackHeaders = `
    ${sortMarker('attacks', 'Attacks')}
    ${sortMarker('respect', 'Respect')}
    ${sortMarker('avg', 'Avg Respect')}
    ${sortMarker('best', 'Best Hit')}
  `;
  const drugHeader = `<th style="text-align:right">${esc(event.drug_name || '')}</th>`;

  body.innerHTML = `
    <div class="lb-scroll">
      <table class="lb-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Player</th>
            <th>Started</th>
            <th>Last refresh</th>
            ${isAttacks ? attackHeaders : drugHeader}
            ${showScrapeLog ? '<th class="lb-scrape" title="View scrape log">log</th>' : ''}
            ${showRemove ? '<th class="lb-remove" title="Remove participant"></th>' : ''}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;

  if (isAttacks) {
    body.querySelectorAll('.lb-sort-th').forEach((th) => {
      th.style.cursor = 'pointer';
      th.addEventListener('click', () => {
        lbSortKey = th.dataset.sort;
        renderLeaderboard(event, participants);
      });
    });
  }
  document.getElementById('lb-refreshed').textContent = `updated ${new Date().toLocaleTimeString()}`;

  // Refresh-all button shares the same admin/creator gating as the per-row
  // scrape-log buttons (gateway requires admin OR creator on the bulk action).
  const refreshAllBtn = document.getElementById('lb-refresh-all');
  if (refreshAllBtn) refreshAllBtn.classList.toggle('hidden', !showScrapeLog);

  if (showScrapeLog) {
    body.querySelectorAll('.lb-scrape-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tornId = btn.dataset.tornId;
        if (!tornId) return;
        openScrapeLogModal({ eventId: event.id, tornId });
      });
    });
  }

  if (showRemove) {
    body.querySelectorAll('.lb-remove-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const tornId = btn.dataset.tornId;
        const tornName = btn.dataset.tornName || tornId;
        if (!tornId) return;
        if (!confirm(`Remove ${tornName} from this event?\n\nTheir count will be deleted from this leaderboard, but they keep their FE login and can re-join manually.`)) return;
        btn.disabled = true;
        try {
          await removeFactionEventParticipant({ eventId: event.id, tornId, auth: feAuth() });
          toast(`Removed ${tornName}`, 'success');
          await refreshEventView(event.id);
        } catch (err) {
          toast(err.message || 'Remove failed');
          btn.disabled = false;
        }
      });
    });
  }
}

// Delay between scrape-next-pending calls, in ms. Gives the operator
// visible per-row progress and spreads load across Torn's API.
const REFRESH_ALL_DELAY_MS = 1500;

// Module-scoped flag so a second click doesn't double-fire the loop, and
// so a page reload mid-batch can detect "I'm not currently running" and
// auto-resume any rows still marked 'pending' in the DB.
let bulkRefreshInFlight = false;

function wireRefreshAllButton() {
  const btn = document.getElementById('lb-refresh-all');
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', async () => {
    if (!currentEvent) return;
    if (bulkRefreshInFlight) return;
    // If any rows are already pending (from a prior interrupted run),
    // resume that queue instead of re-marking everyone pending. Click
    // again to start a fresh batch — the `start-bulk-refresh` call
    // resets every row to pending, so the operator can re-run from
    // scratch any time.
    const anyPending = (lastParticipants || []).some((p) => p.scrape_status === 'pending');
    await runBulkRefresh({ resume: anyPending });
  });
}

// Drive the timed one-at-a-time refresh loop. Marks all rows as pending
// (unless `resume` is true), then calls scrape-next-pending repeatedly
// with REFRESH_ALL_DELAY_MS between calls until the queue drains. After
// each iteration we re-fetch the event so the leaderboard shows the
// fresh counts and the pending badge clears as rows complete.
async function runBulkRefresh({ resume }) {
  if (!currentEvent || bulkRefreshInFlight) return;
  bulkRefreshInFlight = true;
  const eventId = currentEvent.id;
  const btn = document.getElementById('lb-refresh-all');
  const origLabel = btn?.textContent || 'Refresh all';

  let processed = 0;
  let refreshed = 0;
  let transient = 0;
  let removed = 0;
  let noKey = 0;
  const transientNames = [];

  const updateBtn = (label) => {
    if (btn) {
      btn.disabled = true;
      btn.textContent = label;
    }
  };

  try {
    if (!resume) {
      updateBtn('Marking pending…');
      await startBulkRefresh({ eventId, auth: feAuth() });
    } else {
      updateBtn('Resuming…');
    }

    // Pull the freshly-marked roster so pending badges show up immediately.
    try {
      const fresh = await getFactionEvent(eventId);
      currentEvent = fresh.event;
      lastParticipants = fresh.participants || [];
      renderLeaderboard(currentEvent, lastParticipants);
      renderJoinOrMe(currentEvent, lastParticipants);
    } catch { /* best-effort */ }

    while (true) {
      updateBtn(`Scraping… (${processed} done)`);
      const res = await scrapeNextPending({ eventId, auth: feAuth() });
      if (res.done) break;

      processed++;
      switch (res.status) {
        case 'refreshed':
          refreshed++;
          break;
        case 'transient_error':
          transient++;
          if (res.participant?.torn_name) {
            transientNames.push(`${res.participant.torn_name} (code ${res.torn_error_code ?? '?'})`);
          }
          break;
        case 'permanent_error':
        case 'decrypt_failed':
          removed++;
          break;
        case 'no_key':
          noKey++;
          break;
      }

      // Re-fetch and re-render so the just-processed row's pending badge
      // clears and its new count surfaces. Cheaper than maintaining a
      // local mutation: one round-trip per row, but the whole flow is
      // already paced by REFRESH_ALL_DELAY_MS.
      try {
        const fresh = await getFactionEvent(eventId);
        currentEvent = fresh.event;
        lastParticipants = fresh.participants || [];
        renderLeaderboard(currentEvent, lastParticipants);
        renderJoinOrMe(currentEvent, lastParticipants);
      } catch { /* best-effort */ }

      await new Promise((r) => setTimeout(r, REFRESH_ALL_DELAY_MS));
    }

    const parts = [`Refreshed ${refreshed}/${processed}`];
    if (transient) parts.push(`${transient} skipped (paused/throttled)`);
    if (removed) parts.push(`${removed} removed (revoked)`);
    if (noKey) parts.push(`${noKey} no key`);
    toast(parts.join(' · '), 'success');
    if (transientNames.length) {
      console.log('[refresh-all] transient skips:', transientNames.join(', '));
    }
  } catch (err) {
    toast(err.message || 'Refresh-all failed');
  } finally {
    bulkRefreshInFlight = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = origLabel;
    }
  }
}

// On every event-view load, look for any rows still flagged pending
// from an interrupted prior run and auto-resume the loop. The operator
// doesn't have to click anything — just navigating back to the event
// finishes whatever batch was in progress when their tab closed.
function maybeResumePendingScrape() {
  if (bulkRefreshInFlight) return;
  if (!currentEvent || !canViewScrapeLog(currentEvent)) return;
  const anyPending = (lastParticipants || []).some((p) => p.scrape_status === 'pending');
  if (anyPending) {
    runBulkRefresh({ resume: true });
  }
}

// Format unix-seconds to "YYYY-MM-DD HH:MM:SS" in UTC (= Torn City Time).
// Keeps the modal output stable across viewers in different timezones —
// the entire FE feature is anchored to TCT, so UTC is the right default.
function fmtTctTimestamp(unixSec) {
  if (!Number.isFinite(unixSec)) return '?';
  const d = new Date(unixSec * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

// Format a diag object into the plain-text block that gets rendered in the
// admin debug panel and the per-row scrape-log modal. Stripped down to
// just "window + matched timestamps" per the operator's request — no
// histograms, no rejections, no per-page log. Designed to be copy-paste-
// friendly into Discord. `header` is an optional preamble prepended above.
function formatDiagText(diag, header) {
  if (!diag) {
    return [
      header || '',
      '',
      'No log data — this row was last refreshed before the scrape-log column existed, or the gateway pre-dates the diag column. Click "Re-scrape now" to populate it.',
    ].filter(Boolean).join('\n');
  }
  const lines = [];
  if (header) {
    lines.push(header);
    lines.push('');
  }
  // Window line — UTC (= TCT) so the values match the slot picker.
  // Em-dash separator (not colon) for paste-friendliness on iOS, which
  // otherwise URL-encodes text with `<word>:` patterns at the start.
  lines.push(`Window — ${fmtTctTimestamp(diag.from_sec)} → ${fmtTctTimestamp(diag.until_sec)} TCT`);

  if (diag.skipped_reason) {
    lines.push('');
    lines.push('Skipped — ' + diag.skipped_reason);
    return lines.join('\n');
  }

  // Prefer the structured matched_items emitted by the new gateway. Fall
  // back to parsing the legacy `matched` strings (rows scraped before the
  // gateway started persisting matched_items will only have the strings).
  let items = [];
  if (Array.isArray(diag.matched_items) && diag.matched_items.length) {
    items = diag.matched_items.map((it) => ({ ts: it.ts, drug: it.drug }));
  } else if (Array.isArray(diag.matched) && diag.matched.length) {
    // Legacy strings look like: `Cannabis @ 2026-04-19T16:10:55.000Z — ...`
    for (const s of diag.matched) {
      const m = /^(.+?) @ (\S+)/.exec(s);
      if (!m) continue;
      const ts = Math.floor(new Date(m[2]).getTime() / 1000);
      if (Number.isFinite(ts)) items.push({ ts, drug: m[1] });
    }
  }

  lines.push(`Count — ${items.length}`);
  lines.push('');
  if (items.length === 0) {
    lines.push('(no matching log entries in window)');
  } else {
    items.sort((a, b) => a.ts - b.ts);
    for (const it of items) lines.push(`${fmtTctTimestamp(it.ts)} — ${it.drug}`);
  }
  return lines.join('\n');
}

// Render the count diagnostic panel on the me-card. Only visible to the
// HJ admin (operator) — regular players don't need to see Torn API
// pagination internals. `diag` is the object returned by
// refresh-faction-event when the count function ran (or short-circuited).
function renderMeDebug(diag, opts) {
  const panel = document.getElementById('me-debug');
  const body = document.getElementById('me-debug-body');
  if (!panel || !body) return;
  // Always keep the panel hidden for non-admin users.
  if (!isHjAdmin) {
    panel.classList.add('hidden');
    body.textContent = '';
    return;
  }
  if (opts && opts.clear) {
    panel.classList.add('hidden');
    body.textContent = '';
    return;
  }
  if (!diag) {
    body.textContent = 'No diagnostics returned by the gateway. Redeploy supabase/functions/gateway/index.ts (latest on main) — the running version pre-dates the `diag` response field.';
    panel.classList.remove('hidden');
    return;
  }
  body.textContent = formatDiagText(diag);
  panel.classList.remove('hidden');
}

// Anyone authorized to call get-participant-scrape-log on the gateway:
//   - Happy Jump operator (HJ admin via Supabase Auth — backdoor on every event)
//   - The event creator (FE session matches event.creator_torn_id)
// Mirrors the auth check in handleGetParticipantScrapeLog.
function canViewScrapeLog(event) {
  return isHjAdmin || isCreator(event);
}

// ── Scrape-log modal ────────────────────────────────────────────────
// Lazy-built singleton overlay. One instance reused across all
// participant rows; opens with a participant + the event currently
// loaded into `currentEvent`. Closes on backdrop click, Esc key, or
// Close button. The body is a textarea so the operator can long-press
// → Select All → Copy on iPad without dev tools, and the Copy button
// uses the Clipboard API as a one-tap shortcut.

let scrapeLogModal = null;

function buildScrapeLogModal() {
  if (scrapeLogModal) return scrapeLogModal;

  const overlay = document.createElement('div');
  overlay.className = 'scrape-log-overlay hidden';
  overlay.innerHTML = `
    <div class="scrape-log-modal" role="dialog" aria-modal="true" aria-labelledby="scrape-log-title">
      <div class="scrape-log-header">
        <strong id="scrape-log-title">Scrape log</strong>
        <button type="button" class="scrape-log-close" aria-label="Close">×</button>
      </div>
      <div class="scrape-log-meta" id="scrape-log-meta"></div>
      <textarea class="scrape-log-body" id="scrape-log-body" readonly spellcheck="false"></textarea>
      <div class="scrape-log-actions">
        <button type="button" class="fe-secondary" id="scrape-log-copy">Copy</button>
        <button type="button" class="fe-secondary" id="scrape-log-rescrape">Re-scrape now</button>
        <button type="button" class="fe-secondary" id="scrape-log-close-btn">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => closeScrapeLogModal();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.scrape-log-close').addEventListener('click', close);
  overlay.querySelector('#scrape-log-close-btn').addEventListener('click', close);

  overlay.querySelector('#scrape-log-copy').addEventListener('click', async () => {
    const ta = overlay.querySelector('#scrape-log-body');
    try {
      await navigator.clipboard.writeText(ta.value);
      toast('Copied to clipboard', 'success');
    } catch {
      // Fallback for older browsers / iPad PWA: select the textarea so the
      // user can long-press → Copy themselves.
      ta.select();
      toast('Long-press the text and Copy', 'success');
    }
  });

  overlay.querySelector('#scrape-log-rescrape').addEventListener('click', async () => {
    const tornId = scrapeLogModal.tornId;
    const eventId = scrapeLogModal.eventId;
    if (!tornId || !eventId) return;
    const btn = overlay.querySelector('#scrape-log-rescrape');
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Scraping…';
    try {
      const res = await adminRescrapeParticipant({ eventId, tornId, auth: feAuth() });
      // Refresh the underlying leaderboard so the new count surfaces.
      try {
        const fresh = await getFactionEvent(eventId);
        currentEvent = fresh.event;
        lastParticipants = fresh.participants || [];
        renderLeaderboard(currentEvent, lastParticipants);
      } catch { /* leaderboard refresh is best-effort */ }
      // Re-render modal with the fresh diag.
      populateScrapeLogModal({
        participant: res.participant,
        event: res.event,
        diagSourceLabel: 'fresh scrape (just now)',
      });
      toast(`Re-scraped — count is now ${res.count}`, 'success');
    } catch (err) {
      toast(err.message || 'Re-scrape failed');
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });

  scrapeLogModal = {
    overlay,
    tornId: null,
    eventId: null,
    keydownHandler: (e) => { if (e.key === 'Escape') close(); },
  };
  return scrapeLogModal;
}

function populateScrapeLogModal({ participant, event, diagSourceLabel }) {
  const m = scrapeLogModal;
  if (!m) return;
  const overlay = m.overlay;
  const title = overlay.querySelector('#scrape-log-title');
  const meta = overlay.querySelector('#scrape-log-meta');
  const body = overlay.querySelector('#scrape-log-body');

  title.textContent = `Scrape log — ${participant.torn_name} [${participant.torn_id}]`;

  const checkedAt = participant.last_checked_at
    ? new Date(participant.last_checked_at).toISOString()
    : 'never';
  meta.textContent =
    `Event: ${event.title} (${event.event_type === 'attacks' ? 'Attacks' : (event.drug_name || '')})\n` +
    `Count stored: ${Number(participant.last_count) || 0}\n` +
    `Last refresh: ${checkedAt}\n` +
    `Personal start: ${new Date(participant.personal_start_at).toISOString()}\n` +
    `Source: ${diagSourceLabel}`;

  // Header for the copyable textarea body. NOTE: the first line MUST NOT
  // match a `<word>:` pattern — iOS data detectors interpret leading
  // `Participant:` / `Event:` patterns as URI schemes (`participant:` is
  // technically a valid scheme shape) and Apple Notes URL-encodes the
  // entire pasted text when it sees one. Leading "Scrape log —" defeats
  // detection. We use em-dash separators inside the metadata block too
  // for the same reason — pasting into other apps stays clean. The
  // `Window:` / per-match lines further down don't matter; iOS only
  // checks line one.
  const header =
    `Scrape log — ${participant.torn_name} [${participant.torn_id}]\n` +
    `Event — ${event.title}\n` +
    `Count — ${Number(participant.last_count) || 0}\n` +
    `Source — ${diagSourceLabel}`;
  body.value = formatDiagText(participant.last_diag_json, header);
}

function openScrapeLogModal({ eventId, tornId }) {
  buildScrapeLogModal();
  const m = scrapeLogModal;
  m.eventId = eventId;
  m.tornId = tornId;
  m.overlay.classList.remove('hidden');
  document.addEventListener('keydown', m.keydownHandler);

  // Show a loading state while we fetch the stored scrape.
  m.overlay.querySelector('#scrape-log-title').textContent = 'Scrape log — loading…';
  m.overlay.querySelector('#scrape-log-meta').textContent = '';
  m.overlay.querySelector('#scrape-log-body').value = 'Loading…';

  getParticipantScrapeLog({ eventId, tornId, auth: feAuth() })
    .then((res) => {
      const diag = res.participant?.last_diag_json;
      const sourceLabel = diag?.scraped_at
        ? `stored scrape from ${diag.scraped_at}`
        : 'no stored diagnostic yet';
      populateScrapeLogModal({
        participant: res.participant,
        event: res.event,
        diagSourceLabel: sourceLabel,
      });
    })
    .catch((err) => {
      m.overlay.querySelector('#scrape-log-title').textContent = 'Scrape log — error';
      m.overlay.querySelector('#scrape-log-body').value =
        (err && err.message) || 'Failed to load scrape log';
    });
}

function closeScrapeLogModal() {
  if (!scrapeLogModal) return;
  scrapeLogModal.overlay.classList.add('hidden');
  document.removeEventListener('keydown', scrapeLogModal.keydownHandler);
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
    if (event.event_type === 'attacks') {
      const { attacks, respect, avg, best } = leaderboardAttackStats(myRow);
      document.getElementById('me-count').innerHTML =
        `${respect.toFixed(2)} <span class="recent-meta" style="font-size:0.45em">respect</span>`;
      document.getElementById('me-meta').textContent =
        `${attacks} attacks · avg ${avg.toFixed(2)}${best > 0 ? ` · best ${best.toFixed(2)}` : ''} · ${myRow.torn_name} · ${myRow.torn_faction || 'No faction'} · since ${fmtDateTime(myRow.personal_start_at)}`;
    } else {
      document.getElementById('me-count').textContent = Number(myRow.last_count) || 0;
      document.getElementById('me-meta').textContent =
        `${myRow.torn_name} · ${myRow.torn_faction || 'No faction'} · since ${fmtDateTime(myRow.personal_start_at)}`;
    }
    // "Change my start time" is meaningless on attack events — everyone
    // shares the event window. Hide the button + collapse the inline
    // editor so a previously-open form doesn't get orphaned.
    const changeStartBtn = document.getElementById('me-change-start');
    const changeStartForm = document.getElementById('me-change-start-form');
    if (changeStartBtn) changeStartBtn.style.display = event.event_type === 'attacks' ? 'none' : '';
    if (changeStartForm && event.event_type === 'attacks') changeStartForm.classList.add('hidden');
    // Refresh button only works while signed in (server needs the key).
    const refreshBtn = document.getElementById('me-refresh');
    refreshBtn.disabled = !feSession;
    refreshBtn.title = feSession ? '' : 'Sign in above to refresh your count';
  } else {
    joinCard.classList.remove('hidden');
    meCard.classList.add('hidden');

    // Slot picker + calendar pull are drug-event specific: attack events
    // use the global event window for everyone, so there's no per-player
    // start time to choose.
    const isAttacks = event.event_type === 'attacks';
    const slotSel = document.getElementById('join-personal-start');
    const slotLabel = slotSel?.closest('.fe-label');
    const slotRow = slotSel?.closest('.fe-row') || slotLabel;
    const calBtn = document.getElementById('join-fetch-calendar');
    if (slotRow) slotRow.style.display = isAttacks ? 'none' : '';
    if (calBtn) calBtn.style.display = isAttacks ? 'none' : '';
    if (slotSel) {
      // A hidden `required` select would block form submit; clear it
      // for attacks events.
      if (isAttacks) slotSel.removeAttribute('required');
      else slotSel.setAttribute('required', '');
    }
    if (!isAttacks) {
      fillSlotPicker(slotSel, event.starts_at, event.ends_at, slotSel.value || null);
    }

    // Hide the API key row when the user is FE-signed-in. The join handler
    // will use the FE session instead of asking for a key.
    if (feSession) {
      keyRow.classList.add('hidden');
      apiInput.required = false;
      apiInput.value = '';
      document.getElementById('join-intro').textContent = isAttacks
        ? "Click Join — we'll start tracking your attacks for this event's window."
        : 'Pick your personal start time below — we already have your encrypted key.';
    } else {
      keyRow.classList.remove('hidden');
      apiInput.required = true;
      document.getElementById('join-intro').textContent = isAttacks
        ? 'Sign in above with your Torn API key, then click Join. We only read your name, faction, log, and attacks.'
        : 'Sign in above with your Torn API key, then pick your personal start time below. We only read your name, faction, log, and calendar.';
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
    const id = String(currentEvent?.drug_item_id || '');
    // Pre-select whichever preset matches the event's current drug_item_id;
    // if none match (legacy event with an item ID not in the dropdown),
    // leave the placeholder selected so the user must explicitly pick.
    presetSel.value = '';
    for (const opt of presetSel.options) {
      if (opt.value && opt.value.includes('|')) {
        const [optId] = opt.value.split('|');
        if (optId === id) { presetSel.value = opt.value; break; }
      }
    }
    openEditForm('drug');
  };

  document.getElementById('ev-edit-window-btn').onclick = () => {
    if (currentEvent) {
      const isAttacks = currentEvent.event_type === 'attacks';
      document.getElementById('ev-edit-starts-at').value = isoToDateInput(currentEvent.starts_at);
      document.getElementById('ev-edit-duration-hours').value = String(
        durationHoursFromIsos(currentEvent.starts_at, currentEvent.ends_at),
      );
      const timeRow = document.getElementById('ev-edit-time-row');
      const timeInput = document.getElementById('ev-edit-starts-time');
      if (timeRow) timeRow.style.display = isAttacks ? '' : 'none';
      if (timeInput) timeInput.value = isoToTimeInput(currentEvent.starts_at) || '10:00';
      const drugHelp = document.getElementById('ev-edit-window-help-drug');
      const attacksHelp = document.getElementById('ev-edit-window-help-attacks');
      if (drugHelp) drugHelp.style.display = isAttacks ? 'none' : '';
      if (attacksHelp) attacksHelp.style.display = isAttacks ? '' : 'none';
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
    if (presetSel.value && presetSel.value.includes('|')) {
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
    const dateStr = document.getElementById('ev-edit-starts-at').value;
    if (!dateStr) { toast('Pick an event date'); return; }
    const durationHours = Number(document.getElementById('ev-edit-duration-hours').value);
    if (!Number.isFinite(durationHours) || durationHours <= 0 || durationHours > MAX_EVENT_DURATION_HOURS) {
      toast(`Duration must be 1–${MAX_EVENT_DURATION_HOURS} hours`);
      return;
    }
    const isAttacks = currentEvent?.event_type === 'attacks';
    const timeStr = isAttacks
      ? (document.getElementById('ev-edit-starts-time').value || '10:00')
      : null;
    const starts_at = timeStr
      ? dateAndTimeToStartIso(dateStr, timeStr)
      : dateInputToStartIso(dateStr);
    const ends_at = starts_at
      ? new Date(new Date(starts_at).getTime() + durationHours * 60 * 60 * 1000).toISOString()
      : null;
    if (!starts_at || !ends_at) { toast('Invalid event date, time, or duration'); return; }

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

  // ── Delete event (creator OR HJ admin) ────────────────────────────
  // Two-step inline confirm: first click reveals the confirm panel,
  // second click ("Yes, delete it") actually fires the request.
  const deleteBtn = document.getElementById('ev-delete-btn');
  const deleteConfirm = document.getElementById('ev-delete-confirm');
  const deleteYes = document.getElementById('ev-delete-confirm-yes');
  const deleteNo = document.getElementById('ev-delete-confirm-no');

  deleteBtn.onclick = () => {
    deleteConfirm.classList.toggle('hidden');
  };
  deleteNo.onclick = () => {
    deleteConfirm.classList.add('hidden');
  };
  deleteYes.onclick = async () => {
    setLoading(true);
    try {
      // Pass FE auth when available; gateway also accepts HJ admin
      // Supabase Auth which supabase-js attaches automatically.
      await deleteFactionEvent({ eventId, auth: feAuth() });
      toast('Event deleted', 'success');
      // Drop the per-event "I joined this" hint and route back to picker.
      try { localStorage.removeItem(PER_EVENT_PREFIX + eventId); } catch {}
      setEventIdInUrl(null);
      currentEvent = null;
      lastParticipants = [];
      showPickerView();
    } catch (err) {
      toast(err.message || 'Delete failed');
      deleteConfirm.classList.add('hidden');
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
        // "HH:MM" from Torn calendar — interpret as TCT (UTC) so the picker
        // snaps to the matching TCT slot.
        const [h, m] = res.guess_start_label.split(':').map(Number);
        if (Number.isFinite(h) && Number.isFinite(m)) {
          const d = new Date();
          d.setUTCHours(h, m, 0, 0);
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
    const isAttacks = currentEvent?.event_type === 'attacks';
    let slotIso;
    if (isAttacks) {
      // Attack events share the global window — gateway ignores
      // personal_start_at and pins to event.starts_at server-side.
      slotIso = currentEvent.starts_at;
    } else {
      slotIso = document.getElementById('join-personal-start').value;
      if (!slotIso) { toast('Pick your personal start time'); return; }
    }

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
      const joinedMsg = res.event.event_type === 'attacks'
        ? `Joined — ${res.count} attacks counted so far`
        : `Joined — ${res.count} ${res.event.drug_name} found so far`;
      toast(joinedMsg, 'success');
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
      const res = await refreshFactionEvent({ eventId, auth: feAuth() });
      renderMeDebug(res?.diag);
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
      renderMeDebug(null, { clear: true });
      toast('Signed out — your key has been deleted from our server.', 'success');
    } else {
      toast('Already signed out.', 'success');
    }
    refreshEventView(eventId);
  };

  // ── "Change my start time" — toggle the inline picker, populate slots
  //    from the event window, and on Save call joinFactionEvent (which is
  //    an upsert — same flow as the original join, just with a new
  //    personal_start_at). The backend recounts over the new window
  //    immediately and we re-render the leaderboard with the fresh number.
  const changeStartBtn = document.getElementById('me-change-start');
  const changeStartForm = document.getElementById('me-change-start-form');
  const startPicker = document.getElementById('me-start-picker');
  const changeStartSave = document.getElementById('me-change-start-save');
  const changeStartCancel = document.getElementById('me-change-start-cancel');

  changeStartBtn.onclick = () => {
    if (!feSession) {
      toast('Sign in above to change your start time');
      return;
    }
    if (!currentEvent) return;
    const myRow = (lastParticipants || []).find(
      (p) => String(p.torn_id) === String(feSession.torn_id),
    );
    fillSlotPicker(
      startPicker,
      currentEvent.starts_at,
      currentEvent.ends_at,
      myRow?.personal_start_at || null,
    );
    changeStartForm.classList.remove('hidden');
  };

  changeStartCancel.onclick = () => {
    changeStartForm.classList.add('hidden');
  };

  changeStartSave.onclick = async () => {
    if (!feSession) {
      toast('Sign in above to change your start time');
      return;
    }
    const newStart = startPicker.value;
    if (!newStart) {
      toast('Pick a slot');
      return;
    }
    setLoading(true);
    try {
      await joinFactionEvent({
        eventId,
        auth: feAuth(),
        personalStartAt: newStart,
      });
      changeStartForm.classList.add('hidden');
      await refreshEventView(eventId);
      toast('Start time updated — recounted', 'success');
    } catch (err) {
      toast(err.message || 'Update failed');
    } finally {
      setLoading(false);
    }
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
  // Operator backdoor probe — am I signed in to Happy Jump admin? If
  // the supabase-js client has a session, the gateway will see the
  // Authorization header and treat any request from us as admin.
  // Used to show the Delete event button on every event.
  try {
    const { data } = await supabase.auth.getUser();
    isHjAdmin = !!data?.user;
  } catch { isHjAdmin = false; }

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
  wireRefreshAllButton();
  wireTabs();
  wireTestBench();

  const id = getEventIdFromUrl();
  if (id) {
    showEventView(id);
  } else {
    showPickerView();
  }
}

// ── Top-level tabs (Consumables / Racing / …) ───────────────────────
// Sign-in card sits ABOVE the tabs so a single login covers every event
// type. Tabs just toggle which panel is visible; default is Consumables.
function wireTabs() {
  const tabs = document.querySelectorAll('.fe-tab');
  const panels = {
    consumables: document.getElementById('tab-consumables'),
    racing: document.getElementById('tab-racing'),
  };
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const which = tab.dataset.tab;
      tabs.forEach((t) => {
        const active = t === tab;
        t.classList.toggle('active', active);
        t.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      Object.entries(panels).forEach(([name, panel]) => {
        if (!panel) return;
        panel.classList.toggle('hidden', name !== which);
      });
    });
  });
}

// ── Dev test bench (hidden unless ?test=1) ──────────────────────────
// Lets the operator paste a Torn API key and run the gateway scanners
// directly so we can verify data shape before adding new metrics to the
// live app. No DB writes; no FE session needed.
function wireTestBench() {
  const bench = document.getElementById('fe-test-bench');
  if (!bench) return;
  const params = new URLSearchParams(window.location.search);
  if (params.get('test') !== '1') return;
  bench.classList.remove('hidden');

  const keyInput = document.getElementById('tb-api-key');
  const fromInput = document.getElementById('tb-from');
  const toInput = document.getElementById('tb-to');
  const drugSel = document.getElementById('tb-drug-preset');
  const drugBtn = document.getElementById('tb-count-drugs');
  const attackBtn = document.getElementById('tb-count-attacks');
  const statusEl = document.getElementById('tb-status');
  const outputEl = document.getElementById('tb-output');

  // datetime-local strings are interpreted as the operator's LOCAL clock;
  // convert to unix seconds via Date so the gateway gets a stable epoch.
  function localInputToUnix(value) {
    if (!value) return null;
    const ms = new Date(value).getTime();
    if (!Number.isFinite(ms)) return null;
    return Math.floor(ms / 1000);
  }

  function render(label, payload) {
    statusEl.textContent = label;
    try {
      outputEl.textContent = JSON.stringify(payload, null, 2);
    } catch {
      outputEl.textContent = String(payload);
    }
  }

  drugBtn.addEventListener('click', async () => {
    const apiKey = keyInput.value.trim();
    if (!apiKey) { statusEl.textContent = 'Paste an API key first.'; return; }
    const presetVal = drugSel.value || '';
    const [idStr, ...nameParts] = presetVal.split('|');
    const drugItemId = Number(idStr);
    const drugName = nameParts.join('|').trim();
    if (!drugItemId || !drugName) { statusEl.textContent = 'Pick a drug.'; return; }
    statusEl.textContent = `Counting ${drugName} uses…`;
    outputEl.textContent = '(running — this can take 5-20 seconds per page of log)';
    const t0 = Date.now();
    try {
      const result = await feTestCountDrugs({
        apiKey,
        drugItemId,
        drugName,
        fromTs: localInputToUnix(fromInput.value),
        toTs: localInputToUnix(toInput.value),
      });
      render(`Done in ${Date.now() - t0} ms — ${drugName} count: ${result.count ?? '?'}`, result);
    } catch (err) {
      render('Error', { error: err.message || String(err) });
    }
  });

  attackBtn.addEventListener('click', async () => {
    const apiKey = keyInput.value.trim();
    if (!apiKey) { statusEl.textContent = 'Paste an API key first.'; return; }
    statusEl.textContent = 'Fetching attacks…';
    outputEl.textContent = '(running)';
    const t0 = Date.now();
    try {
      const result = await feTestCountAttacks({
        apiKey,
        fromTs: localInputToUnix(fromInput.value),
        toTs: localInputToUnix(toInput.value),
      });
      const total = result.total_records ?? (result.torn_error ? 'torn error' : '?');
      render(`Done in ${Date.now() - t0} ms — records: ${total}`, result);
    } catch (err) {
      render('Error', { error: err.message || String(err) });
    }
  });
}

boot();


