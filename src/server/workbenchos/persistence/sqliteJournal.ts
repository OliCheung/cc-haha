/**
 * WorkbenchOS SQLite journal.
 *
 * `commit` is the single write entry point and runs in one transaction.
 * Side effects must never happen inside this transaction (DECISION_LOG D-012);
 * that is enforced by not exposing any callback-style transaction API.
 *
 * Authorized by task package M1-001-P3 (§7 F5, F6, F7, F9).
 */

import { Database } from 'bun:sqlite'
import type {
  ActorRef,
  EventEnvelopeV01,
  EventType,
  IdempotencyRecord,
  IdempotencyStatus,
  JsonValue,
  ResultEnvelopeV01,
  RunProjection,
  RunState,
  TaskProjection,
  TaskState,
} from '../contracts.js'
import type {
  JournalCommitBatch,
  JournalCommitResult,
  JournalErrorCode,
  JournalIntegrityReport,
  JournalPortV01,
} from '../ports/journalPort.js'
import { hashPayload } from '../core/idempotency.js'
import {
  WORKBENCH_PRAGMAS,
  WORKBENCH_SCHEMA_VERSION,
  bootstrapSchema,
  readSchemaVersion,
} from './schema.js'

/**
 * F9: the projection checkpoint (`last_event_sequence`) is owned by the journal.
 * Whenever a projection is written, the journal stamps it with the highest event
 * sequence recorded for that aggregate inside the contract of the same
 * transaction. The value supplied by the caller is therefore advisory.
 */

export type SqliteJournalOptions = {
  databasePath: string
}

const TERMINAL_RUN_STATES: readonly RunState[] = [
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
]

const TASK_COLUMNS =
  'task_id, state, envelope_json, active_run_id, latest_result_id, version, last_event_sequence, updated_at'

const RUN_COLUMNS =
  'run_id, task_id, attempt, state, submission_key, native_ref, result_id, version, last_event_sequence, updated_at'

const EVENT_COLUMNS =
  'sequence, event_id, task_id, run_id, event_type, protocol_version, producer_kind, producer_id, dedupe_key, payload_hash, payload_json, recorded_at, causation_event_id'

class JournalFailure extends Error {
  readonly code: JournalErrorCode

  constructor(code: JournalErrorCode, detail: string) {
    super(detail)
    this.name = 'JournalFailure'
    this.code = code
  }
}

export class SqliteJournal implements JournalPortV01 {
  readonly protocolVersion = '0.1' as const

  private readonly databasePath: string
  private db: Database | null = null

  constructor(options: SqliteJournalOptions) {
    if (typeof options.databasePath !== 'string' || options.databasePath.length === 0) {
      throw new TypeError('databasePath must be a non-empty string')
    }
    this.databasePath = options.databasePath
  }

