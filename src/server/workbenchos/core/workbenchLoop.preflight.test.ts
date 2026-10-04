/**
 * M5-PRE-009 — L0-001 preflight: single-agent bounded loop vertical slice.
 *
 * Evidence class: **Implementation/Test Evidence only**. The agent is a test
 * double (`FakeAgentPort`), so nothing here says anything about Codex
 * availability — `codex-cli 0.160.0` real execution remains BLOCKED BY QUOTA.
 *
 * This file deliberately adds only what the existing suite does NOT already
 * prove directly (M5-PRE-009 §7): a non-empty EvidenceRef round trip, an
 * operation-level (not content-level) dedupe check with an explicit workspace, a
 * persisted failure, and duplicate recovery on the Agent path. Happy-path state
 * machine, browser approval and fix-loop bounds are already covered elsewhere
 * and are referenced, not re-implemented.
 *
 * Authorized by task package M5-PRE-009.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EvidenceRef } from '../contracts.js'
import type {
  AgentHealth,
  AgentPortV01,
  AgentResultMaterial,
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

/** `FakeAgentPort` ignores its input, so this keeps the submissions themselves. */
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
  const dir = mkdtempSync(join(tmpdir(), 'workbenchos-loop-'))
  const databasePath = join(dir, 'workbench.sqlite3')
  const agent = new FakeAgentPort()
  const recorder = new RecordingAgentPort(agent)
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
// Fixtures
// ---------------------------------------------------------------------------

const EVIDENCE: EvidenceRef[] = [
  { kind: 'loop_preflight_run', ref: 'preflight-run-1', hash: 'hash-evidence-1' },
]

const ARTIFACTS: EvidenceRef[] = [
  { kind: 'loop_preflight_artifact', ref: 'preflight-artifact-1', hash: 'hash-artifact-1' },
]

function terminalMaterial(nativeRunRef: string, succeeded: boolean): AgentResultMaterial {
  return {
    native_run_ref: nativeRunRef,
    outcome: succeeded ? 'succeeded' : 'failed',
    completion: succeeded ? 'complete' : 'none',
    summary: succeeded ? 'vertical slice succeeded' : 'vertical slice failed on purpose',
    changed_files: [],
    commands: [],
    validations: [],
    git_state: { available: true, commit_performed: false, push_performed: false },
    artifacts: succeeded ? ARTIFACTS : [],
    native_evidence_refs: succeeded ? EVIDENCE : [],
    risks: [],
    unresolved_work: succeeded ? [] : ['the fake agent failed on purpose'],
    errors: succeeded
      ? []
      : [{ code: 'LOOP_PREFLIGHT_FAILED', message: 'controlled failure', retryable: false }],
    finished_at: '2026-01-01T00:00:00.000Z',
  }
}

function makeTaskInput(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    conversation_ref: { browser_adapter_id: 'chatgpt-web', conversation_id: 'conversation-1' },
    idempotency_key: 'idem-1',
    goal: 'prove the single-agent loop closes',
    requested_execution: { agent_id: 'fake', execution_timeout_ms: 600000 },
    ...overrides,
  }
}

