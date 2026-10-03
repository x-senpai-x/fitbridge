-- Freeze the date convention before the first signed import can commit.
ALTER TABLE owner ADD COLUMN ingest_started INTEGER NOT NULL DEFAULT 0 CHECK (ingest_started IN (0, 1));
UPDATE owner SET ingest_started = 1 WHERE EXISTS (SELECT 1 FROM records);
