import { describe, expect, test } from 'bun:test'
import type {
  EventEnvelopeV01,
  EventType,
  JsonValue,
  RunProjection,
  RunState,
  TaskEnvelopeV01,
  TaskProjection,
  TaskState,
  TransitionResult,
} from '../contracts.js'
import { reduceRun } from './runReducer.js'
import { reduceTask } from './taskReducer.js'

const FIXED_TIME = '2026-01-01T00:00:00.000Z'

function makeTaskEnvelope(): TaskEnvelopeV01 {
  return {
    kind: 'workbench.task',
    protocol_version: '0.1',
    task_id: 'task-0001',
    project_id: 'project-0001',
    conversation_ref: {
      browser_adapter_id: 'chatgpt-web',
      conversation_id: 'conversation-0001',
    },
    idempotency_key: 'idem-0001',
    requested_execution: {
      agent_id: 'codebuddy',
      execution_timeout_ms: 600000,
    },
    goal: 'implement the isolated workbench core',
    context_refs: [],
    allowed_scope: { repository_relative_paths: [], action_classes: [] },
    forbidden_scope: { repository_relative_paths: [], action_classes: [] },
    validation_requirements: [],
    approval_requirements: [],
    stop_condition: 'RESULT_READY_FOR_REVIEW',
    created_at: FIXED_TIME,
  }
}

function makeEvent(
  type: EventType,
  payload: JsonValue,
  sequence = 1,
): EventEnvelopeV01<JsonValue> {
  return {
    kind: 'workbench.event',
    protocol_version: '0.1',
    event_id: `event-${sequence}`,
    sequence,
    task_id: 'task-0001',
    run_id: 'run-0001',
    event_type: type,
    producer: { kind: 'core', id: 'workbench-core' },
    recorded_at: FIXED_TIME,
    dedupe_key: `dedupe-${type}-${sequence}`,
    payload_hash: `hash-${sequence}`,
    payload,
  }
}

function taskProjection(state: TaskState): TaskProjection {
  return {
    task_id: 'task-0001',
    state,
    envelope: makeTaskEnvelope(),
    active_run_id: null,
    latest_result_id: null,
    version: 3,
    last_event_sequence: 7,
    updated_at: FIXED_TIME,
  }
}

function runProjection(state: RunState): RunProjection {
  return {
    run_id: 'run-0001',
    task_id: 'task-0001',
    attempt: 1,
    state,
    submission_key: 'agent-submit:run-0001:v1',
    native_ref: null,
    result_id: null,
    version: 3,
    last_event_sequence: 7,
    updated_at: FIXED_TIME,
  }
}

function expectOkTask(result: TransitionResult<TaskProjection>): TaskProjection {
  if (!result.ok) {
    throw new Error(`expected ok, got INVALID_TRANSITION for ${result.error.current_state} <- ${result.error.event_type}`)
  }
  return result.next
}

function expectOkRun(result: TransitionResult<RunProjection>): RunProjection {
  if (!result.ok) {
    throw new Error(`expected ok, got INVALID_TRANSITION for ${result.error.current_state} <- ${result.error.event_type}`)
  }
  return result.next
}

function expectInvalid(result: TransitionResult<unknown>): void {
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.error.code).toBe('INVALID_TRANSITION')
}

const NON_TERMINAL_TASK_STATES: TaskState[] = [
  'CREATED',
  'READY',
  'RUNNING',
  'WAITING_REVIEW',
  'BLOCKED',
]

const NON_TERMINAL_RUN_STATES: RunState[] = [
  'CREATED',
  'SUBMITTED',
  'RUNNING',
  'WAITING_APPROVAL',
  'RECOVERY_REQUIRED',
]

const RESULT_RECORDABLE_RUN_STATES: RunState[] = [
  'SUBMITTED',
  'RUNNING',
  'WAITING_APPROVAL',
  'RECOVERY_REQUIRED',
]

const TERMINAL_RUN_STATES: RunState[] = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']

