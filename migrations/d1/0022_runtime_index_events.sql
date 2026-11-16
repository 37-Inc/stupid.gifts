-- Registration is in the real catalog acceptance transaction. Delivery is not
-- a second catalog publisher and never changes products, source clocks or heads.
-- Reuse the existing immutable native payload; do not change legacy row shapes.
CREATE TABLE catalog_runtime_index_events (
  sequence INTEGER PRIMARY KEY NOT NULL REFERENCES catalog_maintenance_vector_payloads(sequence),
  release_id TEXT NOT NULL REFERENCES publication_receipts(release_id) DEFERRABLE INITIALLY DEFERRED,
  operation_id TEXT NOT NULL REFERENCES catalog_maintenance_operations(operation_id),
  descriptor_json TEXT CHECK(descriptor_json IS NULL OR json_valid(descriptor_json)),
  delivery_json TEXT NOT NULL DEFAULT '{"native":[],"serving":[]}' CHECK(json_valid(delivery_json)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','complete')),
  retry_after TEXT,
  completed_at TEXT,
  CHECK((state='complete')=(completed_at IS NOT NULL))
);
CREATE INDEX catalog_runtime_index_events_pending ON catalog_runtime_index_events(state,sequence);
CREATE TRIGGER catalog_runtime_index_event_identity BEFORE UPDATE OF sequence,release_id,operation_id ON catalog_runtime_index_events BEGIN
  SELECT RAISE(ABORT,'Runtime index event identity is immutable');
END;
CREATE TRIGGER catalog_runtime_index_event_descriptor BEFORE UPDATE OF descriptor_json ON catalog_runtime_index_events
WHEN OLD.descriptor_json IS NOT NULL AND OLD.descriptor_json IS NOT NEW.descriptor_json BEGIN
  SELECT RAISE(ABORT,'Runtime index descriptor is immutable');
END;
CREATE TRIGGER catalog_runtime_index_event_complete BEFORE UPDATE ON catalog_runtime_index_events WHEN OLD.state='complete' BEGIN
  SELECT RAISE(ABORT,'Runtime index completion is immutable');
END;
CREATE TRIGGER catalog_runtime_index_event_retained BEFORE DELETE ON catalog_runtime_index_events BEGIN
  SELECT RAISE(ABORT,'Runtime index events are retained');
END;
