-- Private, append-only editorial REQUESTS. These are not catalog receipts,
-- published projections, admission jobs or permission to call a provider.
CREATE TABLE content_admin_requests (
  request_id TEXT PRIMARY KEY NOT NULL,
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  resource TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0),
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  base_catalog_revision TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('admit','product','collection','active-show','restore')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL,
  UNIQUE(resource,revision)
);
CREATE TRIGGER content_admin_requests_immutable BEFORE UPDATE ON content_admin_requests BEGIN
  SELECT RAISE(ABORT,'Content requests are append-only');
END;
CREATE TRIGGER content_admin_requests_retained BEFORE DELETE ON content_admin_requests BEGIN
  SELECT RAISE(ABORT,'Content request history is retained');
END;
