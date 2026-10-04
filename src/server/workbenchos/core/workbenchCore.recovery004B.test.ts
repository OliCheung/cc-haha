/**
 * REAL-004B — D1-A / D3 / D5 behaviour.
 *
 * Deterministic, 0 real Codex. Uses FakeAgentPort + a manually advanced clock so
 * the D1-A liveness window (MAX_RUNNING_SILENCE_MS) can be crossed without
 * advancing a real clock by 30 minutes.
 *
 * Covers:
 *   - D1-A: a RUNNING run silent beyond the threshold is presumed native-lost
 *           (RUNNING -> RECOVERY_REQUIRED, classified recovery_required, never reconciled).
 *   - D1-A inverse: a recently-run RUNNING run stays reconciled (D5).
 *   - D3: recovery observation never auto-resubmits a RECOVERY_REQUIRED run.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentPortV01, AgentResultMaterial } from '../ports/agentPort.js'
import { SqliteJournal } from '../persistence/sqliteJournal.js'
import { FakeAgentPort, type FakeTerminalStatus } from '../testing/fakeAgentPort.js'
import {
  WorkbenchCore,
  type Clock,
  type CoreResult,
  type CreateTaskInput,
} from './workbenchCore.js'

// ---------------------------------------------------------------------------
// Harness with a manually advanced clock
// ---------------------------------------------------------------------------

type ManualClock = Clock & { setNow(value: string): void }

function makeManualClock(initial = '2026-01-01T00:00:00.000Z'): ManualClock {
  let current = initial
  return {
    now: () => current,
    setNow: (value: string) => {
      current = value
    },
  }
}

function makeIds(): { next(): string } {
  let counter = 0
  return { next: () => {
    counter += 1
    return `id-${counter}`
  } }
}

type Harness = {
  readonly journal: SqliteJournal
  readonly core: WorkbenchCore
  readonly agent: FakeAgentPort
  readonly databasePath: string
  readonly clock: ManualClock
  restart(): Promise<void>
  coreWith(agentPort: AgentPortV01): WorkbenchCore
}

async function withHarness(run: (h: Harness) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'workbenchos-recovery-004b-'))
  const databasePath = join(dir, 'workbench.sqlite3')
  const agent = new FakeAgentPort()
  const clock = makeManualClock()
  const ids = makeIds()
  let journal = new SqliteJournal({ databasePath })
  await journal.open()
  const buildCore = (agentPort: AgentPortV01): WorkbenchCore =>
    new WorkbenchCore({ journal, agentPort, clock, ids, project_id: 'project-1', port_timeout_ms: 1000 })
  let core = buildCore(agent)
  const handle: Harness = {
    get journal() { return journal },
    get core() { return core },
    agent,
    databasePath,
    clock,
    async restart() {
      await journal.close()
      journal = new SqliteJournal({ databasePath })
      await journal.open()
      core = buildCore(agent)
    },
    coreWith(agentPort: AgentPortV01) { return buildCore(agentPort) },
  }
  try {
    await run(handle)
  } finally {
    await journal.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTaskInput(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    conversation_ref: { browser_adapter_id: 'chatgpt-web', conversation_id: 'conversation-1' },
    idempotency_key: 'idem-1',
    goal: 'REAL-004B recovery semantics',
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
    summary: `REAL-004B material for ${outcome}`,
    changed_files: [],
    commands: [],
    validations: [],
    git_state: { available: true, commit_performed: false, push_performed: false },
    artifacts: [],
    native_evidence_refs: [],
    risks: [],
    unresolved_work: succeeded ? [] : ['terminal without success'],
    errors: succeeded
      ? []
      : [{ code: 'TEST_TERMINAL', message: 'terminal without success', retryable: false }],
    finished_at: '2026-01-01T00:00:00.000Z',
  }
}

function expectOk<T>(result: CoreResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.detail}`)
  return result.value
}

async function createReadyTaskOn(core: WorkbenchCore, overrides: Partial<CreateTaskInput> = {}): Promise<string> {
  const created = expectOk(await core.createTask(makeTaskInput(overrides)))
  expectOk(await core.markTaskReady(created.task_id))
  return created.task_id
}

function submittedKeys(agent: FakeAgentPort): Array<string | undefined> {
  return agent
    .getCalls()
    .filter(call => call.method === 'submitTask')
    .map(call => call.idempotency_key)
}

/** Drives a Run into RUNNING (native_ref bound, adapter still `running`). */
async function driveToRunning(h: Harness): Promise<{ taskId: string; runId: string; nativeRef: string }> {
  h.agent.enqueueScenario({ steps: [{ status: 'running' }] })
  const taskId = await createReadyTaskOn(h.core)
  const run = expectOk(await h.core.startRun(taskId))
  h.agent.advance('native-1')
  expectOk(await h.core.reconcileRun(run.run_id))
  expect((await h.journal.readRun(run.run_id))?.state).toBe('RUNNING')
  return { taskId, runId: run.run_id, nativeRef: 'native-1' }
}

