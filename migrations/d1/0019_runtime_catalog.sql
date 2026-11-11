-- Runtime DATA publication is independent of Worker version activation.
-- Existing catalog/native/publication receipts keep their original schema/bytes.
CREATE TABLE catalog_runtime_publications (
  release_id TEXT PRIMARY KEY NOT NULL REFERENCES publication_receipts(release_id),
  catalog_revision TEXT NOT NULL,
  data_sha256 TEXT NOT NULL CHECK(length(data_sha256)=64),
  source_snapshot_sha256 TEXT NOT NULL CHECK(length(source_snapshot_sha256)=64),
  public_snapshot_sha256 TEXT NOT NULL CHECK(length(public_snapshot_sha256)=64),
  handoff_sha256 TEXT CHECK(handoff_sha256 IS NULL OR length(handoff_sha256)=64),
  request_id TEXT REFERENCES catalog_build_requests(request_id),
  owner_json TEXT NOT NULL CHECK(json_valid(owner_json)),
  previous_release_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TRIGGER catalog_runtime_publications_immutable BEFORE UPDATE ON catalog_runtime_publications BEGIN
  SELECT RAISE(ABORT,'Runtime publication receipts are immutable');
END;
CREATE TRIGGER catalog_runtime_publications_retained BEFORE DELETE ON catalog_runtime_publications BEGIN
  SELECT RAISE(ABORT,'Runtime publication receipts are retained');
END;
CREATE TABLE catalog_runtime_head (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  release_id TEXT NOT NULL REFERENCES catalog_runtime_publications(release_id),
  version INTEGER NOT NULL CHECK(version>0),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1))
);
CREATE TABLE catalog_runtime_collections (
  name TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0),
  request_id TEXT NOT NULL UNIQUE REFERENCES content_admin_requests(request_id),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  PRIMARY KEY(name,revision)
);
CREATE TRIGGER catalog_runtime_collections_immutable BEFORE UPDATE ON catalog_runtime_collections BEGIN
  SELECT RAISE(ABORT,'Collection versions are immutable');
END;
CREATE TRIGGER catalog_runtime_collections_retained BEFORE DELETE ON catalog_runtime_collections BEGIN
  SELECT RAISE(ABORT,'Collection versions are retained');
END;
CREATE TABLE content_admin_results (
  request_id TEXT PRIMARY KEY REFERENCES content_admin_requests(request_id),
  state TEXT NOT NULL CHECK(state IN ('applied','running','failed')),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  created_at TEXT NOT NULL
);
-- Only finite derived bodies are registered here, with ORIGINAL deadlines.
-- Cleared base data, control records and publication history are not purged.
CREATE TABLE catalog_runtime_retention (
  object_key TEXT PRIMARY KEY NOT NULL,
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  not_after TEXT NOT NULL,
  release_id TEXT NOT NULL,
  purged_at TEXT
);
