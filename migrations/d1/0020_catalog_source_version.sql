-- A small invalidation counter, not catalog data or a publication receipt.
-- Every change to a source table invalidates a process-local inventory proof.
CREATE TABLE catalog_source_version (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  version INTEGER NOT NULL CHECK(version>=0)
);
INSERT INTO catalog_source_version VALUES(1,0);
CREATE TRIGGER catalog_source_products_insert AFTER INSERT ON products BEGIN
  UPDATE catalog_source_version SET version=version+1 WHERE singleton=1;
END;
CREATE TRIGGER catalog_source_products_update AFTER UPDATE ON products BEGIN
  UPDATE catalog_source_version SET version=version+1 WHERE singleton=1;
END;
CREATE TRIGGER catalog_source_products_delete AFTER DELETE ON products BEGIN
  UPDATE catalog_source_version SET version=version+1 WHERE singleton=1;
END;
CREATE TRIGGER catalog_source_private_insert AFTER INSERT ON catalog_maintenance_products BEGIN
  UPDATE catalog_source_version SET version=version+1 WHERE singleton=1;
END;
CREATE TRIGGER catalog_source_private_update AFTER UPDATE ON catalog_maintenance_products BEGIN
  UPDATE catalog_source_version SET version=version+1 WHERE singleton=1;
END;
CREATE TRIGGER catalog_source_private_delete AFTER DELETE ON catalog_maintenance_products BEGIN
  UPDATE catalog_source_version SET version=version+1 WHERE singleton=1;
END;
CREATE TRIGGER catalog_source_operations_insert AFTER INSERT ON catalog_maintenance_operations BEGIN
  UPDATE catalog_source_version SET version=version+1 WHERE singleton=1;
END;
CREATE TRIGGER catalog_source_operations_update AFTER UPDATE ON catalog_maintenance_operations BEGIN
  UPDATE catalog_source_version SET version=version+1 WHERE singleton=1;
END;
CREATE TRIGGER catalog_source_operations_delete AFTER DELETE ON catalog_maintenance_operations BEGIN
  UPDATE catalog_source_version SET version=version+1 WHERE singleton=1;
END;