describe('task reducer', () => {
  test('creates CREATED projection from null', () => {
    const next = expectOkTask(
      reduceTask(null, makeEvent('task.created', { envelope: makeTaskEnvelope() })),
    )
    expect(next.state).toBe('CREATED')
    expect(next.version).toBe(1)
    expect(next.task_id).toBe('task-0001')
    expect(next.last_event_sequence).toBe(1)
  })

  test('rejects task.created when a task already exists', () => {
    expectInvalid(
      reduceTask(taskProjection('CREATED'), makeEvent('task.created', { envelope: makeTaskEnvelope() })),
    )
  })

  test('moves CREATED to READY', () => {
    const next = expectOkTask(
      reduceTask(taskProjection('CREATED'), makeEvent('task.ready', { reason: 'unblocked' })),
    )
    expect(next.state).toBe('READY')
  })

  test('moves BLOCKED to READY', () => {
    const next = expectOkTask(
      reduceTask(taskProjection('BLOCKED'), makeEvent('task.ready', { reason: 'unblocked' })),
    )
    expect(next.state).toBe('READY')
  })

  test('moves WAITING_REVIEW to READY', () => {
    const next = expectOkTask(
      reduceTask(taskProjection('WAITING_REVIEW'), makeEvent('task.ready', { reason: 'review_retry' })),
    )
    expect(next.state).toBe('READY')
  })

  test('rejects task.ready from RUNNING', () => {
    expectInvalid(reduceTask(taskProjection('RUNNING'), makeEvent('task.ready', { reason: 'unblocked' })))
  })

  test('rejects task.ready from COMPLETED', () => {
    expectInvalid(reduceTask(taskProjection('COMPLETED'), makeEvent('task.ready', { reason: 'unblocked' })))
  })

  test('moves RUNNING to BLOCKED', () => {
    const next = expectOkTask(
      reduceTask(
        taskProjection('RUNNING'),
        makeEvent('task.blocked', { blocker_code: 'NEEDS_INPUT', detail: 'missing decision' }),
      ),
    )
    expect(next.state).toBe('BLOCKED')
  })

  test('rejects task.blocked from CREATED', () => {
    expectInvalid(
      reduceTask(
        taskProjection('CREATED'),
        makeEvent('task.blocked', { blocker_code: 'NEEDS_INPUT', detail: 'missing decision' }),
      ),
    )
  })

  test('moves RUNNING to WAITING_REVIEW', () => {
    const next = expectOkTask(
      reduceTask(taskProjection('RUNNING'), makeEvent('task.review_ready', { result_id: 'result-0001' })),
    )
    expect(next.state).toBe('WAITING_REVIEW')
  })

  test('rejects task.review_ready from READY', () => {
    expectInvalid(
      reduceTask(taskProjection('READY'), makeEvent('task.review_ready', { result_id: 'result-0001' })),
    )
  })

  test('moves WAITING_REVIEW to COMPLETED', () => {
    const next = expectOkTask(
      reduceTask(
        taskProjection('WAITING_REVIEW'),
        makeEvent('task.completed', { review_actor: { kind: 'user', id: 'reviewer-0001' } }),
      ),
    )
    expect(next.state).toBe('COMPLETED')
  })

  test('rejects task.completed from RUNNING', () => {
    expectInvalid(
      reduceTask(
        taskProjection('RUNNING'),
        makeEvent('task.completed', { review_actor: { kind: 'user', id: 'reviewer-0001' } }),
      ),
    )
  })

  test('moves WAITING_REVIEW to FAILED', () => {
    const next = expectOkTask(
      reduceTask(taskProjection('WAITING_REVIEW'), makeEvent('task.failed', { failure_decision: 'rejected' })),
    )
    expect(next.state).toBe('FAILED')
  })

  test('moves BLOCKED to FAILED', () => {
    const next = expectOkTask(
      reduceTask(taskProjection('BLOCKED'), makeEvent('task.failed', { failure_decision: 'abandoned' })),
    )
    expect(next.state).toBe('FAILED')
  })

  test('rejects task.failed from READY', () => {
    expectInvalid(
      reduceTask(taskProjection('READY'), makeEvent('task.failed', { failure_decision: 'rejected' })),
    )
  })

  test('moves every non-terminal state to CANCELLED', () => {
    for (const state of NON_TERMINAL_TASK_STATES) {
      const next = expectOkTask(
        reduceTask(taskProjection(state), makeEvent('task.cancelled', { reason: 'user request' })),
      )
      expect(next.state).toBe('CANCELLED')
    }
  })

  test('rejects task.cancelled from COMPLETED', () => {
    expectInvalid(
      reduceTask(taskProjection('COMPLETED'), makeEvent('task.cancelled', { reason: 'user request' })),
    )
  })

  test('does not reopen a terminal task', () => {
    expectInvalid(reduceTask(taskProjection('COMPLETED'), makeEvent('task.ready', { reason: 'unblocked' })))
    expectInvalid(reduceTask(taskProjection('FAILED'), makeEvent('task.ready', { reason: 'unblocked' })))
  })

  test('advances version and sequence', () => {
    const current = taskProjection('RUNNING')
    const next = expectOkTask(
      reduceTask(
        current,
        makeEvent('task.blocked', { blocker_code: 'NEEDS_INPUT', detail: 'missing decision' }, 11),
      ),
    )
    expect(next.version).toBe(current.version + 1)
    expect(next.last_event_sequence).toBe(11)
  })

  test('does not mutate the input projection', () => {
    const current = taskProjection('RUNNING')
    const snapshot = JSON.stringify(current)
    reduceTask(current, makeEvent('task.review_ready', { result_id: 'result-0001' }))
    expect(JSON.stringify(current)).toBe(snapshot)
  })

  test('rejects a non-task event type', () => {
    expectInvalid(
      reduceTask(
        taskProjection('READY'),
        makeEvent('run.created', {
          run_id: 'run-0001',
          task_id: 'task-0001',
          attempt: 1,
          submission_key: 'agent-submit:run-0001:v1',
        }),
      ),
    )
  })
})

