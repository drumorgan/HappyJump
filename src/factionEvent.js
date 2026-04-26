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
  joinFactionEvent,
  refreshFactionEvent,
  refreshStaleParticipants,
  fetchTornEventStart,
  getParticipantScrapeLog,
  adminRescrapeParticipant,
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
// start date and run for a per-event duration in hours (default 6h, cap
// 30 days). Personal start slots are 15-min increments spanning the
// event's full window.

const EVENT_START_HOUR_TCT = 10;
const DEFAULT_EVENT_DURATION_HOURS = 6;
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

function wireCreateForm() {
  const presetSel = document.getElementById('ce-drug-preset');

  // Default date = today in TCT.
  const startsInput = document.getElementById('ce-starts-at');
  if (!startsInput.value) startsInput.value = todayTctDateInput();

  document.getElementById('create-event-form').onsubmit = async (e) => {
    e.preventDefault();

    if (!feSession) {
      toast('Sign in above before creating an event');
      return;
    }

    const title = document.getElementById('ce-title').value.trim();
    const presetVal = presetSel.value;
    let drug_item_id, drug_name;
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

    const dateStr = document.getElementById('ce-starts-at').value;
    if (!dateStr) { toast('Pick an event date'); return; }

    const durationHours = Number(document.getElementById('ce-duration-hours').value);
    if (!Number.isFinite(durationHours) || durationHours <= 0 || durationHours > MAX_EVENT_DURATION_HOURS) {
      toast(`Duration must be 1–${MAX_EVENT_DURATION_HOURS} hours`);
      return;
    }

    const startsAtIso = dateInputToStartIso(dateStr);
    const endsAtIso = dateInputToEndIso(dateStr, durationHours);
    if (!startsAtIso || !endsAtIso) { toast('Invalid event date or duration'); return; }

    setLoading(true);
    try {
      // No personal_start_at on create — backend defaults the creator's
      // personal start to event_start. Creator picks their slot from the
      // me-card's "Change my start time" UI after the event exists.
      const res = await createFactionEvent({
        title,
        drug_item_id,
        drug_name,
        starts_at: startsAtIso,
        ends_at: endsAtIso,
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

  // Delete event — visible to creator OR HJ admin (operator backdoor).
  // Confirm sub-form is collapsed by default; reset whenever we re-render.
  const showDelete = showPencils || isHjAdmin;
  document.getElementById('ev-delete-block').classList.toggle('hidden', !showDelete);
  document.getElementById('ev-delete-confirm').classList.add('hidden');

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

  // Scrape-log column appears only for authorized viewers (HJ admin or
  // event creator). Mirrors the gateway authorization for
  // get-participant-scrape-log so we don't render a button that would 403.
  const showScrapeLog = canViewScrapeLog(event);

  const rows = sorted.map((p, i) => {
    const isMe = String(p.torn_id) === String(myTornId);
    const checked = p.last_checked_at
      ? fmtRelative(Date.now() - new Date(p.last_checked_at).getTime()) + ' ago'
      : 'pending';
    const scrapeBtn = showScrapeLog
      ? `<td class="lb-scrape"><button type="button" class="lb-scrape-btn" data-torn-id="${esc(String(p.torn_id))}" title="View scrape log">view</button></td>`
      : '';
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
        ${scrapeBtn}
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
          ${showScrapeLog ? '<th class="lb-scrape" title="View scrape log">log</th>' : ''}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  document.getElementById('lb-refreshed').textContent = `updated ${new Date().toLocaleTimeString()}`;

  if (showScrapeLog) {
    body.querySelectorAll('.lb-scrape-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tornId = btn.dataset.tornId;
        if (!tornId) return;
        openScrapeLogModal({ eventId: event.id, tornId });
      });
    });
  }
}

// Format a diag object into the plain-text block that gets rendered in the
// admin debug panel and the per-row scrape-log modal. Designed to be
// copy-pasteable into Discord — no markdown, no ANSI, just lines. `header`
// is an optional preamble (participant info, scrape timestamp) prepended
// above the standard diag dump so the same renderer covers both stored
// scrapes (header includes "stored scrape from X") and fresh scrapes.
function formatDiagText(diag, header) {
  if (!diag) {
    return [
      header || '',
      '',
      'No diagnostics available — this row was last refreshed before the scrape-log column existed, or the gateway pre-dates the diag column. Click "Re-scrape now" to populate it.',
    ].filter(Boolean).join('\n');
  }
  const lines = [];
  if (header) {
    lines.push(header);
    lines.push('');
  }
  if (diag.scraped_at) lines.push(`scraped_at: ${diag.scraped_at}`);
  if (diag.drug_name) lines.push(`drug: ${diag.drug_name} (item ${diag.drug_item_id ?? '?'})`);
  lines.push(`window: from=${diag.from_sec} until=${diag.until_sec} (${diag.window_seconds}s)`);
  if (diag.skipped_reason) {
    lines.push('');
    lines.push('SKIPPED: ' + diag.skipped_reason);
  } else {
    lines.push(
      `pages=${diag.pages ?? '?'} totalEntries=${diag.total_entries ?? '?'} inWindowTotal=${diag.in_window_total ?? '?'} reachedCutoff=${diag.reached_cutoff ?? '?'}`,
    );
    if (Array.isArray(diag.matched) && diag.matched.length > 0) {
      lines.push('');
      lines.push(`MATCHED (${diag.matched.length}):`);
      for (const m of diag.matched) lines.push('  ' + m);
    }
    if (Array.isArray(diag.log_type_histogram) && diag.log_type_histogram.length > 0) {
      lines.push('');
      lines.push(`IN-WINDOW LOG TYPES (top ${diag.log_type_histogram.length}):`);
      for (const e of diag.log_type_histogram) lines.push(`  ${e.count}x ${e.key}`);
    }
    if (Array.isArray(diag.data_item_histogram) && diag.data_item_histogram.length > 0) {
      lines.push('');
      lines.push(`IN-WINDOW data.item VALUES (top ${diag.data_item_histogram.length}):`);
      for (const e of diag.data_item_histogram) lines.push(`  ${e.count}x item=${e.key}`);
    } else if (Array.isArray(diag.data_item_histogram)) {
      lines.push('');
      lines.push('IN-WINDOW data.item VALUES: (none — no item-use-shaped entries at all)');
    }
    if (Array.isArray(diag.interesting_rejections) && diag.interesting_rejections.length > 0) {
      lines.push('');
      lines.push(`INTERESTING REJECTIONS (have data.item or mention drug name, up to 15):`);
      for (const r of diag.interesting_rejections) lines.push('  ' + r);
    }
    if (Array.isArray(diag.rejected_samples) && diag.rejected_samples.length > 0) {
      lines.push('');
      lines.push(`FIRST REJECTIONS (sample of up to 5):`);
      for (const r of diag.rejected_samples) lines.push('  ' + r);
    }
    if (Array.isArray(diag.debug)) {
      lines.push('');
      lines.push('PER-PAGE LOG:');
      for (const d of diag.debug) lines.push('  ' + d);
    }
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
    `Event: ${event.title} (${event.drug_name})\n` +
    `Count stored: ${Number(participant.last_count) || 0}\n` +
    `Last refresh: ${checkedAt}\n` +
    `Personal start: ${new Date(participant.personal_start_at).toISOString()}\n` +
    `Source: ${diagSourceLabel}`;

  const header =
    `Participant: ${participant.torn_name} [${participant.torn_id}]\n` +
    `Event: ${event.title}\n` +
    `Count: ${Number(participant.last_count) || 0}\n` +
    `Source: ${diagSourceLabel}`;
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
      document.getElementById('ev-edit-starts-at').value = isoToDateInput(currentEvent.starts_at);
      document.getElementById('ev-edit-duration-hours').value = String(
        durationHoursFromIsos(currentEvent.starts_at, currentEvent.ends_at),
      );
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
    const starts_at = dateInputToStartIso(dateStr);
    const ends_at = dateInputToEndIso(dateStr, durationHours);
    if (!starts_at || !ends_at) { toast('Invalid event date or duration'); return; }

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

  const id = getEventIdFromUrl();
  if (id) {
    showEventView(id);
  } else {
    showPickerView();
  }
}

boot();


