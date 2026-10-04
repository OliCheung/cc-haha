import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { AgentPortError } from '../ports/agentPort.js'
import type { JsonValue } from '../contracts.js'
import { SqliteJournal } from '../persistence/sqliteJournal.js'
import {
  WorkbenchCore,
  type Clock,
  type CoreResult,
  type CreateTaskInput,
} from './workbenchCore.js'
import { runCreateKey, taskIngestKey } from './idempotency.js'

// ---------------------------------------------------------------------------
// Test-local scripted AgentPort (see task package M1-001-P4 §F11 / §R4)
// ---------------------------------------------------------------------------

type ScriptedStatus =
  | 'accepted'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'unknown'

type ScriptedStep = { status: ScriptedStatus; material?: AgentResultMaterial }

type ScriptedScenario = {
  steps: ScriptedStep[]
  submit_behavior?: 'accept' | 'timeout' | 'unavailable' | 'effect_then_lost_ack'
}

type Binding = {
  idempotency_key: string
  status: ScriptedStatus
  steps: ScriptedStep[]
  index: number
  material: AgentResultMaterial | null
}

const TERMINAL_SCRIPTED: ScriptedStatus[] = ['succeeded', 'failed', 'cancelled', 'timed_out']

function isTerminalScripted(status: ScriptedStatus): boolean {
  return TERMINAL_SCRIPTED.includes(status)
}

function defaultMaterial(
  nativeRunRef: string,
  status: ScriptedStatus,
  at: string,
): AgentResultMaterial {
  const outcome = status === 'succeeded'
    ? 'succeeded'
    : status === 'failed'
      ? 'failed'
      : status === 'cancelled'
        ? 'cancelled'
        : 'timed_out'
  const succeeded = outcome === 'succeeded'

  return {
    native_run_ref: nativeRunRef,
    outcome,
    completion: succeeded ? 'complete' : 'none',
    summary: `scripted result for ${nativeRunRef}`,
    changed_files: [],
    commands: [],
    validations: [],
    git_state: { available: true, commit_performed: false, push_performed: false },
    artifacts: [],
    native_evidence_refs: [],
    risks: [],
    unresolved_work: succeeded ? [] : ['scripted terminal without material'],
    errors: succeeded
      ? []
      : [{ code: 'SCRIPTED_TERMINAL', message: 'scripted terminal without material', retryable: false }],
    finished_at: at,
  }
}

class ScriptedAgentPort implements AgentPortV01 {
  readonly protocolVersion = '0.1' as const

  health = {
    protocol_version: '0.1' as string,
    available: true,
    capabilities: ['scripted'] as string[],
    detail: undefined as string | undefined,
  }

  submitCallCount = 0
  lookupCallCount = 0
  cancelCallCount = 0
  healthCallCount = 0
  submitKeys: string[] = []
  cancelKeys: string[] = []

  private readonly clock: () => string
  private readonly scenarios: ScriptedScenario[] = []
  private readonly bindings = new Map<string, Binding>()
  private readonly byKey = new Map<string, string>()
  private readonly cancelReceipts = new Map<string, CancelReceipt>()
  private readonly faults = new Map<string, Set<string>>()
  private scenarioIndex = 0
  private lookupUnavailable = false

  constructor(clock: () => string = () => '2026-01-01T00:00:00.000Z') {
    this.clock = clock
  }

  // --- scripted control surface ---

  enqueueScenario(scenario: ScriptedScenario): void {
    this.scenarios.push(scenario)
  }

  setHealth(next: Partial<typeof this.health>): void {
    this.health = { ...this.health, ...next }
  }

  setLookupUnavailable(value: boolean): void {
    this.lookupUnavailable = value
  }

  injectFault(nativeRunRef: string, fault: string): void {
    const set = this.faults.get(nativeRunRef) ?? new Set<string>()
    set.add(fault)
    this.faults.set(nativeRunRef, set)
  }

  nativeRefs(): string[] {
    return [...this.bindings.keys()]
  }

  statusOf(nativeRunRef: string): ScriptedStatus | null {
    return this.bindings.get(nativeRunRef)?.status ?? null
  }

  advance(nativeRunRef: string): ScriptedStatus {
    const binding = this.bindings.get(nativeRunRef)
    if (!binding) return 'unknown'
    if (isTerminalScripted(binding.status)) return binding.status

    const step = binding.steps[binding.index]
    if (!step) return binding.status

    binding.index += 1
    binding.status = step.status
    if (step.material) binding.material = step.material
    return binding.status
  }

