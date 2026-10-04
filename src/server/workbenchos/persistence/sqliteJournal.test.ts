import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  EventEnvelopeV01,
  JsonValue,
  ResultEnvelopeV01,
  RunProjection,
  RunState,
  TaskEnvelopeV01,
  TaskProjection,
} from '../contracts.js'
import { SqliteJournal } from './sqliteJournal.js'
import { readSchemaVersion } from './schema.js'

const T = '2026-01-01T00:00:00.000Z'
const T2 = '2026-01-01T00:00:01.000Z'

type Ctx = {
  dir: string
  dbPath: string
  journal: SqliteJournal
}

async function withJournal(run: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'workbenchos-journal-'))
  const dbPath = join(dir, 'workbench.sqlite3')
  const journal = new SqliteJournal({ databasePath: dbPath })
  try {
    await run({ dir, dbPath, journal })
  } finally {
    await journal.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function makeTaskEnvelope(taskId = 'task-0001'): TaskEnvelopeV01 {
  return {
    kind: 'workbench.task',
    protocol_version: '0.1',
    task_id: taskId,
    project_id: 'project-0001',
    conversation_ref: {
      browser_adapter_id: 'chatgpt-web',
      conversation_id: 'conversation-0001',
    },
    idempotency_key: `idem-${taskId}`,
    requested_execution: { agent_id: 'codebuddy', execution_timeout_ms: 600000 },
    goal: 'implement the isolated workbench core',
    context_refs: [],
    allowed_scope: { repository_relative_paths: [], action_classes: [] },
    forbidden_scope: { repository_relative_paths: [], action_classes: [] },
    validation_requirements: [],
    approval_requirements: [],
    stop_condition: 'RESULT_READY_FOR_REVIEW',
    created_at: T,
  }
}

function makeEvent(
  dedupeKey: string,
  extra: Partial<EventEnvelopeV01<JsonValue>> = {},
): EventEnvelopeV01<JsonValue> {
  return {
    kind: 'workbench.event',
    protocol_version: '0.1',
    event_id: `event-${dedupeKey}`,
    sequence: 0,
    task_id: 'task-0001',
    event_type: 'task.created',
    producer: { kind: 'core', id: 'workbench-core' },
    recorded_at: T,
    dedupe_key: dedupeKey,
    payload_hash: `hash-${dedupeKey}`,
    payload: { envelope: makeTaskEnvelope() },
    ...extra,
  }
}

function makeTaskProjection(overrides: Partial<TaskProjection> = {}): TaskProjection {
  return {
    task_id: 'task-0001',
    state: 'CREATED',
    envelope: makeTaskEnvelope(),
    active_run_id: null,
    latest_result_id: null,
    version: 1,
    last_event_sequence: 0,
    updated_at: T,
    ...overrides,
  }
}

function makeRunProjection(overrides: Partial<RunProjection> = {}): RunProjection {
  return {
    run_id: 'run-0001',
    task_id: 'task-0001',
    attempt: 1,
    state: 'CREATED',
    submission_key: 'agent-submit:run-0001:v1',
    native_ref: null,
    result_id: null,
    version: 1,
    last_event_sequence: 0,
    updated_at: T,
    ...overrides,
  }
}

function makeResultEnvelope(overrides: Partial<ResultEnvelopeV01> = {}): ResultEnvelopeV01 {
  return {
    kind: 'workbench.result',
    protocol_version: '0.1',
    result_id: 'result-0001',
    task_id: 'task-0001',
    run_id: 'run-0001',
    executor: { agent_id: 'codebuddy' },
    outcome: { status: 'succeeded', completion: 'complete' },
    summary: 'implemented the isolated core',
    changed_files: [],
    commands: [],
    validations: [],
    git_state: { available: true, commit_performed: false, push_performed: false },
    artifacts: [],
    native_evidence_refs: [],
    risks: [],
    unresolved_work: [],
    errors: [],
    next_action: { kind: 'review' },
    finished_at: T,
    recorded_at: T,
    ...overrides,
  }
}

function expectOk(result: Awaited<ReturnType<SqliteJournal['commit']>>): number {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.detail}`)
  return result.sequence
}

function expectFailure(
  result: Awaited<ReturnType<SqliteJournal['commit']>>,
  code: string,
): void {
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.error.code).toBe(code)
}

async function seedTaskAndRun(journal: SqliteJournal): Promise<void> {
  expectOk(await journal.commit({
    events: [makeEvent('seed-task'), makeEvent('seed-run', { run_id: 'run-0001' })],
    tasks: [makeTaskProjection()],
    runs: [makeRunProjection()],
  }))
}

describe('sqlite journal lifecycle', () => {
  test('bootstraps an empty database to schema version 1', async () => {
    await withJournal(async ({ dbPath, journal }) => {
      await journal.open()
      await journal.close()

      const raw = new Database(dbPath)
      try {
        expect(readSchemaVersion(raw)).toBe(1)
        const rows = raw.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
        const names = rows.map(row => row.name).filter(name => !name.startsWith('sqlite_')).sort()
        expect(names).toEqual(['events', 'idempotency', 'results', 'runs', 'tasks'])
      } finally {
        raw.close()
      }
    })
  })

  test('reopens an existing v1 database', async () => {
    await withJournal(async ({ dbPath, journal }) => {
      await journal.open()
      await journal.close()

      const second = new SqliteJournal({ databasePath: dbPath })
      await second.open()
      const report = await second.checkIntegrity()
      expect(report.schema_version).toBe(1)
      await second.close()
    })
  })

  test('fails closed on a future schema version', async () => {
    await withJournal(async ({ dbPath, journal }) => {
      await journal.open()
      await journal.close()

      const raw = new Database(dbPath)
      raw.exec('PRAGMA user_version = 2')
      raw.close()

      const second = new SqliteJournal({ databasePath: dbPath })
      await expect(second.open()).rejects.toThrow()
      await second.close()

      const check = new Database(dbPath)
      try {
        expect(readSchemaVersion(check)).toBe(2)
      } finally {
        check.close()
      }
    })
  })

  test('does not create a database before open', async () => {
    await withJournal(async ({ dbPath, journal }) => {
      expect(existsSync(dbPath)).toBe(false)
      await journal.open()
      expect(existsSync(dbPath)).toBe(true)
    })
  })
})

describe('sqlite journal commit', () => {
  test('commits events and projections atomically', async () => {
    await withJournal(async ({ journal }) => {
      await journal.open()
      expectOk(await journal.commit({
        events: [makeEvent('e1')],
        tasks: [makeTaskProjection()],
      }))

      const task = await journal.readTask('task-0001')
      expect(task?.state).toBe('CREATED')
      const events = await journal.listEventsForTask('task-0001')
      expect(events.length).toBe(1)
    })
  })

  test('returns the sequence of the last committed event', async () => {
    await withJournal(async ({ journal }) => {
      await journal.open()
      const sequence = expectOk(await journal.commit({
        events: [makeEvent('e1'), makeEvent('e2')],
      }))
      expect(sequence).toBe(2)
    })
  })

  test('deduplicates an identical event', async () => {
    await withJournal(async ({ journal }) => {
      await journal.open()
      const first = expectOk(await journal.commit({ events: [makeEvent('e1')] }))
      const second = expectOk(await journal.commit({ events: [makeEvent('e1')] }))
      expect(second).toBe(first)
      expect((await journal.listEventsForTask('task-0001')).length).toBe(1)
    })
  })

  test('rejects a conflicting event payload', async () => {
    await withJournal(async ({ journal }) => {
      await journal.open()
      expectOk(await journal.commit({ events: [makeEvent('e1')] }))

      const conflicting = makeEvent('e1', { event_id: 'event-e1-conflict', payload_hash: 'hash-changed' })
      expectFailure(await journal.commit({ events: [conflicting] }), 'IDEMPOTENCY_CONFLICT')
      expect((await journal.listEventsForTask('task-0001')).length).toBe(1)
    })
  })

  test('records an idempotency reservation then completion', async () => {
    await withJournal(async ({ journal }) => {
      await journal.open()
      expectOk(await journal.commit({
        idempotency: {
          namespace: 'run-create',
          operation_key: 'task-0001:1',
          payload_hash: 'h1',
          outcome_ref: 'run-0001',
          status: 'reserved',
          at: T,
        },
      }))

      let record = await journal.readIdempotency('run-create', 'task-0001:1')
      expect(record?.status).toBe('reserved')
      expect(record?.completed_at).toBeNull()

      expectOk(await journal.commit({
        idempotency: {
          namespace: 'run-create',
          operation_key: 'task-0001:1',
          payload_hash: 'h1',
          outcome_ref: 'receipt:run-0001',
          status: 'completed',
          at: T2,
        },
      }))

      record = await journal.readIdempotency('run-create', 'task-0001:1')
      expect(record?.status).toBe('completed')
      expect(record?.outcome_ref).toBe('receipt:run-0001')
      expect(record?.completed_at).toBe(T2)
    })
  })

  test('does not rebind or downgrade a completed idempotency outcome', async () => {
    await withJournal(async ({ journal }) => {
      await journal.open()
      expectOk(await journal.commit({
        idempotency: {
          namespace: 'task-ingest',
          operation_key: 'chatgpt-web|conversation-1|idem-1',
          payload_hash: 'same-payload',
          outcome_ref: 'task-original',
          status: 'completed',
          at: T,
        },
      }))

      expectFailure(await journal.commit({
        idempotency: {
          namespace: 'task-ingest',
          operation_key: 'chatgpt-web|conversation-1|idem-1',
          payload_hash: 'same-payload',
          outcome_ref: 'task-duplicate',
          status: 'completed',
          at: T2,
        },
      }), 'IDEMPOTENCY_CONFLICT')
      expectFailure(await journal.commit({
        idempotency: {
          namespace: 'task-ingest',
          operation_key: 'chatgpt-web|conversation-1|idem-1',
          payload_hash: 'same-payload',
          outcome_ref: 'task-original',
          status: 'reserved',
          at: T2,
        },
      }), 'IDEMPOTENCY_CONFLICT')

      const record = await journal.readIdempotency('task-ingest', 'chatgpt-web|conversation-1|idem-1')
      expect(record?.outcome_ref).toBe('task-original')
      expect(record?.status).toBe('completed')
      expect(record?.completed_at).toBe(T)
    })
  })

  test('rejects a conflicting idempotency payload', async () => {
    await withJournal(async ({ journal }) => {
      await journal.open()
      expectOk(await journal.commit({
        idempotency: {
          namespace: 'run-create',
          operation_key: 'task-0001:1',
          payload_hash: 'h1',
          outcome_ref: 'run-0001',
          status: 'reserved',
          at: T,
        },
      }))

      expectFailure(await journal.commit({
        idempotency: {
          namespace: 'run-create',
          operation_key: 'task-0001:1',
          payload_hash: 'h2',
          outcome_ref: 'run-0002',
          status: 'reserved',
          at: T,
        },
      }), 'IDEMPOTENCY_CONFLICT')
    })
  })

  test('rejects a stale expected_task_version', async () => {
    await withJournal(async ({ journal }) => {
      await journal.open()
      expectOk(await journal.commit({ events: [makeEvent('e1')], tasks: [makeTaskProjection()] }))

      expectFailure(await journal.commit({
        expected_task_version: { task_id: 'task-0001', version: 99 },
        tasks: [makeTaskProjection({ version: 100, state: 'READY' })],
      }), 'CONCURRENCY_CONFLICT')
    })
  })

  test('rejects a stale expected_run_version', async () => {
    await withJournal(async ({ journal }) => {
      await journal.open()
      await seedTaskAndRun(journal)

      expectFailure(await journal.commit({
        expected_run_version: { run_id: 'run-0001', version: 99 },
        runs: [makeRunProjection({ version: 100, state: 'SUBMITTED' })],
      }), 'CONCURRENCY_CONFLICT')
    })
  })

  test('rejects inserting a task that already exists without an expected version', async () => {
    await withJournal(async ({ journal }) => {
      await journal.open()
      expectOk(await journal.commit({ events: [makeEvent('e1')], tasks: [makeTaskProjection()] }))
      expectFailure(await journal.commit({ tasks: [makeTaskProjection()] }), 'CONCURRENCY_CONFLICT')
    })
  })

  test('rolls back the whole batch when a later write fails', async () => {
    await withJournal(async ({ journal }) => {
      await journal.open()
      expectOk(await journal.commit({ events: [makeEvent('e1')], tasks: [makeTaskProjection()] }))
      const before = (await journal.listEventsForTask('task-0001')).length

      // The event write succeeds, then the duplicate task insert fails.
      expectFailure(await journal.commit({
        events: [makeEvent('e2')],
        tasks: [makeTaskProjection()],
      }), 'CONCURRENCY_CONFLICT')

      expect((await journal.listEventsForTask('task-0001')).length).toBe(before)
      expect((await journal.readTask('task-0001'))?.state).toBe('CREATED')
    })
  })

  test('rejects duplicate results for one run', async () => {
    await withJournal(async ({ journal }) => {
      await journal.open()
      await seedTaskAndRun(journal)
      expectOk(await journal.commit({ results: [makeResultEnvelope()] }))

      expectFailure(await journal.commit({
        results: [makeResultEnvelope({ result_id: 'result-0002' })],
      }), 'IDEMPOTENCY_CONFLICT')
    })
  })

  test('reports an integrity failure when a run references a missing task', async () => {
    await withJournal(async ({ journal }) => {
      await journal.open()

      expectFailure(await journal.commit({
        runs: [makeRunProjection({ task_id: 'task-missing' })],
      }), 'INTEGRITY_FAILURE')
    })
  })

  test('reports an integrity failure when a result references a missing run', async () => {
    await withJournal(async ({ journal }) => {
      await journal.open()
      expectOk(await journal.commit({ tasks: [makeTaskProjection()] }))

      expectFailure(await journal.commit({
        results: [makeResultEnvelope({ run_id: 'run-missing' })],
      }), 'INTEGRITY_FAILURE')
    })
  })
})

describe('sqlite journal reads', () => {
  test('reads back a run projection', async () => {
    await withJournal(async ({ journal }) => {
      await journal.open()
      await seedTaskAndRun(journal)

      const run = await journal.readRun('run-0001')
      expect(run).not.toBeNull()
      expect(run?.task_id).toBe('task-0001')
      expect(run?.attempt).toBe(1)
      expect(run?.state).toBe('CREATED')
      expect(run?.submission_key).toBe('agent-submit:run-0001:v1')
      expect(run?.native_ref).toBeNull()
      expect(run?.result_id).toBeNull()
      expect(run?.version).toBe(1)
      expect(await journal.readRun('run-missing')).toBeNull()
    })
  })

  test('reads back a result envelope', async () => {
    await withJournal(async ({ journal }) => {
      await journal.open()
      await seedTaskAndRun(journal)
      const result = makeResultEnvelope()
      expectOk(await journal.commit({ results: [result] }))

      expect(await journal.readResultByRun('run-0001')).toEqual(result)
      expect(await journal.readResultByRun('run-missing')).toBeNull()
    })
  })

  test('lists only non-terminal runs', async () => {
    await withJournal(async ({ journal }) => {
      await journal.open()

      const states: RunState[] = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'SUBMITTED', 'RUNNING']
      const runs: RunProjection[] = states.map((state, index) => makeRunProjection({
        run_id: `run-000${index + 1}`,
        attempt: index + 1,
        state,
        submission_key: `agent-submit:run-000${index + 1}:v1`,
      }))
      expectOk(await journal.commit({ tasks: [makeTaskProjection()], runs }))

      const nonTerminal = await journal.listNonTerminalRuns()
      expect(nonTerminal.map(run => run.run_id)).toEqual(['run-0005', 'run-0006'])
    })
  })

  test('lists events for a task in sequence order', async () => {
    await withJournal(async ({ journal }) => {
      await journal.open()
      expectOk(await journal.commit({
        events: [makeEvent('e3'), makeEvent('e1'), makeEvent('e2')],
      }))

      const events = await journal.listEventsForTask('task-0001')
      expect(events.map(event => event.sequence)).toEqual([1, 2, 3])
      expect(events.map(event => event.dedupe_key)).toEqual(['e3', 'e1', 'e2'])
      expect(events[0]?.producer).toEqual({ kind: 'core', id: 'workbench-core' })
      expect(events[0]?.payload_hash).toBe('hash-e3')
    })
  })
})

describe('sqlite journal integrity and shutdown', () => {
  test('reports a consistent journal', async () => {
    await withJournal(async ({ journal }) => {
      await journal.open()
      await seedTaskAndRun(journal)

      const report = await journal.checkIntegrity()
      expect(report.schema_version).toBe(1)
      expect(report.event_count).toBe(2)
      expect(report.details).toEqual([])
      expect(report.projection_consistent).toBe(true)
    })
  })

  test('detects a projection that is behind its events', async () => {
    await withJournal(async ({ dbPath, journal }) => {
      await journal.open()
      await seedTaskAndRun(journal)
      await journal.close()

      const raw = new Database(dbPath)
      raw.exec('UPDATE tasks SET last_event_sequence = last_event_sequence - 1 WHERE task_id = \'task-0001\'')
      raw.close()

      const second = new SqliteJournal({ databasePath: dbPath })
      await second.open()
      const report = await second.checkIntegrity()
      expect(report.projection_consistent).toBe(false)
      expect(report.details.some(detail => detail.includes('task_projection_ahead_or_behind'))).toBe(true)
      await second.close()
    })
  })

  test('rejects writes after close', async () => {
    await withJournal(async ({ journal }) => {
      await journal.open()
      await journal.close()

      expectFailure(await journal.commit({ events: [makeEvent('e1')] }), 'UNAVAILABLE')
      await expect(journal.readTask('task-0001')).rejects.toThrow(/UNAVAILABLE/)
    })
  })
})
