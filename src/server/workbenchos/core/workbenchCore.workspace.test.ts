/**
 * M5-PRE-007 — run-scoped workspace authority contracts.
 *
 * The binding is a durable journal fact: `startRun` records the workspace on
 * `run.created`, the submission carries it, and recovery re-reads it instead of
 * re-deciding it. No `process.cwd()`, no default, no guessing.
 *
 * Everything here runs against a real SqliteJournal; a "restart" really closes
 * the database and opens a new instance with a new Core. No real CLI runs.
 *
 * Authorized by task package M5-PRE-007.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentHealth,
  AgentPortV01,
  AgentStatusSnapshot,
  AgentSubmissionV01,
  CancelReceipt,
  CollectResultOutcome,
  SubmissionReceipt,
} from '../ports/agentPort.js'
import { SqliteJournal } from '../persistence/sqliteJournal.js'
import { FakeAgentPort } from '../testing/fakeAgentPort.js'
import {
  WorkbenchCore,
  type Clock,
  type CoreResult,
  type CreateTaskInput,
} from './workbenchCore.js'

// ---------------------------------------------------------------------------
// Test double: records the submission the Core actually sends
// ---------------------------------------------------------------------------

/**
 * `FakeAgentPort` deliberately records only method names and idempotency keys, so
 * it cannot answer "what workspace did the Run hand to the agent?". This thin
 * recorder delegates every behaviour to the fake and keeps the submissions.
 */
class RecordingAgentPort implements AgentPortV01 {
  readonly protocolVersion = '0.1' as const
  readonly submissions: AgentSubmissionV01[] = []

  private readonly inner: FakeAgentPort

  constructor(inner: FakeAgentPort) {
    this.inner = inner
  }

  workspaceRefs(): Array<string | undefined> {
    return this.submissions.map(submission => submission.workspace_ref)
  }

  async submitTask(
    input: AgentSubmissionV01,
    idempotencyKey: string,
    timeoutMs: number,
  ): Promise<SubmissionReceipt> {
    this.submissions.push(input)
    return this.inner.submitTask(input, idempotencyKey, timeoutMs)
  }

  lookupSubmission(
    idempotencyKey: string,
    timeoutMs: number,
  ): Promise<SubmissionReceipt | null> {
    return this.inner.lookupSubmission(idempotencyKey, timeoutMs)
  }

  getStatus(nativeRunRef: string, timeoutMs: number): Promise<AgentStatusSnapshot> {
    return this.inner.getStatus(nativeRunRef, timeoutMs)
  }

  collectResult(nativeRunRef: string, timeoutMs: number): Promise<CollectResultOutcome> {
    return this.inner.collectResult(nativeRunRef, timeoutMs)
  }

  cancel(
    nativeRunRef: string,
    idempotencyKey: string,
    reason: string,
    timeoutMs: number,
  ): Promise<CancelReceipt> {
    return this.inner.cancel(nativeRunRef, idempotencyKey, reason, timeoutMs)
  }

  healthCheck(timeoutMs: number): Promise<AgentHealth> {
    return this.inner.healthCheck(timeoutMs)
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Harness = {
  readonly journal: SqliteJournal
  readonly core: WorkbenchCore
  readonly agent: FakeAgentPort
  readonly recorder: RecordingAgentPort
  /** Closes the database, opens a new instance, and constructs a new Core. */
  restart(): Promise<void>
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

async function withHarness(run: (h: Harness) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'workbenchos-workspace-'))
  const databasePath = join(dir, 'workbench.sqlite3')
  const agent = new FakeAgentPort()
  const recorder = new RecordingAgentPort(agent)
  // Created once per test on purpose: a generator that restarted its counter
  // would collide on event ids after a restart (see M1-001-P6 CL-6).
  const clock = makeClock()
  const ids = makeIds()

  let journal = new SqliteJournal({ databasePath })
  await journal.open()

  const buildCore = (): WorkbenchCore =>
    new WorkbenchCore({
      journal,
      agentPort: recorder,
      clock,
      ids,
      project_id: 'project-1',
      port_timeout_ms: 1000,
    })

  let core = buildCore()

  try {
    await run({
      get journal() {
        return journal
      },
      get core() {
        return core
      },
      agent,
      recorder,
      async restart() {
        await journal.close()
        journal = new SqliteJournal({ databasePath })
        await journal.open()
        core = buildCore()
      },
    })
  } finally {
    await journal.close().catch(() => undefined)
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
    goal: 'prove the workspace contracts hold',
    requested_execution: { agent_id: 'fake', execution_timeout_ms: 600000 },
    ...overrides,
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

async function createReadyTaskOn(h: Harness): Promise<string> {
  const created = expectOk(await h.core.createTask(makeTaskInput()))
  expectOk(await h.core.markTaskReady(created.task_id))
  return created.task_id
}

/** The workspace recorded on the run's durable `run.created` event. */
async function recordedWorkspace(h: Harness, taskId: string): Promise<unknown> {
  const events = await h.journal.listEventsForTask(taskId)
  const created = events.filter(event => event.event_type === 'run.created')
  expect(created.length).toBeGreaterThan(0)
  const payload = created[0]?.payload as unknown as Record<string, unknown>
  return payload['workspace_ref']
}

// ---------------------------------------------------------------------------
// T1 / T2 — binding
// ---------------------------------------------------------------------------

describe('workspace binding', () => {
  test('T1: records the run workspace durably and hands it to the agent', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({ steps: [] })
      const taskId = await createReadyTaskOn(h)

      const run = expectOk(await h.core.startRun(taskId, '/ws/a'))

      expect(h.recorder.workspaceRefs()).toEqual(['/ws/a'])
      expect(await recordedWorkspace(h, taskId)).toBe('/ws/a')
      expect((await h.journal.readRun(run.run_id))?.task_id).toBe(taskId)
    })
  })

  test('T2a: two Runs keep their own workspaces', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({ steps: [] })
      h.agent.enqueueScenario({ steps: [] })

      const taskA = await createReadyTaskOn(h)
      const taskB = expectOk(await h.core.createTask(
        makeTaskInput({ idempotency_key: 'idem-2' }),
      )).task_id
      expectOk(await h.core.markTaskReady(taskB))

      expectOk(await h.core.startRun(taskA, '/ws/a'))
      expectOk(await h.core.startRun(taskB, '/ws/b'))

      expect(h.recorder.workspaceRefs()).toEqual(['/ws/a', '/ws/b'])
    })
  })

  test('T2b: one Task can bind each of its Runs to a different workspace', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({ steps: [{ status: 'running' }, { status: 'succeeded' }] })
      const taskId = await createReadyTaskOn(h)

      const first = expectOk(await h.core.startRun(taskId, '/ws/a'))
      h.agent.advance('native-1')
      h.agent.advance('native-1')
      expectOk(await h.core.reconcileRun(first.run_id))

      // A terminal Run plus an explicit unblock is what makes a second Run legal.
      expectOk(await h.core.markTaskReady(taskId, 'review_retry'))
      const second = expectOk(await h.core.startRun(taskId, '/ws/b'))

      expect(second.run_id).not.toBe(first.run_id)
      expect(h.recorder.workspaceRefs()).toEqual(['/ws/a', '/ws/b'])
    })
  })
})