  // --- AgentPortV01 ---

  async submitTask(
    _input: AgentSubmissionV01,
    idempotencyKey: string,
    _timeoutMs: number,
  ): Promise<SubmissionReceipt> {
    this.submitCallCount += 1
    this.submitKeys.push(idempotencyKey)

    const existing = this.byKey.get(idempotencyKey)
    if (existing !== undefined) return this.receiptFor(existing, idempotencyKey)

    // Each submit ATTEMPT consumes exactly one scenario, which is what lets a
    // scenario express "the first attempt times out, the retry then succeeds".
    const scenario = this.scenarios[this.scenarioIndex] ?? { steps: [] }
    this.scenarioIndex += 1
    const behavior = scenario.submit_behavior ?? 'accept'

    if (behavior === 'timeout') {
      throw new AgentPortError({
        code: 'TIMEOUT',
        message: 'scripted submit timed out',
        retryable: true,
      })
    }
    if (behavior === 'unavailable') {
      throw new AgentPortError({
        code: 'UNAVAILABLE',
        message: 'scripted submit unavailable',
        retryable: true,
      })
    }

    const nativeRunRef = `native-${this.bindings.size + 1}`
    this.bindings.set(nativeRunRef, {
      idempotency_key: idempotencyKey,
      status: 'accepted',
      steps: scenario.steps,
      index: 0,
      material: null,
    })
    this.byKey.set(idempotencyKey, nativeRunRef)

    if (behavior === 'effect_then_lost_ack') {
      throw new AgentPortError({
        code: 'TIMEOUT',
        message: 'scripted acknowledgement lost after the effect',
        retryable: true,
      })
    }

    return this.receiptFor(nativeRunRef, idempotencyKey)
  }

  async lookupSubmission(
    idempotencyKey: string,
    _timeoutMs: number,
  ): Promise<SubmissionReceipt | null> {
    this.lookupCallCount += 1
    if (this.lookupUnavailable) {
      throw new AgentPortError({
        code: 'UNAVAILABLE',
        message: 'scripted lookup unavailable',
        retryable: true,
      })
    }
    const nativeRunRef = this.byKey.get(idempotencyKey)
    if (nativeRunRef === undefined) return null
    return this.receiptFor(nativeRunRef, idempotencyKey)
  }

  async getStatus(nativeRunRef: string, _timeoutMs: number): Promise<AgentStatusSnapshot> {
    const binding = this.bindings.get(nativeRunRef)
    if (!binding) {
      throw new AgentPortError({
        code: 'NOT_FOUND',
        message: `unknown native ref ${nativeRunRef}`,
        retryable: false,
      })
    }
    if (this.faults.get(nativeRunRef)?.has('status_unknown')) {
      return { status: 'unknown', observed_at: this.clock() }
    }
    return { status: binding.status, observed_at: this.clock() }
  }

  async collectResult(nativeRunRef: string, _timeoutMs: number): Promise<CollectResultOutcome> {
    const binding = this.bindings.get(nativeRunRef)
    if (!binding) {
      throw new AgentPortError({
        code: 'NOT_FOUND',
        message: `unknown native ref ${nativeRunRef}`,
        retryable: false,
      })
    }
    if (!isTerminalScripted(binding.status)) return { status: 'not_ready' }
    if (this.faults.get(nativeRunRef)?.has('result_conflicts')) {
      throw new AgentPortError({
        code: 'INTERNAL',
        message: 'scripted conflicting result',
        retryable: false,
      })
    }
    return {
      status: 'ready',
      material: binding.material ?? defaultMaterial(nativeRunRef, binding.status, this.clock()),
    }
  }

  async cancel(
    nativeRunRef: string,
    idempotencyKey: string,
    _reason: string,
    _timeoutMs: number,
  ): Promise<CancelReceipt> {
    const binding = this.bindings.get(nativeRunRef)
    if (!binding) {
      throw new AgentPortError({
        code: 'NOT_FOUND',
        message: `unknown native ref ${nativeRunRef}`,
        retryable: false,
      })
    }

    const existing = this.cancelReceipts.get(idempotencyKey)
    if (existing) return existing

    this.cancelCallCount += 1
    this.cancelKeys.push(idempotencyKey)

    if (this.faults.get(nativeRunRef)?.has('cancel_ignored')) {
      return { native_run_ref: nativeRunRef, accepted: false, cancelled_at: this.clock() }
    }

    const receipt: CancelReceipt = {
      native_run_ref: nativeRunRef,
      accepted: true,
      cancelled_at: this.clock(),
    }
    this.cancelReceipts.set(idempotencyKey, receipt)
    return receipt
  }

