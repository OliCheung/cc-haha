import { describe, expect, test } from 'bun:test'
import {
  isActiveRunState,
  isRepositoryRelativePath,
  isTerminalRunState,
  isTerminalTaskState,
  validateEventEnvelope,
  validateResultEnvelope,
  validateTaskEnvelope,
} from './contracts.js'
import type {
  ContractResult,
  ResultEnvelopeV01,
  RunState,
  TaskEnvelopeV01,
  TaskState,
} from './contracts.js'

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
    allowed_scope: {
      repository_relative_paths: ['src/server/workbenchos/'],
      action_classes: ['file_write'],
    },
    forbidden_scope: {
      repository_relative_paths: ['desktop/'],
      action_classes: ['git_push'],
    },
    validation_requirements: [],
    approval_requirements: [],
    stop_condition: 'RESULT_READY_FOR_REVIEW',
    created_at: FIXED_TIME,
  }
}

function makeResultEnvelope(): ResultEnvelopeV01 {
  return {
    kind: 'workbench.result',
    protocol_version: '0.1',
    result_id: 'result-0001',
    task_id: 'task-0001',
    run_id: 'run-0001',
    executor: { agent_id: 'codebuddy' },
    outcome: { status: 'succeeded', completion: 'complete' },
    summary: 'implemented the isolated core',
    changed_files: [],
    commands: [],
    validations: [],
    git_state: { available: true, commit_performed: false, push_performed: false },
    artifacts: [],
    native_evidence_refs: [],
    risks: [],
    unresolved_work: [],
    errors: [],
    next_action: { kind: 'review' },
    finished_at: FIXED_TIME,
    recorded_at: FIXED_TIME,
  }
}

function makeEventEnvelope(): Record<string, unknown> {
  return {
    kind: 'workbench.event',
    protocol_version: '0.1',
    event_id: 'event-0001',
    sequence: 1,
    task_id: 'task-0001',
    event_type: 'task.created',
    producer: { kind: 'core', id: 'workbench-core' },
    recorded_at: FIXED_TIME,
    dedupe_key: 'task-created:task-0001',
    payload_hash: 'hash-0001',
    payload: { envelope: makeTaskEnvelope() },
  }
}

function mutateTask(mutate: (envelope: Record<string, unknown>) => void): unknown {
  const envelope = makeTaskEnvelope() as unknown as Record<string, unknown>
  mutate(envelope)
  return envelope
}

function mutateResult(mutate: (envelope: Record<string, unknown>) => void): unknown {
  const envelope = makeResultEnvelope() as unknown as Record<string, unknown>
  mutate(envelope)
  return envelope
}

function mutateEvent(mutate: (envelope: Record<string, unknown>) => void): unknown {
  const envelope = makeEventEnvelope()
  mutate(envelope)
  return envelope
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>
}

function errorCode(result: ContractResult<unknown>): string {
  return result.ok === true ? 'NO_ERROR' : result.error.code
}

