# Happy Jump Insurance

Web application for selling insured Happy Jump drug packages in the browser RPG **Torn City**. The operator (Giro Vagabondo) buys drug packages, sells them to clients with OD insurance built in, and tracks all transactions through a public storefront and private admin dashboard.

**Live URL:** `happyjump.girovagabondo.com`

## Tech Stack

| Layer    | Choice                                                         |
|----------|----------------------------------------------------------------|
| Frontend | Vanilla JS ES modules + Vite                                  |
| Backend  | Supabase (Postgres + Auth + Edge Functions)                    |
| Hosting  | InMotion cPanel subdomain                                      |
| Deploy   | GitHub Actions → FTP (Vite builds to `dist/`)                  |
| Torn API | Torn API v2 via Supabase Edge Function proxy (keys never client-side) |

## Project Structure

- `dist/` — Vite build output, FTP-deployed to `public_html/happyjump.girovagabondo.com/`
- `supabase/functions/gateway/index.ts` — **single Edge Function** handling all server-side logic
- Supabase Edge Functions deployed separately via Supabase CLI

## Business Logic

### Happy Jump Package

A Happy Jump consumes: 4x Xanax, 5x Erotic DVDs, 1x Ecstasy. Any OD at any step destroys all progress.

### OD Probabilities

- Xanax OD rate: 3% per pill
- Ecstasy OD rate: 5%
- P(any Xanax OD across 4 pills): `1 - (0.97)^4 = 11.47%`
- P(Ecstasy OD, having survived Xanax): `(0.97)^4 × 0.05 = 4.43%`

### Payout Structure

| OD Event        | Operator Pays                                                    |
|-----------------|------------------------------------------------------------------|
| Any Xanax (1-4) | 4x Xanax + $1M rehab bonus                                      |
| Ecstasy         | Full new package (4 Xan + 5 EDVD + 1 Ecstasy) + $1M rehab bonus |

### Pricing Formulas

All prices are variables pulled live from Torn API item market.

```
Package Cost        = (4 × xanax_price) + (5 × edvd_price) + (1 × ecstasy_price)
Xanax Payout        = (4 × xanax_price) + rehab_bonus
Ecstasy Payout      = package_cost + rehab_bonus
P(Xanax OD)         = 1 - (1 - xanax_od_pct)^4
P(Ecstasy OD)       = (1 - xanax_od_pct)^4 × ecstasy_od_pct
Expected Liability  = (P_xanax × xanax_payout) + (P_ecstasy × ecstasy_payout)
True Cost           = package_cost + expected_liability
Suggested Price     = true_cost / (1 - target_margin)
Profit Per Package  = suggested_price - true_cost
```

### Reserve & Availability

```
Max Simultaneous Packages = FLOOR(current_reserve / ecstasy_payout)
Remaining Availability    = max_simultaneous_packages - active_transactions
```

### Default Variable Values

| Variable           | Default    |
|--------------------|------------|
| Xanax price        | $850,000   |
| EDVD price         | $4,000,000 |
| Ecstasy price      | $70,000    |
| Xanax OD %         | 3%         |
| Ecstasy OD %       | 5%         |
| Rehab bonus        | $1,000,000 |
| Target margin      | 15%        |
| Worst case clients | 3          |

## Transaction Lifecycle

```
requested → purchased → closed_clean
                     → od_xanax → payout_sent
                     → od_ecstasy → payout_sent
```

- **requested:** Client submits Torn API key, request logged
- **purchased:** Operator completes in-game trade, marks purchased — 1-week timer starts
- **closed_clean:** 1 week passes with no OD reported, auto-closes
- **od_xanax / od_ecstasy:** Operator marks OD type, payout calculated automatically
- **payout_sent:** Operator sends replacement + rehab bonus in-game, confirms

OD verification uses Torn API events endpoint to confirm OD event in client's log.

## Database Schema

### `config` table (single row, operator-managed)

```sql
xanax_price         bigint
edvd_price          bigint
ecstasy_price       bigint
xanax_od_pct        decimal   -- e.g. 0.03
ecstasy_od_pct      decimal   -- e.g. 0.05
rehab_bonus         bigint
target_margin       decimal   -- e.g. 0.15
worst_case_clients  integer
current_reserve     bigint    -- operator updates manually
```

### `transactions` table

