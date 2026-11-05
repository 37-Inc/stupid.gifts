-- Anonymous per-search observations, not visitor/session records. No catalog writes.
CREATE TABLE IF NOT EXISTS search_demand (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  topic TEXT NOT NULL CHECK(length(topic) BETWEEN 2 AND 80),
  outcome TEXT NOT NULL CHECK(outcome IN ('results','unavailable')),
  result_count INTEGER,
  selected_rank INTEGER,
  expires_at INTEGER NOT NULL,
  CHECK((outcome='unavailable' AND result_count IS NULL AND selected_rank IS NULL)
    OR (outcome='results' AND result_count IS NOT NULL AND typeof(result_count)='integer' AND result_count BETWEEN 0 AND 36
      AND (selected_rank IS NULL OR selected_rank BETWEEN 1 AND result_count)))
);
CREATE INDEX IF NOT EXISTS search_demand_expiry ON search_demand(expires_at);
CREATE INDEX IF NOT EXISTS search_demand_day ON search_demand(day);
