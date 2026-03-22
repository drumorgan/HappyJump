# Happy Jump — Supabase Integration Plan

## Current State
- Vanilla JS frontend with Vite build pipeline
- Working Torn API client (direct calls from browser)
- Happy Jump pricing logic implemented
- GitHub Actions → FTP deploy pipeline working
- **No Supabase integration at all** — no SDK, no env vars, no schema, no Edge Functions

## Goal
Integrate the "Torn City" Supabase project as the backend: database, auth, and Edge Function API proxy.

---

## Phase 1: Project Scaffolding & SDK Setup

### 1.1 Install Supabase JS client
```
npm install @supabase/supabase-js
```

### 1.2 Create environment config
- Create `.env` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
- Vite exposes `VITE_`-prefixed vars to client code via `import.meta.env`
- `.env` is already in `.gitignore`

### 1.3 Create `src/supabaseClient.js`
- Initialize and export the Supabase client singleton
- Used by all modules that need DB or auth access

---

## Phase 2: Database Schema

### 2.1 Create `config` table (single-row, operator-managed)
Columns per CLAUDE.md spec:
- `id` (integer, default 1, primary key — single row enforced)
- `xanax_price`, `edvd_price`, `ecstasy_price` (bigint)
- `xanax_od_pct`, `ecstasy_od_pct` (decimal)
- `rehab_bonus` (bigint)
- `target_margin` (decimal)
- `worst_case_clients` (integer)
- `current_reserve` (bigint)
- `updated_at` (timestamptz)

RLS: Public read (anon can SELECT), only service role can UPDATE.

### 2.2 Create `transactions` table
Columns per CLAUDE.md spec:
- `id` (uuid, primary key, default gen_random_uuid())
- `torn_id`, `torn_name`, `torn_faction` (text)
- `torn_level` (integer)
- `status` (text — enum: requested/purchased/closed_clean/od_xanax/od_ecstasy/payout_sent)
- `package_cost`, `suggested_price`, `xanax_payout`, `ecstasy_payout` (bigint — snapshots)
- `payout_amount` (bigint, nullable)
- `purchased_at`, `closes_at`, `closed_at` (timestamptz, nullable)
- `created_at` (timestamptz, default now())

RLS: Anon can INSERT only. No SELECT/UPDATE/DELETE for anon. Service role (Edge Functions) has full access.

### 2.3 Seed default config row
Insert 1 row with default values from CLAUDE.md (xanax $850k, EDVD $4M, ecstasy $70k, etc.)

**Delivery:** SQL migration script for the user to run in Supabase SQL Editor.

---

## Phase 3: Supabase Edge Function — Torn API Proxy

### 3.1 Initialize Supabase CLI structure
- Create `supabase/` directory with Edge Function scaffolding
- The user will link to their "Torn City" project and deploy separately

### 3.2 `torn-proxy` Edge Function
- Accepts requests from the frontend with a Torn API key + endpoint params
- Proxies to Torn API v2, returns response
- Key is used once for the call, never stored
- Validates input params before proxying

### 3.3 `validate-player` Edge Function
- Takes client's Torn API key
- Calls Torn API to get player info (name, faction, level)
- Returns player data to frontend for confirmation
- Does NOT store the API key

### 3.4 `create-transaction` Edge Function
- Takes validated player info + current config prices
- Snapshots pricing at time of creation
- Inserts transaction as `requested` using service role
- Returns transaction ID

**Note:** Edge Functions are deployed via Supabase CLI, not through the Vite/FTP pipeline.

---

## Phase 4: Frontend Refactor

### 4.1 Refactor `src/main.js`
- Replace direct Torn API calls with Supabase Edge Function calls
- Fetch config from `config` table (public read) for pricing display
- Keep existing UI components and styling

### 4.2 Create `src/api.js` module
- `getConfig()` — fetch config row from Supabase
- `validatePlayer(apiKey)` — call validate-player Edge Function
- `createTransaction(playerData)` — call create-transaction Edge Function
- `getAvailability()` — calculate from config (reserve / ecstasy_payout - active count)

### 4.3 Update public page
- Load pricing from config table instead of hardcoded/API-fetched values
- Show package price, availability counter
- Purchase flow: API key → validate → confirm → create transaction

---

## Phase 5: Admin Auth & Dashboard (future — not this PR)

This is scoped out of the Supabase integration PR but documented for planning:
- Supabase Auth with email/password for operator login
- Admin page with transaction management
- Config editing panel
- OD verification via Torn API events

---

## Deliverables for This PR

1. **`@supabase/supabase-js`** installed
2. **`src/supabaseClient.js`** — client singleton
3. **SQL migration script** — `config` + `transactions` tables with RLS
4. **Edge Function stubs** — `supabase/functions/torn-proxy/`, `validate-player/`, `create-transaction/`
5. **`src/api.js`** — Supabase-backed API module
6. **Refactored `src/main.js`** — uses Supabase instead of direct Torn API
7. **`.env.example`** — documents required env vars (no secrets)

## Files Changed/Created
- `package.json` — add @supabase/supabase-js
- `src/supabaseClient.js` — NEW
- `src/api.js` — NEW
- `src/main.js` — MODIFIED (use api.js + supabaseClient)
- `supabase/migrations/001_initial_schema.sql` — NEW
- `supabase/functions/torn-proxy/index.ts` — NEW
- `supabase/functions/validate-player/index.ts` — NEW
- `supabase/functions/create-transaction/index.ts` — NEW
- `.env.example` — NEW
