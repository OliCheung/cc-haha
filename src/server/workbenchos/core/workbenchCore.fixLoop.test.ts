/**
 * M5-01 — bounded fix-loop integration contracts.
 *
 * Drives the real WorkbenchCore over a real SqliteJournal using the production
 * FakeAgentPort from M1-001-P5, proving that `next_action.kind === 'retry'` is
 * consumed inside the transaction that records the Result.
 *
 * Authorized by task package M5-01.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentResultMaterial } from '../ports/agentPort.js'
import { SqliteJournal } from '../persistence/sqliteJournal.js'
import { FakeAgentPort } from '../testing/fakeAgentPort.js'
import {
  WorkbenchCore,
  type Clock,
  type CoreResult,
  type CreateTaskInput,
} from './workbenchCore.js'
import type { FixLoopDecision, FixLoopPolicy, FixLoopPolicyInput } from './fixLoopPolicy.js'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Harness = {
  readonly journal: SqliteJournal
  readonly core: WorkbenchCore
  readonly agent: FakeAgentPort
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

async function withHarness(
  run: (h: Harness) => Promise<void>,
  options: { fixLoopPolicy?: FixLoopPolicy } = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'workbenchos-fixloop-'))
  const journal = new SqliteJournal({ databasePath: join(dir, 'workbench.sqlite3') })
  await journal.open()

  const agent = new FakeAgentPort()
  const core = new WorkbenchCore({
    journal,
    agentPort: agent,
    clock: makeClock(),
    ids: makeIds(),
    project_id: 'project-1',
    port_timeout_ms: 1000,
    ...(options.fixLoopPolicy === undefined ? {} : { fixLoopPolicy: options.fixLoopPolicy }),
  })

  try {
    await run({ journal, core, agent })
  } finally {
    await journal.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTaskInput(key: string): CreateTaskInput {
  return {
    conversation_ref: { browser_adapter_id: 'fake', conversation_id: 'conversation-1' },
    idempotency_key: key,
    goal: 'prove the bounded fix loop',
    requested_execution: { agent_id: 'fake', execution_timeout_ms: 600000 },
  }
}

function makeFailedMaterial(
  nativeRunRef: string,
  changedPaths: string[],
  requirementId: string,
): AgentResultMaterial {
  return {
    native_run_ref: nativeRunRef,
    outcome: 'failed',
    completion: 'none',
    summary: `verification failed for ${nativeRunRef}`,
    changed_files: changedPaths.map(path => ({ path, change: 'modified' as const })),
    commands: [],
    validations: [{ requirement_id: requirementId, result: 'failed' as const }],
    git_state: { available: true, commit_performed: false, push_performed: false },
    artifacts: [],
    native_evidence_refs: [],
    risks: [],
    unresolved_work: [`${requirementId} still fails`],
    errors: [{ code: 'VERIFY_FAILED', message: 'verification failed', retryable: false }],
    finished_at: '2026-01-01T00:00:00.000Z',
  }
}

function makeSucceededMaterial(nativeRunRef: string): AgentResultMaterial {
  return {
    native_run_ref: nativeRunRef,
    outcome: 'succeeded',
    completion: 'complete',
    summary: `verification passed for ${nativeRunRef}`,
    changed_files: [],
    commands: [],
    validations: [],
    git_state: { available: true, commit_performed: false, push_performed: false },
    artifacts: [],
    native_evidence_refs: [],
    risks: [],
    unresolved_work: [],
    errors: [],
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

async function createReadyTask(h: Harness, key = 'idem-1'): Promise<string> {
  const created = expectOk(await h.core.createTask(makeTaskInput(key)))
  expectOk(await h.core.markTaskReady(created.task_id))
  return created.task_id
}

/** Runs one attempt that ends FAILED with the given file changes. */
async function runFailedAttempt(
  h: Harness,
  taskId: string,
  changedPaths: string[],
  requirementId = 'req-1',
): Promise<string> {
  const expectedRef = `native-${h.agent.listNativeRefs().length + 1}`
  h.agent.enqueueScenario({
    steps: [{ status: 'failed', material: makeFailedMaterial(expectedRef, changedPaths, requirementId) }],
  })

  const run = expectOk(await h.core.startRun(taskId))
  const bound = await h.journal.readRun(run.run_id)
  expect(bound?.native_ref).toBe(expectedRef)

  h.agent.advance(expectedRef)
  const settled = expectOk(await h.core.reconcileRun(run.run_id))
  expect(settled.state).toBe('FAILED')
  return run.run_id
}

