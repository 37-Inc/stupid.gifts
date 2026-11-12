-- A dispatch acknowledgement is not product publication. Keep these separate
-- from admission results, which the existing coordinator owns.
CREATE TABLE content_admin_dispatches (
  request_id TEXT PRIMARY KEY NOT NULL REFERENCES content_admin_requests(request_id),
  claim_token TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('claimed','accepted','rejected','unknown')),
  provider_status INTEGER,
  workflow_run_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