/** Drives a Run into RECOVERY_REQUIRED via an unknown adapter status. */
async function driveToRecoveryRequired(h: Harness): Promise<{ taskId: string; runId: string; nativeRef: string }> {
  h.agent.enqueueScenario({ steps: [{ status: 'running' }] })
  const taskId = await createReadyTaskOn(h.core)
  const run = expectOk(await h.core.startRun(taskId))
  h.agent.advance('native-1')
  expectOk(await h.core.reconcileRun(run.run_id))
  h.agent.injectFault('native-1', 'status_unknown')
  const recovered = expectOk(await h.core.recoverPendingRuns())
  expect(recovered.recovery_required).toEqual([run.run_id])
  expect(recovered.reconciled).toEqual([])
  expect((await h.journal.readRun(run.run_id))?.state).toBe('RECOVERY_REQUIRED')
  return { taskId, runId: run.run_id, nativeRef: 'native-1' }
}

// ---------------------------------------------------------------------------
// D1-A: RUNNING liveness proxy
// ---------------------------------------------------------------------------

describe('REAL-004B D1-A: RUNNING liveness proxy', () => {
  test('a RUNNING run silent beyond the threshold is presumed native-lost', async () => {
    await withHarness(async (h) => {
      const T0 = '2026-01-01T00:00:00.000Z'
      h.clock.setNow(T0)
      const { runId } = await driveToRunning(h)
      // updated_at anchored at T0; advance well past MAX_RUNNING_SILENCE_MS (30 min).
      h.clock.setNow('2026-01-01T00:31:00.000Z')
      const recovered = expectOk(await h.core.recoverPendingRuns())
      // D5: it must NOT be classified as reconciled; it is recovery_required.
      expect(recovered.reconciled).toEqual([])
      expect(recovered.recovery_required).toEqual([runId])
      expect((await h.journal.readRun(runId))?.state).toBe('RECOVERY_REQUIRED')
    })
  })

  test('a recently-run RUNNING run is NOT presumed lost (stays reconciled)', async () => {
    await withHarness(async (h) => {
      const T0 = '2026-01-01T00:00:00.000Z'
      h.clock.setNow(T0)
      const { runId } = await driveToRunning(h)
      // Only a small advance, well within the liveness window.
      h.clock.setNow('2026-01-01T00:00:30.000Z')
      const recovered = expectOk(await h.core.recoverPendingRuns())
      expect(recovered.reconciled).toEqual([runId])
      expect(recovered.recovery_required).toEqual([])
      expect((await h.journal.readRun(runId))?.state).toBe('RUNNING')
    })
  })
})

// ---------------------------------------------------------------------------
// D3: recovery observation never auto-resubmits
// ---------------------------------------------------------------------------

describe('REAL-004B D3: recovery observation never auto-resubmits', () => {
  test('a RECOVERY_REQUIRED run produces no new submission across observation passes', async () => {
    await withHarness(async (h) => {
      const { runId } = await driveToRecoveryRequired(h)
      const submitsBefore = submittedKeys(h.agent).length
      const second = expectOk(await h.core.recoverPendingRuns())
      expect(second.recovery_required).toEqual([runId])
      expect(second.reconciled).toEqual([])
      // No new external submission side effect was created by observation.
      expect(submittedKeys(h.agent).length).toBe(submitsBefore)
    })
  })

  test('a RECOVERY_REQUIRED run is still observed as recovery_required after a restart', async () => {
    await withHarness(async (h) => {
      const { runId } = await driveToRecoveryRequired(h)
      await h.restart()
      const recovered = expectOk(await h.core.recoverPendingRuns())
      expect(recovered.recovery_required).toEqual([runId])
      expect(recovered.reconciled).toEqual([])
    })
  })
})
