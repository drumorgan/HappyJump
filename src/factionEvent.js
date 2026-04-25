// Faction Events — drinking / drug-use leaderboards.
// Self-contained: doesn't share state with the Happy Jump storefront beyond
// the gateway Edge Function and the shared API helper.

import {
  createFactionEvent,
  getFactionEvent,
  listFactionEvents,
  joinFactionEvent,
  refreshFactionEvent,
  fetchTornEventStart,
} from './api.js';
import { esc, showToast } from './utils.js';

const toastEl = document.getElementById('toast');
const loadingEl = document.getElementById('loading');

const SESSION_PREFIX = 'faction_event_session:'; // per-event-id, value: { torn_id, torn_name, api_key }

function toast(msg, type = 'error') {
  showToast(toastEl, msg, type);
  toastEl.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.add('hidden'), 6000);
}

function setLoading(on) {
  loadingEl.classList.toggle('hidden', !on);
}

function getEventIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get('id');
}

function setEventIdInUrl(id) {
  const url = new URL(window.location.href);
  url.searchParams.set('id', id);
  window.history.replaceState({}, '', url.toString());
}

// Convert a `datetime-local` input value (interpreted as the user's local
// time, no zone) into an ISO string in UTC.
function localInputToIso(localValue) {
  if (!localValue) return null;
  const d = new Date(localValue);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

// Convert an ISO/UTC string to a value usable in <input type="datetime-local">,
// in the viewer's local zone.
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
  const day = Math.round(hr / 24);
  return `${day}d`;
}

function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString();
}

function sessionKey(eventId) {
  return SESSION_PREFIX + eventId;
}