async function authorizeReviewRetry(h: Harness, taskId: string): Promise<void> {
  expectOk(await h.core.markTaskReady(taskId, 'review_retry'))
}

async function submissionKeyFor(
  h: Harness,
  taskId: string,
  runId: string,
): Promise<string> {
  const events = await h.journal.listEventsForTask(taskId)
  const event = events.find(
    candidate => candidate.run_id === runId && candidate.event_type === 'run.submission_requested',
  )
  const payload = event?.payload as unknown as Record<string, unknown> | undefined
  if (typeof payload?.submission_key !== 'string') {
    throw new Error(`missing submission key for ${runId}`)
  }
  return payload.submission_key
}

async function taskEvents(h: Harness, taskId: string) {
  return h.journal.listEventsForTask(taskId)
}

type Spy = { policy: FixLoopPolicy; inputs: FixLoopPolicyInput[] }

function makeSpyPolicy(decisions: FixLoopDecision[] = []): Spy {
  const inputs: FixLoopPolicyInput[] = []
  return {
    inputs,
    policy: {
      decide(input) {
        inputs.push(input)
        return decisions.shift() ?? { action: 'retry' }
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fix loop: retry path', () => {
  test('keeps the Task at WAITING_REVIEW when the policy proposes retry', async () => {
    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)
      const runId = await runFailedAttempt(h, taskId, ['src/a.ts'])

      const task = await h.journal.readTask(taskId)
      expect(task?.state).toBe('WAITING_REVIEW')
      const result = await h.journal.readResultByRun(runId)
      expect(result?.extensions?.['workbenchos.fix_loop']).toEqual({ action: 'retry', round: 1 })
      const events = await taskEvents(h, taskId)
      expect(
        events.filter(event => event.run_id === runId && event.event_type === 'task.ready'),
      ).toHaveLength(0)
      expect(events.filter(event => event.dedupe_key.startsWith('fix-loop-retry:'))).toHaveLength(0)
    })
  })

  test('records the Result and review state in the same transaction', async () => {
    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)
      await runFailedAttempt(h, taskId, ['src/a.ts'])

      const events = await h.journal.listEventsForTask(taskId)
      const tail = events.slice(-2)

      expect(tail.map(event => event.event_type)).toEqual([
        'run.result_recorded',
        'task.review_ready',
      ])
      // A single commit writes the Result and review transition back-to-back.
      expect(tail[1]!.sequence - tail[0]!.sequence).toBe(1)
    })
  })

  test('marks an explicit review retry with the fix-loop dedupe prefix', async () => {
    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)
      await runFailedAttempt(h, taskId, ['src/a.ts'])
      await authorizeReviewRetry(h, taskId)

      const events = await h.journal.listEventsForTask(taskId)
      const retry = events.find(event => event.dedupe_key.startsWith('fix-loop-retry:'))

      expect(retry?.dedupe_key).toBe(`fix-loop-retry:${taskId}:1`)
      const payload = retry?.payload as unknown as Record<string, unknown>
      expect(payload.round).toBe(1)
      expect(payload.reason).toBe('review_retry')
    })
  })

  test('requires explicit review retry before creating a new Run', async () => {
    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)
      const firstRunId = await runFailedAttempt(h, taskId, ['src/a.ts'])

      expectFailure(await h.core.startRun(taskId), 'INVALID_TRANSITION')

      await authorizeReviewRetry(h, taskId)
      h.agent.enqueueScenario({ steps: [{ status: 'running' }] })
      const second = expectOk(await h.core.startRun(taskId))
      const firstKey = await submissionKeyFor(h, taskId, firstRunId)
      const secondKey = await submissionKeyFor(h, taskId, second.run_id)

      expect(second.run_id).not.toBe(firstRunId)
      expect(secondKey).not.toBe(firstKey)
    })
  })

  test('increments the granted round count across decisions', async () => {
    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)

      await runFailedAttempt(h, taskId, ['src/a.ts', 'src/b.ts'], 'req-1')
      await authorizeReviewRetry(h, taskId)
      await runFailedAttempt(h, taskId, ['src/c.ts', 'src/d.ts'], 'req-2')
      await authorizeReviewRetry(h, taskId)

      const retries = (await taskEvents(h, taskId))
        .filter(event => event.dedupe_key.startsWith('fix-loop-retry:'))

      expect(retries.map(event => event.dedupe_key)).toEqual([
        `fix-loop-retry:${taskId}:1`,
        `fix-loop-retry:${taskId}:2`,
      ])
      expect(retries.map(event => (event.payload as unknown as Record<string, unknown>).round))
        .toEqual([1, 2])
    })
  })
})

