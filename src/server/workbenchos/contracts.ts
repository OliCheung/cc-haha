/**
 * WorkbenchOS V0.1 contracts.
 *
 * Dependency rule (M0-03 §5.1): this file is the root of the workbenchos dependency tree.
 * It MUST NOT contain any import statement.
 *
 * Authorized by task package M1-001-P1.
 */

export const PROTOCOL_VERSION = '0.1'
export type ProtocolVersion = typeof PROTOCOL_VERSION

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export type EvidenceRef = {
  kind: string
  ref: string
  hash?: string
}

export type ActorKind = 'core' | 'agent_adapter' | 'browser_adapter' | 'user'

export type ActorRef = {
  kind: ActorKind
  id: string
}

// ---------------------------------------------------------------------------
// States and enumerations
// ---------------------------------------------------------------------------

export type TaskState =
  | 'CREATED'
  | 'READY'
  | 'RUNNING'
  | 'WAITING_REVIEW'
  | 'BLOCKED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'

export type RunState =
  | 'CREATED'
  | 'SUBMITTED'
  | 'RUNNING'
  | 'WAITING_APPROVAL'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT'
  | 'RECOVERY_REQUIRED'

export type ApprovalType =
  | 'commit'
  | 'push'
  | 'merge'
  | 'branch_create'
  | 'worktree_create'
  | 'dependency_install'
  | 'privileged_command'
  | 'credential_access'
  | 'broad_filesystem_write'
  | 'external_browser_submit'

/**
 * Note: there is deliberately no `run.failed` / `run.cancelled` event.
 * A Run reaches a terminal state only through `run.result_recorded`.
 */
export type EventType =
  | 'task.created'
  | 'task.ready'
  | 'task.blocked'
  | 'run.created'
  | 'run.submission_requested'
  | 'run.native_bound'
  | 'run.started'
  | 'approval.requested'
  | 'approval.resolved'
  | 'run.cancel_requested'
  | 'run.recovery_required'
  | 'recovery.reconciled'
  | 'run.result_recorded'
  | 'task.review_ready'
  | 'result.delivery_requested'
  | 'result.delivered'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled'

// ---------------------------------------------------------------------------
// Task envelope
// ---------------------------------------------------------------------------

export type ValidationRequirement = {
  requirement_id: string
  description: string
  required: boolean
}

export type TaskEnvelopeV01 = {
  kind: 'workbench.task'
  protocol_version: ProtocolVersion
  task_id: string
  project_id: string
  conversation_ref: {
    browser_adapter_id: string
    conversation_id: string
  }
  source_message_ref?: string
  idempotency_key: string
  requested_execution: {
    agent_id: string
    model_id?: string
    execution_timeout_ms: number
  }
  goal: string
  context_refs: EvidenceRef[]
  allowed_scope: {
    repository_relative_paths: string[]
    action_classes: string[]
  }
  forbidden_scope: {
    repository_relative_paths: string[]
    action_classes: string[]
  }
  validation_requirements: ValidationRequirement[]
  approval_requirements: ApprovalType[]
  stop_condition: 'RESULT_READY_FOR_REVIEW'
  created_at: string
  extensions?: Record<string, JsonValue>
}

// ---------------------------------------------------------------------------
// Result envelope
// ---------------------------------------------------------------------------

export type FileChange = {
  path: string
  change: 'created' | 'modified' | 'deleted' | 'renamed'
  previous_path?: string
}

export type CommandEvidence = {
  command: string
  exit_code: number | null
  output_excerpt?: string
}

export type ValidationResult =
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'blocked'
  | 'not_run'

export type ValidationEvidence = {
  requirement_id: string
  result: ValidationResult
  command?: string
  output_excerpt?: string
}

export type GitEvidence = {
  available: boolean
  branch?: string
  head?: string
  dirty?: boolean
  commit_performed: boolean
  push_performed: boolean
  unavailable_reason?: string
}

