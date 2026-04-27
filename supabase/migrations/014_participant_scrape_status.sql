-- Faction Events: per-participant scrape queue state. Drives the "timed
-- bulk refresh" flow where the operator clicks "Refresh all", every row
-- is marked 'pending', then the frontend processes participants one at a
-- time with a delay between each call (avoids hammering Torn's API and
-- gives the operator visible progress).
--
-- States:
--   NULL      → ready / never queued / done (default)
--   'pending' → queued for refresh; not yet processed
--
-- Resume semantics: if the page reloads mid-batch, any rows still
-- 'pending' are still pending. The frontend can pick up where it left
-- off by calling scrape-next-pending until the queue is empty.
ALTER TABLE faction_event_participants
  ADD COLUMN IF NOT EXISTS scrape_status text;

-- Partial index to keep "find next pending row for this event" fast even
-- when the table grows. Filtering on event_id + scrape_status='pending'
-- ordered by created_at is the hot path for handleScrapeNextPending.
CREATE INDEX IF NOT EXISTS faction_event_participants_pending_idx
  ON faction_event_participants(event_id, created_at)
  WHERE scrape_status IS NOT NULL;