  async open(): Promise<void> {
    if (this.db !== null) return

    const db = new Database(this.databasePath, { create: true })
    try {
      for (const pragma of WORKBENCH_PRAGMAS) {
        db.exec(`PRAGMA ${pragma}`)
      }

      const version = readSchemaVersion(db)
      if (version === 0) {
        db.exec('BEGIN IMMEDIATE')
        try {
          bootstrapSchema(db)
          db.exec('COMMIT')
        } catch (error) {
          try {
            db.exec('ROLLBACK')
          } catch {
            // The connection is discarded below; the original error is reported.
          }
          throw error
        }
      } else if (version !== WORKBENCH_SCHEMA_VERSION) {
        throw new JournalFailure(
          'SCHEMA_VERSION_UNSUPPORTED',
          `unsupported schema version ${version}, this build supports ${WORKBENCH_SCHEMA_VERSION}`,
        )
      }

      this.db = db
    } catch (error) {
      try {
        db.close()
      } catch {
        // Nothing useful can be done with a handle that already failed to open.
      }
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  async close(): Promise<void> {
    const db = this.db
    if (db === null) return
    this.db = null
    try {
      db.close()
    } catch {
      // Closing an already failed handle must not mask the caller's flow.
    }
  }

  async commit(batch: JournalCommitBatch): Promise<JournalCommitResult> {
    const db = this.db
    if (db === null) {
      return { ok: false, error: { code: 'UNAVAILABLE', detail: 'journal is not open' } }
    }

    db.exec('BEGIN IMMEDIATE')
    try {
      // F9: events first, so projection checkpoints can be derived from them.
      // FKs only constrain tasks -> runs -> results, so this order stays valid.
      let lastSequence = 0
      for (const event of batch.events ?? []) {
        lastSequence = this.writeEvent(db, event)
      }

      if (batch.expected_task_version) {
        this.assertTaskVersion(db, batch.expected_task_version)
      }
      if (batch.expected_run_version) {
        this.assertRunVersion(db, batch.expected_run_version)
      }

      for (const task of batch.tasks ?? []) {
        this.writeTask(db, task, batch.expected_task_version)
      }
      for (const run of batch.runs ?? []) {
        this.writeRun(db, run, batch.expected_run_version)
      }
      for (const result of batch.results ?? []) {
        this.writeResult(db, result)
      }
      if (batch.idempotency) {
        this.writeIdempotency(db, batch.idempotency)
      }

      db.exec('COMMIT')
      return { ok: true, sequence: lastSequence }
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Report the original failure rather than the rollback outcome.
      }
      if (error instanceof JournalFailure) {
        return { ok: false, error: { code: error.code, detail: error.message } }
      }
      return { ok: false, error: { code: 'INTERNAL', detail: errorMessage(error) } }
    }
  }

  async checkIntegrity(): Promise<JournalIntegrityReport> {
    const db = this.getDb()
    const details: string[] = []

    const schemaVersion = readSchemaVersion(db)

    const quickCheck = db.query('PRAGMA quick_check').all() as Array<Record<string, unknown>>
    const quickValues = quickCheck.map(row => String(Object.values(row)[0]))
    if (quickValues.length !== 1 || quickValues[0] !== 'ok') {
      details.push(`quick_check_failed: ${quickValues.join(', ')}`)
    }

    const foreignKeyViolations = db.query('PRAGMA foreign_key_check').all()
    if (foreignKeyViolations.length > 0) {
      details.push(`foreign_key_violation: ${JSON.stringify(foreignKeyViolations)}`)
    }

    const tasks = db.query('SELECT task_id, last_event_sequence FROM tasks').all() as Array<Record<string, unknown>>
    for (const row of tasks) {
      const taskId = String(row.task_id)
      const projection = Number(row.last_event_sequence)
      const events = maxEventSequence(db, 'task_id', taskId)
      if (events !== projection) {
        details.push(`task_projection_ahead_or_behind: ${taskId} (projection=${projection}, events=${events})`)
      }
    }

    const runs = db.query('SELECT run_id, last_event_sequence FROM runs').all() as Array<Record<string, unknown>>
    for (const row of runs) {
      const runId = String(row.run_id)
      const projection = Number(row.last_event_sequence)
      const events = maxEventSequence(db, 'run_id', runId)
      if (events !== projection) {
        details.push(`run_projection_ahead_or_behind: ${runId} (projection=${projection}, events=${events})`)
      }
    }

    const countRow = db.query('SELECT COUNT(*) AS event_count FROM events').get() as Record<string, unknown> | null
    const eventCount = countRow === null ? 0 : Number(countRow.event_count)

    return {
      schema_version: schemaVersion,
      event_count: eventCount,
      projection_consistent: details.length === 0,
      details,
    }
  }

  async readTask(taskId: string): Promise<TaskProjection | null> {
    const row = this.getDb()
      .query(`SELECT ${TASK_COLUMNS} FROM tasks WHERE task_id = ?`)
      .get(taskId) as Record<string, unknown> | null
    if (row === null) return null
    return {
      task_id: String(row.task_id),
      state: String(row.state) as TaskState,
      envelope: JSON.parse(String(row.envelope_json)) as TaskProjection['envelope'],
      active_run_id: nullableString(row.active_run_id),
      latest_result_id: nullableString(row.latest_result_id),
      version: Number(row.version),
      last_event_sequence: Number(row.last_event_sequence),
      updated_at: String(row.updated_at),
    }
  }

  async readRun(runId: string): Promise<RunProjection | null> {
    const row = this.getDb()
      .query(`SELECT ${RUN_COLUMNS} FROM runs WHERE run_id = ?`)
      .get(runId) as Record<string, unknown> | null
    if (row === null) return null
    return mapRunRow(row)
  }

  async readResultByRun(runId: string): Promise<ResultEnvelopeV01 | null> {
    const row = this.getDb()
      .query('SELECT envelope_json FROM results WHERE run_id = ?')
      .get(runId) as Record<string, unknown> | null
    if (row === null) return null
    return JSON.parse(String(row.envelope_json)) as ResultEnvelopeV01
  }

  async readIdempotency(namespace: string, operationKey: string): Promise<IdempotencyRecord | null> {
    const row = this.getDb()
      .query('SELECT namespace, operation_key, payload_hash, outcome_ref, status, created_at, completed_at FROM idempotency WHERE namespace = ? AND operation_key = ?')
      .get(namespace, operationKey) as Record<string, unknown> | null
    if (row === null) return null
    return {
      namespace: String(row.namespace),
      operation_key: String(row.operation_key),
      payload_hash: String(row.payload_hash),
      outcome_ref: String(row.outcome_ref),
      status: String(row.status) as IdempotencyRecord['status'],
      created_at: String(row.created_at),
      completed_at: nullableString(row.completed_at),
    }
  }

  async listIdempotency(
    namespace: string,
    status?: IdempotencyStatus,
  ): Promise<IdempotencyRecord[]> {
    const db = this.getDb()
    const rows =
      status === undefined
        ? (db
            .query(
              'SELECT namespace, operation_key, payload_hash, outcome_ref, status, created_at, completed_at FROM idempotency WHERE namespace = ? ORDER BY operation_key ASC',
            )
            .all(namespace) as Array<Record<string, unknown>>)
        : (db
            .query(
              'SELECT namespace, operation_key, payload_hash, outcome_ref, status, created_at, completed_at FROM idempotency WHERE namespace = ? AND status = ? ORDER BY operation_key ASC',
            )
            .all(namespace, status) as Array<Record<string, unknown>>)

    return rows.map((row) => ({
      namespace: String(row.namespace),
      operation_key: String(row.operation_key),
      payload_hash: String(row.payload_hash),
      outcome_ref: String(row.outcome_ref),
      status: String(row.status) as IdempotencyStatus,
      created_at: String(row.created_at),
      completed_at: nullableString(row.completed_at),
    }))
  }

  async listNonTerminalRuns(): Promise<RunProjection[]> {
    const placeholders = TERMINAL_RUN_STATES.map(() => '?').join(', ')
    const rows = this.getDb()
      .query(`SELECT ${RUN_COLUMNS} FROM runs WHERE state NOT IN (${placeholders}) ORDER BY run_id ASC`)
      .all(...TERMINAL_RUN_STATES) as Array<Record<string, unknown>>
    return rows.map(mapRunRow)
  }

  async listEventsForTask(taskId: string): Promise<EventEnvelopeV01<JsonValue>[]> {
    const rows = this.getDb()
      .query(`SELECT ${EVENT_COLUMNS} FROM events WHERE task_id = ? ORDER BY sequence ASC`)
      .all(taskId) as Array<Record<string, unknown>>
    return rows.map(mapEventRow)
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private getDb(): Database {
    const db = this.db
    if (db === null) throw new Error('UNAVAILABLE: journal is not open')
    return db
  }

  private assertTaskVersion(
    db: Database,
    expected: { task_id: string; version: number },
  ): void {
    const row = db.query('SELECT version FROM tasks WHERE task_id = ?').get(expected.task_id) as Record<string, unknown> | null
    if (row === null) {
      throw new JournalFailure(
        'CONCURRENCY_CONFLICT',
        `task ${expected.task_id} does not exist at version ${expected.version}`,
      )
    }
    if (Number(row.version) !== expected.version) {
      throw new JournalFailure(
        'CONCURRENCY_CONFLICT',
        `task ${expected.task_id} version mismatch: expected ${expected.version}, found ${String(row.version)}`,
      )
    }
  }

  private assertRunVersion(
    db: Database,
    expected: { run_id: string; version: number },
  ): void {
    const row = db.query('SELECT version FROM runs WHERE run_id = ?').get(expected.run_id) as Record<string, unknown> | null
    if (row === null) {
      throw new JournalFailure(
        'CONCURRENCY_CONFLICT',
        `run ${expected.run_id} does not exist at version ${expected.version}`,
      )
    }
    if (Number(row.version) !== expected.version) {
      throw new JournalFailure(
        'CONCURRENCY_CONFLICT',
        `run ${expected.run_id} version mismatch: expected ${expected.version}, found ${String(row.version)}`,
      )
    }
  }

  private writeTask(
    db: Database,
    task: TaskProjection,
    expected?: { task_id: string; version: number },
  ): void {
    // F9: the checkpoint is derived from the events in this transaction.
    const checkpoint = maxEventSequence(db, 'task_id', task.task_id)

    if (expected !== undefined && expected.task_id === task.task_id) {
      const result = db.query(
        `UPDATE tasks SET state = ?, envelope_json = ?, active_run_id = ?, latest_result_id = ?, version = ?, last_event_sequence = ?, updated_at = ? WHERE task_id = ? AND version = ?`,
      ).run(
        task.state,
        JSON.stringify(task.envelope),
        task.active_run_id,
        task.latest_result_id,
        task.version,
        checkpoint,
        task.updated_at,
        task.task_id,
        expected.version,
      )
      if (Number(result.changes) !== 1) {
        throw new JournalFailure(
          'CONCURRENCY_CONFLICT',
          `task ${task.task_id} update affected ${String(result.changes)} rows`,
        )
      }
      return
    }

    try {
      db.query(
        `INSERT INTO tasks (task_id, state, envelope_json, active_run_id, latest_result_id, version, last_event_sequence, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        task.task_id,
        task.state,
        JSON.stringify(task.envelope),
        task.active_run_id,
        task.latest_result_id,
        task.version,
        checkpoint,
        task.updated_at,
      )
    } catch (error) {
      if (isConstraintError(error)) {
        throw new JournalFailure('CONCURRENCY_CONFLICT', `task ${task.task_id} already exists`)
      }
      throw error
    }
  }

  private writeRun(
    db: Database,
    run: RunProjection,
    expected?: { run_id: string; version: number },
  ): void {
    const checkpoint = maxEventSequence(db, 'run_id', run.run_id)

    if (expected !== undefined && expected.run_id === run.run_id) {
      const result = db.query(
        `UPDATE runs SET task_id = ?, attempt = ?, state = ?, submission_key = ?, native_ref = ?, result_id = ?, version = ?, last_event_sequence = ?, updated_at = ? WHERE run_id = ? AND version = ?`,
      ).run(
        run.task_id,
        run.attempt,
        run.state,
        run.submission_key,
        run.native_ref,
        run.result_id,
        run.version,
        checkpoint,
        run.updated_at,
        run.run_id,
        expected.version,
      )
      if (Number(result.changes) !== 1) {
        throw new JournalFailure(
          'CONCURRENCY_CONFLICT',
          `run ${run.run_id} update affected ${String(result.changes)} rows`,
        )
      }
      return
    }

    try {
      db.query(
        `INSERT INTO runs (run_id, task_id, attempt, state, submission_key, native_ref, result_id, version, last_event_sequence, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        run.run_id,
        run.task_id,
        run.attempt,
        run.state,
        run.submission_key,
        run.native_ref,
        run.result_id,
        run.version,
        checkpoint,
        run.updated_at,
      )
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new JournalFailure(
          'INTEGRITY_FAILURE',
          `run ${run.run_id} references task ${run.task_id} which does not exist`,
        )
      }
      if (isConstraintError(error)) {
        throw new JournalFailure('CONCURRENCY_CONFLICT', `run ${run.run_id} already exists`)
      }
      throw error
    }
  }

  private writeResult(db: Database, result: ResultEnvelopeV01): void {
    const existing = db.query('SELECT result_id FROM results WHERE result_id = ? OR run_id = ?')
      .get(result.result_id, result.run_id) as Record<string, unknown> | null
    if (existing !== null) {
      throw new JournalFailure(
        'IDEMPOTENCY_CONFLICT',
        `a result already exists for run ${result.run_id} or result id ${result.result_id}`,
      )
    }

    try {
      db.query(
        'INSERT INTO results (result_id, run_id, payload_hash, envelope_json, recorded_at) VALUES (?, ?, ?, ?, ?)',
      ).run(
        result.result_id,
        result.run_id,
        hashPayload(result),
        JSON.stringify(result),
        result.recorded_at,
      )
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new JournalFailure(
          'INTEGRITY_FAILURE',
          `result ${result.result_id} references run ${result.run_id} which does not exist`,
        )
      }
      if (isConstraintError(error)) {
        throw new JournalFailure('IDEMPOTENCY_CONFLICT', `result ${result.result_id} already exists`)
      }
      throw error
    }
  }

  private writeEvent(db: Database, event: EventEnvelopeV01<JsonValue>): number {
    const existing = db.query('SELECT sequence, payload_hash FROM events WHERE producer_id = ? AND dedupe_key = ?')
      .get(event.producer.id, event.dedupe_key) as Record<string, unknown> | null

    if (existing !== null) {
      if (existing.payload_hash === event.payload_hash) return Number(existing.sequence)
      throw new JournalFailure(
        'IDEMPOTENCY_CONFLICT',
        `event ${event.dedupe_key} from ${event.producer.id} already exists with a different payload_hash`,
      )
    }

    let inserted: { lastInsertRowid: number | bigint; changes: number }
    try {
      inserted = db.query(
        `INSERT INTO events (event_id, task_id, run_id, event_type, protocol_version, producer_kind, producer_id, dedupe_key, payload_hash, payload_json, recorded_at, causation_event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        event.event_id,
        event.task_id,
        event.run_id ?? null,
        event.event_type,
        event.protocol_version,
        event.producer.kind,
        event.producer.id,
        event.dedupe_key,
        event.payload_hash,
        JSON.stringify(event.payload),
        event.recorded_at,
        event.causation_event_id ?? null,
      ) as { lastInsertRowid: number | bigint; changes: number }
    } catch (error) {
      if (isConstraintError(error)) {
        throw new JournalFailure('IDEMPOTENCY_CONFLICT', `event ${event.event_id} already exists`)
      }
      throw error
    }

    const sequence = Number(inserted.lastInsertRowid)
    if (!Number.isFinite(sequence) || sequence <= 0) {
      throw new JournalFailure('INTERNAL', `failed to obtain a sequence for event ${event.event_id}`)
    }
    return sequence
  }

  private writeIdempotency(
    db: Database,
    record: NonNullable<JournalCommitBatch['idempotency']>,
  ): void {
    const completedAt = record.status === 'completed' ? record.at : null
    const existing = db.query(
      'SELECT payload_hash, outcome_ref, status FROM idempotency WHERE namespace = ? AND operation_key = ?',
    )
      .get(record.namespace, record.operation_key) as Record<string, unknown> | null

    if (existing !== null) {
      if (existing.payload_hash !== record.payload_hash) {
        throw new JournalFailure(
          'IDEMPOTENCY_CONFLICT',
          `idempotency ${record.namespace}/${record.operation_key} already exists with a different payload_hash`,
        )
      }

      const existingStatus = String(existing.status)
      const existingOutcomeRef = String(existing.outcome_ref)
      if (existingStatus === 'reserved' && record.status === 'completed') {
        // The reserved browser-submit row stores its durable intent; completion
        // replaces that reference with the observed receipt. This is the only
        // transition that may intentionally change outcome_ref.
        db.query('UPDATE idempotency SET outcome_ref = ?, status = ?, completed_at = ? WHERE namespace = ? AND operation_key = ?')
          .run(record.outcome_ref, record.status, completedAt, record.namespace, record.operation_key)
        return
      }

      if (existingStatus === record.status && existingOutcomeRef === record.outcome_ref) {
        // Exact replays are no-ops: preserve the original completion timestamp
        // and never rebind a completed key to another aggregate.
        return
      }

      throw new JournalFailure(
        'IDEMPOTENCY_CONFLICT',
        `idempotency ${record.namespace}/${record.operation_key} cannot change ${existingStatus}/${existingOutcomeRef} to ${record.status}/${record.outcome_ref}`,
      )
    }

    db.query(
      'INSERT INTO idempotency (namespace, operation_key, payload_hash, outcome_ref, status, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      record.namespace,
      record.operation_key,
      record.payload_hash,
      record.outcome_ref,
      record.status,
      record.at,
      completedAt,
    )
  }
}

// ---------------------------------------------------------------------------
// Row mapping and helpers
// ---------------------------------------------------------------------------

function mapRunRow(row: Record<string, unknown>): RunProjection {
  return {
    run_id: String(row.run_id),
    task_id: String(row.task_id),
    attempt: Number(row.attempt),
    state: String(row.state) as RunState,
    submission_key: String(row.submission_key),
    native_ref: nullableString(row.native_ref),
    result_id: nullableString(row.result_id),
    version: Number(row.version),
    last_event_sequence: Number(row.last_event_sequence),
    updated_at: String(row.updated_at),
  }
}

function mapEventRow(row: Record<string, unknown>): EventEnvelopeV01<JsonValue> {
  const runId = nullableString(row.run_id)
  const causationEventId = nullableString(row.causation_event_id)
  const producer: ActorRef = {
    kind: String(row.producer_kind) as ActorRef['kind'],
    id: String(row.producer_id),
  }
  return {
    kind: 'workbench.event',
    protocol_version: String(row.protocol_version) as '0.1',
    event_id: String(row.event_id),
    sequence: Number(row.sequence),
    task_id: String(row.task_id),
    ...(runId === null ? {} : { run_id: runId }),
    event_type: String(row.event_type) as EventType,
    producer,
    recorded_at: String(row.recorded_at),
    dedupe_key: String(row.dedupe_key),
    payload_hash: String(row.payload_hash),
    ...(causationEventId === null ? {} : { causation_event_id: causationEventId }),
    payload: JSON.parse(String(row.payload_json)) as JsonValue,
  }
}

function maxEventSequence(db: Database, column: 'task_id' | 'run_id', id: string): number {
  const row = db.query(`SELECT MAX(sequence) AS max_sequence FROM events WHERE ${column} = ?`)
    .get(id) as Record<string, unknown> | null
  if (row === null) return 0
  const value = row.max_sequence
  if (value === null || value === undefined) return 0
  return Number(value)
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return String(value)
}

/**
 * A foreign key violation means the caller referenced an aggregate that does not
 * exist. That is an integrity failure, not an idempotency conflict, so it must
 * not be folded into `isConstraintError`'s return value.
 */
function isForeignKeyViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /FOREIGN KEY constraint failed/i.test(error.message)
}

function isConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) return true
  return /constraint failed|UNIQUE constraint|PRIMARY KEY/i.test(error.message)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}