export type NormalizedError = {
  code: string
  message: string
  retryable: boolean
  evidence_ref?: EvidenceRef
}

export type ResultEnvelopeV01 = {
  kind: 'workbench.result'
  protocol_version: ProtocolVersion
  result_id: string
  task_id: string
  run_id: string
  executor: {
    agent_id: string
    model_id?: string
  }
  outcome: {
    status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out'
    completion: 'complete' | 'partial' | 'none'
    terminal_reason?: string
  }
  summary: string
  changed_files: FileChange[]
  commands: CommandEvidence[]
  validations: ValidationEvidence[]
  git_state: GitEvidence
  artifacts: EvidenceRef[]
  native_evidence_refs: EvidenceRef[]
  risks: string[]
  unresolved_work: string[]
  errors: NormalizedError[]
  next_action: {
    kind: 'none' | 'review' | 'retry' | 'user_action'
    summary?: string
  }
  started_at?: string
  finished_at: string
  recorded_at: string
  extensions?: Record<string, JsonValue>
}

// ---------------------------------------------------------------------------
// Event envelope
// ---------------------------------------------------------------------------

export type EventEnvelopeV01<T = JsonValue> = {
  kind: 'workbench.event'
  protocol_version: ProtocolVersion
  event_id: string
  sequence: number
  task_id: string
  run_id?: string
  event_type: EventType
  producer: ActorRef
  recorded_at: string
  dedupe_key: string
  payload_hash: string
  causation_event_id?: string
  payload: T
  extensions?: Record<string, JsonValue>
}

// ---------------------------------------------------------------------------
// Projections, transitions, and event payloads
// ---------------------------------------------------------------------------

export type TerminalTaskState = 'COMPLETED' | 'FAILED' | 'CANCELLED'

export type TerminalRunState = 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT'

export type ActiveRunState = 'SUBMITTED' | 'RUNNING' | 'WAITING_APPROVAL'

export type TaskProjection = {
  task_id: string
  state: TaskState
  envelope: TaskEnvelopeV01
  active_run_id: string | null
  latest_result_id: string | null
  version: number
  last_event_sequence: number
  updated_at: string
}

export type RunProjection = {
  run_id: string
  task_id: string
  attempt: number
  state: RunState
  submission_key: string
  native_ref: string | null
  result_id: string | null
  version: number
  last_event_sequence: number
  updated_at: string
}

export type IdempotencyStatus = 'reserved' | 'completed'

export type IdempotencyRecord = {
  namespace: string
  operation_key: string
  payload_hash: string
  outcome_ref: string
  status: IdempotencyStatus
  created_at: string
  completed_at: string | null
}

export type TransitionResult<T> =
  | { ok: true; next: T }
  | {
      ok: false
      error: {
        code: 'INVALID_TRANSITION'
        aggregate: 'task' | 'run'
        current_state: string
        event_type: EventType
      }
    }

export type TaskEventPayloadMap = {
  'task.created': { envelope: TaskEnvelopeV01 }
  'task.ready': { reason: 'run_created' | 'review_retry' | 'unblocked' }
  'task.blocked': { blocker_code: string; detail: string; required_user_action?: string }
  'task.review_ready': { result_id: string }
  'task.completed': { review_actor: ActorRef }
  'task.failed': { failure_decision: string }
  'task.cancelled': { reason: string }
}

export type RunEventPayloadMap = {
  'run.created': {
    run_id: string
    task_id: string
    attempt: number
    submission_key: string
  }
  'run.submission_requested': { task_id: string; submission_key: string }
  'run.native_bound': { task_id: string; native_ref: string; receipt_hash: string }
  'run.started': { task_id: string; observation_key: string }
  'approval.requested': {
    task_id: string
    approval_id: string
    action_fingerprint: string
    resume_state: ActiveRunState
  }
  'approval.resolved': {
    task_id: string
    approval_id: string
    decision: 'approved' | 'denied'
    resume_state: ActiveRunState
  }
  'run.cancel_requested': { task_id: string; reason: string }
  'run.recovery_required': { task_id: string; checkpoint: string }
  'recovery.reconciled': {
    task_id: string
    resumed_state: ActiveRunState
    evidence_hash: string
  }
  'run.result_recorded': {
    task_id: string
    result_id: string
    terminal_state: TerminalRunState
  }
}

