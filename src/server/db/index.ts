import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Snapshot } from '../../shared/types.js';
import type { ReviewUnit } from '../git/units.js';

const here = dirname(fileURLToPath(import.meta.url));

export type UnitState = 'unreviewed' | 'reviewed' | 'flagged' | 'skimmed';

export interface ResumeReport {
  isNew: boolean;
  newUnits: number;
  goneUnits: number;
  carriedReviewed: number;
  movedUnits: number;
  editedUnits: number;
  previousHead?: string;
  baseMoved: boolean;
}

let db: DatabaseSync | null = null;

/**
 * Node's built-in SQLite, not better-sqlite3.
 *
 * A native addon needs a compile step at install time, which is exactly the
 * friction a local tool should not have. `node:sqlite` ships with Node 22 and
 * gives the same synchronous API, so a single writer in the server process
 * sidesteps lock contention entirely.
 */
export function open(path?: string): DatabaseSync {
  if (db) return db;
  const file = path ?? join(homedir(), '.changelens', 'db.sqlite');
  mkdirSync(dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  return db;
}

/** node:sqlite has no transaction helper, so scope one explicitly. */
function inTransaction<T>(d: DatabaseSync, fn: () => T): T {
  d.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    d.exec('COMMIT');
    return out;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

function reviewKey(snap: Snapshot): { kind: string; ref: string } {
  return snap.kind === 'pr'
    ? { kind: 'pr', ref: `pr/${snap.prNumber}` }
    : { kind: 'local', ref: snap.headRef };
}

/**
 * Record this snapshot and carry review state forward from the previous one.
 *
 * Carry-over falls out of the schema rather than from a migration: a unit's
 * identity is (review, file, content hash, ordinal), so re-deriving the same
 * change in a later snapshot lands on the same row and therefore the same
 * `unit_state`. A clean rebase changes every commit SHA but not the net diff,
 * so its units match on content and nothing resets — no rebase-specific code.
 */
export function persistSnapshot(
  snap: Snapshot,
  units: ReviewUnit[],
): { snapshotId: number; reviewId: number; states: Record<string, UnitState>; resume: ResumeReport } {
  const d = open();
  const now = Date.now();
  const { kind, ref } = reviewKey(snap);

  return inTransaction(d, () => {
    d.prepare(
      `INSERT INTO review (repo_key, kind, ref, title, created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(repo_key, kind, ref) DO UPDATE SET title = excluded.title`,
    ).run(snap.repoKey, kind, ref, snap.prTitle ?? null, now);
    const reviewId = d
      .prepare('SELECT id FROM review WHERE repo_key=? AND kind=? AND ref=?')
      .get(snap.repoKey, kind, ref) as { id: number };

    const previous = d
      .prepare('SELECT id, head_sha, base_sha FROM snapshot WHERE review_id=? ORDER BY seq DESC LIMIT 1')
      .get(reviewId.id) as { id: number; head_sha: string; base_sha: string } | undefined;

    const existing = d
      .prepare(
        'SELECT id FROM snapshot WHERE review_id=? AND base_sha=? AND head_sha=? AND dirty_digest=?',
      )
      .get(reviewId.id, snap.baseSha, snap.headSha, snap.dirtyDigest ?? '') as { id: number } | undefined;

    let snapshotId: number;
    let isNew: boolean;
    if (existing) {
      snapshotId = existing.id;
      isNew = false;
    } else {
      const seq = (d.prepare('SELECT COALESCE(MAX(seq),0) s FROM snapshot WHERE review_id=?')
        .get(reviewId.id) as { s: number }).s + 1;
      snapshotId = d
        .prepare(
          'INSERT INTO snapshot (review_id, seq, base_sha, head_sha, dirty_digest, created_at) VALUES (?,?,?,?,?,?)',
        )
        .run(reviewId.id, seq, snap.baseSha, snap.headSha, snap.dirtyDigest ?? '', now)
        .lastInsertRowid as number;
      isNew = true;
    }

    const priorUnitIds = previous
      ? new Set(
          (d.prepare('SELECT unit_id FROM snapshot_unit WHERE snapshot_id=?')
            .all(previous.id) as { unit_id: number }[]).map((r) => r.unit_id),
        )
      : new Set<number>();

    const upsertUnit = d.prepare(
      `INSERT INTO unit (review_id, file_path, content_hash, ordinal, body, additions, deletions, first_seen)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(review_id, file_path, content_hash, ordinal) DO UPDATE SET body = excluded.body
       RETURNING id`,
    );
    const linkUnit = d.prepare(
      `INSERT INTO snapshot_unit (snapshot_id, unit_id, new_start, old_start, locator_hash, symbol)
       VALUES (?,?,?,?,?,?) ON CONFLICT(snapshot_id, unit_id) DO UPDATE SET
         new_start = excluded.new_start, old_start = excluded.old_start,
         locator_hash = excluded.locator_hash, symbol = excluded.symbol`,
    );
    const getState = d.prepare('SELECT state FROM unit_state WHERE unit_id=?');
    const priorLocator = d.prepare(
      'SELECT locator_hash FROM snapshot_unit WHERE snapshot_id=? AND unit_id=?',
    );

    const states: Record<string, UnitState> = {};
    const currentUnitIds = new Set<number>();
    let carriedReviewed = 0;
    let newUnits = 0;
    let movedUnits = 0;

    for (const u of units) {
      const unitId = (upsertUnit.get(
        reviewId.id, u.filePath, u.contentHash, u.ordinal, u.body, u.additions, u.deletions, now,
      ) as { id: number }).id;
      currentUnitIds.add(unitId);
      linkUnit.run(snapshotId, unitId, u.newStart, u.oldStart, u.locatorHash, u.symbol || null);

      const prior = (getState.get(unitId) as { state: UnitState } | undefined)?.state;
      if (prior && prior !== 'unreviewed') {
        states[u.id] = prior;
        if (prior === 'reviewed' || prior === 'skimmed') carriedReviewed++;
      }
      if (!priorUnitIds.has(unitId)) {
        newUnits++;
      } else if (previous) {
        // Same content under different surroundings: the code moved but is
        // unchanged, so review state is still valid.
        const before = (priorLocator.get(previous.id, unitId) as { locator_hash: string } | undefined);
        if (before && before.locator_hash !== u.locatorHash) movedUnits++;
      }
    }

    const goneUnits = [...priorUnitIds].filter((id) => !currentUnitIds.has(id)).length;

    return {
      snapshotId,
      reviewId: reviewId.id,
      states,
      resume: {
        isNew: isNew && !previous ? true : isNew,
        newUnits: previous ? newUnits : 0,
        goneUnits,
        carriedReviewed,
        movedUnits,
        // A unit that vanished while a new one appeared in the same file is the
        // in-place edit case; reported together rather than guessed at per-unit.
        editedUnits: Math.min(goneUnits, newUnits),
        previousHead: previous?.head_sha,
        baseMoved: Boolean(previous && previous.base_sha !== snap.baseSha),
      },
    };
  });
}

export function setUnitState(
  reviewId: number,
  snapshotId: number,
  filePath: string,
  contentHash: string,
  ordinal: number,
  state: UnitState,
): void {
  const d = open();
  const unit = d
    .prepare('SELECT id FROM unit WHERE review_id=? AND file_path=? AND content_hash=? AND ordinal=?')
    .get(reviewId, filePath, contentHash, ordinal) as { id: number } | undefined;
  if (!unit) return;
  d.prepare(
    `INSERT INTO unit_state (unit_id, state, decided_at, decided_in) VALUES (?,?,?,?)
     ON CONFLICT(unit_id) DO UPDATE SET state=excluded.state, decided_at=excluded.decided_at, decided_in=excluded.decided_in`,
  ).run(unit.id, state, Date.now(), snapshotId);
}

/** Triage decisions are keyed by fingerprint so they survive a re-review. */
export function setDisposition(reviewId: number, fingerprint: string, disposition: string, note?: string): void {
  const d = open();
  d.prepare(
    `INSERT INTO finding_decision (review_id, fingerprint, disposition, note, decided_at) VALUES (?,?,?,?,?)
     ON CONFLICT(review_id, fingerprint) DO UPDATE SET disposition=excluded.disposition, note=excluded.note, decided_at=excluded.decided_at`,
  ).run(reviewId, fingerprint, disposition, note ?? null, Date.now());
}

export function dispositionsFor(reviewId: number): Record<string, string> {
  const rows = open()
    .prepare('SELECT fingerprint, disposition FROM finding_decision WHERE review_id=?')
    .all(reviewId) as { fingerprint: string; disposition: string }[];
  return Object.fromEntries(rows.map((r) => [r.fingerprint, r.disposition]));
}
