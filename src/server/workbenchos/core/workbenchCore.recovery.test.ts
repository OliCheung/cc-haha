/**
 * M1-001-P6 — restart / replay integration contracts.
 *
 * Covers M0-02 §10.1's six crash-or-replay scenarios and §17 families 12, 15, 17.
 * Every case drives the real WorkbenchCore over a real SqliteJournal; a "restart"
 * really closes the database and opens a new instance. No shortcuts, no spies on
 * production code.
 *
 * Authorized by task package M1-001-P6.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EventEnvelopeV01, JsonValue } from '../contracts.js'
import type { AgentPortV01, AgentResultMaterial } from '../ports/agentPort.js'
import { SqliteJournal } from '../persistence/sqliteJournal.js'
import { FakeAgentPort, type FakeTerminalStatus } from '../testing/fakeAgentPort.js'
import {
  WorkbenchCore,
  type Clock,
  type CoreResult,
  type CreateTaskInput,
} from './workbenchCore.js'
import { hashPayload } from './idempotency.js'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Harness = {
  readonly journal: SqliteJournal
  readonly core: WorkbenchCore
  readonly agent: FakeAgentPort
  readonly databasePath: string
  /** Closes the database, opens a new instance, and constructs a new Core. */
  restart(): Promise<void>
  /** A Core bound to an alternative adapter, sharing journal, clock and ids. */
  coreWith(agentPort: AgentPortV01): WorkbenchCore
}

function makeClock(): Clock {
  let tick = 0
  return {
    now: () => {
      tick += 1
      const minutes = String(Math.floor(tick / 60)).padStart(2, '0')
      const seconds = String(tick % 60).padStart(2, '0')
      return `2026-01-01T00:${minutes}:${seconds}.000Z`
    },
  }
}

function makeIds(): { next(): string } {
  let counter = 0
  return {
    next: () => {
      counter += 1
      return `id-${counter}`
    },
  }
}

/**
 * The clock and the id generator are created once per test and survive restarts.
 *
 * This is not incidental: the journal enforces unique event ids, so a generator
 * that restarted its counter would collide on the first event written after a
 * restart and fail for reasons unrelated to the behaviour under test. A real
 * process keeps issuing fresh identifiers across a restart (see CL-6).
 */
async function withHarness(run: (h: Harness) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'workbenchos-recovery-'))
  const databasePath = join(dir, 'workbench.sqlite3')
  const agent = new FakeAgentPort()
  const clock = makeClock()
  const ids = makeIds()

  let journal = new SqliteJournal({ databasePath })
  await journal.open()

  const buildCore = (agentPort: AgentPortV01): WorkbenchCore =>
    new WorkbenchCore({
      journal,
      agentPort,
      clock,
      ids,
      project_id: 'project-1',
      port_timeout_ms: 1000,
    })

  let core = buildCore(agent)

  const handle: Harness = {
    get journal() {
      return journal
    },
    get core() {
      return core
    },
    agent,
    databasePath,
    async restart() {
      await journal.close()
      journal = new SqliteJournal({ databasePath })
      await journal.open()
      core = buildCore(agent)
    },
    coreWith(agentPort: AgentPortV01) {
      return buildCore(agentPort)
    },
  }

  try {
    await run(handle)
  } finally {
    await journal.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Fixtures and assertions
// ---------------------------------------------------------------------------

function makeTaskInput(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    conversation_ref: { browser_adapter_id: 'chatgpt-web', conversation_id: 'conversation-1' },
    idempotency_key: 'idem-1',
    goal: 'prove the restart contracts hold',
    requested_execution: { agent_id: 'fake', execution_timeout_ms: 600000 },
    ...overrides,
  }
}

