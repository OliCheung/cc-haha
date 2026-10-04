/**
 * WorkbenchOS core application service.
 *
 * Responsibility: command orchestration, transaction boundaries, side-effect
 * ordering, recovery dispatch, and clock/id injection. Nothing else.
 *
 * Hard rules enforced here (DECISION_LOG D-010 / D-012):
 *   - every external side effect happens strictly OUTSIDE a journal transaction
 *   - submission intent is persisted BEFORE the agent port is called
 *   - a failed side effect never rolls back the persisted intent
 *   - recovery never creates a new Run and never invents a new key
 *
 * Authorized by task package M1-001-P4 (including the §15 pre-execution revisions).
 */

import {
  isTerminalRunState,
  validateResultEnvelope,
  validateTaskEnvelope,
  type ActorRef,
  type ApprovalType,
  type EventEnvelopeV01,
  type EvidenceRef,
  type JsonValue,
  type ResultEnvelopeV01,
  type RunProjection,
  type RunState,
  type TaskEnvelopeV01,
  type TaskProjection,
  type TaskState,
  type TerminalRunState,
  type ValidationRequirement,
} from '../contracts.js'
import type {
  IdempotencyRecord,
  JournalErrorCode,
  JournalPortV01,
} from '../ports/journalPort.js'
import {
  AgentPortError,
  type AgentPortV01,
  type AgentResultMaterial,
  type AgentSubmissionV01,
  type SubmissionReceipt,
} from '../ports/agentPort.js'
import {
  BrowserAutomationPortError,
  type BrowserAutomationHealth,
  type BrowserAutomationPortV01,
  type ConversationObservation,
  type ConversationRef,
  type SubmitUserMessageInput,
  type UserMessageReceipt,
} from '../ports/browserAutomationPort.js'
import { reduceRun } from './runReducer.js'
import { reduceTask } from './taskReducer.js'
import {
  agentSubmitKey,
  canonicalJson,
  hashPayload,
  resultRecordKey,
  runCreateKey,
  taskIngestKey,
} from './idempotency.js'
import {
  createDefaultFixLoopPolicy,
  type FixLoopPolicy,
  type FixLoopPolicyInput,
} from './fixLoopPolicy.js'
import { matchesExternalBrowserSubmitApproval } from './deliveryApproval.js'

// ---------------------------------------------------------------------------
// REAL-004B (D1-A): native-liveness proxy threshold
// ---------------------------------------------------------------------------

// A RUNNING run whose last credible state change exceeds this window, while the
// adapter still reports `running`, is presumed native-lost and moved to
// RECOVERY_REQUIRED. PLACEHOLDER value: calibrate against the real Codex
// duration distribution before production use (see REAL-004B task package).
const MAX_RUNNING_SILENCE_MS = 30 * 60 * 1000

// ---------------------------------------------------------------------------
// Injected dependencies and result types
// ---------------------------------------------------------------------------

export type Clock = { now(): string }
export type IdGenerator = { next(): string }

export type WorkbenchCoreOptions = {
  journal: JournalPortV01
  agentPort: AgentPortV01
  /** Optional BrowserAutomationPortV01 (M4-03A). When absent, browser commands fail with UNSUPPORTED_CAPABILITY. */
  browserAutomation?: BrowserAutomationPortV01
  clock: Clock
  ids: IdGenerator
  project_id: string
  /** Upper bound for every AgentPort call. */
  port_timeout_ms: number
  /**
   * Bounded fix-loop policy. Optional: when omitted,
   * `createDefaultFixLoopPolicy()` supplies the values frozen by DEC-01..03.
   */
  fixLoopPolicy?: FixLoopPolicy
}

export type CoreErrorCode =
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'INVALID_TRANSITION'
  | 'IDEMPOTENCY_CONFLICT'
  | 'CONCURRENCY_CONFLICT'
  | 'AGENT_UNAVAILABLE'
  | 'AGENT_TIMEOUT'
  | 'PERMISSION_REQUIRED'
  | 'UNSUPPORTED_CAPABILITY'
  | 'RECOVERY_REQUIRED'
  | 'INTEGRITY_FAILURE'
  | 'UNAVAILABLE'
  | 'INTERNAL'

export type CoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: CoreErrorCode; detail: string } }

export type CreateTaskInput = {
  conversation_ref: { browser_adapter_id: string; conversation_id: string }
  idempotency_key: string
  source_message_ref?: string
  goal: string
  requested_execution: {
    agent_id: string
    model_id?: string
    execution_timeout_ms: number
  }
  context_refs?: EvidenceRef[]
  allowed_scope?: { repository_relative_paths: string[]; action_classes: string[] }
  forbidden_scope?: { repository_relative_paths: string[]; action_classes: string[] }
  validation_requirements?: ValidationRequirement[]
  approval_requirements?: ApprovalType[]
}

export type ResolveApprovalInput = {
  run_id: string
  approval_id: string
  decision: 'approved' | 'denied'
}

/** Result of a browser-submit crash-recovery sweep. */
export type BrowserSubmitRecoveryResult = {
  /** operation keys that were recovered to 'completed' */
  recovered: string[]
  /** operation keys that failed closed and remain 'reserved' for manual review */
  failed: string[]
}

/** Durable intent persisted before the external side effect (M4-03B). */
type BrowserSubmitIntent = {
  task_id: string
  conversation_ref: ConversationRef
  content: string
  approval_ref: EvidenceRef
  /** User message refs present immediately BEFORE the external submit (M4-03B).
   *  Lets recovery exclude historical identical-content messages when re-deriving
   *  the receipt. Opaque to Core; never parsed for vendor/DOM structure.
   *  Optional ONLY so a record persisted before this field existed stays
   *  distinguishable from one whose baseline was legitimately empty; recovery
   *  fails closed when it is absent. */
  baseline_user_message_refs?: string[]
}

// ---------------------------------------------------------------------------
// Constants and pure helpers
// ---------------------------------------------------------------------------

const CORE_PRODUCER: ActorRef = { kind: 'core', id: 'workbench-core' }
const DEFAULT_SCOPE = { repository_relative_paths: [], action_classes: [] }
const MAX_ATTEMPT_SCAN = 1000

/** Dedupe-key prefix for explicitly authorized fix-loop retry transitions. */
const FIX_LOOP_RETRY_PREFIX = 'fix-loop-retry:'

const TERMINAL_STATE_BY_OUTCOME: Record<AgentResultMaterial['outcome'], TerminalRunState> = {
  succeeded: 'SUCCEEDED',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
  timed_out: 'TIMED_OUT',
}

const AGENT_ERROR_MAP: Record<string, CoreErrorCode> = {
  VERSION_MISMATCH: 'UNSUPPORTED_CAPABILITY',
  INVALID_REQUEST: 'INVALID_REQUEST',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  NOT_FOUND: 'NOT_FOUND',
  UNAVAILABLE: 'AGENT_UNAVAILABLE',
  TIMEOUT: 'AGENT_TIMEOUT',
  PERMISSION_REQUIRED: 'PERMISSION_REQUIRED',
  UNSUPPORTED_CAPABILITY: 'UNSUPPORTED_CAPABILITY',
  INTERNAL: 'INTERNAL',
}

const JOURNAL_ERROR_MAP: Record<JournalErrorCode, CoreErrorCode> = {
  CONCURRENCY_CONFLICT: 'CONCURRENCY_CONFLICT',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  SCHEMA_VERSION_UNSUPPORTED: 'UNSUPPORTED_CAPABILITY',
  INTEGRITY_FAILURE: 'INTEGRITY_FAILURE',
  UNAVAILABLE: 'UNAVAILABLE',
  INTERNAL: 'INTERNAL',
}

function ok<T>(value: T): CoreResult<T> {
  return { ok: true, value }
}

function fail<T>(code: CoreErrorCode, detail: string): CoreResult<T> {
  return { ok: false, error: { code, detail } }
}

