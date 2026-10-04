/**
 * M1-001-P6 — approval integration contracts.
 *
 * Covers M0-02 §17 family 11 (approval). The Run state machine has no transition
 * for a refused approval, so a denial resumes the Run per the frozen table and
 * blocks the Task; these cases pin that behaviour down (see R2).
 *
 * Authorized by task package M1-001-P6.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JsonValue } from '../contracts.js'
import { SqliteJournal } from '../persistence/sqliteJournal.js'
import { FakeAgentPort } from '../testing/fakeAgentPort.js'
import {
  WorkbenchCore,
  type Clock,
  type CoreResult,
  type CreateTaskInput,
} from './workbenchCore.js'

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

async function withHarness(run: (h: Harness) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'workbenchos-approval-'))
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
  })

  try {
    await run({ journal, core, agent })
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
    goal: 'prove the approval contracts hold',
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

async function findApprovalId(h: Harness, taskId: string): Promise<string> {
  const events = await h.journal.listEventsForTask(taskId)
  for (const event of events) {
    if (event.event_type !== 'approval.requested') continue
    const payload = event.payload as unknown as Record<string, JsonValue>
    const approvalId = payload.approval_id
    if (typeof approvalId === 'string' && approvalId.length > 0) return approvalId
  }
  throw new Error('no approval.requested event was recorded')
}

/** Drives a Task and its first Run to WAITING_APPROVAL on a RUNNING Task. */
async function driveToWaitingApproval(
  h: Harness,
): Promise<{ taskId: string; runId: string; approvalId: string }> {
  h.agent.enqueueScenario({ steps: [{ status: 'running' }, { status: 'waiting_approval' }] })

  const created = expectOk(await h.core.createTask(makeTaskInput()))
  expectOk(await h.core.markTaskReady(created.task_id))
  const run = expectOk(await h.core.startRun(created.task_id))

  h.agent.advance('native-1')
  expectOk(await h.core.reconcileRun(run.run_id))
  h.agent.advance('native-1')

  const waiting = expectOk(await h.core.reconcileRun(run.run_id))
  expect(waiting.state).toBe('WAITING_APPROVAL')

  const approvalId = await findApprovalId(h, created.task_id)
  return { taskId: created.task_id, runId: run.run_id, approvalId }
}

// ---------------------------------------------------------------------------
// Family 11 — approval
// ---------------------------------------------------------------------------

describe('approval family 11', () => {
  test('requests an approval when the adapter reports waiting_approval', async () => {
    await withHarness(async (h) => {
      const { taskId, runId, approvalId } = await driveToWaitingApproval(h)

      const run = await h.journal.readRun(runId)
      expect(run?.state).toBe('WAITING_APPROVAL')

      const events = await h.journal.listEventsForTask(taskId)
      const requested = events.filter(event => event.event_type === 'approval.requested')
      expect(requested.length).toBe(1)

      const payload = requested[0]?.payload as unknown as Record<string, JsonValue>
      expect(payload.approval_id).toBe(approvalId)
      expect(payload.resume_state).toBe('RUNNING')
    })
  })

  test('does not terminalize a Run that waits for approval', async () => {
    await withHarness(async (h) => {
      const { runId } = await driveToWaitingApproval(h)

      expect(await h.journal.readResultByRun(runId)).toBeNull()

      const run = await h.journal.readRun(runId)
      expect(run?.state).toBe('WAITING_APPROVAL')
      expect(run?.state).not.toBe('SUCCEEDED')
      expect(run?.state).not.toBe('FAILED')
    })
  })

  test('resumes the Run when the approval is approved', async () => {
    await withHarness(async (h) => {
      const { taskId, runId, approvalId } = await driveToWaitingApproval(h)

      const resolved = expectOk(await h.core.resolveApproval({
        run_id: runId,
        approval_id: approvalId,
        decision: 'approved',
      }))

      expect(resolved.state).toBe('RUNNING')

      const run = await h.journal.readRun(runId)
      expect(run?.state).toBe('RUNNING')
      expect(await h.journal.readResultByRun(runId)).toBeNull()

      const task = await h.journal.readTask(taskId)
      expect(task?.state).toBe('RUNNING')
    })
  })

  test('blocks the Task when the approval is denied', async () => {
    await withHarness(async (h) => {
      const { taskId, runId, approvalId } = await driveToWaitingApproval(h)

      const resolved = expectOk(await h.core.resolveApproval({
        run_id: runId,
        approval_id: approvalId,
        decision: 'denied',
      }))

      // The Run follows the frozen resume table; it is not terminalized.
      expect(resolved.state).toBe('RUNNING')
      const run = await h.journal.readRun(runId)
      expect(run?.state).toBe('RUNNING')
      expect(await h.journal.readResultByRun(runId)).toBeNull()

      // The Task is blocked, so no new Run can start without explicit intent.
      const task = await h.journal.readTask(taskId)
      expect(task?.state).toBe('BLOCKED')

      expectFailure(await h.core.startRun(taskId), 'INVALID_TRANSITION')
    })
  })

  test('rejects an unknown approval id', async () => {
    await withHarness(async (h) => {
      const { taskId, runId } = await driveToWaitingApproval(h)

      expectFailure(
        await h.core.resolveApproval({
          run_id: runId,
          approval_id: 'approval-that-was-never-requested',
          decision: 'approved',
        }),
        'NOT_FOUND',
      )

      const run = await h.journal.readRun(runId)
      expect(run?.state).toBe('WAITING_APPROVAL')
      expect((await h.journal.readTask(taskId))?.state).toBe('RUNNING')
      expect(await h.journal.readResultByRun(runId)).toBeNull()
    })
  })

  test('rejects resolving an approval on a Run that is not waiting', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({ steps: [{ status: 'running' }] })

      const created = expectOk(await h.core.createTask(makeTaskInput()))
      expectOk(await h.core.markTaskReady(created.task_id))
      const run = expectOk(await h.core.startRun(created.task_id))

      h.agent.advance('native-1')
      const running = expectOk(await h.core.reconcileRun(run.run_id))
      expect(running.state).toBe('RUNNING')

      expectFailure(
        await h.core.resolveApproval({
          run_id: run.run_id,
          approval_id: 'any-approval-id',
          decision: 'approved',
        }),
        'INVALID_TRANSITION',
      )

      expect((await h.journal.readRun(run.run_id))?.state).toBe('RUNNING')
      expect((await h.journal.readTask(created.task_id))?.state).toBe('RUNNING')
    })
  })
})
