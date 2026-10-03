-- One row per Health Connect record; heart-rate and skin-temperature samples are packed into their parent record.
CREATE TABLE records (
  type TEXT NOT NULL,
  id TEXT NOT NULL,
  source TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  local_date TEXT NOT NULL,
  value REAL,
  n INTEGER NOT NULL,
  vmin REAL,
  vmax REAL,
  body TEXT NOT NULL,
  -- Heart rate only: [[minute_ms, n, sum, min, max], ...], so readers never expand the raw samples.
  minutes TEXT,
  observed_ms INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (type, local_date, id)
) WITHOUT ROWID;

CREATE UNIQUE INDEX records_type_id ON records (type, id);

CREATE TABLE daily (
  local_date TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (local_date, metric)
) WITHOUT ROWID;

CREATE TABLE dirty_days (
  local_date TEXT PRIMARY KEY
) WITHOUT ROWID;

-- ON CONFLICT DO NOTHING, not INSERT OR IGNORE: an upsert's conflict policy overrides OR IGNORE inside its triggers.
CREATE TRIGGER records_dirty_insert AFTER INSERT ON records BEGIN
  INSERT INTO dirty_days (local_date) SELECT NEW.local_date WHERE NEW.local_date <> '' ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER records_dirty_update AFTER UPDATE ON records BEGIN
  INSERT INTO dirty_days (local_date) SELECT OLD.local_date WHERE OLD.local_date <> '' ON CONFLICT DO NOTHING;
  INSERT INTO dirty_days (local_date) SELECT NEW.local_date WHERE NEW.local_date <> '' ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER records_dirty_delete AFTER DELETE ON records BEGIN
  INSERT INTO dirty_days (local_date) SELECT OLD.local_date WHERE OLD.local_date <> '' ON CONFLICT DO NOTHING;
END;

CREATE TABLE write_budget (
  day TEXT PRIMARY KEY,
  rows INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE ingest_log (
  id INTEGER PRIMARY KEY,
  received_ms INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_ms INTEGER,
  sequence INTEGER,
  bytes INTEGER NOT NULL,
  counts TEXT NOT NULL DEFAULT '{}',
  deletions INTEGER NOT NULL DEFAULT 0,
  backfill_window TEXT,
  deletions_unavailable TEXT,
  records_outside_window TEXT,
  status INTEGER NOT NULL,
  error TEXT
);
CREATE INDEX ingest_log_received ON ingest_log (received_ms);

CREATE TABLE rejected_records (
  id INTEGER PRIMARY KEY,
  received_ms INTEGER NOT NULL,
  payload_ms INTEGER,
  type TEXT NOT NULL,
  reason TEXT NOT NULL,
  raw TEXT NOT NULL
);
CREATE INDEX rejected_records_received ON rejected_records (received_ms);