```sql
id                  uuid primary key
torn_id             text
torn_name           text
torn_faction        text
torn_level          integer
status              text  -- requested | purchased | closed_clean | od_xanax | od_ecstasy | payout_sent
package_cost        bigint    -- snapshot at time of sale
suggested_price     bigint    -- snapshot at time of sale
xanax_payout        bigint    -- snapshot at time of sale
ecstasy_payout      bigint    -- snapshot at time of sale
payout_amount       bigint    -- populated on OD
purchased_at        timestamptz
closes_at           timestamptz  -- purchased_at + 7 days
closed_at           timestamptz
created_at          timestamptz default now()
```

## Pages

### Public Page (`happyjump.girovagabondo.com`)

Displays: current package price, package contents, Xanax/Ecstasy OD payout amounts, rehab bonus, packages available counter (disables buy button at 0).

**Purchase flow:** Client enters Torn API key → Edge Function validates via Torn API → player info displayed for confirmation → client confirms → transaction created as `requested`.

### Admin Dashboard (password-protected via Supabase Auth)

- Stats bar: Active, Clean Closes, Xanax ODs, Ecstasy ODs, Total Revenue, Total Paid Out
- Transaction list: Sortable, filterable by status
- Per-transaction actions based on status
- Config panel: Edit all pricing variables and current reserve
- Auto-close: Scheduled function closes `purchased` transactions where `closes_at < now()`

## Edge Function Architecture

**All server-side logic goes through a single `gateway` Edge Function.** Do NOT create separate Edge Functions — add new actions to the gateway's router instead.

- **Location:** `supabase/functions/gateway/index.ts`
- **JWT verification:** OFF (disabled in Supabase dashboard). Public actions have no auth; admin actions verify auth internally.
- **Routing:** Client sends `{ action: "action-name", ...payload }` — gateway switches on `action`.
- **Client helper:** `src/api.js` has a `gateway()` function — all client calls go through it.
- **Deploy:** `supabase functions deploy gateway --no-verify-jwt`

### Current actions

| Action                   | Auth     | Description                              |
|--------------------------|----------|------------------------------------------|
| `validate-player`        | None     | Verify Torn identity via API key         |
| `torn-proxy`             | None     | Proxy arbitrary Torn API calls           |
| `create-transaction`     | None     | Create a new purchase request            |
| `get-player-transactions`| None     | Fetch a player's transaction history     |
| `get-availability`       | None     | Check package availability               |
| `update-config`          | Admin    | Update operator config (requires Supabase Auth session) |

## Torn API Integration

All calls go through the gateway Edge Function. Client never sees API keys.

### Torn API Endpoints Used

- `GET /user/?selections=basic,profile` — validate player, get name/faction/level
- `GET /torn/?selections=items` — item market prices for Xanax (ID 206), EDVD (366), Ecstasy (197)
- `GET /user/{torn_id}/events` — verify OD event in log

Cache market prices (refresh every 15 min max). Client-submitted API key used only once for identity verification, never stored.

## Git Workflow

**All work happens on `main`. No feature branches. No exceptions.** Push directly to `main` — this triggers the deploy workflow. When working from a Claude feature branch, always merge to `main` and push `main` so the code actually deploys. The live URL is the ONLY place the user tests — there is no local dev server, no staging, no preview. If code is not on `main`, it is not deployed, and the user cannot see it. NEVER ask "are you testing locally?" — the answer is always no.

## Deployment

```
Push to main → GitHub Actions → Vite build → FTP to InMotion cPanel subdomain
```

- Vite builds to `dist/`
- FTP deploys `dist/` to document root at `/home/nopape6/happyjump.girovagabondo.com/` (FTP_SERVER_DIR=/)
- Supabase Edge Functions: single `gateway` function deployed via `supabase functions deploy gateway --no-verify-jwt`
- **Hosting:** InMotion cPanel, subdomain document root is `/home/nopape6/happyjump.girovagabondo.com/` (NOT inside `public_html/`)

## Important Gotchas

- **iPad/no DevTools:** All errors must surface via visible UI (`showToast()` or inline error elements). Never `console.log` only.
- **FTP deploy:** Do NOT exclude `assets/dist/` from FTP sync — causes silent failures.
- **Supabase RLS:** Lock `transactions` table so clients can only insert, never read other clients' rows. Admin operations go through service role key in Edge Functions only.
- **Price snapshots:** Always snapshot pricing at time of transaction creation — config changes mid-week must not affect open transactions.
- **1-week timer:** Starts at `purchased_at`, not `created_at`. Auto-close must be idempotent.
- **Single gateway pattern:** NEVER create new Edge Functions. Add new actions to `supabase/functions/gateway/index.ts` and route via the `action` field. JWT must stay OFF — admin auth is handled inside the gateway.