// ---------------------------------------------------------------------------
// T4 / T5 / T8 — fail closed, validation, idempotency
// ---------------------------------------------------------------------------

describe('workspace fail-closed behaviour', () => {
  test('T4: an unbound Run carries no workspace instead of inventing one', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({ steps: [] })
      const taskId = await createReadyTaskOn(h)

      expectOk(await h.core.startRun(taskId))

      expect(h.recorder.submissions).toHaveLength(1)
      expect('workspace_ref' in (h.recorder.submissions[0] ?? {})).toBe(false)
      expect(await recordedWorkspace(h, taskId)).toBeUndefined()
      // The adapter is the fail-closed boundary for a missing workspace; see
      // codexAdapter.test.ts ("refuses a submission with no worktree").
    })
  })

  test('T5: an unusable workspace reference is rejected and no Run is created', async () => {
    await withHarness(async (h) => {
      const taskId = await createReadyTaskOn(h)

      expectFailure(await h.core.startRun(taskId, '   '), 'INVALID_REQUEST')

      expect(h.recorder.submissions).toEqual([])
      expect(await h.journal.listNonTerminalRuns()).toEqual([])
      expect((await h.journal.readTask(taskId))?.state).toBe('READY')
    })
  })

  test('T8: a repeated start cannot re-bind the same Task to another workspace', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({ steps: [] })
      const taskId = await createReadyTaskOn(h)
      expectOk(await h.core.startRun(taskId, '/ws/a'))

      expectFailure(await h.core.startRun(taskId, '/ws/b'), 'INVALID_TRANSITION')

      expect(h.recorder.workspaceRefs()).toEqual(['/ws/a'])
      const events = await h.journal.listEventsForTask(taskId)
      expect(events.filter(event => event.event_type === 'run.created').length).toBe(1)
    })
  })
})

// ---------------------------------------------------------------------------
// T3 / T9 — persistence across a restart and recovery of the binding
// ---------------------------------------------------------------------------

describe('workspace recovery', () => {
  test('T3: the binding survives a restart', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({ steps: [] })
      const taskId = await createReadyTaskOn(h)
      expectOk(await h.core.startRun(taskId, '/ws/a'))

      await h.restart()

      expect(await recordedWorkspace(h, taskId)).toBe('/ws/a')
    })
  })

  test('T9: recovery re-submits the recorded workspace instead of re-deciding it', async () => {
    await withHarness(async (h) => {
      // First attempt loses its acknowledgement; the retry after the restart
      // succeeds. This is the exact path that re-builds a submission.
      h.agent.enqueueScenario({ steps: [], submit_behavior: 'timeout' })
      h.agent.enqueueScenario({ steps: [] })

      const taskId = await createReadyTaskOn(h)
      expectOk(await h.core.startRun(taskId, '/ws/a'))
      expect(h.recorder.workspaceRefs()).toEqual(['/ws/a'])

      await h.restart()
      expectOk(await h.core.recoverPendingRuns())

      expect(h.recorder.submissions).toHaveLength(2)
      expect(h.recorder.workspaceRefs()).toEqual(['/ws/a', '/ws/a'])
      expect(h.agent.listNativeRefs()).toEqual(['native-1'])
    })
  })

  test('T9b: an unbound Run recovers unbound — recovery never invents a workspace', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({ steps: [], submit_behavior: 'timeout' })
      h.agent.enqueueScenario({ steps: [] })

      const taskId = await createReadyTaskOn(h)
      expectOk(await h.core.startRun(taskId))

      await h.restart()
      expectOk(await h.core.recoverPendingRuns())

      expect(h.recorder.submissions).toHaveLength(2)
      expect(h.recorder.submissions[1]?.workspace_ref).toBeUndefined()
    })
  })
})