describe('fix loop: stop proposal', () => {
  test('keeps the Task reviewable when the policy proposes stop', async () => {
    const stopping: FixLoopPolicy = {
      decide: () => ({
        action: 'stop',
        blocker_code: 'FIX_LOOP_BUDGET_EXCEEDED',
        detail: 'INJECTED STOP',
      }),
    }

    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)
      await runFailedAttempt(h, taskId, ['src/a.ts'])

      const task = await h.journal.readTask(taskId)
      expect(task?.state).toBe('WAITING_REVIEW')
      expect(await h.core.startRun(taskId)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_TRANSITION' },
      })
    }, { fixLoopPolicy: stopping })
  })

  test('records the blocker code and detail in the review proposal', async () => {
    const stopping: FixLoopPolicy = {
      decide: () => ({
        action: 'stop',
        blocker_code: 'FIX_LOOP_BUDGET_EXCEEDED',
        detail: 'INJECTED STOP',
      }),
    }

    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)
      const runId = await runFailedAttempt(h, taskId, ['src/a.ts'])

      const result = await h.journal.readResultByRun(runId)
      expect(result?.extensions?.['workbenchos.fix_loop']).toEqual({
        action: 'stop',
        blocker_code: 'FIX_LOOP_BUDGET_EXCEEDED',
        detail: 'INJECTED STOP',
        round: 1,
      })
    }, { fixLoopPolicy: stopping })
  })

  test('stops at the cap with FIX_LOOP_EXHAUSTED', async () => {
    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await runFailedAttempt(h, taskId, [`src/round-${attempt}.ts`], `req-${attempt}`)
        expect((await h.journal.readTask(taskId))?.state).toBe('WAITING_REVIEW')
        await authorizeReviewRetry(h, taskId)
      }

      // The fourth failure reaches granted_fix_rounds === 3 === the cap.
      await runFailedAttempt(h, taskId, ['src/round-final.ts'], 'req-final')

      const task = await h.journal.readTask(taskId)
      expect(task?.state).toBe('WAITING_REVIEW')
      const result = await h.journal.readResultByRun(task?.active_run_id ?? '')
      expect(result?.extensions?.['workbenchos.fix_loop']).toMatchObject({
        action: 'stop',
        blocker_code: 'FIX_LOOP_EXHAUSTED',
      })
    })
  })

  test('stops with NO_PROGRESS when a fix round changes nothing', async () => {
    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)

      await runFailedAttempt(h, taskId, ['src/a.ts'])
      expect((await h.journal.readTask(taskId))?.state).toBe('WAITING_REVIEW')
      await authorizeReviewRetry(h, taskId)

      // The second attempt is a FIX round (granted === 1) that changed nothing.
      await runFailedAttempt(h, taskId, [])

      const task = await h.journal.readTask(taskId)
      expect(task?.state).toBe('WAITING_REVIEW')
      const result = await h.journal.readResultByRun(task?.active_run_id ?? '')
      expect(result?.extensions?.['workbenchos.fix_loop']).toMatchObject({
        action: 'stop',
        blocker_code: 'FIX_LOOP_NO_PROGRESS',
      })
    })
  })

  test('keeps the journal consistent after a loop stop', async () => {
    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await runFailedAttempt(h, taskId, [`src/round-${attempt}.ts`], `req-${attempt}`)
        if (attempt < 3) await authorizeReviewRetry(h, taskId)
      }

      expect((await h.journal.readTask(taskId))?.state).toBe('WAITING_REVIEW')

      const report = await h.journal.checkIntegrity()
      expect(report.projection_consistent).toBe(true)
      expect(report.details).toEqual([])
    })
  })
})