describe('task envelope', () => {
  test('accepts a valid TaskEnvelope', () => {
    expect(validateTaskEnvelope(makeTaskEnvelope()).ok).toBe(true)
  })

  test('rejects wrong task kind', () => {
    const result = validateTaskEnvelope(mutateTask((envelope) => {
      envelope.kind = 'workbench.result'
    }))
    expect(errorCode(result)).toBe('TASK_KIND_MISMATCH')
  })

  test('rejects wrong protocol_version', () => {
    const result = validateTaskEnvelope(mutateTask((envelope) => {
      envelope.protocol_version = '0.2'
    }))
    expect(errorCode(result)).toBe('PROTOCOL_VERSION_MISMATCH')
  })

  test('rejects missing goal', () => {
    const result = validateTaskEnvelope(mutateTask((envelope) => {
      delete envelope.goal
    }))
    expect(['MISSING_REQUIRED_FIELD', 'GOAL_INVALID']).toContain(errorCode(result))
  })

  test('rejects empty goal', () => {
    const result = validateTaskEnvelope(mutateTask((envelope) => {
      envelope.goal = ''
    }))
    expect(errorCode(result)).toBe('GOAL_INVALID')
  })

  test('rejects goal longer than 8192', () => {
    const result = validateTaskEnvelope(mutateTask((envelope) => {
      envelope.goal = 'a'.repeat(8193)
    }))
    expect(errorCode(result)).toBe('GOAL_INVALID')
  })

  test('rejects zero timeout', () => {
    const result = validateTaskEnvelope(mutateTask((envelope) => {
      asRecord(envelope.requested_execution).execution_timeout_ms = 0
    }))
    expect(errorCode(result)).toBe('TIMEOUT_INVALID')
  })

  test('rejects negative timeout', () => {
    const result = validateTaskEnvelope(mutateTask((envelope) => {
      asRecord(envelope.requested_execution).execution_timeout_ms = -1
    }))
    expect(errorCode(result)).toBe('TIMEOUT_INVALID')
  })

  test('rejects timeout above ceiling', () => {
    const result = validateTaskEnvelope(mutateTask((envelope) => {
      asRecord(envelope.requested_execution).execution_timeout_ms = 3600001
    }))
    expect(errorCode(result)).toBe('TIMEOUT_INVALID')
  })

  test('rejects absolute scope path', () => {
    const result = validateTaskEnvelope(mutateTask((envelope) => {
      asRecord(envelope.allowed_scope).repository_relative_paths = ['/etc/passwd']
    }))
    expect(errorCode(result)).toBe('SCOPE_PATH_ESCAPE')
  })

  test('rejects parent traversal scope path', () => {
    const result = validateTaskEnvelope(mutateTask((envelope) => {
      asRecord(envelope.allowed_scope).repository_relative_paths = ['../outside']
    }))
    expect(errorCode(result)).toBe('SCOPE_PATH_ESCAPE')
  })

  test('rejects backslash scope path', () => {
    const result = validateTaskEnvelope(mutateTask((envelope) => {
      asRecord(envelope.allowed_scope).repository_relative_paths = ['src\\app.ts']
    }))
    expect(errorCode(result)).toBe('SCOPE_PATH_ESCAPE')
  })

  test('rejects empty idempotency key', () => {
    const result = validateTaskEnvelope(mutateTask((envelope) => {
      envelope.idempotency_key = ''
    }))
    expect(errorCode(result)).toBe('IDEMPOTENCY_KEY_INVALID')
  })

  test('rejects idempotency key longer than 256', () => {
    const result = validateTaskEnvelope(mutateTask((envelope) => {
      envelope.idempotency_key = 'k'.repeat(257)
    }))
    expect(errorCode(result)).toBe('IDEMPOTENCY_KEY_INVALID')
  })

  test('rejects unknown top-level field', () => {
    const result = validateTaskEnvelope(mutateTask((envelope) => {
      envelope.extra = 1
    }))
    expect(errorCode(result)).toBe('UNKNOWN_TOP_LEVEL_FIELD')
  })

  test('rejects non-namespaced extension key', () => {
    const result = validateTaskEnvelope(mutateTask((envelope) => {
      envelope.extensions = { feature: 1 }
    }))
    expect(errorCode(result)).toBe('EXTENSION_KEY_NOT_NAMESPACED')
  })
})

