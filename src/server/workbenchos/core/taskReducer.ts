/**
 * Pure Task state machine.
 *
 * Rules (M0-03 §9.1): pure function, no IO, no clock, no id generation,
 * no throwing for expected invalid transitions.
 *
 * Authorized by task package M1-001-P2.
 */

import type {
  EventEnvelopeV01,
  JsonValue,
  TaskEnvelopeV01,
  TaskEventPayloadMap,
  TaskProjection,
  TaskState,
  TransitionResult,
} from '../contracts.js'

/** Legal inbound states, per M0-02 §8 Task state table. */
const TASK_READY_FROM: ReadonlySet<string> = new Set(['CREATED', 'BLOCKED', 'WAITING_REVIEW'])
const TASK_BLOCKED_FROM: ReadonlySet<string> = new Set(['READY', 'RUNNING', 'WAITING_REVIEW'])
const TASK_REVIEW_READY_FROM: ReadonlySet<string> = new Set(['RUNNING'])
const TASK_COMPLETED_FROM: ReadonlySet<string> = new Set(['WAITING_REVIEW'])
const TASK_FAILED_FROM: ReadonlySet<string> = new Set(['WAITING_REVIEW', 'BLOCKED'])
const TASK_CANCELLED_FROM: ReadonlySet<string> = new Set([
  'CREATED',
  'READY',
  'RUNNING',
  'WAITING_REVIEW',
  'BLOCKED',
])

export function reduceTask(
  current: TaskProjection | null,
  event: EventEnvelopeV01<JsonValue>,
): TransitionResult<TaskProjection> {
  if (current === null) {
    if (event.event_type !== 'task.created') return invalidTransition(null, event)
    const envelope = readCreatedEnvelope(event)
    if (envelope === null) return invalidTransition(null, event)
    return {
      ok: true,
      next: {
        task_id: envelope.task_id,
        state: 'CREATED',
        envelope,
        active_run_id: null,
        latest_result_id: null,
        version: 1,
        last_event_sequence: event.sequence,
        updated_at: event.recorded_at,
      },
    }
  }

  switch (event.event_type) {
    case 'task.created':
      // Re-creating an existing Task is never legal.
      return invalidTransition(current, event)
    case 'task.ready':
      return applyTransition(current, event, TASK_READY_FROM, 'READY')
    case 'task.blocked':
      return applyTransition(current, event, TASK_BLOCKED_FROM, 'BLOCKED')
    case 'task.review_ready':
      return applyTransition(current, event, TASK_REVIEW_READY_FROM, 'WAITING_REVIEW')
    case 'task.completed':
      return applyTransition(current, event, TASK_COMPLETED_FROM, 'COMPLETED')
    case 'task.failed':
      return applyTransition(current, event, TASK_FAILED_FROM, 'FAILED')
    case 'task.cancelled':
      return applyTransition(current, event, TASK_CANCELLED_FROM, 'CANCELLED')

    // Run-scoped events can never drive the Task state machine.
    case 'run.created':
    case 'run.submission_requested':
    case 'run.native_bound':
    case 'run.started':
    case 'approval.requested':
    case 'approval.resolved':
    case 'run.cancel_requested':
    case 'run.recovery_required':
    case 'recovery.reconciled':
    case 'run.result_recorded':
    case 'result.delivery_requested':
    case 'result.delivered':
      return invalidTransition(current, event)

    default:
      return invalidTransition(current, event)
  }
}

function applyTransition(
  current: TaskProjection,
  event: EventEnvelopeV01<JsonValue>,
  allowedFrom: ReadonlySet<string>,
  nextState: TaskState,
): TransitionResult<TaskProjection> {
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

function readCreatedEnvelope(event: EventEnvelopeV01<JsonValue>): TaskEnvelopeV01 | null {
  const payload = asRecord(event.payload)
  if (payload === null) return null
  const envelope = asRecord(payload.envelope)
  if (envelope === null) return null
  const taskId = envelope.task_id
  if (typeof taskId !== 'string' || taskId.length === 0) return null
  return envelope as unknown as TaskEventPayloadMap['task.created']['envelope']
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function invalidTransition(
  current: TaskProjection | null,
  event: EventEnvelopeV01<JsonValue>,
): TransitionResult<TaskProjection> {
  return {
    ok: false,
    error: {
      code: 'INVALID_TRANSITION',
      aggregate: 'task',
      current_state: current === null ? 'NONE' : current.state,
      event_type: event.event_type,
    },
  }
}