function mapAgentError(error: unknown): { code: CoreErrorCode; detail: string } {
  if (error instanceof AgentPortError) {
    return { code: AGENT_ERROR_MAP[error.code] ?? 'INTERNAL', detail: error.message }
  }
  if (error instanceof Error) return { code: 'INTERNAL', detail: `${error.name}: ${error.message}` }
  return { code: 'INTERNAL', detail: String(error) }
}

const BROWSER_ERROR_MAP: Record<string, CoreErrorCode> = {
  VERSION_MISMATCH: 'UNSUPPORTED_CAPABILITY',
  INVALID_REQUEST: 'INVALID_REQUEST',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  NOT_FOUND: 'NOT_FOUND',
  UNAVAILABLE: 'UNAVAILABLE',
  TIMEOUT: 'TIMEOUT',
  PERMISSION_REQUIRED: 'PERMISSION_REQUIRED',
  UNSUPPORTED_CAPABILITY: 'UNSUPPORTED_CAPABILITY',
  INTERNAL: 'INTERNAL',
}

function mapBrowserError(error: unknown): { code: CoreErrorCode; detail: string } {
  if (error instanceof BrowserAutomationPortError) {
    return { code: BROWSER_ERROR_MAP[error.code] ?? 'INTERNAL', detail: error.message }
  }
  if (error instanceof Error) return { code: 'INTERNAL', detail: `${error.name}: ${error.message}` }
  return { code: 'INTERNAL', detail: String(error) }
}

function journalFailure<T>(
  error: { code: JournalErrorCode; detail: string },
): CoreResult<T> {
  return fail<T>(JOURNAL_ERROR_MAP[error.code] ?? 'INTERNAL', error.detail)
}