function loadSession(eventId) {
  try {
    const raw = localStorage.getItem(sessionKey(eventId));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveSession(eventId, data) {
  try {
    localStorage.setItem(sessionKey(eventId), JSON.stringify(data));
  } catch {}
}

function clearSession(eventId) {
  try {
    localStorage.removeItem(sessionKey(eventId));
  } catch {}
}

// ── Picker view ──────────────────────────────────────────────────────

function showPickerView() {
  document.getElementById('picker-view').classList.remove('hidden');
  document.getElementById('event-view').classList.add('hidden');
  wireCreateForm();
  loadRecentEvents();
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

  // Default start = next round 15-min boundary
  const startsInput = document.getElementById('ce-starts-at');
  if (!startsInput.value) {
    const now = new Date();
    now.setMinutes(Math.ceil(now.getMinutes() / 15) * 15, 0, 0);
    startsInput.value = isoToLocalInput(now.toISOString());
  }

  document.getElementById('create-event-form').onsubmit = async (e) => {
    e.preventDefault();
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

    setLoading(true);
    try {
      const res = await createFactionEvent({
        title,
        drug_item_id,
        drug_name,
        starts_at: startsAtIso,
        ends_at: endsAtIso,
      });
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

// ── Event view ───────────────────────────────────────────────────────

let currentEvent = null;

async function showEventView(eventId) {
  document.getElementById('picker-view').classList.add('hidden');
  document.getElementById('event-view').classList.remove('hidden');

  await refreshEventView(eventId);
  wireEventControls(eventId);
}

async function refreshEventView(eventId) {
  setLoading(true);
  try {
    const { event, participants } = await getFactionEvent(eventId);
    currentEvent = event;
    renderEventHeader(event);
    renderLeaderboard(event, participants || []);
    renderJoinOrMe(event, participants || []);
  } catch (err) {
    toast(err.message || 'Failed to load event');
  } finally {
    setLoading(false);
  }
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

  // Inline drug name into join card prose
  document.querySelectorAll('.ev-drug-inline').forEach((el) => {
    el.textContent = event.drug_name;
  });

  const shareUrl = `${window.location.origin}${window.location.pathname}?id=${event.id}`;
  document.getElementById('ev-share-link').value = shareUrl;
}

function renderLeaderboard(event, participants) {
  const body = document.getElementById('leaderboard-body');
  if (participants.length === 0) {
    body.innerHTML = '<p class="form-intro" style="color:#888">No participants yet — share the link to get started.</p>';
    return;
  }
  // Sort by count desc, then earliest personal_start_at as tiebreak
  const sorted = [...participants].sort((a, b) => {
    if (b.last_count !== a.last_count) return b.last_count - a.last_count;
    return new Date(a.personal_start_at).getTime() - new Date(b.personal_start_at).getTime();
  });

  const me = loadSession(event.id);
  const myTornId = me?.torn_id || null;

  const rows = sorted.map((p, i) => {
    const isMe = p.torn_id === myTornId;
    const checked = p.last_checked_at ? fmtRelative(Date.now() - new Date(p.last_checked_at).getTime()) + ' ago' : '—';
    return `
      <tr class="${isMe ? 'me-row' : ''}">
        <td class="lb-rank">${i + 1}</td>
        <td>
          <strong>${esc(p.torn_name)}</strong>
          <div class="recent-meta">${esc(p.torn_faction || 'No faction')}</div>
        </td>
        <td class="recent-meta">since ${fmtDateTime(p.personal_start_at)}</td>
        <td class="recent-meta">${esc(checked)}</td>
        <td class="lb-count">${p.last_count}</td>
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
  const session = loadSession(event.id);
  const joinCard = document.getElementById('join-card');
  const meCard = document.getElementById('me-card');

  const myRow = session ? participants.find((p) => p.torn_id === session.torn_id) : null;
  if (session && myRow) {
    joinCard.classList.add('hidden');
    meCard.classList.remove('hidden');
    document.getElementById('me-count').textContent = myRow.last_count;
    document.getElementById('me-meta').textContent =
      `${myRow.torn_name} · ${myRow.torn_faction || 'No faction'} · since ${fmtDateTime(myRow.personal_start_at)}`;
  } else {
    joinCard.classList.remove('hidden');
    meCard.classList.add('hidden');
    // Default the personal-start picker to the event start
    const picker = document.getElementById('join-personal-start');
    if (!picker.value) picker.value = isoToLocalInput(event.starts_at);
  }
}

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
    showPickerView();
  };

  document.getElementById('join-fetch-calendar').onclick = async () => {
    const apiKey = document.getElementById('join-api-key').value.trim();
    if (!apiKey) {
      toast('Enter your API key first, then we can ask Torn for your calendar');
      return;
    }
    setLoading(true);
    try {
      const res = await fetchTornEventStart(apiKey);
      if (res.guess_start_unix) {
        const iso = new Date(res.guess_start_unix * 1000).toISOString();
        document.getElementById('join-personal-start').value = isoToLocalInput(iso);
        toast('Pulled start time from Torn calendar', 'success');
      } else if (res.guess_start_label) {
        // Combine today's date with the HH:MM label
        const [h, m] = res.guess_start_label.split(':').map(Number);
        if (Number.isFinite(h) && Number.isFinite(m)) {
          const d = new Date();
          d.setHours(h, m, 0, 0);
          document.getElementById('join-personal-start').value = isoToLocalInput(d.toISOString());
          toast(`Pulled "${res.guess_start_label}" from Torn calendar`, 'success');
        } else {
          toast('Torn returned a calendar but no usable start time — pick manually');
        }
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
    const apiKey = document.getElementById('join-api-key').value.trim();
    const localStart = document.getElementById('join-personal-start').value;
    if (!apiKey) { toast('API key is required'); return; }
    if (!localStart) { toast('Pick your personal start time'); return; }

    setLoading(true);
    try {
      const personalStartIso = localInputToIso(localStart);
      const res = await joinFactionEvent({ eventId, auth: apiKey, personalStartAt: personalStartIso });
      saveSession(eventId, {
        torn_id: res.participant.torn_id,
        torn_name: res.participant.torn_name,
        api_key: apiKey,
      });
      toast(`Joined — ${res.count} ${res.event.drug_name} found so far`, 'success');
      await refreshEventView(eventId);
    } catch (err) {
      toast(err.message || 'Failed to join');
    } finally {
      setLoading(false);
    }
  };

  document.getElementById('me-refresh').onclick = async () => {
    const session = loadSession(eventId);
    if (!session?.api_key) {
      toast('No saved key — rejoin to refresh');
      return;
    }
    setLoading(true);
    try {
      await refreshFactionEvent({ eventId, auth: session.api_key });
      await refreshEventView(eventId);
      toast('Refreshed', 'success');
    } catch (err) {
      toast(err.message || 'Refresh failed');
    } finally {
      setLoading(false);
    }
  };

  document.getElementById('me-leave').onclick = () => {
    clearSession(eventId);
    toast('Local key cleared. Your leaderboard entry stays.', 'success');
    refreshEventView(eventId);
  };
}

// ── Boot ─────────────────────────────────────────────────────────────

window.addEventListener('popstate', () => boot());

function boot() {
  const id = getEventIdFromUrl();
  if (id) {
    showEventView(id);
  } else {
    showPickerView();
  }
}

boot();
