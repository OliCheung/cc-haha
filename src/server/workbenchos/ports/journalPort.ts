/**
 * WorkbenchOS JournalPort V0.1.
 *
 * `commit` is the only write entry point and must be a single transaction.
 * There is deliberately no callback-style transaction API: a callback would let
 * a side effect run inside the SQLite transaction, which D-012 forbids.
 *
 * Authorized by task package M1-001-P1.
 */

import type {
  EventEnvelopeV01,
  IdempotencyRecord,
  IdempotencyStatus,
  JsonValue,
  ResultEnvelopeV01,
  RunProjection,
  TaskProjection,
} from '../contracts.js'

export type JournalCommitBatch = {
  expected_task_version?: { task_id: string; version: number }
  expected_run_version?: { run_id: string; version: number }
  idempotency?: {
    namespace: string
    operation_key: string
    payload_hash: string
    outcome_ref: string
    status: IdempotencyStatus
    at: string
  }
  events?: EventEnvelopeV01<JsonValue>[]
  tasks?: TaskProjection[]
  runs?: RunProjection[]
  results?: ResultEnvelopeV01[]
}

export type JournalErrorCode =
  | 'CONCURRENCY_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'SCHEMA_VERSION_UNSUPPORTED'
  | 'INTEGRITY_FAILURE'
  | 'UNAVAILABLE'
  | 'INTERNAL'

export type JournalCommitResult =
  | { ok: true; sequence: number }
  | { ok: false; error: { code: JournalErrorCode; detail: string } }

export type JournalIntegrityReport = {
  schema_version: number
  event_count: number
  projection_consistent: boolean
  details: string[]
}

export interface JournalPortV01 {
  readonly protocolVersion: '0.1'

  open(): Promise<void>
  close(): Promise<void>
  checkIntegrity(): Promise<JournalIntegrityReport>

  readTask(taskId: string): Promise<TaskProjection | null>
  readRun(runId: string): Promise<RunProjection | null>
  readResultByRun(runId: string): Promise<ResultEnvelopeV01 | null>
  readIdempotency(namespace: string, operationKey: string): Promise<IdempotencyRecord | null>
  listIdempotency(namespace: string, status?: IdempotencyStatus): Promise<IdempotencyRecord[]>
  listNonTerminalRuns(): Promise<RunProjection[]>
  listEventsForTask(taskId: string): Promise<EventEnvelopeV01<JsonValue>[]>

  commit(batch: JournalCommitBatch): Promise<JournalCommitResult>
}
