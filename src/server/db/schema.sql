PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

-- A review follows a branch or PR over time. Snapshots come and go beneath it.
CREATE TABLE IF NOT EXISTS review (
  id          INTEGER PRIMARY KEY,
  repo_key    TEXT NOT NULL,
  kind        TEXT NOT NULL,          -- local | pr
  ref         TEXT NOT NULL,          -- branch name, or 'pr/<n>'
  title       TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE(repo_key, kind, ref)
);

CREATE TABLE IF NOT EXISTS snapshot (
  id            INTEGER PRIMARY KEY,
  review_id     INTEGER NOT NULL REFERENCES review(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  base_sha      TEXT NOT NULL,
  head_sha      TEXT NOT NULL,
  dirty_digest  TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  UNIQUE(review_id, seq),
  -- Re-resolving an unchanged target must reuse its snapshot, not create one.
  UNIQUE(review_id, base_sha, head_sha, dirty_digest)
);

/*
 * Units are identified by content, not position.
 *
 * Because the UNIQUE key is (review, file, content hash, ordinal), a later
 * snapshot that re-derives the same change lands on the same row — and
 * therefore the same unit_state. Carrying review state forward is a lookup,
 * not a migration step that can be got wrong.
 */
CREATE TABLE IF NOT EXISTS unit (
  id            INTEGER PRIMARY KEY,
  review_id     INTEGER NOT NULL REFERENCES review(id) ON DELETE CASCADE,
  file_path     TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  ordinal       INTEGER NOT NULL,
  body          TEXT NOT NULL,        -- kept so old units render after a gc
  additions     INTEGER NOT NULL DEFAULT 0,
  deletions     INTEGER NOT NULL DEFAULT 0,
  first_seen    INTEGER NOT NULL,
  UNIQUE(review_id, file_path, content_hash, ordinal)
);

-- Line numbers live here, never on `unit`: they change without the code changing.
CREATE TABLE IF NOT EXISTS snapshot_unit (
  snapshot_id   INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  unit_id       INTEGER NOT NULL REFERENCES unit(id) ON DELETE CASCADE,
  new_start     INTEGER,
  old_start     INTEGER,
  locator_hash  TEXT NOT NULL,
  symbol        TEXT,
  PRIMARY KEY (snapshot_id, unit_id)
);

CREATE TABLE IF NOT EXISTS unit_state (
  unit_id     INTEGER PRIMARY KEY REFERENCES unit(id) ON DELETE CASCADE,
  state       TEXT NOT NULL,          -- unreviewed | reviewed | flagged | skimmed
  note        TEXT,
  decided_at  INTEGER NOT NULL,
  decided_in  INTEGER NOT NULL REFERENCES snapshot(id)
);

CREATE TABLE IF NOT EXISTS finding (
  id            INTEGER PRIMARY KEY,
  review_id     INTEGER NOT NULL REFERENCES review(id) ON DELETE CASCADE,
  snapshot_id   INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  rank          INTEGER NOT NULL,     -- RANK IS SEVERITY. Never re-sort.
  file_path     TEXT NOT NULL,
  line          INTEGER,
  summary       TEXT NOT NULL,
  short_summary TEXT,
  failure       TEXT NOT NULL,
  category      TEXT,
  verdict       TEXT,
  anchor_unit   INTEGER REFERENCES unit(id),
  fingerprint   TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS finding_by_review ON finding(review_id);
CREATE INDEX IF NOT EXISTS finding_by_fp ON finding(review_id, fingerprint);

-- Triage decisions outlive the snapshot and the run that produced the finding.
CREATE TABLE IF NOT EXISTS finding_decision (
  fingerprint  TEXT NOT NULL,
  review_id    INTEGER NOT NULL REFERENCES review(id) ON DELETE CASCADE,
  disposition  TEXT NOT NULL,
  note         TEXT,
  decided_at   INTEGER NOT NULL,
  PRIMARY KEY (review_id, fingerprint)
);