describe('result envelope', () => {
  test('accepts a valid ResultEnvelope', () => {
    expect(validateResultEnvelope(makeResultEnvelope()).ok).toBe(true)
  })

  test('rejects wrong result kind', () => {
    const result = validateResultEnvelope(mutateResult((envelope) => {
      envelope.kind = 'workbench.task'
    }))
    expect(errorCode(result)).toBe('RESULT_KIND_MISMATCH')
  })

  test('rejects succeeded with partial completion', () => {
    const result = validateResultEnvelope(mutateResult((envelope) => {
      asRecord(envelope.outcome).completion = 'partial'
    }))
    expect(errorCode(result)).toBe('TERMINAL_RULE_VIOLATION')
  })

  test('rejects succeeded with non-passed validation', () => {
    const result = validateResultEnvelope(mutateResult((envelope) => {
      envelope.validations = [{ requirement_id: 'req-1', result: 'failed' }]
    }))
    expect(errorCode(result)).toBe('TERMINAL_RULE_VIOLATION')
  })

  test('rejects failed with empty errors', () => {
    const result = validateResultEnvelope(mutateResult((envelope) => {
      const outcome = asRecord(envelope.outcome)
      outcome.status = 'failed'
      outcome.completion = 'none'
      envelope.errors = []
    }))
    expect(errorCode(result)).toBe('TERMINAL_RULE_VIOLATION')
  })

  test('rejects cancelled without reason', () => {
    const result = validateResultEnvelope(mutateResult((envelope) => {
      const outcome = asRecord(envelope.outcome)
      outcome.status = 'cancelled'
      outcome.completion = 'none'
      delete outcome.terminal_reason
    }))
    expect(errorCode(result)).toBe('TERMINAL_RULE_VIOLATION')
  })

  test('accepts succeeded with complete outcome and all validations passed', () => {
    const result = validateResultEnvelope(mutateResult((envelope) => {
      envelope.validations = [
        { requirement_id: 'req-1', result: 'passed' },
        { requirement_id: 'req-2', result: 'passed' },
      ]
    }))
    expect(result.ok).toBe(true)
  })
})

describe('event envelope', () => {
  test('accepts a valid EventEnvelope', () => {
    expect(validateEventEnvelope(makeEventEnvelope()).ok).toBe(true)
  })

  test('rejects unknown event_type', () => {
    const result = validateEventEnvelope(mutateEvent((envelope) => {
      envelope.event_type = 'run.failed'
    }))
    expect(errorCode(result)).toBe('INVALID_FIELD_TYPE')
  })

  test('rejects missing dedupe_key', () => {
    const result = validateEventEnvelope(mutateEvent((envelope) => {
      delete envelope.dedupe_key
    }))
    expect(errorCode(result)).toBe('MISSING_REQUIRED_FIELD')
  })
})

describe('predicates', () => {
  test('classifies terminal task states', () => {
    const terminal: TaskState[] = ['COMPLETED', 'FAILED', 'CANCELLED']
    const nonTerminal: TaskState[] = ['CREATED', 'READY', 'RUNNING', 'WAITING_REVIEW', 'BLOCKED']
    for (const state of terminal) expect(isTerminalTaskState(state)).toBe(true)
    for (const state of nonTerminal) expect(isTerminalTaskState(state)).toBe(false)
  })

  test('classifies terminal run states', () => {
    const terminal: RunState[] = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']
    const nonTerminal: RunState[] = ['CREATED', 'SUBMITTED', 'RUNNING', 'WAITING_APPROVAL', 'RECOVERY_REQUIRED']
    for (const state of terminal) expect(isTerminalRunState(state)).toBe(true)
    for (const state of nonTerminal) expect(isTerminalRunState(state)).toBe(false)
  })

  test('classifies active run states', () => {
    const active: RunState[] = ['SUBMITTED', 'RUNNING', 'WAITING_APPROVAL']
    const inactive: RunState[] = ['CREATED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'RECOVERY_REQUIRED']
    for (const state of active) expect(isActiveRunState(state)).toBe(true)
    for (const state of inactive) expect(isActiveRunState(state)).toBe(false)
  })

  test('accepts repository-relative paths', () => {
    expect(isRepositoryRelativePath('src/server/workbenchos/contracts.ts')).toBe(true)
    expect(isRepositoryRelativePath('docs/audits/')).toBe(true)
  })

  test('rejects escaping paths', () => {
    expect(isRepositoryRelativePath('')).toBe(false)
    expect(isRepositoryRelativePath('/absolute/path')).toBe(false)
    expect(isRepositoryRelativePath('C:/windows/path')).toBe(false)
    expect(isRepositoryRelativePath('src\\windows\\path')).toBe(false)
    expect(isRepositoryRelativePath('../escape')).toBe(false)
    expect(isRepositoryRelativePath('src/../../escape')).toBe(false)
  })
})