function expectOk<T>(result: CoreResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.detail}`)
  return result.value
}

async function createReadyTaskOn(h: Harness, overrides: Partial<CreateTaskInput> = {}): Promise<string> {
  const created = expectOk(await h.core.createTask(makeTaskInput(overrides)))
  expectOk(await h.core.markTaskReady(created.task_id))
  return created.task_id
}

/** Runs one attempt to its terminal state through the real Core. */
async function driveToTerminal(h: Harness, runId: string): Promise<void> {
  h.agent.advance('native-1')
  h.agent.advance('native-1')
  expectOk(await h.core.reconcileRun(runId))
}

// ---------------------------------------------------------------------------
// Scenario A — happy path (A1–A6)
// ---------------------------------------------------------------------------

describe('loop vertical slice: happy path', () => {
  test('A: Run(workspace) → submit → result(evidence) → Run SUCCEEDED', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({
        steps: [{ status: 'running' }, { status: 'succeeded', material: terminalMaterial('native-1', true) }],
      })

      const taskId = await createReadyTaskOn(h)
      const run = expectOk(await h.core.startRun(taskId, '/ws/test'))

      // A1 / A2: the workspace is bound to the Run and handed to the agent.
      expect(h.recorder.workspaceRefs()).toEqual(['/ws/test'])
      const events = await h.journal.listEventsForTask(taskId)
      const created = events.filter(event => event.event_type === 'run.created')
      expect((created[0]?.payload as unknown as Record<string, unknown>)['workspace_ref']).toBe('/ws/test')

      // A3: exactly one agent submission — single operation, no planner steps.
      const submissions = h.agent.getCalls().filter(call => call.method === 'submitTask')
      expect(submissions.length).toBe(1)
      expect(h.agent.listNativeRefs()).toEqual(['native-1'])

      // A4 / A5: the result is collected and carries the EvidenceRef.
      await driveToTerminal(h, run.run_id)
      const result = await h.journal.readResultByRun(run.run_id)
      expect(result?.native_evidence_refs).toEqual(EVIDENCE)
      expect(result?.artifacts).toEqual(ARTIFACTS)

      // A6: the Run reaches its terminal state.
      expect((await h.journal.readRun(run.run_id))?.state).toBe('SUCCEEDED')
    })
  })

  test('D: the persisted EvidenceRef survives a restart', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({
        steps: [{ status: 'running' }, { status: 'succeeded', material: terminalMaterial('native-1', true) }],
      })
      const taskId = await createReadyTaskOn(h)
      const run = expectOk(await h.core.startRun(taskId, '/ws/test'))
      await driveToTerminal(h, run.run_id)

      await h.restart()

      const result = await h.journal.readResultByRun(run.run_id)
      expect(result?.native_evidence_refs).toEqual(EVIDENCE)
      expect(result?.artifacts).toEqual(ARTIFACTS)
    })
  })
})

// ---------------------------------------------------------------------------
// Scenario C — operation-level idempotency, not content-level dedupe
// ---------------------------------------------------------------------------

describe('loop vertical slice: operation identity', () => {
  test('C: identical content and workspace in different operations both execute', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({ steps: [] })
      h.agent.enqueueScenario({ steps: [] })

      // Same goal, same conversation, same explicit workspace — only the
      // operation (idempotency key) differs.
      const first = await createReadyTaskOn(h, { idempotency_key: 'operation-a' })
      const second = await createReadyTaskOn(h, { idempotency_key: 'operation-b' })

      expectOk(await h.core.startRun(first, '/ws/test'))
      expectOk(await h.core.startRun(second, '/ws/test'))

      expect(h.agent.getCalls().filter(call => call.method === 'submitTask').length).toBe(2)
      expect(h.agent.listNativeRefs()).toEqual(['native-1', 'native-2'])
      expect(h.agent.getSideEffectCount('native-1')).toBe(1)
      expect(h.agent.getSideEffectCount('native-2')).toBe(1)
      expect(h.recorder.workspaceRefs()).toEqual(['/ws/test', '/ws/test'])
    })
  })
})

// ---------------------------------------------------------------------------
// Scenario E — a controlled failure is persisted, never silently completed
// ---------------------------------------------------------------------------

describe('loop vertical slice: failure', () => {
  test('E: the Run fails, the error is persisted, and no second Run is started', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({
        steps: [{ status: 'running' }, { status: 'failed', material: terminalMaterial('native-1', false) }],
      })
      const taskId = await createReadyTaskOn(h)
      const run = expectOk(await h.core.startRun(taskId, '/ws/test'))

      await driveToTerminal(h, run.run_id)

      expect((await h.journal.readRun(run.run_id))?.state).toBe('FAILED')
      const result = await h.journal.readResultByRun(run.run_id)
      expect(result?.outcome.status).toBe('failed')
      expect(result?.errors.map(error => error.code)).toEqual(['LOOP_PREFLIGHT_FAILED'])
      // No implicit retry: starting another Run is the caller's decision.
      expect(h.agent.getCalls().filter(call => call.method === 'submitTask').length).toBe(1)
      expect(await h.journal.listNonTerminalRuns()).toEqual([])
    })
  })
})

// ---------------------------------------------------------------------------
// Terminal outcomes a bounded loop must survive: timeout and cancellation
// ---------------------------------------------------------------------------

describe('loop vertical slice: terminal outcomes', () => {
  test('an agent timeout ends the Run in TIMED_OUT, not in a silent success', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({ steps: [{ status: 'running' }, { status: 'timed_out' }] })
      const taskId = await createReadyTaskOn(h)
      const run = expectOk(await h.core.startRun(taskId, '/ws/test'))

      await driveToTerminal(h, run.run_id)

      expect((await h.journal.readRun(run.run_id))?.state).toBe('TIMED_OUT')
      const result = await h.journal.readResultByRun(run.run_id)
      expect(result?.outcome.status).toBe('timed_out')
      // One attempt, one terminal outcome — the loop does not restart itself.
      expect(h.agent.getCalls().filter(call => call.method === 'submitTask').length).toBe(1)
    })
  })

  test('a cancelled Run ends in CANCELLED after the authoritative Result', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({ steps: [{ status: 'running' }, { status: 'cancelled' }] })
      const taskId = await createReadyTaskOn(h)
      const run = expectOk(await h.core.startRun(taskId, '/ws/test'))

      h.agent.advance('native-1')
      // Cancel is only an intent; the Result terminalizes the Run.
      expectOk(await h.core.cancelRun(run.run_id, 'operator asked'))
      expect((await h.journal.readRun(run.run_id))?.state).not.toBe('CANCELLED')

      h.agent.advance('native-1')
      expectOk(await h.core.reconcileRun(run.run_id))

      expect((await h.journal.readRun(run.run_id))?.state).toBe('CANCELLED')
      const result = await h.journal.readResultByRun(run.run_id)
      expect(result?.outcome.status).toBe('cancelled')
    })
  })
})

// ---------------------------------------------------------------------------
// Scenario F / N — response lost, then recovery twice, still one execution
// ---------------------------------------------------------------------------

describe('loop vertical slice: recovery', () => {
  test('N: lost acknowledgement plus repeated recovery still executes once', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({ steps: [], submit_behavior: 'effect_then_lost_ack' })
      h.agent.enqueueScenario({ steps: [{ status: 'running' }, { status: 'succeeded', material: terminalMaterial('native-1', true) }] })

      const taskId = await createReadyTaskOn(h)
      expectOk(await h.core.startRun(taskId, '/ws/a'))

      // F: the effect happened even though the receipt never arrived.
      expect(h.agent.getSideEffectCount('native-1')).toBe(1)

      await h.restart()

      // N: recovery twice must not re-execute.
      expectOk(await h.core.recoverPendingRuns())
      expectOk(await h.core.recoverPendingRuns())

      expect(h.agent.getSideEffectCount('native-1')).toBe(1)
      expect(h.agent.listNativeRefs()).toEqual(['native-1'])
      // The lookup found the original effect, so recovery never re-submitted.
      expect(h.recorder.submissions).toHaveLength(1)
      // G: the workspace is still the one the Run was bound to.
      expect(h.recorder.workspaceRefs()).toEqual(['/ws/a'])
    })
  })
})
