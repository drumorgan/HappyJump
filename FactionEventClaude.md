# Faction Events — Persistent API Keys + Creator Edits

> **Working spec for the in-flight feature.** Source-of-truth document so a crash doesn't cost us context. Update as we go — strike out finished steps, add notes inline.

Branch: `claude/save-work-prevent-loss-U8vjc` (created after a previous session crashed mid-implementation; no recoverable state existed).

## 0. Why we're doing this

The current Faction Events page (PR #164, already on `main`) has two big UX gaps:

1. **No persistent identity.** Every visit you re-enter your Torn API key. Even the *creator* of an event has to re-enter their key when they come back to refresh their own count. This is friction for the "I check my count once a day for a week" flow.
2. **No creator edits.** Once an event is created its title / drug / time window are immutable. If you typo the title or pick the wrong drug, you have to abandon the event and create a new one (and lose every participant who already joined).

We also want **self-healing leaderboards** — when a viewer loads the event page, stale participant counts should refresh in the background so the numbers are always close to live without every viewer needing the API key of every participant.

## 1. Goal

- Faction Events gets its own opaque session, **completely independent** from the Happy Jump session. Signing out of one does not sign you out of the other.
- The session token grants *only* the ability to count drug uses — no payouts, no transactions, no admin.
- Creator of an event can edit title / drug / start / duration after the fact. Edits invalidate cached counts so the next sweep recounts.
- Background sweep refreshes stale participant counts on every event view.

## 2. Frontend (what the user sees)

### 2.1 Auth model (FE = Faction Event session)
- New `localStorage['faction_event_session'] = { player_id, session_token, torn_id, torn_name, torn_faction }`. Independent key from `happyjump_session`.
- On page load, if a session exists → call `fe-auto-login`. Cache identity in module state.
- Sign-out button → calls `fe-revoke-session` (server deletes the row), then clears localStorage.
- Torn-revoked key → drop localStorage + show "your key was revoked, please rejoin" toast.

### 2.2 Picker view (no `?id=` in URL)
- "Sign in" card at top: API key input + "Sign in" button. Hidden when already signed in; replaced by "Signed in as <name> [<faction>]  · Sign out".
- Create-event form:
  - API key field hidden if FE-signed-in.
  - **Personal-start picker** is a `<select>` with 15-minute slots from `event.starts_at` → `event.ends_at`, viewer-local time. Default = the slot at-or-before "now". (Replaces the previous freeform datetime input.)
  - On submit, gateway returns `{ event, participant }`; we navigate straight into the event view as the creator (creator's row is already inserted).
- Recent-events list: unchanged.

### 2.3 Event view (`?id=<uuid>`)
- Header: title / drug / start / duration. **Inline pencil-edit** on each — visible only when `event.creator_torn_id === currentUser.torn_id`. Read-only otherwise.
- Join card:
  - When FE-signed-in: only the slot picker is shown (no API key field).
  - When not signed in: API key + slot picker.
- Sign-out button (revokes FE session only).
- After every `getFactionEvent()`, fire `refresh-stale-participants` in the background, then re-fetch + re-render so the leaderboard self-heals.

### 2.4 Slot picker generator
```
generateSlots(startISO, endISO):
  slots = []
  cursor = ceil(start to next 15-min boundary)
  while cursor <= end:
    slots.push({ value: cursor.toISOString(), label: viewerLocal(cursor, "MMM d, h:mm a") })
    cursor += 15min
  return slots
```
Default selection = the slot at-or-before `Date.now()` (clamped to `[start, end]`).

### 2.5 `src/api.js` additions
- `feSetApiKey(key)` → `fe-set-api-key`
- `feAutoLogin()` → `fe-auto-login`
- `feRevokeSession()` → `fe-revoke-session`
- `updateFactionEvent({ id, ...patch })` → `update-faction-event`
- `refreshStaleParticipants(eventId)` → `refresh-stale-participants`
- `createFactionEvent(...)` updated: now passes FE auth + personal-start.

## 3. Backend (gateway + DB)

### 3.1 Migration `012_faction_event_secrets.sql`
- New table `faction_event_player_secrets` — exact mirror of `player_secrets`:
  - PK `torn_player_id`
  - AES-256-GCM ciphertext (`encrypted_api_key`)
  - per-row IV (`iv`)
  - SHA-256 token hash (`session_token_hash`)
  - brute-force counter (`failed_attempts`)
  - `created_at`, `last_used_at`
  - Service-role-only RLS.
- Adds column `creator_torn_id text` to `faction_events` + index.

### 3.2 Gateway refactor
- Generic `resolveSessionFromTable(body, tableName)` — both Happy Jump and FE share the same constant-time-compare + 5-strike self-destruct logic.
- `resolveApiKey(body)` becomes a thin wrapper around the generic helper using `player_secrets`.
- New `resolveFactionEventApiKey(body)` wrapper using `faction_event_player_secrets`.
- New `cascadeDeleteFactionEventSecret(supabase, tornId)` helper — drops FE secret + every participant row for that torn_id across all events.
- New `isPermanentTornKeyError(code)` — only Torn codes 2 (incorrect key) and 16 (access-level too low) trigger cascade-delete. Codes 5/8/9 (transient) leave the row alone.

### 3.3 New gateway actions
| Action | Auth | Description |
|--------|------|-------------|
| `fe-set-api-key` | None | Validates key against `selections=basic,profile`, encrypts, returns opaque session token. |
| `fe-auto-login` | Session | Re-validates stored key. On permanent fail → cascade-delete. |
| `fe-revoke-session` | Session | Verifies token, deletes row. |
| `update-faction-event` | FE creator | Patch title / drug / start / duration. If drug or window changes → mark every participant `last_checked_at = null` so next sweep recounts. |
| `refresh-stale-participants` | None (public sweep) | Picks up to 15 stale rows (`last_checked_at IS NULL` first, then `< now() - 60s`). For each, sequentially probes Torn with a tiny `selections=basic` to detect revoked keys cheaply, then runs `countItemUseInLog`. |

### 3.4 Modified handlers
- `create-faction-event` — now requires FE auth. Inserts the event with `creator_torn_id`, then atomically inserts the creator's participant row (rolls back the event insert if the participant insert fails).
- `join-faction-event` / `refresh-faction-event` / `fetch-torn-event-start` — switch from `resolveApiKey` → `resolveFactionEventApiKey`. Add cascade-delete on permanent Torn errors.

## 4. Standing rules (do not violate)

- **Never push half-done state without committing first.** Every logical chunk gets its own commit + `git push`. The previous session lost ~30% of work because nothing was committed before the crash.
- **Never push frontend files to `main` directly.** Always go through a PR (per CLAUDE.md).
- **Gateway file (`supabase/functions/gateway/index.ts`)** does NOT deploy via FTP — when changed, the user must paste it into the Supabase dashboard. Remind them after merging.
- **All DB writes go through the gateway**, service-role-keyed. Frontend uses the anon client for reads only.
- **Bigint columns return as strings** — wrap in `Number()` before arithmetic.
- **Single Edge Function pattern** — add actions to `gateway/index.ts`, never create new functions.
- **Snapshots are immutable** for transactions but counts in `faction_event_participants` are recomputable (that's the whole point of `last_checked_at`).

## 5. Step-by-step commit plan

Each step is a separate commit + `git push -u origin <branch>`. Tick as we go.

- [x] **0. Plan file** — `FactionEventClaude.md` (this doc) committed first so a crash leaves us with at least the spec. (commit `65e75a2`)
- [x] **1. Migration 012** — `supabase/migrations/012_faction_event_secrets.sql`. (commit `37f1a40`)
- [x] **2. Gateway helpers** — `resolveSessionFromTable`, `resolveFactionEventApiKey`, `cascadeDeleteFactionEventSecret`, `isPermanentTornKeyError`. (commit `e01b1af`)
- [x] **3. Gateway: `fe-set-api-key` / `fe-auto-login` / `fe-revoke-session`** + router wiring. (commit `7781377`)
- [x] **4. Gateway: `update-faction-event`** + router wiring + cache invalidation logic. (commit `1a05172`)
- [x] **5. Gateway: `refresh-stale-participants`** + router wiring. (commit `54f3fd8`)
- [x] **6. Gateway: switch `join` / `refresh` / `fetch-start` to FE resolver** + cascade-delete on permanent Torn errors. (commit `92e4cd2`)
- [x] **7. Gateway: `create-faction-event` requires FE auth + auto-inserts creator participant.** (commit `2013871`)
- [x] **8. `src/api.js` wrappers** for all five new actions. (commit `6c55e91`)
- [x] **9. `factionEvent/index.html`** — sign-in card, slot picker, edit pencils, sign-out button. (commit `037723d`)
- [x] **10. `src/factionEvent.js`** — full rewrite for FE session + slot picker + creator edit + background sweep.
- [x] **11. `src/factionEvent.css`** — pencil buttons, slot select, sign-in card.
- [x] **12. `CLAUDE.md`** — document FE secrets table, new actions, gateway change reminder.
- [ ] **13. PR + squash-merge** per standing order at top of `CLAUDE.md`. **← NEXT**

## 6. Recovery notes

If a session crashes mid-implementation:

1. Read this file first.
2. `git log --oneline` on `claude/save-work-prevent-loss-U8vjc` to see what's committed.
3. `git status` — if dirty, `git stash` and inspect; the previous session may have written things that weren't committed.
4. Resume at the next unchecked step above.
5. **Do not merge PR #166 until step 10 is done** — the `index.html` changes from step 9 reference selectors and behaviors that only the rewritten `factionEvent.js` provides. Merging early breaks the live page.

## 7. Out of scope (do not build now)

- Multiple drugs per event.
- Faction-restricted events (private to a faction ID).
- Email/Discord notifications.
- Editing participants list (kicking, etc.).
- Anything that touches the Happy Jump transactions/clients pipeline.

## 8. Open questions / decisions (none currently)

If we hit a fork in the road, log it here before deciding.
