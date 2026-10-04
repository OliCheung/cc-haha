/**
 * Pure Run state machine.
 *
 * Rules (M0-03 §9.1): pure function, no IO, no clock, no id generation,
 * no throwing for expected invalid transitions.
 *
 * Authorized by task package M1-001-P2.
 */

import type {
  EventEnvelopeV01,
  JsonValue,
  RunProjection,
  RunState,
  TransitionResult,
} from '../contracts.js'

/** Legal state sets, per M0-02 §9 Run state machine. */
const RUN_SUBMISSION_FROM: ReadonlySet<string> = new Set(['CREATED'])
const RUN_NATIVE_BOUND_FROM: ReadonlySet<string> = new Set(['SUBMITTED'])
const RUN_STARTED_FROM: ReadonlySet<string> = new Set(['SUBMITTED'])
const APPROVAL_REQUESTED_FROM: ReadonlySet<string> = new Set(['SUBMITTED', 'RUNNING'])
const APPROVAL_RESOLVED_FROM: ReadonlySet<string> = new Set(['WAITING_APPROVAL'])
const CANCEL_REQUESTED_FROM: ReadonlySet<string> = new Set([
  'CREATED',
  'SUBMITTED',
  'RUNNING',
  'WAITING_APPROVAL',
  'RECOVERY_REQUIRED',
])
const RECOVERY_REQUIRED_FROM: ReadonlySet<string> = new Set([
  'SUBMITTED',
  'RUNNING',
  'WAITING_APPROVAL',
])
const RECONCILED_FROM: ReadonlySet<string> = new Set(['RECOVERY_REQUIRED'])
const RESULT_RECORDED_FROM: ReadonlySet<string> = new Set([
  'SUBMITTED',
  'RUNNING',
  'WAITING_APPROVAL',
  'RECOVERY_REQUIRED',
])

/** States a Run may resume into when an approval is resolved. */
const RESUME_TARGET_STATES: ReadonlySet<string> = new Set(['SUBMITTED', 'RUNNING'])

/** States a Run may resume into after a successful reconciliation. */
const RECONCILE_TARGET_STATES: ReadonlySet<string> = new Set([
  'SUBMITTED',
  'RUNNING',
  'WAITING_APPROVAL',
])

const TERMINAL_RUN_STATES: ReadonlySet<string> = new Set([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
])

export function reduceRun(
  current: RunProjection | null,
  event: EventEnvelopeV01<JsonValue>,
): TransitionResult<RunProjection> {
  if (current === null) {
    if (event.event_type !== 'run.created') return invalidTransition(null, event)
    return createRun(event)
  }

  switch (event.event_type) {
    case 'run.created':
      // Re-creating an existing Run is never legal.
      return invalidTransition(current, event)
    case 'run.submission_requested':
      return applyTransition(current, event, RUN_SUBMISSION_FROM, 'SUBMITTED')
    case 'run.native_bound':
      return bindNativeRef(current, event)
    case 'run.started':
      return applyTransition(current, event, RUN_STARTED_FROM, 'RUNNING')
    case 'approval.requested':
      return applyTransition(current, event, APPROVAL_REQUESTED_FROM, 'WAITING_APPROVAL')
    case 'approval.resolved':
      return resolveApproval(current, event)
    case 'run.cancel_requested':
      return recordCancelIntent(current, event)
    case 'run.recovery_required':
      return applyTransition(current, event, RECOVERY_REQUIRED_FROM, 'RECOVERY_REQUIRED')
    case 'recovery.reconciled':
      return reconcile(current, event)
    case 'run.result_recorded':
      return recordResult(current, event)

    // Task-scoped events can never drive the Run state machine.
    case 'task.created':
    case 'task.ready':
    case 'task.blocked':
    case 'task.review_ready':
    case 'task.completed':
    case 'task.failed':
    case 'task.cancelled':
    case 'result.delivery_requested':
    case 'result.delivered':
      return invalidTransition(current, event)

    default:
      return invalidTransition(current, event)
  }
}

function createRun(event: EventEnvelopeV01<JsonValue>): TransitionResult<RunProjection> {
  const payload = asRecord(event.payload)
  if (payload === null) return invalidTransition(null, event)

  const runId = payload.run_id
  const taskId = payload.task_id
  const attempt = payload.attempt
  const submissionKey = payload.submission_key

  if (typeof runId !== 'string' || runId.length === 0) return invalidTransition(null, event)
  if (typeof taskId !== 'string' || taskId.length === 0) return invalidTransition(null, event)
  if (!Number.isInteger(attempt) || (attempt as number) < 1) return invalidTransition(null, event)
  if (typeof submissionKey !== 'string' || submissionKey.length === 0) {
    return invalidTransition(null, event)
  }

  return {
    ok: true,
    next: {
      run_id: runId,
      task_id: taskId,
      attempt: attempt as number,
      state: 'CREATED',
      submission_key: submissionKey,
      native_ref: null,
      result_id: null,
      version: 1,
      last_event_sequence: event.sequence,
      updated_at: event.recorded_at,
    },
  }
}