describe('run reducer', () => {
  test('creates CREATED projection from null', () => {
    const next = expectOkRun(
      reduceRun(null, makeEvent('run.created', {
        run_id: 'run-0001',
        task_id: 'task-0001',
        attempt: 2,
        submission_key: 'agent-submit:run-0001:v1',
      })),
    )
    expect(next.state).toBe('CREATED')
    expect(next.attempt).toBe(2)
    expect(next.submission_key).toBe('agent-submit:run-0001:v1')
    expect(next.version).toBe(1)
  })

  test('rejects run.created when a run already exists', () => {
    expectInvalid(
      reduceRun(runProjection('CREATED'), makeEvent('run.created', {
        run_id: 'run-0001',
        task_id: 'task-0001',
        attempt: 1,
        submission_key: 'agent-submit:run-0001:v1',
      })),
    )
  })

  test('moves CREATED to SUBMITTED', () => {
    const next = expectOkRun(
      reduceRun(
        runProjection('CREATED'),
        makeEvent('run.submission_requested', { task_id: 'task-0001', submission_key: 'agent-submit:run-0001:v1' }),
      ),
    )
    expect(next.state).toBe('SUBMITTED')
  })

  test('rejects run.submission_requested from SUBMITTED', () => {
    expectInvalid(
      reduceRun(
        runProjection('SUBMITTED'),
        makeEvent('run.submission_requested', { task_id: 'task-0001', submission_key: 'agent-submit:run-0001:v1' }),
      ),
    )
  })

  test('binds native_ref while staying SUBMITTED', () => {
    const next = expectOkRun(
      reduceRun(
        runProjection('SUBMITTED'),
        makeEvent('run.native_bound', { task_id: 'task-0001', native_ref: 'native-1', receipt_hash: 'hash-1' }),
      ),
    )
    expect(next.state).toBe('SUBMITTED')
    expect(next.native_ref).toBe('native-1')
  })

  test('rejects run.native_bound from CREATED', () => {
    expectInvalid(
      reduceRun(
        runProjection('CREATED'),
        makeEvent('run.native_bound', { task_id: 'task-0001', native_ref: 'native-1', receipt_hash: 'hash-1' }),
      ),
    )
  })

  test('moves SUBMITTED to RUNNING', () => {
    const next = expectOkRun(
      reduceRun(runProjection('SUBMITTED'), makeEvent('run.started', { task_id: 'task-0001', observation_key: 'obs-1' })),
    )
    expect(next.state).toBe('RUNNING')
  })

  test('rejects run.started from RUNNING', () => {
    expectInvalid(
      reduceRun(runProjection('RUNNING'), makeEvent('run.started', { task_id: 'task-0001', observation_key: 'obs-1' })),
    )
  })

  test('moves SUBMITTED to WAITING_APPROVAL', () => {
    const next = expectOkRun(
      reduceRun(
        runProjection('SUBMITTED'),
        makeEvent('approval.requested', {
          task_id: 'task-0001',
          approval_id: 'approval-0001',
          action_fingerprint: 'fingerprint-1',
          resume_state: 'SUBMITTED',
        }),
      ),
    )
    expect(next.state).toBe('WAITING_APPROVAL')
  })

  test('moves RUNNING to WAITING_APPROVAL', () => {
    const next = expectOkRun(
      reduceRun(
        runProjection('RUNNING'),
        makeEvent('approval.requested', {
          task_id: 'task-0001',
          approval_id: 'approval-0001',
          action_fingerprint: 'fingerprint-1',
          resume_state: 'RUNNING',
        }),
      ),
    )
    expect(next.state).toBe('WAITING_APPROVAL')
  })

  test('restores resume_state on approval.resolved', () => {
    const next = expectOkRun(
      reduceRun(
        runProjection('WAITING_APPROVAL'),
        makeEvent('approval.resolved', {
          task_id: 'task-0001',
          approval_id: 'approval-0001',
          decision: 'approved',
          resume_state: 'RUNNING',
        }),
      ),
    )
    expect(next.state).toBe('RUNNING')
  })

  test('rejects approval.resolved from RUNNING', () => {
    expectInvalid(
      reduceRun(
        runProjection('RUNNING'),
        makeEvent('approval.resolved', {
          task_id: 'task-0001',
          approval_id: 'approval-0001',
          decision: 'approved',
          resume_state: 'RUNNING',
        }),
      ),
    )
  })

  test('rejects approval.resolved with invalid resume_state', () => {
    expectInvalid(
      reduceRun(
        runProjection('WAITING_APPROVAL'),
        makeEvent('approval.resolved', {
          task_id: 'task-0001',
          approval_id: 'approval-0001',
          decision: 'approved',
          resume_state: 'SUCCEEDED',
        }),
      ),
    )
  })

  test('keeps state on run.cancel_requested from every non-terminal state', () => {
    for (const state of NON_TERMINAL_RUN_STATES) {
      const current = runProjection(state)
      const next = expectOkRun(
        reduceRun(current, makeEvent('run.cancel_requested', { task_id: 'task-0001', reason: 'user request' })),
      )
      expect(next.state).toBe(state)
      expect(next.version).toBe(current.version + 1)
    }
  })

  test('moves activity to RECOVERY_REQUIRED', () => {
    for (const state of ['SUBMITTED', 'RUNNING', 'WAITING_APPROVAL'] as RunState[]) {
      const next = expectOkRun(
        reduceRun(
          runProjection(state),
          makeEvent('run.recovery_required', { task_id: 'task-0001', checkpoint: 'checkpoint-1' }),
        ),
      )
      expect(next.state).toBe('RECOVERY_REQUIRED')
    }
  })

  test('rejects run.recovery_required from CREATED', () => {
    expectInvalid(
      reduceRun(
        runProjection('CREATED'),
        makeEvent('run.recovery_required', { task_id: 'task-0001', checkpoint: 'checkpoint-1' }),
      ),
    )
  })

  test('rejects run.recovery_required from RECOVERY_REQUIRED', () => {
    expectInvalid(
      reduceRun(
        runProjection('RECOVERY_REQUIRED'),
        makeEvent('run.recovery_required', { task_id: 'task-0001', checkpoint: 'checkpoint-2' }),
      ),
    )
  })

  test('restores resumed_state on recovery.reconciled', () => {
    const next = expectOkRun(
      reduceRun(
        runProjection('RECOVERY_REQUIRED'),
        makeEvent('recovery.reconciled', {
          task_id: 'task-0001',
          resumed_state: 'RUNNING',
          evidence_hash: 'evidence-1',
        }),
      ),
    )
    expect(next.state).toBe('RUNNING')
  })

  test('rejects recovery.reconciled from RUNNING', () => {
    expectInvalid(
      reduceRun(
        runProjection('RUNNING'),
        makeEvent('recovery.reconciled', {
          task_id: 'task-0001',
          resumed_state: 'RUNNING',
          evidence_hash: 'evidence-1',
        }),
      ),
    )
  })

  test('maps every active state to the payload terminal_state', () => {
    for (const state of RESULT_RECORDABLE_RUN_STATES) {
      for (const terminal of TERMINAL_RUN_STATES) {
        const next = expectOkRun(
          reduceRun(
            runProjection(state),
            makeEvent('run.result_recorded', { task_id: 'task-0001', result_id: 'result-0001', terminal_state: terminal }, 12),
          ),
        )
        expect(next.state).toBe(terminal)
        expect(next.result_id).toBe('result-0001')
        expect(next.last_event_sequence).toBe(12)
      }
    }
  })

  test('rejects run.result_recorded from CREATED', () => {
    expectInvalid(
      reduceRun(
        runProjection('CREATED'),
        makeEvent('run.result_recorded', { task_id: 'task-0001', result_id: 'result-0001', terminal_state: 'SUCCEEDED' }),
      ),
    )
  })

  test('rejects run.result_recorded from a terminal state', () => {
    for (const state of TERMINAL_RUN_STATES) {
      expectInvalid(
        reduceRun(
          runProjection(state),
          makeEvent('run.result_recorded', { task_id: 'task-0001', result_id: 'result-0002', terminal_state: 'SUCCEEDED' }),
        ),
      )
    }
  })

  test('does not mutate the input projection', () => {
    const current = runProjection('SUBMITTED')
    const snapshot = JSON.stringify(current)
    reduceRun(current, makeEvent('run.started', { task_id: 'task-0001', observation_key: 'obs-1' }))
    expect(JSON.stringify(current)).toBe(snapshot)
  })

  test('rejects a non-run event type', () => {
    expectInvalid(
      reduceRun(runProjection('SUBMITTED'), makeEvent('task.created', { envelope: makeTaskEnvelope() })),
    )
  })
})
