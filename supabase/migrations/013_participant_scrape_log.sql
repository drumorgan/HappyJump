-- Faction Events: persist the most recent scrape diagnostic per participant
-- so the operator (and event creator) can investigate count discrepancies
-- without having to wait for a fresh scrape. Without this column, the rich
-- `diag` object that countItemUseInLog produces (matched entries, log-type
-- histogram, rejected samples, per-page debug log) only ever surfaced to
-- the user who clicked their own "Refresh my count" button — it was lost
-- on every other write path (initial join, background sweep, someone else
-- inspecting the row).
--
-- One JSON column per row keeps the latest scrape only — no audit history.
-- If we need a full per-scrape audit log later, that's a separate table.
ALTER TABLE faction_event_participants
  ADD COLUMN IF NOT EXISTS last_diag_json jsonb;