function bindNativeRef(
  current: RunProjection,
  event: EventEnvelopeV01<JsonValue>,
): TransitionResult<RunProjection> {
  if (!RUN_NATIVE_BOUND_FROM.has(current.state)) return invalidTransition(current, event)
  const nativeRef = readPayloadString(event, 'native_ref')
  if (nativeRef === null) return invalidTransition(current, event)
  return {
    ok: true,
    next: {
      ...current,
      native_ref: nativeRef,
      version: current.version + 1,
      last_event_sequence: event.sequence,
      updated_at: event.recorded_at,
    },
  }
}

function resolveApproval(
  current: RunProjection,
  event: EventEnvelopeV01<JsonValue>,
): TransitionResult<RunProjection> {
  if (!APPROVAL_RESOLVED_FROM.has(current.state)) return invalidTransition(current, event)
  const resumeState = readPayloadString(event, 'resume_state')
  if (resumeState === null || !RESUME_TARGET_STATES.has(resumeState)) {
    return invalidTransition(current, event)
  }
  return {
    ok: true,
    next: {
      ...current,
      state: resumeState as RunState,
      version: current.version + 1,
      last_event_sequence: event.sequence,
      updated_at: event.recorded_at,
    },
  }
}

function recordCancelIntent(
  current: RunProjection,
  event: EventEnvelopeV01<JsonValue>,
): TransitionResult<RunProjection> {
  if (!CANCEL_REQUESTED_FROM.has(current.state)) return invalidTransition(current, event)
  // Cancel is an intent, not a terminal transition: the main state stays put
  // until an authoritative Result is recorded.
  return {
    ok: true,
    next: {
      ...current,
      version: current.version + 1,
      last_event_sequence: event.sequence,
      updated_at: event.recorded_at,
    },
  }
}

function reconcile(
  current: RunProjection,
  event: EventEnvelopeV01<JsonValue>,
): TransitionResult<RunProjection> {
  if (!RECONCILED_FROM.has(current.state)) return invalidTransition(current, event)
  const resumedState = readPayloadString(event, 'resumed_state')
  if (resumedState === null || !RECONCILE_TARGET_STATES.has(resumedState)) {
    return invalidTransition(current, event)
  }
  return {
    ok: true,
    next: {
      ...current,
      state: resumedState as RunState,
      version: current.version + 1,
      last_event_sequence: event.sequence,
      updated_at: event.recorded_at,
    },
  }
}

function recordResult(
  current: RunProjection,
  event: EventEnvelopeV01<JsonValue>,
): TransitionResult<RunProjection> {
  if (!RESULT_RECORDED_FROM.has(current.state)) return invalidTransition(current, event)
  const terminalState = readPayloadString(event, 'terminal_state')
  if (terminalState === null || !TERMINAL_RUN_STATES.has(terminalState)) {
    return invalidTransition(current, event)
  }
  const resultId = readPayloadString(event, 'result_id')
  if (resultId === null) return invalidTransition(current, event)
  return {
    ok: true,
    next: {
      ...current,
      state: terminalState as RunState,
      result_id: resultId,
      version: current.version + 1,
      last_event_sequence: event.sequence,
      updated_at: event.recorded_at,
    },
  }
}

function applyTransition(
  current: RunProjection,
  event: EventEnvelopeV01<JsonValue>,
  allowedFrom: ReadonlySet<string>,
  nextState: RunState,
): TransitionResult<RunProjection> {
  if (!allowedFrom.has(current.state)) return invalidTransition(current, event)
  return {
    ok: true,
    next: {
      ...current,
      state: nextState,
      version: current.version + 1,
      last_event_sequence: event.sequence,
      updated_at: event.recorded_at,
    },
  }
}

function readPayloadString(event: EventEnvelopeV01<JsonValue>, key: string): string | null {
  const payload = asRecord(event.payload)
  if (payload === null) return null
  const value = payload[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function invalidTransition(
  current: RunProjection | null,
  event: EventEnvelopeV01<JsonValue>,
): TransitionResult<RunProjection> {
  return {
    ok: false,
    error: {
      code: 'INVALID_TRANSITION',
      aggregate: 'run',
      current_state: current === null ? 'NONE' : current.state,
      event_type: event.event_type,
    },
  }
}