// ---------------------------------------------------------------------------
// Contract validation results
// ---------------------------------------------------------------------------

export type ContractErrorCode =
  | 'TASK_KIND_MISMATCH'
  | 'RESULT_KIND_MISMATCH'
  | 'EVENT_KIND_MISMATCH'
  | 'PROTOCOL_VERSION_MISMATCH'
  | 'MISSING_REQUIRED_FIELD'
  | 'INVALID_FIELD_TYPE'
  | 'GOAL_INVALID'
  | 'IDEMPOTENCY_KEY_INVALID'
  | 'TIMEOUT_INVALID'
  | 'SCOPE_PATH_ESCAPE'
  | 'UNKNOWN_TOP_LEVEL_FIELD'
  | 'EXTENSION_KEY_NOT_NAMESPACED'
  | 'TERMINAL_RULE_VIOLATION'

export type ContractError = {
  code: ContractErrorCode
  path: string
  detail: string
}

export type ContractResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ContractError }

// ---------------------------------------------------------------------------
// Runtime tables
// ---------------------------------------------------------------------------

const APPROVAL_TYPE_SET: ReadonlySet<string> = new Set([
  'commit',
  'push',
  'merge',
  'branch_create',
  'worktree_create',
  'dependency_install',
  'privileged_command',
  'credential_access',
  'broad_filesystem_write',
  'external_browser_submit',
])

const EVENT_TYPE_SET: ReadonlySet<string> = new Set([
  'task.created',
  'task.ready',
  'task.blocked',
  'run.created',
  'run.submission_requested',
  'run.native_bound',
  'run.started',
  'approval.requested',
  'approval.resolved',
  'run.cancel_requested',
  'run.recovery_required',
  'recovery.reconciled',
  'run.result_recorded',
  'task.review_ready',
  'result.delivery_requested',
  'result.delivered',
  'task.completed',
  'task.failed',
  'task.cancelled',
])

const ACTOR_KIND_SET: ReadonlySet<string> = new Set([
  'core',
  'agent_adapter',
  'browser_adapter',
  'user',
])

const RESULT_STATUS_SET: ReadonlySet<string> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
])

const COMPLETION_SET: ReadonlySet<string> = new Set([
  'complete',
  'partial',
  'none',
])

const NEXT_ACTION_KIND_SET: ReadonlySet<string> = new Set([
  'none',
  'review',
  'retry',
  'user_action',
])

const TERMINAL_TASK_STATE_SET: ReadonlySet<string> = new Set([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
])

const TERMINAL_RUN_STATE_SET: ReadonlySet<string> = new Set([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
])

const ACTIVE_RUN_STATE_SET: ReadonlySet<string> = new Set([
  'SUBMITTED',
  'RUNNING',
  'WAITING_APPROVAL',
])

const TASK_TOP_LEVEL_KEY_SET: ReadonlySet<string> = new Set([
  'kind',
  'protocol_version',
  'task_id',
  'project_id',
  'conversation_ref',
  'source_message_ref',
  'idempotency_key',
  'requested_execution',
  'goal',
  'context_refs',
  'allowed_scope',
  'forbidden_scope',
  'validation_requirements',
  'approval_requirements',
  'stop_condition',
  'created_at',
  'extensions',
])

const EXTENSION_KEY_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/i
const DRIVE_LETTER_PATTERN = /^[A-Za-z]:/

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_TASK_STATE_SET.has(state)
}

export function isTerminalRunState(state: RunState): boolean {
  return TERMINAL_RUN_STATE_SET.has(state)
}