function mapJournalError(error: unknown): { code: JournalErrorCode; detail: string } {
  if (error instanceof Error) return { code: 'INTERNAL', detail: `${error.name}: ${error.message}` }
  return { code: 'INTERNAL', detail: String(error) }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function readStringFromPayload(payload: JsonValue, key: string): string | null {
  const record = asRecord(payload)
  if (record === null) return null
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export class WorkbenchCore {
  readonly protocolVersion = '0.1' as const

  private readonly journal: JournalPortV01
  private readonly agentPort: AgentPortV01
  private readonly browserAutomation: BrowserAutomationPortV01 | null
  private readonly clock: Clock
  private readonly ids: IdGenerator
  private readonly projectId: string
  private readonly portTimeoutMs: number
  private readonly fixLoopPolicy: FixLoopPolicy

  constructor(options: WorkbenchCoreOptions) {
    if (typeof options.project_id !== 'string' || options.project_id.length === 0) {
      throw new TypeError('project_id must be a non-empty string')
    }
    if (!Number.isInteger(options.port_timeout_ms) || options.port_timeout_ms <= 0) {
      throw new TypeError('port_timeout_ms must be a positive integer')
    }

    this.journal = options.journal
    this.agentPort = options.agentPort
    this.browserAutomation = options.browserAutomation ?? null
    this.clock = options.clock
    this.ids = options.ids
    this.projectId = options.project_id
    this.portTimeoutMs = options.port_timeout_ms
    this.fixLoopPolicy = options.fixLoopPolicy ?? createDefaultFixLoopPolicy()
  }

  // -------------------------------------------------------------------------
  // Task commands
  // -------------------------------------------------------------------------

  async createTask(
    input: CreateTaskInput,
  ): Promise<CoreResult<{ task_id: string; state: TaskState }>> {
    const taskId = this.ids.next()
    const envelope: TaskEnvelopeV01 = {
      kind: 'workbench.task',
      protocol_version: '0.1',
      task_id: taskId,
      project_id: this.projectId,
      conversation_ref: {
        browser_adapter_id: input.conversation_ref.browser_adapter_id,
        conversation_id: input.conversation_ref.conversation_id,
      },
      idempotency_key: input.idempotency_key,
      requested_execution: {
        agent_id: input.requested_execution.agent_id,
        execution_timeout_ms: input.requested_execution.execution_timeout_ms,
      },
      goal: input.goal,
      context_refs: input.context_refs ?? [],
      allowed_scope: input.allowed_scope ?? { ...DEFAULT_SCOPE },
      forbidden_scope: input.forbidden_scope ?? { ...DEFAULT_SCOPE },
      validation_requirements: input.validation_requirements ?? [],
      approval_requirements: input.approval_requirements ?? [],
      stop_condition: 'RESULT_READY_FOR_REVIEW',
      created_at: this.clock.now(),
    }

    if (input.source_message_ref !== undefined) {
      envelope.source_message_ref = input.source_message_ref
    }
    if (input.requested_execution.model_id !== undefined) {
      envelope.requested_execution.model_id = input.requested_execution.model_id
    }

    const validated = validateTaskEnvelope(envelope)
    if (!validated.ok) {
      return fail('INVALID_REQUEST', `${validated.error.path}: ${validated.error.detail}`)
    }

    const operationKey = taskIngestKey({
      browser_adapter_id: envelope.conversation_ref.browser_adapter_id,
      conversation_id: envelope.conversation_ref.conversation_id,
      idempotency_key: envelope.idempotency_key,
    })
    const payloadHash = this.hashTaskInput(input)

    const existing = await this.journal.readIdempotency('task-ingest', operationKey)
    if (existing !== null) {
      if (existing.payload_hash !== payloadHash) {
        return fail(
          'IDEMPOTENCY_CONFLICT',
          `task-ingest key ${operationKey} already exists with a different payload`,
        )
      }
      const replay = await this.journal.readTask(existing.outcome_ref)
      if (replay === null) {
        return fail(
          'INTEGRITY_FAILURE',
          `task-ingest record points at missing task ${existing.outcome_ref}`,
        )
      }
      return ok({ task_id: replay.task_id, state: replay.state })
    }

    const event = this.makeEvent({
      taskId,
      eventType: 'task.created',
      dedupeKey: `task-created:${taskId}`,
      payload: { envelope: validated.value },
    })

    const reduced = reduceTask(null, event)
    if (!reduced.ok) {
      return fail('INTERNAL', 'task.created was rejected by the reducer from an empty aggregate')
    }

    const committed = await this.journal.commit({
      events: [event],
      tasks: [reduced.next],
      idempotency: {
        namespace: 'task-ingest',
        operation_key: operationKey,
        payload_hash: payloadHash,
        outcome_ref: taskId,
        status: 'completed',
        at: this.clock.now(),
      },
    })
    if (!committed.ok) return journalFailure(committed.error)

    return ok({ task_id: taskId, state: reduced.next.state })
  }

  async markTaskReady(
    taskId: string,
    reason: 'unblocked' | 'review_retry' = 'unblocked',
  ): Promise<CoreResult<{ task_id: string; state: TaskState }>> {
    const task = await this.journal.readTask(taskId)
    if (task === null) return fail('NOT_FOUND', `task ${taskId} does not exist`)

    // A review retry is an explicit human/Main decision. It is intentionally
    // distinct from an ordinary unblock so the journal records which boundary
    // authorized the next Run. No external side effect happens here.
    if (task.state === 'WAITING_REVIEW' && reason !== 'review_retry') {
      return fail(
        'INVALID_REQUEST',
        'WAITING_REVIEW requires an explicit review_retry decision before the Task can become READY',
      )
    }
    if (task.state !== 'WAITING_REVIEW' && reason === 'review_retry') {
      return fail(
        'INVALID_REQUEST',
        `review_retry is only valid from WAITING_REVIEW, found ${task.state}`,
      )
    }

    let dedupeKey = `task-ready:${taskId}:v${task.version + 1}`
    let payload: JsonValue = { reason }
    if (reason === 'review_retry') {
      const events = await this.journal.listEventsForTask(taskId)
      const grantedFixRounds = events.filter(
        event =>
          event.event_type === 'task.ready' &&
          event.dedupe_key.startsWith(FIX_LOOP_RETRY_PREFIX),
      ).length
      const round = grantedFixRounds + 1
      dedupeKey = `${FIX_LOOP_RETRY_PREFIX}${taskId}:${round}`
      payload = { reason, round }
    }

    const event = this.makeEvent({
      taskId,
      eventType: 'task.ready',
      dedupeKey,
      payload,
    })

    const reduced = reduceTask(task, event)
    if (!reduced.ok) {
      return fail('INVALID_TRANSITION', `task.ready is not legal from ${task.state}`)
    }

    const committed = await this.journal.commit({
      events: [event],
      tasks: [reduced.next],
      expected_task_version: { task_id: taskId, version: task.version },
    })
    if (!committed.ok) return journalFailure(committed.error)

    return ok({ task_id: taskId, state: reduced.next.state })
  }

  // -------------------------------------------------------------------------
  // Browser automation commands (M4-03A)
  //
  // These expose the FROZEN BrowserAutomationPortV01 to Core. Core depends only
  // on the port interface, never on the adapter's debugging-protocol, DOM,
  // element-query, or native UI specifics (C-04 / C-06). Every failure maps to
  // the existing CoreErrorCode taxonomy, so browser automation reuses the same
  // error model as the agent path.
  // -------------------------------------------------------------------------

  private requireBrowserAutomation(): CoreResult<BrowserAutomationPortV01> {
    if (this.browserAutomation === null) {
      return fail('UNSUPPORTED_CAPABILITY', 'browser automation port is not configured')
    }
    return ok(this.browserAutomation)
  }

  async checkBrowserAutomationHealth(): Promise<
    CoreResult<{ available: boolean; capabilities: string[] }>
  > {
    const port = this.requireBrowserAutomation()
    if (!port.ok) return fail(port.error.code, port.error.detail)

    let health: BrowserAutomationHealth
    try {
      health = await port.value.healthCheck(this.portTimeoutMs)
    } catch (error) {
      const mapped = mapBrowserError(error)
      return fail(mapped.code, mapped.detail)
    }
    if (health.protocol_version !== '0.1') {
      return fail(
        'UNSUPPORTED_CAPABILITY',
        `browser automation protocol version ${String(health.protocol_version)} is not supported`,
      )
    }
    return ok({ available: health.available, capabilities: health.capabilities })
  }

  async observeBrowserConversation(
    taskId: string,
    opts: { since_fingerprint?: string } = {},
  ): Promise<CoreResult<ConversationObservation>> {
    const port = this.requireBrowserAutomation()
    if (!port.ok) return fail(port.error.code, port.error.detail)

    const task = await this.journal.readTask(taskId)
    if (task === null) return fail('NOT_FOUND', `task ${taskId} does not exist`)

    const ref: ConversationRef = {
      adapter_id: task.envelope.conversation_ref.browser_adapter_id,
      conversation_id: task.envelope.conversation_ref.conversation_id,
    }

    let observation: ConversationObservation
    try {
      observation = await port.value.observeConversation(
        { conversation_ref: ref, since_fingerprint: opts.since_fingerprint },
        this.portTimeoutMs,
      )
    } catch (error) {
      const mapped = mapBrowserError(error)
      return fail(mapped.code, mapped.detail)
    }
    return ok(observation)
  }

  async submitBrowserUserMessage(input: {
    task_id: string
    content: string
    approval_ref: EvidenceRef
    idempotency_key: string
  }): Promise<CoreResult<{ receipt: UserMessageReceipt }>> {
    const port = this.requireBrowserAutomation()
    if (!port.ok) return fail(port.error.code, port.error.detail)

    const task = await this.journal.readTask(input.task_id)
    if (task === null) return fail('NOT_FOUND', `task ${input.task_id} does not exist`)

    const ref = this.deriveBrowserConversationRef(task)

    // M4-05 delivery approval gate: the approval must be an `external_browser_submit`
    // approval bound to the EXACT action (this content, this conversation). Fail
    // closed with PERMISSION_REQUIRED otherwise; never send.
    if (
      input.approval_ref === null ||
      !matchesExternalBrowserSubmitApproval({
        approval_ref: input.approval_ref,
        conversation_ref: ref,
        content: input.content,
      })
    ) {
      return fail(
        'PERMISSION_REQUIRED',
        'submitBrowserUserMessage requires an external_browser_submit approval bound to this exact action',
      )
    }

    const submitInput: SubmitUserMessageInput = {
      conversation_ref: ref,
      content: input.content,
      approval_ref: input.approval_ref,
    }

    // Replay short-circuit: a completed record means the receipt is the journal's
    // authority. Return the stored receipt without re-invoking the port (no second
    // external side effect).
    const existing = await this.journal.readIdempotency('browser-submit', input.idempotency_key)
    if (existing !== null && existing.status === 'completed') {
      const stored = this.parseBrowserReceipt(existing.outcome_ref)
      if (stored !== null) return ok({ receipt: stored })
    }

    // Capture the pre-submit baseline of user message refs so crash recovery
    // (Crash C) can exclude any message already present and thereby avoid adopting
    // a historical identical-content message as this operation's receipt (M4-03B
    // false adoption). The baseline is an opaque set of message_refs owned by the
    // adapter; Core never parses its internal format. Fail closed if the observe
    // fails — no external side effect has occurred yet.
    let baselineUserMessageRefs: string[] = []
    try {
      const baselineObs = await port.value.observeConversation(
        { conversation_ref: ref },
        this.portTimeoutMs,
      )
      baselineUserMessageRefs = baselineObs.messages
        .filter(m => m.role === 'user')
        .map(m => m.message_ref)
    } catch (error) {
      const mapped = mapBrowserError(error)
      return fail(mapped.code, mapped.detail)
    }

    const intent: BrowserSubmitIntent = {
      task_id: input.task_id,
      conversation_ref: ref,
      content: input.content,
      approval_ref: input.approval_ref,
      baseline_user_message_refs: baselineUserMessageRefs,
    }

    // Persist the intent BEFORE the external side effect (C-07/C-08). This is the
    // durable point: a crash after this commit but before submit is Crash B, and a
    // crash after submit but before the completion commit is Crash C. The journal
    // is the single authority for the operation's lifecycle.
    const intentCommit = await this.journal.commit({
      idempotency: {
        namespace: 'browser-submit',
        operation_key: input.idempotency_key,
        payload_hash: hashPayload(submitInput),
        outcome_ref: canonicalJson(intent),
        status: 'reserved',
        at: this.clock.now(),
      },
    })
    if (!intentCommit.ok) return journalFailure(intentCommit.error)

    // External side effect — strictly OUTSIDE the prior SQLite transaction.
    let receipt: UserMessageReceipt
    try {
      receipt = await port.value.submitUserMessage(submitInput, input.idempotency_key, this.portTimeoutMs)
    } catch (error) {
      // Leave the 'reserved' record in place for recovery. A failed side effect
      // never rolls back the persisted intent.
      const mapped = mapBrowserError(error)
      return fail(mapped.code, mapped.detail)
    }

    // Persist the receipt (completed). If this commit is lost in a crash, recovery
    // re-derives the outcome via observeConversation (Crash C) without resending.
    const completed = await this.journal.commit({
      idempotency: {
        namespace: 'browser-submit',
        operation_key: input.idempotency_key,
        payload_hash: hashPayload(submitInput),
        outcome_ref: canonicalJson(receipt),
        status: 'completed',
        at: this.clock.now(),
      },
    })
    if (!completed.ok) return journalFailure(completed.error)

    return ok({ receipt })
  }

  /**
   * Crash recovery sweep for browser submits (M4-03B).
   *
   * Enumerates every `'reserved'` `browser-submit` record from the journal — the
   * single authority — and resumes each exactly once. For every in-flight
   * operation we observe the conversation to decide, at recovery time, whether the
   * external send already landed:
   *   - message present & settled  -> recover the receipt, NO resend (Crash C)
   *   - conversation empty of user messages -> perform exactly one resend (Crash B)
   *   - observe fails / conversation binding changed / messages present but none
   *     match -> fail closed, never resend and never blindly claim another message.
   */
  async recoverPendingBrowserSubmits(): Promise<CoreResult<BrowserSubmitRecoveryResult>> {
    const port = this.requireBrowserAutomation()
    if (!port.ok) return fail(port.error.code, port.error.detail)

    let records: IdempotencyRecord[]
    try {
      records = await this.journal.listIdempotency('browser-submit', 'reserved')
    } catch (error) {
      return journalFailure(this.mapJournalError(error))
    }

    const recovered: string[] = []
    const failed: string[] = []

    for (const rec of records) {
      const outcome = await this.recoverOneBrowserSubmit(rec, port.value)
      if (outcome.ok) recovered.push(rec.operation_key)
      else failed.push(rec.operation_key)
    }

    recovered.sort()
    failed.sort()
    return ok({ recovered, failed })
  }

  // -------------------------------------------------------------------------
  // Run commands
  // -------------------------------------------------------------------------

  /**
   * Starts a Run for a READY task.
   *
   * `workspaceRef` is the run-scoped workspace authority (M5-PRE-007). It is
   * recorded on the durable `run.created` event, so the binding is explicit,
   * run-scoped and recoverable, and it is the only source of
   * `AgentSubmissionV01.workspace_ref`. There is deliberately no default, no
   * `process.cwd()` and no guessing: an unbound Run reaches the adapter without
   * a workspace, and the adapter fails closed instead of running somewhere
   * arbitrary.
   */
  async startRun(
    taskId: string,
    workspaceRef?: string,
  ): Promise<CoreResult<{ run_id: string; state: RunState }>> {
    const task = await this.journal.readTask(taskId)
    if (task === null) return fail('NOT_FOUND', `task ${taskId} does not exist`)
    if (task.state !== 'READY') {
      return fail('INVALID_TRANSITION', `startRun requires a READY task, found ${task.state}`)
    }
    // Validation boundary (M5-PRE-007 §7D): the reference itself is validated
    // here and nowhere else; path validity is enforced by the host at spawn.
    if (
      workspaceRef !== undefined &&
      (typeof workspaceRef !== 'string' || workspaceRef.trim().length === 0)
    ) {
      return fail('INVALID_REQUEST', 'workspace_ref must be a non-empty string')
    }

    // R1: negotiate with the adapter before creating anything at all.
    const health = await this.checkAgentHealth()
    if (!health.ok) return health

    const attempt = await this.nextAttempt(taskId)
    if (attempt === null) {
      return fail('INTERNAL', `unable to allocate a run attempt for task ${taskId}`)
    }

    const runId = this.ids.next()
    const submissionKey = agentSubmitKey(runId)

    const createdEvent = this.makeEvent({
      taskId,
      runId,
      eventType: 'run.created',
      dedupeKey: `run-created:${runId}`,
      payload: {
        run_id: runId,
        task_id: taskId,
        attempt,
        submission_key: submissionKey,
        // M5-PRE-007: the run-scoped workspace binding is part of the durable run
        // record, so recovery re-reads the decision instead of re-deciding it.
        ...(workspaceRef === undefined ? {} : { workspace_ref: workspaceRef }),
      },
    })
    const submitEvent = this.makeEvent({
      taskId,
      runId,
      eventType: 'run.submission_requested',
      dedupeKey: `run-submit:${runId}:v1`,
      payload: { task_id: taskId, submission_key: submissionKey },
    })

    // `run.created` is run-scoped, so the Task reducer deliberately ignores it
    // (taskReducer only accepts task-scoped events). M0-02 §7.1 nevertheless
    // defines its effect on the Task aggregate — READY -> RUNNING plus the active
    // Run binding — and no task-scoped event can express that transition, so the
    // cross-aggregate coupling belongs to the Core.
    const taskNext: TaskProjection = {
      ...task,
      state: 'RUNNING',
      active_run_id: runId,
      version: task.version + 1,
      updated_at: createdEvent.recorded_at,
    }

    const runCreated = reduceRun(null, createdEvent)
    if (!runCreated.ok) {
      return fail('INTERNAL', 'run.created was rejected by the reducer from an empty aggregate')
    }
    const runSubmitted = reduceRun(runCreated.next, submitEvent)
    if (!runSubmitted.ok) {
      return fail('INTERNAL', 'run.submission_requested was rejected from CREATED')
    }
    const runNext = runSubmitted.next

    const intent = await this.journal.commit({
      events: [createdEvent, submitEvent],
      tasks: [taskNext],
      runs: [runNext],
      expected_task_version: { task_id: taskId, version: task.version },
      idempotency: {
        namespace: 'run-create',
        operation_key: runCreateKey(taskId, attempt),
        payload_hash: hashPayload({ task_id: taskId, attempt }),
        outcome_ref: runId,
        status: 'completed',
        at: this.clock.now(),
      },
    })
    if (!intent.ok) return journalFailure(intent.error)

    // The side effect happens strictly outside the transaction (D-012).
    const submission = this.buildSubmission(taskNext.envelope, runId, workspaceRef)

    let receipt: SubmissionReceipt
    try {
      receipt = await this.agentPort.submitTask(submission, submissionKey, this.portTimeoutMs)
    } catch (error) {
      const mapped = mapAgentError(error)
      if (mapped.code === 'AGENT_TIMEOUT') {
        // The intent is durable; convergence is owned by recovery, never by a
        // new key and never by a new Run.
        return ok({ run_id: runId, state: runNext.state })
      }
      return fail(mapped.code, mapped.detail)
    }

    return this.bindNativeRef(runNext, receipt)
  }

  async reconcileRun(
    runId: string,
  ): Promise<CoreResult<{ run_id: string; state: RunState }>> {
    const run = await this.journal.readRun(runId)
    if (run === null) return fail('NOT_FOUND', `run ${runId} does not exist`)
    return this.reconcileRunProjection(run)
  }

  async resolveApproval(
    input: ResolveApprovalInput,
  ): Promise<CoreResult<{ run_id: string; state: RunState }>> {
    if (input.decision !== 'approved' && input.decision !== 'denied') {
      return fail('INVALID_REQUEST', `unsupported approval decision ${String(input.decision)}`)
    }

    const run = await this.journal.readRun(input.run_id)
    if (run === null) return fail('NOT_FOUND', `run ${input.run_id} does not exist`)
    if (run.state !== 'WAITING_APPROVAL') {
      return fail('INVALID_TRANSITION', `resolveApproval requires WAITING_APPROVAL, found ${run.state}`)
    }

    const task = await this.journal.readTask(run.task_id)
    if (task === null) return fail('INTEGRITY_FAILURE', `run ${run.run_id} references a missing task`)

    const resumeState = await this.findApprovalResumeState(run.task_id, input.approval_id)
    if (resumeState === null) {
      return fail('NOT_FOUND', `unknown approval ${input.approval_id} for run ${run.run_id}`)
    }

    const resolvedEvent = this.makeEvent({
      taskId: run.task_id,
      runId: run.run_id,
      eventType: 'approval.resolved',
      dedupeKey: `approval-resolved:${input.approval_id}`,
      payload: {
        task_id: run.task_id,
        approval_id: input.approval_id,
        decision: input.decision,
        resume_state: resumeState,
      },
    })

    const runReduced = reduceRun(run, resolvedEvent)
    if (!runReduced.ok) {
      return fail('INVALID_TRANSITION', `approval.resolved is not legal from ${run.state}`)
    }

    if (input.decision === 'approved') {
      const committed = await this.journal.commit({
        events: [resolvedEvent],
        runs: [runReduced.next],
        expected_run_version: { run_id: run.run_id, version: run.version },
      })
      if (!committed.ok) return journalFailure(committed.error)
      return ok({ run_id: run.run_id, state: runReduced.next.state })
    }

    // Denied. The frozen Run state machine defines no transition for a refusal,
    // so no new transition is invented: the Run resumes per the frozen table and
    // the Task is blocked, forcing an explicit BLOCKED -> READY before any new Run.
    const blockedEvent = this.makeEvent({
      taskId: run.task_id,
      runId: run.run_id,
      eventType: 'task.blocked',
      dedupeKey: `task-blocked:${run.task_id}:v${task.version + 1}`,
      payload: {
        blocker_code: 'APPROVAL_DENIED',
        detail: input.approval_id,
        required_user_action: 'review or cancel the run',
      },
    })

    const taskReduced = reduceTask(task, blockedEvent)
    if (!taskReduced.ok) {
      return fail('INVALID_TRANSITION', `task.blocked is not legal from ${task.state}`)
    }

    const committed = await this.journal.commit({
      events: [resolvedEvent, blockedEvent],
      tasks: [taskReduced.next],
      runs: [runReduced.next],
      expected_task_version: { task_id: task.task_id, version: task.version },
      expected_run_version: { run_id: run.run_id, version: run.version },
    })
    if (!committed.ok) return journalFailure(committed.error)

    return ok({ run_id: run.run_id, state: runReduced.next.state })
  }

  async cancelRun(
    runId: string,
    reason: string,
  ): Promise<CoreResult<{ run_id: string; state: RunState }>> {
    const run = await this.journal.readRun(runId)
    if (run === null) return fail('NOT_FOUND', `run ${runId} does not exist`)
    if (isTerminalRunState(run.state)) return ok({ run_id: runId, state: run.state })

    // Cancel is an intent. It never terminalizes the Run on its own; the
    // authoritative Result does that.
    const intent = await this.emitRunEvent(
      run,
      'run.cancel_requested',
      `run-cancel:${runId}:v${run.version + 1}`,
      { task_id: run.task_id, reason },
    )
    if (!intent.ok) return intent

    const nativeRef = run.native_ref
    if (nativeRef === null) return intent

    try {
      await this.agentPort.cancel(nativeRef, `cancel:${runId}`, reason, this.portTimeoutMs)
    } catch (error) {
      const mapped = mapAgentError(error)
      return fail(mapped.code, mapped.detail)
    }

    return intent
  }

  async recoverPendingRuns(): Promise<
    CoreResult<{ reconciled: string[]; recovery_required: string[] }>
  > {
    const runs = await this.journal.listNonTerminalRuns()
    const reconciled: string[] = []
    const recoveryRequired: string[] = []

    for (const run of runs) {
      const outcome = await this.reconcileRunProjection(run)
      if (!outcome.ok || outcome.value.state === 'RECOVERY_REQUIRED') {
        recoveryRequired.push(run.run_id)
        continue
      }
      reconciled.push(run.run_id)
    }

    reconciled.sort()
    recoveryRequired.sort()
    return ok({ reconciled, recovery_required: recoveryRequired })
  }

  // -------------------------------------------------------------------------
  // Recovery internals
  // -------------------------------------------------------------------------

  private async reconcileRunProjection(
    run: RunProjection,
  ): Promise<CoreResult<{ run_id: string; state: RunState }>> {
    if (isTerminalRunState(run.state)) {
      return ok({ run_id: run.run_id, state: run.state })
    }

    const nativeRef = run.native_ref
    if (nativeRef === null) return this.reconcileUnboundRun(run)

    let snapshot: Awaited<ReturnType<AgentPortV01['getStatus']>>
    try {
      snapshot = await this.agentPort.getStatus(nativeRef, this.portTimeoutMs)
    } catch (error) {
      const mapped = mapAgentError(error)
      if (mapped.code === 'AGENT_UNAVAILABLE' || mapped.code === 'AGENT_TIMEOUT') {
        return this.forceRecoveryRequired(run, `adapter status unavailable: ${mapped.detail}`)
      }
      return fail(mapped.code, mapped.detail)
    }

    const recovering = run.state === 'RECOVERY_REQUIRED'

    switch (snapshot.status) {
      case 'accepted':
        if (recovering) return this.reconcileBack(run, 'SUBMITTED', 'adapter reports accepted')
        return ok({ run_id: run.run_id, state: run.state })

      case 'running':
        if (recovering) return this.reconcileBack(run, 'RUNNING', 'adapter reports running')
        if (run.state !== 'SUBMITTED') {
          // D1-A (REAL-004B): a RUNNING run silent beyond the liveness window,
          // while the adapter still reports `running`, is presumed native-lost.
          if (run.state === 'RUNNING' && this.isRunSilentBeyondThreshold(run)) {
            return this.forceRecoveryRequired(
              run,
              `run silent beyond ${MAX_RUNNING_SILENCE_MS}ms (updated_at ${run.updated_at}); presumed native lost`,
            )
          }
          return ok({ run_id: run.run_id, state: run.state })
        }
        return this.emitRunEvent(run, 'run.started', `run-started:${run.run_id}`, {
          task_id: run.task_id,
          observation_key: 'status.running',
        })

      case 'waiting_approval':
        if (recovering) {
          return this.reconcileBack(run, 'WAITING_APPROVAL', 'adapter reports waiting_approval')
        }
        if (run.state !== 'SUBMITTED' && run.state !== 'RUNNING') {
          return ok({ run_id: run.run_id, state: run.state })
        }
        return this.emitRunEvent(
          run,
          'approval.requested',
          `approval-requested:${run.run_id}:v${run.version + 1}`,
          {
            task_id: run.task_id,
            approval_id: this.ids.next(),
            action_fingerprint: hashPayload({ run_id: run.run_id, state: run.state }),
            resume_state: run.state,
          },
        )

      case 'succeeded':
      case 'failed':
      case 'cancelled':
      case 'timed_out':
        return this.recordTerminalResult(run)

      case 'unknown':
        return this.forceRecoveryRequired(run, 'adapter reported an unknown status')

      default:
        return this.forceRecoveryRequired(
          run,
          `unhandled adapter status ${String(snapshot.status)}`,
        )
    }
  }

  /**
   * D1-A (REAL-004B): proxy for native liveness. A RUNNING run whose last
   * credible state-change time (`updated_at`) is older than
   * `MAX_RUNNING_SILENCE_MS` is treated as having lost credible liveness
   * evidence. `updated_at` is only advanced when an event is emitted, so a run
   * that simply sits in RUNNING accrues silence across reconcile passes.
   */
  private isRunSilentBeyondThreshold(run: RunProjection): boolean {
    const nowMs = new Date(this.clock.now()).getTime()
    const updatedMs = new Date(run.updated_at).getTime()
    if (!Number.isFinite(nowMs) || !Number.isFinite(updatedMs)) return false
    return nowMs - updatedMs > MAX_RUNNING_SILENCE_MS
  }

  private async reconcileUnboundRun(
    run: RunProjection,
  ): Promise<CoreResult<{ run_id: string; state: RunState }>> {
    // D3 (REAL-004A): a RECOVERY_REQUIRED run must not be auto-resubmitted by
    // recovery observation. A retry requires an explicit external decision with
    // a fresh operation identity, never a silent same-key resubmission.
    if (run.state === 'RECOVERY_REQUIRED') {
      return this.forceRecoveryRequired(
        run,
        'recovery observation must not auto-resubmit a RECOVERY_REQUIRED run (D3)',
      )
    }

    const submissionKey = run.submission_key

    let receipt: SubmissionReceipt | null
    try {
      receipt = await this.agentPort.lookupSubmission(submissionKey, this.portTimeoutMs)
    } catch (error) {
      const mapped = mapAgentError(error)
      if (mapped.code === 'AGENT_UNAVAILABLE' || mapped.code === 'AGENT_TIMEOUT') {
        return this.forceRecoveryRequired(run, `submission lookup unavailable: ${mapped.detail}`)
      }
      return fail(mapped.code, mapped.detail)
    }

    if (receipt === null) {
      // A null lookup is positive proof of absence, which is the only condition
      // under which re-submitting with the SAME key is allowed (D-010).
      const task = await this.journal.readTask(run.task_id)
      if (task === null) {
        return fail('INTEGRITY_FAILURE', `run ${run.run_id} references a missing task`)
      }
      const submission = this.buildSubmission(
        task.envelope,
        run.run_id,
        await this.readRunWorkspaceRef(run),
      )
      try {
        receipt = await this.agentPort.submitTask(submission, submissionKey, this.portTimeoutMs)
      } catch (error) {
        const mapped = mapAgentError(error)
        if (mapped.code === 'AGENT_TIMEOUT') {
          return ok({ run_id: run.run_id, state: run.state })
        }
        return fail(mapped.code, mapped.detail)
      }
    }

    return this.bindNativeRef(run, receipt)
  }

  /**
   * Collects the durable inputs the fix-loop policy needs. A single event listing
   * yields the budget start, the granted round count and the prior Run ids, so a
   * decision costs one listing plus one result read per prior Run.
   */
  private async buildFixLoopInput(
    task: TaskProjection,
    lastResult: ResultEnvelopeV01,
  ): Promise<FixLoopPolicyInput> {
    const events = await this.journal.listEventsForTask(task.task_id)

    let budgetStartedAt: string | null = null
    let grantedFixRounds = 0
    const priorRunIds: string[] = []

    for (const event of events) {
      if (event.event_type === 'run.created' && budgetStartedAt === null) {
        budgetStartedAt = event.recorded_at
      }
      if (event.event_type === 'task.ready' && event.dedupe_key.startsWith(FIX_LOOP_RETRY_PREFIX)) {
        grantedFixRounds += 1
      }
      if (event.event_type === 'run.result_recorded' && event.run_id !== undefined) {
        priorRunIds.push(event.run_id)
      }
    }

    const priorResults: ResultEnvelopeV01[] = []
    for (const runId of priorRunIds) {
      const prior = await this.journal.readResultByRun(runId)
      if (prior !== null) priorResults.push(prior)
    }

    return {
      task,
      lastResult,
      priorResults,
      recorded_result_count: priorResults.length,
      granted_fix_rounds: grantedFixRounds,
      budget_started_at: budgetStartedAt,
      now: this.clock.now(),
    }
  }

  private async recordTerminalResult(
    run: RunProjection,
  ): Promise<CoreResult<{ run_id: string; state: RunState }>> {
    const nativeRef = run.native_ref
    if (nativeRef === null) {
      return this.forceRecoveryRequired(run, 'terminal status without a native reference')
    }

    let collected: Awaited<ReturnType<AgentPortV01['collectResult']>>
    try {
      collected = await this.agentPort.collectResult(nativeRef, this.portTimeoutMs)
    } catch (error) {
      const mapped = mapAgentError(error)
      if (mapped.code === 'AGENT_UNAVAILABLE' || mapped.code === 'AGENT_TIMEOUT') {
        return this.forceRecoveryRequired(run, `result collection unavailable: ${mapped.detail}`)
      }
      return fail(mapped.code, mapped.detail)
    }

    if (collected.status !== 'ready') {
      return ok({ run_id: run.run_id, state: run.state })
    }

    const task = await this.journal.readTask(run.task_id)
    if (task === null) {
      return fail('INTEGRITY_FAILURE', `run ${run.run_id} references a missing task`)
    }

    const resultId = this.ids.next()
    const result = this.buildResultEnvelope(task, run, collected.material, resultId)

    // Fail closed: an unjustifiable terminal Result must never be persisted.
    const validated = validateResultEnvelope(result)
    if (!validated.ok) {
      return fail(
        'INTEGRITY_FAILURE',
        `result material violates terminal rules at ${validated.error.path}: ${validated.error.detail}`,
      )
    }

    const terminalState = TERMINAL_STATE_BY_OUTCOME[collected.material.outcome]
    const resultEvent = this.makeEvent({
      taskId: run.task_id,
      runId: run.run_id,
      eventType: 'run.result_recorded',
      dedupeKey: `run-result:${run.run_id}`,
      payload: { task_id: run.task_id, result_id: resultId, terminal_state: terminalState },
    })
    const reviewEvent = this.makeEvent({
      taskId: run.task_id,
      runId: run.run_id,
      eventType: 'task.review_ready',
      dedupeKey: `task-review-ready:${run.task_id}:v${task.version + 1}`,
      payload: { result_id: resultId },
    })

    const runReduced = reduceRun(run, resultEvent)
    if (!runReduced.ok) {
      return fail('INVALID_TRANSITION', `run.result_recorded is not legal from ${run.state}`)
    }
    const taskReduced = reduceTask(task, reviewEvent)
    if (!taskReduced.ok) {
      return fail('INVALID_TRANSITION', `task.review_ready is not legal from ${task.state}`)
    }

    // DEC-01..04: evaluate the bounded policy while the Task is still at
    // WAITING_REVIEW, but persist the outcome as a review proposal only. The
    // policy must not change Task lifecycle state: a retry becomes effective
    // only after an explicit markTaskReady(..., 'review_retry') command.
    const taskNext: TaskProjection = taskReduced.next
    if (result.next_action.kind === 'retry') {
      const loopInput = await this.buildFixLoopInput(taskNext, result)
      const ordinal = loopInput.granted_fix_rounds + 1
      const decision = this.fixLoopPolicy.decide(loopInput)
      result.extensions = {
        ...(result.extensions ?? {}),
        'workbenchos.fix_loop':
          decision.action === 'retry'
            ? { action: 'retry', round: ordinal }
            : {
                action: 'stop',
                blocker_code: decision.blocker_code,
                detail: decision.detail,
                round: ordinal,
              },
      }
    }

    const committed = await this.journal.commit({
      events: [resultEvent, reviewEvent],
      tasks: [taskNext],
      runs: [runReduced.next],
      results: [result],
      expected_task_version: { task_id: task.task_id, version: task.version },
      expected_run_version: { run_id: run.run_id, version: run.version },
      idempotency: {
        namespace: 'result-record',
        operation_key: resultRecordKey(run.run_id),
        payload_hash: hashPayload(result),
        outcome_ref: resultId,
        status: 'completed',
        at: this.clock.now(),
      },
    })
    if (!committed.ok) return journalFailure(committed.error)

    return ok({ run_id: run.run_id, state: runReduced.next.state })
  }

  private async reconcileBack(
    run: RunProjection,
    resumedState: 'SUBMITTED' | 'RUNNING' | 'WAITING_APPROVAL',
    detail: string,
  ): Promise<CoreResult<{ run_id: string; state: RunState }>> {
    return this.emitRunEvent(
      run,
      'recovery.reconciled',
      `recovery-reconciled:${run.run_id}:v${run.version + 1}`,
      {
        task_id: run.task_id,
        resumed_state: resumedState,
        evidence_hash: hashPayload({ detail }),
      },
    )
  }

  private async forceRecoveryRequired(
    run: RunProjection,
    detail: string,
  ): Promise<CoreResult<{ run_id: string; state: RunState }>> {
    if (run.state === 'RECOVERY_REQUIRED') {
      return ok({ run_id: run.run_id, state: run.state })
    }
    return this.emitRunEvent(
      run,
      'run.recovery_required',
      `run-recovery:${run.run_id}:v${run.version + 1}`,
      { task_id: run.task_id, checkpoint: detail },
    )
  }

  private async bindNativeRef(
    run: RunProjection,
    receipt: SubmissionReceipt,
  ): Promise<CoreResult<{ run_id: string; state: RunState }>> {
    const events: EventEnvelopeV01<JsonValue>[] = []
    let current = run

    // A recovered Run must first re-enter a bindable state; no transition is invented.
    if (current.state === 'RECOVERY_REQUIRED') {
      const reconciledEvent = this.makeEvent({
        taskId: run.task_id,
        runId: run.run_id,
        eventType: 'recovery.reconciled',
        dedupeKey: `recovery-reconciled:${run.run_id}:bind`,
        payload: {
          task_id: run.task_id,
          resumed_state: 'SUBMITTED',
          evidence_hash: hashPayload(receipt),
        },
      })
      const reduced = reduceRun(current, reconciledEvent)
      if (!reduced.ok) {
        return fail('INVALID_TRANSITION', 'recovery.reconciled was rejected from RECOVERY_REQUIRED')
      }
      current = reduced.next
      events.push(reconciledEvent)
    }

    const boundEvent = this.makeEvent({
      taskId: run.task_id,
      runId: run.run_id,
      eventType: 'run.native_bound',
      dedupeKey: `run-bound:${run.run_id}`,
      payload: {
        task_id: run.task_id,
        native_ref: receipt.native_run_ref,
        receipt_hash: hashPayload(receipt),
      },
    })
    const reduced = reduceRun(current, boundEvent)
    if (!reduced.ok) {
      return fail('INVALID_TRANSITION', `run.native_bound is not legal from ${current.state}`)
    }
    events.push(boundEvent)

    const committed = await this.journal.commit({
      events,
      runs: [reduced.next],
      expected_run_version: { run_id: run.run_id, version: run.version },
    })
    if (!committed.ok) return journalFailure(committed.error)

    return ok({ run_id: run.run_id, state: reduced.next.state })
  }

  // -------------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------------

  private async checkAgentHealth(): Promise<CoreResult<true>> {
    let health: Awaited<ReturnType<AgentPortV01['healthCheck']>>
    try {
      health = await this.agentPort.healthCheck(this.portTimeoutMs)
    } catch (error) {
      const mapped = mapAgentError(error)
      return fail(mapped.code, mapped.detail)
    }

    if (health.protocol_version !== '0.1') {
      return fail(
        'UNSUPPORTED_CAPABILITY',
        `adapter protocol version ${String(health.protocol_version)} is not supported`,
      )
    }
    if (!health.available) {
      return fail('AGENT_UNAVAILABLE', health.detail ?? 'adapter reports unavailable')
    }
    return ok(true)
  }

  /**
   * The ingestion hash deliberately excludes the generated task_id and the
   * created_at timestamp, so that a replay of the same request yields the same
   * hash. Every optional field is normalised to null because canonicalJson
   * rejects undefined (D-016).
   */
  private hashTaskInput(input: CreateTaskInput): string {
    return hashPayload({
      project_id: this.projectId,
      browser_adapter_id: input.conversation_ref.browser_adapter_id,
      conversation_id: input.conversation_ref.conversation_id,
      idempotency_key: input.idempotency_key,
      source_message_ref: input.source_message_ref ?? null,
      goal: input.goal,
      agent_id: input.requested_execution.agent_id,
      model_id: input.requested_execution.model_id ?? null,
      execution_timeout_ms: input.requested_execution.execution_timeout_ms,
      context_refs: input.context_refs ?? [],
      allowed_scope: input.allowed_scope ?? DEFAULT_SCOPE,
      forbidden_scope: input.forbidden_scope ?? DEFAULT_SCOPE,
      validation_requirements: input.validation_requirements ?? [],
      approval_requirements: input.approval_requirements ?? [],
    })
  }

  private async nextAttempt(taskId: string): Promise<number | null> {
    for (let attempt = 1; attempt <= MAX_ATTEMPT_SCAN; attempt += 1) {
      const existing = await this.journal.readIdempotency('run-create', runCreateKey(taskId, attempt))
      if (existing === null) return attempt
    }
    return null
  }

  private async findApprovalResumeState(
    taskId: string,
    approvalId: string,
  ): Promise<'SUBMITTED' | 'RUNNING' | null> {
    const events = await this.journal.listEventsForTask(taskId)
    for (const event of events) {
      if (event.event_type !== 'approval.requested') continue
      const record = asRecord(event.payload)
      if (record === null || record.approval_id !== approvalId) continue
      const resumeState = readStringFromPayload(event.payload, 'resume_state')
      if (resumeState === 'SUBMITTED' || resumeState === 'RUNNING') return resumeState
      return null
    }
    return null
  }

  private deriveBrowserConversationRef(task: TaskProjection): ConversationRef {
    return {
      adapter_id: task.envelope.conversation_ref.browser_adapter_id,
      conversation_id: task.envelope.conversation_ref.conversation_id,
    }
  }

  private parseBrowserReceipt(raw: string): UserMessageReceipt | null {
    const record = asRecord(safeJsonParse(raw))
    if (record === null) return null
    if (typeof record.message_ref !== 'string') return null
    if (typeof record.accepted_at !== 'string') return null
    if (typeof record.content_fingerprint !== 'string') return null
    return {
      message_ref: record.message_ref,
      accepted_at: record.accepted_at,
      content_fingerprint: record.content_fingerprint,
    }
  }

  private parseBrowserSubmitIntent(raw: string): BrowserSubmitIntent | null {
    const record = asRecord(safeJsonParse(raw))
    if (record === null) return null
    if (typeof record.task_id !== 'string') return null
    if (typeof record.content !== 'string') return null
    const ref = asRecord(record.conversation_ref)
    if (ref === null) return null
    if (typeof ref.adapter_id !== 'string' || typeof ref.conversation_id !== 'string') return null
    const approval = asRecord(record.approval_ref)
    if (approval === null || typeof approval.ref !== 'string') return null
    // An ABSENT baseline (a record persisted before this field existed) is NOT the
    // same as a legitimately EMPTY baseline. Keep it `undefined` so recovery can
    // fail closed instead of silently degrading to content-only matching.
    const baseline = Array.isArray(record.baseline_user_message_refs)
      ? record.baseline_user_message_refs.filter((x): x is string => typeof x === 'string')
      : undefined
    return {
      task_id: record.task_id,
      conversation_ref: { adapter_id: ref.adapter_id, conversation_id: ref.conversation_id },
      content: record.content,
      approval_ref: {
        kind: typeof approval.kind === 'string' ? approval.kind : 'approval',
        ref: approval.ref,
        // M4-05 (fix A): preserve `hash` losslessly. It is now part of the intent's
        // payload identity, so dropping it here would make recovery recompute a
        // different payload_hash and fail closed with IDEMPOTENCY_CONFLICT.
        ...(typeof approval.hash === 'string' ? { hash: approval.hash } : {}),
      },
      baseline_user_message_refs: baseline,
    }
  }

  private async recoverOneBrowserSubmit(
    rec: IdempotencyRecord,
    port: BrowserAutomationPortV01,
  ): Promise<CoreResult<true>> {
    const intent = this.parseBrowserSubmitIntent(rec.outcome_ref)
    if (intent === null) {
      return fail('INTEGRITY_FAILURE', `browser-submit ${rec.operation_key} has an unparseable intent`)
    }

    // A record persisted before the baseline existed carries no ownership boundary.
    // Without it we cannot distinguish a freshly-sent message K from a historical
    // message H with identical content, so refuse rather than guess (fail closed).
    // Checked before any observe so a hopeless record costs no external round trip.
    const baseline = intent.baseline_user_message_refs
    if (baseline === undefined) {
      return fail(
        'INTEGRITY_FAILURE',
        `browser-submit ${rec.operation_key} has no pre-submit baseline; refusing to recover or resend`,
      )
    }

    const task = await this.journal.readTask(intent.task_id)
    if (task === null) {
      return fail('NOT_FOUND', `browser-submit ${rec.operation_key} references a missing task`)
    }

    // Fail closed on a changed conversation binding: never resend to a stale ref.
    const currentRef = this.deriveBrowserConversationRef(task)
    if (
      currentRef.adapter_id !== intent.conversation_ref.adapter_id ||
      currentRef.conversation_id !== intent.conversation_ref.conversation_id
    ) {
      return fail(
        'INVALID_TRANSITION',
        `browser-submit ${rec.operation_key} conversation binding changed; refusing to recover`,
      )
    }

    // Observe to decide whether the external send already landed (Crash C) or is
    // still absent (Crash B). This is the browser analog of the agent's
    // lookupSubmission: a positive find proves the effect happened, so we must not
    // resend.
    let observation: ConversationObservation
    try {
      observation = await port.observeConversation(
        { conversation_ref: intent.conversation_ref },
        this.portTimeoutMs,
      )
    } catch (error) {
      // A missing/unavailable conversation is fail-closed: do not resend blindly.
      const mapped = mapBrowserError(error)
      return fail(mapped.code, mapped.detail)
    }

    const userMessages = observation.messages.filter(m => m.role === 'user')
    // Recovery candidates: a user message that (a) is settled, (b) matches the
    // intended content, AND (c) was NOT present before our submit. The baseline
    // exclusion is the ownership boundary — it prevents claiming a historical
    // identical-content message H instead of the freshly-sent message K (M4-03B
    // false adoption). message_ref is the only ownership proof; content match is a
    // necessary but insufficient filter, never a substitute for identity.
    const candidates = userMessages.filter(
      m => m.settled && m.content === intent.content && !baseline.includes(m.message_ref),
    )

    let receipt: UserMessageReceipt
    if (candidates.length === 1) {
      // Crash C: exactly one new matching message -> recover without resending.
      const settled = candidates[0]
      receipt = {
        message_ref: settled.message_ref,
        accepted_at: this.clock.now(),
        content_fingerprint: settled.content_fingerprint,
      }
    } else if (userMessages.length === 0) {
      // Crash B: conversation empty of user messages -> perform exactly one resend.
      try {
        receipt = await port.submitUserMessage(
          {
            conversation_ref: intent.conversation_ref,
            content: intent.content,
            approval_ref: intent.approval_ref,
          },
          rec.operation_key,
          this.portTimeoutMs,
        )
      } catch (error) {
        const mapped = mapBrowserError(error)
        return fail(mapped.code, mapped.detail)
      }
    } else {
      // 0 candidates (content mismatch / all matches are historical) or >1 candidate
      // (ambiguous landing) -> fail closed. Never resend blindly, never adopt H.
      return fail(
        'INTEGRITY_FAILURE',
        `browser-submit ${rec.operation_key} recovery ambiguous or non-matching (${candidates.length} candidates); refusing to recover or resend`,
      )
    }

    const committed = await this.journal.commit({
      idempotency: {
        namespace: 'browser-submit',
        operation_key: rec.operation_key,
        payload_hash: hashPayload({
          conversation_ref: intent.conversation_ref,
          content: intent.content,
          approval_ref: intent.approval_ref,
        }),
        outcome_ref: canonicalJson(receipt),
        status: 'completed',
        at: this.clock.now(),
      },
    })
    if (!committed.ok) return journalFailure(committed.error)

    return ok(true)
  }

  private buildSubmission(
    envelope: TaskEnvelopeV01,
    runId: string,
    workspaceRef?: string,
  ): AgentSubmissionV01 {
    const submission: AgentSubmissionV01 = {
      task_id: envelope.task_id,
      run_id: runId,
      agent_id: envelope.requested_execution.agent_id,
      goal: envelope.goal,
      context_refs: envelope.context_refs,
      allowed_scope: envelope.allowed_scope,
      forbidden_scope: envelope.forbidden_scope,
      validation_requirements: envelope.validation_requirements,
    }
    if (envelope.requested_execution.model_id !== undefined) {
      submission.model_id = envelope.requested_execution.model_id
    }
    // M5-PRE-007 §11: the run-scoped reference is what the adapter consumes. The
    // Core never invents one, so an unbound Run simply carries no workspace and
    // the adapter fails closed.
    if (workspaceRef !== undefined) submission.workspace_ref = workspaceRef
    return submission
  }

  /**
   * Re-reads the run-scoped workspace binding recorded on `run.created`
   * (M5-PRE-007 §16). Recovery must never re-decide where a Run executes, so the
   * durable event — not a fresh choice — is the only source here.
   */
  private async readRunWorkspaceRef(run: RunProjection): Promise<string | undefined> {
    const events = await this.journal.listEventsForTask(run.task_id)
    for (const event of events) {
      if (event.event_type !== 'run.created' || event.run_id !== run.run_id) continue
      const payload = event.payload
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) continue
      const value = (payload as Record<string, JsonValue>)['workspace_ref']
      if (typeof value === 'string' && value.length > 0) return value
    }
    return undefined
  }

  private buildResultEnvelope(
    task: TaskProjection,
    run: RunProjection,
    material: AgentResultMaterial,
    resultId: string,
  ): ResultEnvelopeV01 {
    const result: ResultEnvelopeV01 = {
      kind: 'workbench.result',
      protocol_version: '0.1',
      result_id: resultId,
      task_id: task.task_id,
      run_id: run.run_id,
      executor: { agent_id: task.envelope.requested_execution.agent_id },
      outcome: { status: material.outcome, completion: material.completion },
      summary: material.summary,
      changed_files: material.changed_files,
      commands: material.commands,
      validations: material.validations,
      git_state: material.git_state,
      artifacts: material.artifacts,
      native_evidence_refs: material.native_evidence_refs,
      risks: material.risks,
      unresolved_work: material.unresolved_work,
      errors: material.errors,
      next_action: { kind: material.outcome === 'succeeded' ? 'review' : 'retry' },
      finished_at: material.finished_at,
      recorded_at: this.clock.now(),
    }

    if (task.envelope.requested_execution.model_id !== undefined) {
      result.executor.model_id = task.envelope.requested_execution.model_id
    }
    if (material.started_at !== undefined) {
      result.started_at = material.started_at
    }
    if (material.outcome === 'cancelled' || material.outcome === 'timed_out') {
      result.outcome.terminal_reason = `adapter reported ${material.outcome}`
    }

    return result
  }

  private makeEvent<T extends JsonValue>(input: {
    taskId: string
    runId?: string
    eventType: EventEnvelopeV01['event_type']
    dedupeKey: string
    payload: T
  }): EventEnvelopeV01<JsonValue> {
    const event: EventEnvelopeV01<JsonValue> = {
      kind: 'workbench.event',
      protocol_version: '0.1',
      event_id: this.ids.next(),
      sequence: 0,
      task_id: input.taskId,
      event_type: input.eventType,
      producer: CORE_PRODUCER,
      recorded_at: this.clock.now(),
      dedupe_key: input.dedupeKey,
      payload_hash: hashPayload(input.payload),
      payload: input.payload,
    }
    if (input.runId !== undefined) event.run_id = input.runId
    return event
  }

  private async emitRunEvent(
    run: RunProjection,
    eventType: EventEnvelopeV01['event_type'],
    dedupeKey: string,
    payload: JsonValue,
  ): Promise<CoreResult<{ run_id: string; state: RunState }>> {
    return this.commitRunEvent(
      run,
      this.makeEvent({
        taskId: run.task_id,
        runId: run.run_id,
        eventType,
        dedupeKey,
        payload,
      }),
    )
  }

  private async commitRunEvent(
    run: RunProjection,
    event: EventEnvelopeV01<JsonValue>,
  ): Promise<CoreResult<{ run_id: string; state: RunState }>> {
    const reduced = reduceRun(run, event)
    if (!reduced.ok) {
      return fail('INVALID_TRANSITION', `${String(event.event_type)} is not legal from ${run.state}`)
    }

    const committed = await this.journal.commit({
      events: [event],
      runs: [reduced.next],
      expected_run_version: { run_id: run.run_id, version: run.version },
    })
    if (!committed.ok) return journalFailure(committed.error)

    return ok({ run_id: run.run_id, state: reduced.next.state })
  }
}