  async healthCheck(_timeoutMs: number): Promise<AgentHealth> {
    this.healthCallCount += 1
    return this.health as unknown as AgentHealth
  }

  private receiptFor(nativeRunRef: string, idempotencyKey: string): SubmissionReceipt {
    return { native_run_ref: nativeRunRef, idempotency_key: idempotencyKey, accepted_at: this.clock() }
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Harness = {
  journal: SqliteJournal
  agent: ScriptedAgentPort
  core: WorkbenchCore
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
  const dir = mkdtempSync(join(tmpdir(), 'workbenchos-core-'))
  const journal = new SqliteJournal({ databasePath: join(dir, 'workbench.sqlite3') })
  await journal.open()

  const agent = new ScriptedAgentPort()
  const core = new WorkbenchCore({
    journal,
    agentPort: agent,
    clock: makeClock(),
    ids: makeIds(),
    project_id: 'project-1',
    port_timeout_ms: 1000,
  })

  try {
    await run({ journal, agent, core })
  } finally {
    await journal.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function makeTaskInput(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    conversation_ref: { browser_adapter_id: 'chatgpt-web', conversation_id: 'conversation-1' },
    idempotency_key: 'idem-1',
    goal: 'implement the isolated workbench core',
    requested_execution: { agent_id: 'codebuddy', execution_timeout_ms: 600000 },
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

async function createReadyTask(h: Harness, overrides: Partial<CreateTaskInput> = {}): Promise<string> {
  const created = expectOk(await h.core.createTask(makeTaskInput(overrides)))
  expectOk(await h.core.markTaskReady(created.task_id))
  return created.task_id
}

function succeededMaterial(nativeRunRef: string, completion: 'complete' | 'partial') {
  return {
    native_run_ref: nativeRunRef,
    outcome: 'succeeded' as const,
    completion,
    summary: 'scripted success',
    changed_files: [],
    commands: [],
    validations: [],
    git_state: { available: true, commit_performed: false, push_performed: false },
    artifacts: [],
    native_evidence_refs: [],
    risks: [],
    unresolved_work: [] as string[],
    errors: [],
    finished_at: '2026-01-01T00:00:09.000Z',
  }
}

async function findApprovalId(h: Harness, taskId: string): Promise<string> {
  const events = await h.journal.listEventsForTask(taskId)
  for (const event of events) {
    if (event.event_type !== 'approval.requested') continue
    const payload = event.payload as unknown as Record<string, JsonValue>
    const approvalId = payload.approval_id
    if (typeof approvalId === 'string' && approvalId.length > 0) return approvalId
  }
  throw new Error('no approval.requested event found')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('workbench core task commands', () => {
  test('creates a Task in CREATED', async () => {
    await withHarness(async (h) => {
      const result = await h.core.createTask(makeTaskInput())
      expect(result.ok).toBe(true)
      if (!result.ok) return

      expect(result.value.state).toBe('CREATED')
      const task = await h.journal.readTask(result.value.task_id)
      expect(task?.state).toBe('CREATED')
    })
  })

  test('is idempotent for the same ingestion key and payload', async () => {
    await withHarness(async (h) => {
      const first = expectOk(await h.core.createTask(makeTaskInput()))
      const second = expectOk(await h.core.createTask(makeTaskInput()))

      expect(second.task_id).toBe(first.task_id)
      const events = await h.journal.listEventsForTask(first.task_id)
      expect(events.filter(event => event.event_type === 'task.created').length).toBe(1)
    })
  })

  test('does not create two Tasks for concurrent requests with the same ingestion key', async () => {
    await withHarness(async (h) => {
      const input = makeTaskInput()
      const outcomes = await Promise.all([
        h.core.createTask(input),
        h.core.createTask(input),
      ])
      const successfulTasks = outcomes.flatMap((outcome) => outcome.ok ? [outcome.value] : [])

      expect(successfulTasks.length).toBeGreaterThan(0)
      if (successfulTasks.length === 2) {
        expect(successfulTasks[1]!.task_id).toBe(successfulTasks[0]!.task_id)
      }
      const failed = outcomes.find((outcome) => !outcome.ok)
      if (failed !== undefined) expectFailure(failed, 'IDEMPOTENCY_CONFLICT')

      const operationKey = taskIngestKey({
        browser_adapter_id: input.conversation_ref.browser_adapter_id,
        conversation_id: input.conversation_ref.conversation_id,
        idempotency_key: input.idempotency_key,
      })
      const record = await h.journal.readIdempotency('task-ingest', operationKey)
      expect(record?.outcome_ref).toBe(successfulTasks[0]!.task_id)
      expect((await h.journal.checkIntegrity()).event_count).toBe(1)
    })
  })

  test('rejects a conflicting payload for the same ingestion key', async () => {
    await withHarness(async (h) => {
      const first = expectOk(await h.core.createTask(makeTaskInput()))
      expectFailure(
        await h.core.createTask(makeTaskInput({ goal: 'a deliberately different goal' })),
        'IDEMPOTENCY_CONFLICT',
      )

      const events = await h.journal.listEventsForTask(first.task_id)
      expect(events.filter(event => event.event_type === 'task.created').length).toBe(1)
    })
  })

  test('rejects an invalid envelope without persisting anything', async () => {
    await withHarness(async (h) => {
      const result = await h.core.createTask(makeTaskInput({
        requested_execution: { agent_id: 'codebuddy', execution_timeout_ms: 0 },
      }))
      expectFailure(result, 'INVALID_REQUEST')

      const report = await h.journal.checkIntegrity()
      expect(report.event_count).toBe(0)
    })
  })

  test('moves CREATED to READY', async () => {
    await withHarness(async (h) => {
      const created = expectOk(await h.core.createTask(makeTaskInput()))
      const ready = expectOk(await h.core.markTaskReady(created.task_id))
      expect(ready.state).toBe('READY')
    })
  })

  test('rejects markTaskReady on a RUNNING task', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({ steps: [] })
      const taskId = await createReadyTask(h)
      expectOk(await h.core.startRun(taskId))

      expectFailure(await h.core.markTaskReady(taskId), 'INVALID_TRANSITION')
      const task = await h.journal.readTask(taskId)
      expect(task?.state).toBe('RUNNING')
    })
  })

  test('rejects startRun on a task that is not READY', async () => {
    await withHarness(async (h) => {
      const created = expectOk(await h.core.createTask(makeTaskInput()))
      expectFailure(await h.core.startRun(created.task_id), 'INVALID_TRANSITION')
      expect((await h.journal.listNonTerminalRuns()).length).toBe(0)
    })
  })
})

describe('workbench core run commands', () => {
  test('creates exactly one Run and moves the Task to RUNNING', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({ steps: [] })
      const taskId = await createReadyTask(h)
      const run = expectOk(await h.core.startRun(taskId))

      const runs = await h.journal.listNonTerminalRuns()
      expect(runs.length).toBe(1)
      expect(runs[0]?.run_id).toBe(run.run_id)

      const task = await h.journal.readTask(taskId)
      expect(task?.state).toBe('RUNNING')
      expect(task?.active_run_id).toBe(run.run_id)
    })
  })

  test('persists the submission intent before calling the AgentPort', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({ steps: [] })
      const taskId = await createReadyTask(h)
      const run = expectOk(await h.core.startRun(taskId))

      expect(h.agent.submitCallCount).toBe(1)
      const persisted = await h.journal.readRun(run.run_id)
      expect(persisted?.state).toBe('SUBMITTED')
    })
  })

  test('binds the native reference from the receipt', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({ steps: [] })
      const taskId = await createReadyTask(h)
      const run = expectOk(await h.core.startRun(taskId))

      const persisted = await h.journal.readRun(run.run_id)
      expect(persisted?.native_ref).toBe('native-1')
    })
  })

  test('keeps SUBMITTED when the AgentPort times out', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({ submit_behavior: 'timeout' })
      const taskId = await createReadyTask(h)
      const run = expectOk(await h.core.startRun(taskId))

      expect(run.state).toBe('SUBMITTED')
      const persisted = await h.journal.readRun(run.run_id)
      expect(persisted?.state).toBe('SUBMITTED')
      expect(persisted?.native_ref).toBeNull()

      const record = await h.journal.readIdempotency('run-create', runCreateKey(taskId, 1))
      expect(record?.status).toBe('completed')
    })
  })

  test('keeps the persisted intent when the AgentPort fails', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({ submit_behavior: 'unavailable' })
      const taskId = await createReadyTask(h)
      const result = await h.core.startRun(taskId)
      expectFailure(result, 'AGENT_UNAVAILABLE')

      const runs = await h.journal.listNonTerminalRuns()
      expect(runs.length).toBe(1)
      expect(runs[0]?.state).toBe('SUBMITTED')
    })
  })

  test('uses a new attempt for a second Run after a terminal Result', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({ steps: [{ status: 'running' }, { status: 'succeeded' }] })
      const taskId = await createReadyTask(h)
      const first = expectOk(await h.core.startRun(taskId))

      h.agent.advance('native-1')
      h.agent.advance('native-1')
      const settled = expectOk(await h.core.reconcileRun(first.run_id))
      expect(settled.state).toBe('SUCCEEDED')

      expectOk(await h.core.markTaskReady(taskId, 'review_retry'))
      const second = expectOk(await h.core.startRun(taskId))
      expect(second.run_id).not.toBe(first.run_id)

      const record = await h.journal.readIdempotency('run-create', runCreateKey(taskId, 2))
      expect(record?.outcome_ref).toBe(second.run_id)
    })
  })

  test('reconciles SUBMITTED to RUNNING on a running snapshot', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({ steps: [{ status: 'running' }] })
      const taskId = await createReadyTask(h)
      const run = expectOk(await h.core.startRun(taskId))

      h.agent.advance('native-1')
      const reconciled = expectOk(await h.core.reconcileRun(run.run_id))
      expect(reconciled.state).toBe('RUNNING')
    })
  })

  test('records the Result and moves the Task to WAITING_REVIEW', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({ steps: [{ status: 'running' }, { status: 'succeeded' }] })
      const taskId = await createReadyTask(h)
      const run = expectOk(await h.core.startRun(taskId))

      h.agent.advance('native-1')
      h.agent.advance('native-1')
      const settled = expectOk(await h.core.reconcileRun(run.run_id))
      expect(settled.state).toBe('SUCCEEDED')

      const result = await h.journal.readResultByRun(run.run_id)
      expect(result).not.toBeNull()
      expect(result?.outcome.status).toBe('succeeded')

      const task = await h.journal.readTask(taskId)
      expect(task?.state).toBe('WAITING_REVIEW')
    })
  })

  test('fails closed when the Result material violates terminal rules', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({
        steps: [
          { status: 'running' },
          { status: 'succeeded', material: succeededMaterial('native-1', 'partial') },
        ],
      })
      const taskId = await createReadyTask(h)
      const run = expectOk(await h.core.startRun(taskId))

      h.agent.advance('native-1')
      expectOk(await h.core.reconcileRun(run.run_id))
      h.agent.advance('native-1')
      expectFailure(await h.core.reconcileRun(run.run_id), 'INTEGRITY_FAILURE')

      const persisted = await h.journal.readRun(run.run_id)
      expect(persisted?.state).toBe('RUNNING')
      expect(await h.journal.readResultByRun(run.run_id)).toBeNull()
    })
  })

  test('enters RECOVERY_REQUIRED on an unknown snapshot', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({ steps: [] })
      const taskId = await createReadyTask(h)
      const run = expectOk(await h.core.startRun(taskId))

      h.agent.injectFault('native-1', 'status_unknown')
      const reconciled = expectOk(await h.core.reconcileRun(run.run_id))
      expect(reconciled.state).toBe('RECOVERY_REQUIRED')
    })
  })

  test('resubmits with the same key when lookup proves absence', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({ submit_behavior: 'timeout' })
      h.agent.enqueueScenario({ steps: [{ status: 'running' }] })
      const taskId = await createReadyTask(h)
      const run = expectOk(await h.core.startRun(taskId))
      expect(h.agent.submitCallCount).toBe(1)
      expect(h.agent.nativeRefs().length).toBe(0)

      const reconciled = expectOk(await h.core.reconcileRun(run.run_id))
      expect(h.agent.submitCallCount).toBe(2)
      expect(h.agent.submitKeys[0]).toBe(h.agent.submitKeys[1])
      expect(h.agent.nativeRefs().length).toBe(1)
      expect(reconciled.state).toBe('SUBMITTED')
    })
  })

  test('records cancel intent without terminalizing', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({ steps: [{ status: 'running' }] })
      const taskId = await createReadyTask(h)
      const run = expectOk(await h.core.startRun(taskId))

      h.agent.advance('native-1')
      expectOk(await h.core.reconcileRun(run.run_id))

      const cancelled = expectOk(await h.core.cancelRun(run.run_id, 'user request'))
      expect(h.agent.cancelCallCount).toBe(1)
      expect(cancelled.state).toBe('RUNNING')
      expect(await h.journal.readResultByRun(run.run_id)).toBeNull()
    })
  })

  test('recoverPendingRuns reports reconciled and stuck runs', async () => {
    await withHarness(async (h) => {
      h.agent.enqueueScenario({ steps: [{ status: 'running' }] })
      const taskA = await createReadyTask(h, { idempotency_key: 'idem-a' })
      const runA = expectOk(await h.core.startRun(taskA))
      h.agent.advance('native-1')
      expectOk(await h.core.reconcileRun(runA.run_id))

      h.agent.enqueueScenario({ steps: [] })
      const taskB = await createReadyTask(h, { idempotency_key: 'idem-b' })
      const runB = expectOk(await h.core.startRun(taskB))
      h.agent.injectFault('native-2', 'status_unknown')

      const before = (await h.journal.listNonTerminalRuns()).length
      const recovered = expectOk(await h.core.recoverPendingRuns())
      const after = (await h.journal.listNonTerminalRuns()).length

      expect(before).toBe(2)
      expect(after).toBe(2)
      expect(recovered.reconciled).toEqual([runA.run_id])
      expect(recovered.recovery_required).toEqual([runB.run_id])
    })
  })
})

