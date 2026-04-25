# Faction Event — Persistent API Keys + Creator Edits

Durable spec for the v2 of the Faction Event page. Reconstructed from the planning session that crashed before saving. **This file is the source of truth — read this first when resuming.**

The current live feature (`factionEvent/`, `src/factionEvent.js`, `src/factionEvent.css`, migration `011_faction_events.sql`, gateway actions `create-faction-event` / `get-faction-event` / `list-faction-events` / `join-faction-event` / `refresh-faction-event` / `fetch-torn-event-start`) is the v1 baseline. v2 layers persistence and editability on top — it does **not** rip up v1.

## Goals

1. **Persistent API keys for FE participants.** A returning user shouldn't have to paste their Torn API key every time they open the page. Mirror the Happy Jump session pattern (encrypted server-side, opaque session token in `localStorage`).
2. **Creator can edit the event.** Title, drug, start time, duration. Changes invalidate stale counts so the leaderboard recomputes.
3. **Self-healing leaderboard.** Background sweep re-counts stale participants whenever someone visits the page, so the board doesn't go stale just because participants stopped opening it.
4. **FE auth is independent of Happy Jump auth.** Signing out of one must not sign you out of the other. They use separate `localStorage` keys and separate DB tables.

## Front-end design

### Auth model — separate FE session

- New `localStorage` key: `faction_event_session = { player_id, session_token, torn_id, torn_name, torn_faction }`.
- Independent from `happyjump_session`. Signing out of FE leaves Happy Jump alone, and vice versa.
- On page load, if the FE session exists → call `fe-auto-login`. Cache identity in module state.
- On sign-out → call `fe-revoke-session`, then clear `localStorage`.
- On Torn-revoked-key response → drop `localStorage`, show toast "your Torn key was revoked, please rejoin", fall back to manual key entry.

### Sign-in card (top of page)

- Visible when no FE session exists. Single API key input + "Sign in" button.
- On successful `fe-set-api-key`: identity bar replaces the card with `Signed in as {name} [{torn_id}] — Sign out`.

### Picker view (no `?id=` in URL)

- Identity bar at top (sign-in card if not signed in).
- "Create a new event" form:
  - API key field — **hidden** when FE-signed-in.
  - Title, drug select, start, duration (existing fields).
  - **New: personal-start `<select>` slot picker.** Options every 15 min from `event.starts_at` to `event.ends_at`, in viewer-local time. Default = the slot at-or-before "now".
- "Recent events" list (existing).

### Event view (`?id=<uuid>` in URL)

- Identity bar at top.
- Header (title / drug / window):
  - **Inline pencil-edit buttons visible only when `event.creator_torn_id === currentUser.torn_id`.** Read-only otherwise.
  - Editable fields: title, drug, start, duration.
- Join card:
  - API key field **hidden** when FE-signed-in (just slot picker + "Join" button).
  - Slot picker (same 15-min generator as create form).
  - When not signed in: API key field shown, with note "your key will be remembered next time".
- Leaderboard (existing).
- After every `getFactionEvent()`: fire `refresh-stale-participants` in the background, then re-fetch + re-render.

### Slot picker generator

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

### `src/api.js` additions

- `feSetApiKey(key)` → `{ player_id, session_token, identity }`
- `feAutoLogin({ player_id, session_token })` → `{ identity }` or `{ error: 'session_invalid' }`
- `feRevokeSession({ player_id, session_token })` → `{ ok: true }`
- `updateFactionEvent({ event_id, fields, auth })` — creator-only.
- `refreshStaleParticipants({ event_id })` — public, no auth.
- Updated `createFactionEvent` signature: includes `auth` (FE session) + `personal_start_ts`.

## Back-end design

### Migration `012_faction_event_secrets.sql`

```sql
create table faction_event_player_secrets (
  torn_player_id      text primary key,
  api_key_ciphertext  text not null,
  api_key_iv          text not null,
  session_token_hash  text not null,
  failed_attempts     integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
alter table faction_event_player_secrets enable row level security;
-- service role only; no anon policies

alter table faction_events add column creator_torn_id text;
create index on faction_events (creator_torn_id);
```

Mirror of `player_secrets` (migration 010), but separate table so a Happy Jump key revoke doesn't blow away an FE key and vice versa.

### Gateway helpers (`supabase/functions/gateway/index.ts`)

