/**
 * WorkbenchOS journal schema v1.
 *
 * Authorized by task package M1-001-P3 (§7 F4, F6).
 */

import type { Database } from 'bun:sqlite'

export const WORKBENCH_SCHEMA_VERSION = 1

export const WORKBENCH_PRAGMAS: readonly string[] = [
  'journal_mode = WAL',
  'foreign_keys = ON',
  'synchronous = FULL',
  'busy_timeout = 5000',
]

export const WORKBENCH_SCHEMA_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    task_id TEXT NOT NULL,
    run_id TEXT,
    event_type TEXT NOT NULL,
    protocol_version TEXT NOT NULL,
    producer_kind TEXT NOT NULL,
    producer_id TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    causation_event_id TEXT,
    UNIQUE (producer_id, dedupe_key)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_events_task ON events (task_id, sequence)',
  'CREATE INDEX IF NOT EXISTS idx_events_run ON events (run_id, sequence)',
  `CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    envelope_json TEXT NOT NULL,
    active_run_id TEXT,
    latest_result_id TEXT,
    version INTEGER NOT NULL,
    last_event_sequence INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(task_id),
    attempt INTEGER NOT NULL,
    state TEXT NOT NULL,
    submission_key TEXT NOT NULL,
    native_ref TEXT,
    result_id TEXT,
    version INTEGER NOT NULL,
    last_event_sequence INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (task_id, attempt)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_runs_task ON runs (task_id)',
  `CREATE TABLE IF NOT EXISTS results (
    result_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id),
    payload_hash TEXT NOT NULL,
    envelope_json TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS idempotency (
    namespace TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    outcome_ref TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    PRIMARY KEY (namespace, operation_key)
  )`,
]

export function readSchemaVersion(db: Database): number {
  const row = db.query('PRAGMA user_version').get() as Record<string, unknown> | null
  const raw = row === null ? undefined : row.user_version
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw
  if (typeof raw === 'bigint') return Number(raw)
  throw new Error(`unable to read PRAGMA user_version: ${String(raw)}`)
}

export function writeSchemaVersion(db: Database, version: number): void {
  if (version !== 0 && version !== WORKBENCH_SCHEMA_VERSION) {
    throw new TypeError(`unsupported schema version write: ${String(version)}`)
  }
  db.exec(`PRAGMA user_version = ${version}`)
}

/**
 * Applies the v1 DDL and stamps the schema version. The caller owns the
 * surrounding transaction; this function never opens or commits one.
 */
export function bootstrapSchema(db: Database): void {
  for (const statement of WORKBENCH_SCHEMA_DDL) {
    db.exec(statement)
  }
  writeSchemaVersion(db, WORKBENCH_SCHEMA_VERSION)
}