describe('workbench core adapter negotiation', () => {
  test('refuses to create a Run when the AgentPort is unavailable', async () => {
    await withHarness(async (h) => {
      h.agent.setHealth({ available: false, detail: 'scripted adapter down' })
      const taskId = await createReadyTask(h)

      expectFailure(await h.core.startRun(taskId), 'AGENT_UNAVAILABLE')
      expect((await h.journal.listNonTerminalRuns()).length).toBe(0)
      expect(h.agent.submitCallCount).toBe(0)

      const task = await h.journal.readTask(taskId)
      expect(task?.state).toBe('READY')
    })
  })

  test('refuses to create a Run on a protocol version mismatch', async () => {
    await withHarness(async (h) => {
      h.agent.setHealth({ protocol_version: '9.9' })
      const taskId = await createReadyTask(h)

      expectFailure(await h.core.startRun(taskId), 'UNSUPPORTED_CAPABILITY')
      expect((await h.journal.listNonTerminalRuns()).length).toBe(0)
      expect(h.agent.submitCallCount).toBe(0)
    })
  })
})

describe('workbench core approvals', () => {
  async function driveToWaitingApproval(h: Harness): Promise<{ taskId: string; runId: string }> {
    h.agent.enqueueScenario({ steps: [{ status: 'running' }, { status: 'waiting_approval' }] })
    const taskId = await createReadyTask(h)
    const run = expectOk(await h.core.startRun(taskId))

    h.agent.advance('native-1')
    expectOk(await h.core.reconcileRun(run.run_id))
    h.agent.advance('native-1')
    const waiting = expectOk(await h.core.reconcileRun(run.run_id))
    expect(waiting.state).toBe('WAITING_APPROVAL')

    return { taskId, runId: run.run_id }
  }

  test('resumes the Run when an approval is approved', async () => {
    await withHarness(async (h) => {
      const { taskId, runId } = await driveToWaitingApproval(h)
      const approvalId = await findApprovalId(h, taskId)

      const resolved = expectOk(await h.core.resolveApproval({
        run_id: runId,
        approval_id: approvalId,
        decision: 'approved',
      }))
      expect(resolved.state).toBe('RUNNING')

      const task = await h.journal.readTask(taskId)
      expect(task?.state).toBe('RUNNING')
    })
  })

  test('blocks the Task when an approval is denied', async () => {
    await withHarness(async (h) => {
      const { taskId, runId } = await driveToWaitingApproval(h)
      const approvalId = await findApprovalId(h, taskId)

      const resolved = expectOk(await h.core.resolveApproval({
        run_id: runId,
        approval_id: approvalId,
        decision: 'denied',
      }))
      expect(resolved.state).toBe('RUNNING')

      const task = await h.journal.readTask(taskId)
      expect(task?.state).toBe('BLOCKED')

      const run = await h.journal.readRun(runId)
      expect(run?.state).toBe('RUNNING')
      expect(await h.journal.readResultByRun(runId)).toBeNull()
    })
  })
})