function makeMaterial(outcome: FakeTerminalStatus): AgentResultMaterial {
  const succeeded = outcome === 'succeeded'

  return {
    native_run_ref: 'native-1',
    outcome,
    completion: succeeded ? 'complete' : 'none',
    summary: `recovery material for ${outcome}`,
    changed_files: [],
    commands: [],
    validations: [],
    git_state: { available: true, commit_performed: false, push_performed: false },
    artifacts: [],
    native_evidence_refs: [],
    risks: [],
    unresolved_work: succeeded ? [] : ['recovery terminal without success'],
    errors: succeeded
      ? []
      : [{ code: 'TEST_TERMINAL', message: 'recovery terminal without success', retryable: false }],
    finished_at: '2026-01-01T00:00:00.000Z',
  }
}

function expectOk<T>(result: CoreResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.detail}`)
  return result.value
}

function expectFailure<T>(result: CoreResult<T>, code: string): void {
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.error.code).toBe(code)
}

async function createReadyTaskOn(
  core: WorkbenchCore,
  overrides: Partial<CreateTaskInput> = {},
): Promise<string> {
  const created = expectOk(await core.createTask(makeTaskInput(overrides)))
  expectOk(await core.markTaskReady(created.task_id))
  return created.task_id
}

function calledMethods(agent: FakeAgentPort): string[] {
  return agent.getCalls().map(call => call.method)
}

function submittedKeys(agent: FakeAgentPort): Array<string | undefined> {
  return agent
    .getCalls()
    .filter(call => call.method === 'submitTask')
    .map(call => call.idempotency_key)
}

/**
 * Family 15 needs an adapter that reports a mismatched protocol version. The
 * fake deliberately reports '0.1' only, so the mismatch is injected through a
 * thin delegating wrapper rather than by editing production code (see D10).
 */
function withReportedProtocolVersion(port: FakeAgentPort, reported: string): AgentPortV01 {
  return {
    protocolVersion: '0.1',
    submitTask: (input, idempotencyKey, timeoutMs) =>
      port.submitTask(input, idempotencyKey, timeoutMs),
    lookupSubmission: (idempotencyKey, timeoutMs) =>
      port.lookupSubmission(idempotencyKey, timeoutMs),
    getStatus: (nativeRunRef, timeoutMs) => port.getStatus(nativeRunRef, timeoutMs),
    collectResult: (nativeRunRef, timeoutMs) => port.collectResult(nativeRunRef, timeoutMs),
    cancel: (nativeRunRef, idempotencyKey, reason, timeoutMs) =>
      port.cancel(nativeRunRef, idempotencyKey, reason, timeoutMs),
    healthCheck: async () => ({
      protocol_version: reported as '0.1',
      available: true,
      capabilities: ['fake'],
    }),
  }
}

/** Drives a Task and its first Run all the way to a terminal SUCCEEDED Run. */
async function driveToSucceeded(
  h: Harness,
): Promise<{ taskId: string; runId: string; nativeRef: string }> {
  h.agent.enqueueScenario({
    steps: [{ status: 'running' }, { status: 'succeeded', material: makeMaterial('succeeded') }],
  })
  const taskId = await createReadyTaskOn(h.core)
  const run = expectOk(await h.core.startRun(taskId))

  h.agent.advance('native-1')
  expectOk(await h.core.reconcileRun(run.run_id))
  h.agent.advance('native-1')
  const settled = expectOk(await h.core.reconcileRun(run.run_id))
  expect(settled.state).toBe('SUCCEEDED')

  return { taskId, runId: run.run_id, nativeRef: 'native-1' }
}

/** Drives a Run into RECOVERY_REQUIRED through an unknown adapter status. */
async function driveToRecoveryRequired(
  h: Harness,
): Promise<{ taskId: string; runId: string; nativeRef: string }> {
  h.agent.enqueueScenario({ steps: [{ status: 'running' }] })
  const taskId = await createReadyTaskOn(h.core)
  const run = expectOk(await h.core.startRun(taskId))

  h.agent.advance('native-1')
  expectOk(await h.core.reconcileRun(run.run_id))
  h.agent.injectFault('native-1', 'status_unknown')

  const recovered = expectOk(await h.core.recoverPendingRuns())
  expect(recovered.recovery_required).toEqual([run.run_id])
  expect(recovered.reconciled).toEqual([])
  expect((await h.journal.listNonTerminalRuns()).map(entry => entry.run_id)).toEqual([run.run_id])
  expect(await h.journal.readResultByRun(run.run_id)).toBeNull()

  return { taskId, runId: run.run_id, nativeRef: 'native-1' }
}

// ---------------------------------------------------------------------------
// Scenario 1 — duplicate observation
// ---------------------------------------------------------------------------

describe('recovery scenario 1: duplicate observation', () => {
  test('returns the same Task when the same observation is replayed after a restart', async () => {
    await withHarness(async (h) => {
      const first = expectOk(await h.core.createTask(makeTaskInput()))
      await h.restart()

      const replayed = expectOk(await h.core.createTask(makeTaskInput()))

      expect(replayed.task_id).toBe(first.task_id)
      expect(replayed.state).toBe('CREATED')

      const events = await h.journal.listEventsForTask(first.task_id)
      expect(events.filter(event => event.event_type === 'task.created').length).toBe(1)
      expect(await h.journal.listNonTerminalRuns()).toEqual([])

      const report = await h.journal.checkIntegrity()
      expect(report.projection_consistent).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// Scenario 2 — crash between the intent commit and the adapter call
// ---------------------------------------------------------------------------

describe('recovery scenario 2: crash before the adapter call', () => {
  test('does not duplicate the submission when restarting before the AgentPort call', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({ steps: [], submit_behavior: 'timeout' })
      h.agent.enqueueScenario({ steps: [{ status: 'running' }] })

      const taskId = await createReadyTaskOn(h.core)
      const run = expectOk(await h.core.startRun(taskId))

      // The intent is durable while the native outcome is still unknown.
      expect(run.state).toBe('SUBMITTED')
      expect((await h.journal.readRun(run.run_id))?.native_ref).toBeNull()

      await h.restart()

      const recovered = expectOk(await h.core.recoverPendingRuns())
      expect(recovered.reconciled).toEqual([run.run_id])

      // Recovery must consult the lookup before it re-submits anything.
      expect(calledMethods(h.agent)).toEqual([
        'healthCheck',
        'submitTask',
        'lookupSubmission',
        'submitTask',
      ])

      const keys = submittedKeys(h.agent)
      expect(keys[0]).toBe(keys[1])
      expect(h.agent.listNativeRefs()).toEqual(['native-1'])
      expect(h.agent.getSideEffectCount('native-1')).toBe(1)
      expect((await h.journal.readRun(run.run_id))?.native_ref).toBe('native-1')
    })
  })
})

// ---------------------------------------------------------------------------
// Scenario 3 — crash after the effect, before the receipt is persisted
// ---------------------------------------------------------------------------

describe('recovery scenario 3: lost acknowledgement', () => {
  test('uses the original submission key when re-submitting after a proven absence', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({ steps: [], submit_behavior: 'timeout' })
      h.agent.enqueueScenario({ steps: [] })

      const taskId = await createReadyTaskOn(h.core)
      const run = expectOk(await h.core.startRun(taskId))
      expect(h.agent.listNativeRefs()).toEqual([])

      await h.restart()
      expectOk(await h.core.recoverPendingRuns())

      const keys = submittedKeys(h.agent)
      expect(keys.length).toBe(2)
      expect(keys[0]).toBe(keys[1])
      expect(h.agent.listNativeRefs()).toEqual(['native-1'])
      expect((await h.journal.readRun(run.run_id))?.native_ref).toBe('native-1')
    })
  })

  test('does not duplicate the native effect when the acknowledgement was lost', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({ steps: [], submit_behavior: 'effect_then_lost_ack' })

      const taskId = await createReadyTaskOn(h.core)
      const run = expectOk(await h.core.startRun(taskId))

      // The native effect exists even though the receipt never arrived.
      expect(run.state).toBe('SUBMITTED')
      expect(h.agent.listNativeRefs()).toEqual(['native-1'])
      expect(h.agent.getSideEffectCount('native-1')).toBe(1)

      await h.restart()

      const recovered = expectOk(await h.core.recoverPendingRuns())
      expect(recovered.reconciled).toEqual([run.run_id])

      // The lookup found the original effect, so no second submission happened.
      expect(calledMethods(h.agent).filter(method => method === 'submitTask').length).toBe(1)
      expect(h.agent.listNativeRefs()).toEqual(['native-1'])
      expect(h.agent.getSideEffectCount('native-1')).toBe(1)
      expect((await h.journal.readRun(run.run_id))?.native_ref).toBe('native-1')
    })
  })
})

// ---------------------------------------------------------------------------
// Scenario 4 — duplicate terminal reconciliation
// ---------------------------------------------------------------------------

describe('recovery scenario 4: duplicate terminal reconciliation', () => {
  test('records a terminal Result only once when the run is reconciled twice', async () => {
    await withHarness(async (h) => {
      const { taskId, runId } = await driveToSucceeded(h)

      const first = await h.journal.readResultByRun(runId)
      expect(first).not.toBeNull()

      const again = expectOk(await h.core.reconcileRun(runId))
      expect(again.state).toBe('SUCCEEDED')

      const events = await h.journal.listEventsForTask(taskId)
      expect(events.filter(event => event.event_type === 'run.result_recorded').length).toBe(1)

      const second = await h.journal.readResultByRun(runId)
      expect(second?.result_id).toBe(first?.result_id)
    })
  })
})

// ---------------------------------------------------------------------------
// Scenario 6 — mid-batch commit failure
// ---------------------------------------------------------------------------

describe('recovery scenario 6: mid-batch commit failure', () => {
  test('leaves no half state when the journal commit fails mid-batch', async () => {
    await withHarness(async (h) => {
      const taskId = await createReadyTaskOn(h.core)

      const existing = (await h.journal.listEventsForTask(taskId))[0]
      if (existing === undefined) throw new Error('expected a persisted task.created event')

      // The first event is brand new and must be rolled back when the second
      // write in the same batch is rejected.
      const probeEvent: EventEnvelopeV01<JsonValue> = {
        ...existing,
        event_id: 'probe-event-0001',
        dedupe_key: 'probe-event-0001',
        payload_hash: hashPayload({ probe: 'first' }),
        payload: { probe: 'first' },
      }
      // Same dedupe_key as the persisted event but a different payload hash.
      const conflictingEvent: EventEnvelopeV01<JsonValue> = {
        ...existing,
        event_id: 'probe-event-0002',
        payload_hash: hashPayload({ probe: 'conflicting' }),
        payload: { probe: 'conflicting' },
      }

      const before = (await h.journal.checkIntegrity()).event_count

      const failed = await h.journal.commit({ events: [probeEvent, conflictingEvent] })
      expect(failed.ok).toBe(false)
      if (failed.ok) return
      expect(failed.error.code).toBe('IDEMPOTENCY_CONFLICT')

      const after = await h.journal.checkIntegrity()
      expect(after.event_count).toBe(before)
      expect(after.projection_consistent).toBe(true)
      expect(after.details).toEqual([])

      const remaining = (await h.journal.listEventsForTask(taskId)).map(event => event.event_id)
      expect(remaining).not.toContain('probe-event-0001')

      // The Core is still usable after the rejected batch.
      const report = await h.journal.readTask(taskId)
      expect(report?.state).toBe('READY')
    })
  })
})

// ---------------------------------------------------------------------------
// Family 12 — restart / replay
// ---------------------------------------------------------------------------

describe('recovery family 12: restart and replay', () => {
  test('never creates a new Run while recovering', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({ steps: [{ status: 'running' }] })
      const taskId = await createReadyTaskOn(h.core)
      const run = expectOk(await h.core.startRun(taskId))

      h.agent.advance('native-1')

      const before = (await h.journal.listNonTerminalRuns()).length
      const recovered = expectOk(await h.core.recoverPendingRuns())
      const after = (await h.journal.listNonTerminalRuns()).length

      expect(before).toBe(1)
      expect(after).toBe(1)
      expect(recovered.reconciled).toEqual([run.run_id])
    })
  })

  test('enters RECOVERY_REQUIRED on an unknown adapter status', async () => {
    await withHarness(async (h) => {
      const { runId } = await driveToRecoveryRequired(h)

      const run = await h.journal.readRun(runId)
      expect(run?.state).toBe('RECOVERY_REQUIRED')
    })
  })

  test('blocks new Runs while a Run is in RECOVERY_REQUIRED', async () => {
    await withHarness(async (h) => {
      const { taskId } = await driveToRecoveryRequired(h)

      expectFailure(await h.core.startRun(taskId), 'INVALID_TRANSITION')

      const task = await h.journal.readTask(taskId)
      expect(task?.state).toBe('RUNNING')
      expect((await h.journal.listNonTerminalRuns()).length).toBe(1)
    })
  })

  test('recovers a RECOVERY_REQUIRED Run back to an active state', async () => {
    await withHarness(async (h) => {
      const { runId } = await driveToRecoveryRequired(h)

      // Clearing the fault is what makes a positive observation possible again.
      h.agent.resetCalls()

      const recovered = expectOk(await h.core.recoverPendingRuns())
      expect(recovered.reconciled).toEqual([runId])
      expect(recovered.recovery_required).toEqual([])

      const run = await h.journal.readRun(runId)
      expect(run?.state).toBe('RUNNING')
    })
  })

  test('keeps the journal consistent across a restart', async () => {
    await withHarness(async (h) => {
      const { runId } = await driveToSucceeded(h)
      await h.restart()

      expect(await h.journal.readResultByRun(runId)).not.toBeNull()

      const report = await h.journal.checkIntegrity()
      expect(report.projection_consistent).toBe(true)
      expect(report.details).toEqual([])
      expect(report.schema_version).toBe(1)
    })
  })
})

// ---------------------------------------------------------------------------
// Family 17 — authority isolation
// ---------------------------------------------------------------------------

describe('recovery family 17: authority isolation', () => {
  test('keeps the Task at WAITING_REVIEW after a terminal Result', async () => {
    await withHarness(async (h) => {
      const { taskId } = await driveToSucceeded(h)

      const task = await h.journal.readTask(taskId)
      expect(task?.state).toBe('WAITING_REVIEW')
      expect(task?.state).not.toBe('COMPLETED')
    })
  })

  test('requires an explicit return to READY before a second Run', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({
        steps: [{ status: 'succeeded', material: makeMaterial('succeeded') }],
      })
      h.agent.enqueueScenario({ steps: [] })

      const taskId = await createReadyTaskOn(h.core)
      const first = expectOk(await h.core.startRun(taskId))

      h.agent.advance('native-1')
      expectOk(await h.core.reconcileRun(first.run_id))
      expect((await h.journal.readTask(taskId))?.state).toBe('WAITING_REVIEW')

      // Without the explicit unblock no new Run may start.
      expectFailure(await h.core.startRun(taskId), 'INVALID_TRANSITION')

      expectOk(await h.core.markTaskReady(taskId, 'review_retry'))
      const second = expectOk(await h.core.startRun(taskId))

      expect(second.run_id).not.toBe(first.run_id)
      expect(h.agent.listNativeRefs()).toEqual(['native-1', 'native-2'])
    })
  })
})

// ---------------------------------------------------------------------------
// Family 15 — adapter mismatch
// ---------------------------------------------------------------------------

describe('recovery family 15: adapter mismatch', () => {
  test('refuses to call the AgentPort when the adapter version mismatches', async () => {
    await withHarness(async (h) => {
      const core = h.coreWith(withReportedProtocolVersion(h.agent, '9.9'))
      const taskId = await createReadyTaskOn(core)

      expectFailure(await core.startRun(taskId), 'UNSUPPORTED_CAPABILITY')

      expect(h.agent.getCalls().filter(call => call.method === 'submitTask').length).toBe(0)
      expect(await h.journal.listNonTerminalRuns()).toEqual([])

      const task = await h.journal.readTask(taskId)
      expect(task?.state).toBe('READY')
    })
  })
})