export function isActiveRunState(state: RunState): boolean {
  return ACTIVE_RUN_STATE_SET.has(state)
}

/**
 * A repository-relative path must not escape the workspace.
 * Rules: non-empty, at most 1024 characters, no leading slash, no drive letter,
 * no backslash, and no `..` segment.
 */
export function isRepositoryRelativePath(value: string): boolean {
  return isRepositoryRelativePathValue(value)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isRepositoryRelativePathValue(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false
  if (value.length > 1024) return false
  if (value.startsWith('/')) return false
  if (DRIVE_LETTER_PATTERN.test(value)) return false
  if (value.includes('\\')) return false
  return !value.split('/').some(segment => segment === '..')
}

function contractFail(
  code: ContractErrorCode,
  path: string,
  detail: string,
): ContractResult<never> {
  return { ok: false, error: { code, path, detail } }
}

function validateExtensions(value: unknown): ContractResult<never> | null {
  if (value === undefined) return null
  if (!isPlainObject(value)) {
    return contractFail('INVALID_FIELD_TYPE', 'extensions', 'extensions must be an object')
  }
  for (const key of Object.keys(value)) {
    if (!EXTENSION_KEY_PATTERN.test(key)) {
      return contractFail(
        'EXTENSION_KEY_NOT_NAMESPACED',
        `extensions.${key}`,
        `extension key must be namespaced, for example vendor.feature: ${key}`,
      )
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Envelope validation
// ---------------------------------------------------------------------------

export function validateTaskEnvelope(input: unknown): ContractResult<TaskEnvelopeV01> {
  if (!isPlainObject(input)) {
    return contractFail('INVALID_FIELD_TYPE', '', 'task envelope must be an object')
  }

  if (input.kind !== 'workbench.task') {
    return contractFail('TASK_KIND_MISMATCH', 'kind', "kind must be 'workbench.task'")
  }

  if (input.protocol_version !== PROTOCOL_VERSION) {
    return contractFail(
      'PROTOCOL_VERSION_MISMATCH',
      'protocol_version',
      `protocol_version must be '${PROTOCOL_VERSION}'`,
    )
  }

  for (const key of Object.keys(input)) {
    if (!TASK_TOP_LEVEL_KEY_SET.has(key)) {
      return contractFail('UNKNOWN_TOP_LEVEL_FIELD', key, `unknown top-level field: ${key}`)
    }
  }

  for (const key of ['task_id', 'project_id', 'created_at'] as const) {
    if (!isNonEmptyString(input[key])) {
      return contractFail('MISSING_REQUIRED_FIELD', key, `${key} must be a non-empty string`)
    }
  }

  if (input.stop_condition !== 'RESULT_READY_FOR_REVIEW') {
    return contractFail(
      'MISSING_REQUIRED_FIELD',
      'stop_condition',
      "stop_condition must be 'RESULT_READY_FOR_REVIEW'",
    )
  }

  if (!isNonEmptyString(input.goal) || input.goal.length > 8192) {
    return contractFail(
      'GOAL_INVALID',
      'goal',
      'goal must be a non-empty string of at most 8192 characters',
    )
  }

  if (!isNonEmptyString(input.idempotency_key) || input.idempotency_key.length > 256) {
    return contractFail(
      'IDEMPOTENCY_KEY_INVALID',
      'idempotency_key',
      'idempotency_key must be a non-empty string of at most 256 characters',
    )
  }

  const requestedExecution = input.requested_execution
  if (!isPlainObject(requestedExecution)) {
    return contractFail(
      'MISSING_REQUIRED_FIELD',
      'requested_execution',
      'requested_execution must be an object',
    )
  }
  if (!isNonEmptyString(requestedExecution.agent_id)) {
    return contractFail(
      'MISSING_REQUIRED_FIELD',
      'requested_execution.agent_id',
      'agent_id must be a non-empty string',
    )
  }
  const timeoutMs = requestedExecution.execution_timeout_ms
  if (
    !Number.isInteger(timeoutMs) ||
    (timeoutMs as number) <= 0 ||
    (timeoutMs as number) > 3_600_000
  ) {
    return contractFail(
      'TIMEOUT_INVALID',
      'requested_execution.execution_timeout_ms',
      'execution_timeout_ms must be an integer between 1 and 3600000',
    )
  }

  const conversationRef = input.conversation_ref
  if (!isPlainObject(conversationRef)) {
    return contractFail(
      'MISSING_REQUIRED_FIELD',
      'conversation_ref',
      'conversation_ref must be an object',
    )
  }
  if (!isNonEmptyString(conversationRef.browser_adapter_id)) {
    return contractFail(
      'MISSING_REQUIRED_FIELD',
      'conversation_ref.browser_adapter_id',
      'browser_adapter_id must be a non-empty string',
    )
  }
  if (!isNonEmptyString(conversationRef.conversation_id)) {
    return contractFail(
      'MISSING_REQUIRED_FIELD',
      'conversation_ref.conversation_id',
      'conversation_id must be a non-empty string',
    )
  }

  for (const scopeKey of ['allowed_scope', 'forbidden_scope'] as const) {
    const scope = input[scopeKey]
    if (!isPlainObject(scope)) {
      return contractFail('MISSING_REQUIRED_FIELD', scopeKey, `${scopeKey} must be an object`)
    }
    const paths = scope.repository_relative_paths
    if (!Array.isArray(paths)) {
      return contractFail(
        'INVALID_FIELD_TYPE',
        `${scopeKey}.repository_relative_paths`,
        'repository_relative_paths must be an array',
      )
    }
    for (let index = 0; index < paths.length; index += 1) {
      if (!isRepositoryRelativePathValue(paths[index])) {
        return contractFail(
          'SCOPE_PATH_ESCAPE',
          `${scopeKey}.repository_relative_paths[${index}]`,
          `path must be repository-relative and must not escape: ${String(paths[index])}`,
        )
      }
    }
    if (!Array.isArray(scope.action_classes)) {
      return contractFail(
        'INVALID_FIELD_TYPE',
        `${scopeKey}.action_classes`,
        'action_classes must be an array',
      )
    }
  }

  if (!Array.isArray(input.context_refs)) {
    return contractFail('MISSING_REQUIRED_FIELD', 'context_refs', 'context_refs must be an array')
  }

  const requirements = input.validation_requirements
  if (!Array.isArray(requirements)) {
    return contractFail(
      'MISSING_REQUIRED_FIELD',
      'validation_requirements',
      'validation_requirements must be an array',
    )
  }
  for (let index = 0; index < requirements.length; index += 1) {
    const requirement = requirements[index]
    if (!isPlainObject(requirement)) {
      return contractFail(
        'INVALID_FIELD_TYPE',
        `validation_requirements[${index}]`,
        'validation requirement must be an object',
      )
    }
    if (!isNonEmptyString(requirement.requirement_id)) {
      return contractFail(
        'MISSING_REQUIRED_FIELD',
        `validation_requirements[${index}].requirement_id`,
        'requirement_id must be a non-empty string',
      )
    }
    if (!isNonEmptyString(requirement.description)) {
      return contractFail(
        'MISSING_REQUIRED_FIELD',
        `validation_requirements[${index}].description`,
        'description must be a non-empty string',
      )
    }
    if (typeof requirement.required !== 'boolean') {
      return contractFail(
        'MISSING_REQUIRED_FIELD',
        `validation_requirements[${index}].required`,
        'required must be a boolean',
      )
    }
  }

  const approvalRequirements = input.approval_requirements
  if (approvalRequirements !== undefined) {
    if (!Array.isArray(approvalRequirements)) {
      return contractFail(
        'INVALID_FIELD_TYPE',
        'approval_requirements',
        'approval_requirements must be an array',
      )
    }
    for (let index = 0; index < approvalRequirements.length; index += 1) {
      if (!APPROVAL_TYPE_SET.has(approvalRequirements[index] as string)) {
        return contractFail(
          'INVALID_FIELD_TYPE',
          `approval_requirements[${index}]`,
          `unknown approval type: ${String(approvalRequirements[index])}`,
        )
      }
    }
  }

  const extensionError = validateExtensions(input.extensions)
  if (extensionError) return extensionError

  return { ok: true, value: input as unknown as TaskEnvelopeV01 }
}

export function validateResultEnvelope(input: unknown): ContractResult<ResultEnvelopeV01> {
  if (!isPlainObject(input)) {
    return contractFail('INVALID_FIELD_TYPE', '', 'result envelope must be an object')
  }

  if (input.kind !== 'workbench.result') {
    return contractFail('RESULT_KIND_MISMATCH', 'kind', "kind must be 'workbench.result'")
  }

  if (input.protocol_version !== PROTOCOL_VERSION) {
    return contractFail(
      'PROTOCOL_VERSION_MISMATCH',
      'protocol_version',
      `protocol_version must be '${PROTOCOL_VERSION}'`,
    )
  }

  for (const key of [
    'result_id',
    'task_id',
    'run_id',
    'summary',
    'finished_at',
    'recorded_at',
  ] as const) {
    if (!isNonEmptyString(input[key])) {
      return contractFail('MISSING_REQUIRED_FIELD', key, `${key} must be a non-empty string`)
    }
  }

  const outcome = input.outcome
  if (!isPlainObject(outcome)) {
    return contractFail('MISSING_REQUIRED_FIELD', 'outcome', 'outcome must be an object')
  }
  if (!RESULT_STATUS_SET.has(outcome.status as string)) {
    return contractFail(
      'INVALID_FIELD_TYPE',
      'outcome.status',
      `unknown outcome status: ${String(outcome.status)}`,
    )
  }
  if (!COMPLETION_SET.has(outcome.completion as string)) {
    return contractFail(
      'INVALID_FIELD_TYPE',
      'outcome.completion',
      `unknown completion: ${String(outcome.completion)}`,
    )
  }

  const nextAction = input.next_action
  if (!isPlainObject(nextAction)) {
    return contractFail('MISSING_REQUIRED_FIELD', 'next_action', 'next_action must be an object')
  }
  if (!NEXT_ACTION_KIND_SET.has(nextAction.kind as string)) {
    return contractFail(
      'INVALID_FIELD_TYPE',
      'next_action.kind',
      `unknown next_action kind: ${String(nextAction.kind)}`,
    )
  }

  for (const key of [
    'changed_files',
    'commands',
    'validations',
    'artifacts',
    'native_evidence_refs',
    'risks',
    'unresolved_work',
    'errors',
  ] as const) {
    if (!Array.isArray(input[key])) {
      return contractFail('MISSING_REQUIRED_FIELD', key, `${key} must be an array`)
    }
  }

  if (!isPlainObject(input.executor)) {
    return contractFail('MISSING_REQUIRED_FIELD', 'executor', 'executor must be an object')
  }
  if (!isPlainObject(input.git_state)) {
    return contractFail('MISSING_REQUIRED_FIELD', 'git_state', 'git_state must be an object')
  }

  const terminal = validateTerminalOutcome(input as unknown as ResultEnvelopeV01)
  if (!terminal.ok) return terminal

  return { ok: true, value: input as unknown as ResultEnvelopeV01 }
}

export function validateEventEnvelope(input: unknown): ContractResult<EventEnvelopeV01> {
  if (!isPlainObject(input)) {
    return contractFail('INVALID_FIELD_TYPE', '', 'event envelope must be an object')
  }

  if (input.kind !== 'workbench.event') {
    return contractFail('EVENT_KIND_MISMATCH', 'kind', "kind must be 'workbench.event'")
  }

  if (input.protocol_version !== PROTOCOL_VERSION) {
    return contractFail(
      'PROTOCOL_VERSION_MISMATCH',
      'protocol_version',
      `protocol_version must be '${PROTOCOL_VERSION}'`,
    )
  }

  for (const key of ['event_id', 'task_id', 'recorded_at', 'dedupe_key', 'payload_hash'] as const) {
    if (!isNonEmptyString(input[key])) {
      return contractFail('MISSING_REQUIRED_FIELD', key, `${key} must be a non-empty string`)
    }
  }

  if (!Number.isInteger(input.sequence) || (input.sequence as number) < 0) {
    return contractFail('INVALID_FIELD_TYPE', 'sequence', 'sequence must be a non-negative integer')
  }

  if (!EVENT_TYPE_SET.has(input.event_type as string)) {
    return contractFail(
      'INVALID_FIELD_TYPE',
      'event_type',
      `unknown event_type: ${String(input.event_type)}`,
    )
  }

  const producer = input.producer
  if (!isPlainObject(producer)) {
    return contractFail('INVALID_FIELD_TYPE', 'producer', 'producer must be an object')
  }
  if (!ACTOR_KIND_SET.has(producer.kind as string)) {
    return contractFail(
      'INVALID_FIELD_TYPE',
      'producer.kind',
      `unknown actor kind: ${String(producer.kind)}`,
    )
  }
  if (!isNonEmptyString(producer.id)) {
    return contractFail('INVALID_FIELD_TYPE', 'producer.id', 'producer.id must be a non-empty string')
  }

  const extensionError = validateExtensions(input.extensions)
  if (extensionError) return extensionError

  return { ok: true, value: input as unknown as EventEnvelopeV01 }
}

/**
 * Terminal outcome rules. A Result must not claim a terminal status it cannot
 * justify with its own evidence.
 */
export function validateTerminalOutcome(
  result: ResultEnvelopeV01,
): ContractResult<ResultEnvelopeV01> {
  const status = result.outcome.status
  const completion = result.outcome.completion
  const errors = Array.isArray(result.errors) ? result.errors : []
  const validations = Array.isArray(result.validations) ? result.validations : []
  const unresolvedWork = Array.isArray(result.unresolved_work) ? result.unresolved_work : []

  if (status === 'succeeded') {
    if (completion !== 'complete') {
      return contractFail(
        'TERMINAL_RULE_VIOLATION',
        'outcome.completion',
        "succeeded requires completion 'complete'",
      )
    }
    if (errors.length > 0) {
      return contractFail(
        'TERMINAL_RULE_VIOLATION',
        'errors',
        'succeeded requires an empty errors array',
      )
    }
    for (const validation of validations) {
      const validationResult = (validation as ValidationEvidence | undefined)?.result
      if (validationResult !== 'passed') {
        return contractFail(
          'TERMINAL_RULE_VIOLATION',
          'validations',
          `succeeded requires every validation to be passed, found '${String(validationResult)}'`,
        )
      }
    }
  }

  if (status === 'failed' && errors.length === 0) {
    return contractFail(
      'TERMINAL_RULE_VIOLATION',
      'errors',
      'failed requires at least one normalized error',
    )
  }

  if (status === 'cancelled' && !isNonEmptyString(result.outcome.terminal_reason)) {
    return contractFail(
      'TERMINAL_RULE_VIOLATION',
      'outcome.terminal_reason',
      'cancelled requires a terminal_reason',
    )
  }

  if (status === 'timed_out' && !isNonEmptyString(result.outcome.terminal_reason)) {
    return contractFail(
      'TERMINAL_RULE_VIOLATION',
      'outcome.terminal_reason',
      'timed_out requires a terminal_reason',
    )
  }

  if (completion === 'partial' && unresolvedWork.length === 0) {
    return contractFail(
      'TERMINAL_RULE_VIOLATION',
      'unresolved_work',
      "completion 'partial' requires a non-empty unresolved_work array",
    )
  }

  return { ok: true, value: result }
}