- **Refactor** `resolveApiKey` into a generic `resolveSessionFromTable(body, tableName)` so both Happy Jump (`player_secrets`) and Faction Events (`faction_event_player_secrets`) share the constant-time-compare + 5-strike self-destruct logic.
- Keep `resolveApiKey(body)` as a thin wrapper for back-compat.
- Add `resolveFactionEventApiKey(body)` wrapper.
- Add `cascadeDeleteFactionEventSecret(supabase, tornId)` — drops the FE secret row + every participant row for that torn_id across all events.
- Add `isPermanentTornKeyError(code)` — returns true only for Torn codes 2 (incorrect key) and 16 (access-level too low). Transient errors (5/8/9 — rate limit / temp error / IP block) leave the row alone.

### New gateway actions

| Action | Auth | Behavior |
|---|---|---|
| `fe-set-api-key` | None | Validate key against Torn `selections=basic,profile`. Drop scope to `log,calendar` (no `events`). Encrypt with AES-256-GCM, store, return opaque session token. |
| `fe-auto-login` | Session | Re-validate stored key. On permanent fail → cascade-delete + return `session_invalid`. Transient → leave row, return `session_invalid` (client retries later). |
| `fe-revoke-session` | Session | Verify token, delete row, return `{ ok: true }`. |
| `update-faction-event` | FE creator | Only creator (matched by `creator_torn_id`) can edit. If `drug` or window changes → `update faction_event_participants set last_checked_at = null where event_id = $1` so the next sweep recounts everyone. |
| `refresh-stale-participants` | None | Pick up to 15 stale rows (`last_checked_at IS NULL` first, then `last_checked_at < now() - 60s`). Sequentially probe Torn with a tiny `selections=basic` to detect revoked keys cheaply. For live keys, run `countItemUseInLog`. Cascade-delete on permanent Torn errors. |

### Modified existing handlers

- `create-faction-event` — now requires FE auth. Insert event with `creator_torn_id` set. **Atomically** insert the creator's participant row (rolls back the event if that fails).
- `join-faction-event` / `refresh-faction-event` / `fetch-torn-event-start` — switch from `resolveApiKey` to `resolveFactionEventApiKey`. Cascade-delete on permanent Torn errors instead of just bubbling them.

### Router wiring

Add cases in the router switch:
- `fe-set-api-key`
- `fe-auto-login`
- `fe-revoke-session`
- `update-faction-event`
- `refresh-stale-participants`

## Implementation order (baby steps, commit + push after each)

> **Iron rule: commit and push after every numbered step.** A crash mid-step costs at most that one step. PR is held for the very end.

1. **Write this file.** ✅ (you are here — committed first so the plan is durable)
2. **Migration `012_faction_event_secrets.sql`.** Table + `creator_torn_id` column. Match style of 010 + 011.
3. **Gateway: refactor session resolver + FE helpers.** `resolveSessionFromTable`, `resolveFactionEventApiKey`, `cascadeDeleteFactionEventSecret`, `isPermanentTornKeyError`. No new actions yet — verify existing actions still work via the wrapper.
4. **Gateway: three FE session handlers + router cases.** `fe-set-api-key`, `fe-auto-login`, `fe-revoke-session`.
5. **Gateway: `update-faction-event` handler + router case.**
6. **Gateway: `refresh-stale-participants` handler + router case.**
7. **Gateway: switch the three existing FE handlers to FE resolver + cascade-delete.** `join-faction-event`, `refresh-faction-event`, `fetch-torn-event-start`.
8. **Gateway: `create-faction-event` requires FE auth + atomic creator-participant insert.**
9. **`src/api.js`: client wrappers** for all six new actions, plus updated `createFactionEvent`.
10. **`factionEvent/index.html`: sign-in card + identity bar + slot pickers + edit pencils.**
11. **`src/factionEvent.js`: full rewrite.** FE session bootstrapping, slot picker generator, creator edit handlers, background sweep on event load.
12. **`src/factionEvent.css`: styles** for new UI elements (pencil buttons, slot select, sign-in card).
13. **`CLAUDE.md`: update Faction Events section** with FE secrets table + new actions + edit/sweep behavior.
14. **PR + squash-merge** per CLAUDE.md standing order.

## Recovery notes

If a session crashes mid-implementation:

1. Read this file first.
2. `git log --oneline` to see how far we got. Steps map to commits.
3. `git status` — if dirty, `git stash` and inspect; the previous session may have written things that weren't committed.
4. Resume at the next unchecked step in the list above.

## Out of scope (do not build now)

- Multiple drugs per event.
- Faction-restricted events (private to a faction ID).
- Email/Discord notifications.
- Editing participants list (kicking, etc.).
- Anything that touches the Happy Jump transactions/clients pipeline.