describe('fix loop: policy wiring', () => {
  test('passes the collected inputs to an injected policy', async () => {
    const spy = makeSpyPolicy()

    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)
      await runFailedAttempt(h, taskId, ['src/a.ts'])

      expect(spy.inputs.length).toBe(1)
      const input = spy.inputs[0]!
      expect(input.granted_fix_rounds).toBe(0)
      expect(input.recorded_result_count).toBe(0)
      expect(input.priorResults).toEqual([])
      expect(input.lastResult.next_action.kind).toBe('retry')
      expect(input.task.task_id).toBe(taskId)

      // The budget starts at the first run.created, not at task.created.
      const events = await h.journal.listEventsForTask(taskId)
      const firstRunCreated = events.find(event => event.event_type === 'run.created')
      expect(input.budget_started_at).toBe(firstRunCreated?.recorded_at)
      expect(input.budget_started_at).not.toBe(input.task.envelope.created_at)
    }, { fixLoopPolicy: spy.policy })
  })

  test('exposes the prior results on the second decision', async () => {
    const spy = makeSpyPolicy()

    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)
      await runFailedAttempt(h, taskId, ['src/a.ts'])
      await authorizeReviewRetry(h, taskId)
      await runFailedAttempt(h, taskId, ['src/b.ts'])

      expect(spy.inputs.length).toBe(2)
      const second = spy.inputs[1]!
      expect(second.granted_fix_rounds).toBe(1)
      expect(second.recorded_result_count).toBe(1)
      expect(second.priorResults.length).toBe(1)
      expect(second.priorResults[0]?.next_action.kind).toBe('retry')
    }, { fixLoopPolicy: spy.policy })
  })

  test('does not consult the policy when the result asks for review', async () => {
    const spy = makeSpyPolicy()

    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)
      const expectedRef = `native-${h.agent.listNativeRefs().length + 1}`
      h.agent.enqueueScenario({
        steps: [{ status: 'succeeded', material: makeSucceededMaterial(expectedRef) }],
      })

      const run = expectOk(await h.core.startRun(taskId))
      h.agent.advance(expectedRef)
      expectOk(await h.core.reconcileRun(run.run_id))

      expect(spy.inputs.length).toBe(0)
      expect((await h.journal.readTask(taskId))?.state).toBe('WAITING_REVIEW')
    }, { fixLoopPolicy: spy.policy })
  })

  test('does not decide twice for the same Run', async () => {
    const spy = makeSpyPolicy()

    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)
      const runId = await runFailedAttempt(h, taskId, ['src/a.ts'])
      expect(spy.inputs.length).toBe(1)

      const again = expectOk(await h.core.reconcileRun(runId))
      expect(again.state).toBe('FAILED')
      expect(spy.inputs.length).toBe(1)

      const events = await h.journal.listEventsForTask(taskId)
      expect(events.filter(event => event.event_type === 'run.result_recorded').length).toBe(1)
    }, { fixLoopPolicy: spy.policy })
  })
})

describe('fix loop: explicit review retry path', () => {
  test('allows a human-authorized retry after a review proposal', async () => {
    await withHarness(async (h) => {
      const taskId = await createReadyTask(h)
      const firstRunId = await runFailedAttempt(h, taskId, ['src/round-0.ts'])
      expect((await h.journal.readTask(taskId))?.state).toBe('WAITING_REVIEW')

      // No implicit resume: the review gate must be crossed explicitly.
      expectFailure(await h.core.startRun(taskId), 'INVALID_TRANSITION')

      await authorizeReviewRetry(h, taskId)
      h.agent.enqueueScenario({ steps: [{ status: 'running' }] })
      const resumed = expectOk(await h.core.startRun(taskId))
      expect(resumed.state).toBe('SUBMITTED')

      const events = await taskEvents(h, taskId)
      expect(events.filter(event => event.event_type === 'task.ready').length).toBe(2)
      expect(events.filter(event => event.dedupe_key.startsWith('fix-loop-retry:')).length).toBe(1)
      expect(resumed.run_id).not.toBe(firstRunId)
    })
  })
})
