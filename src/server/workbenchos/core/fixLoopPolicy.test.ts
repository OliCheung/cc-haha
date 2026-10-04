import { describe, expect, test } from 'bun:test'
import type {
  CommandEvidence,
  FileChange,
  ResultEnvelopeV01,
  TaskEnvelopeV01,
  TaskProjection,
  ValidationEvidence,
} from '../contracts.js'
import {
  DEFAULT_FIX_LOOP_BUDGET_MS,
  DEFAULT_MAX_FIX_ROUNDS,
  DEFAULT_STAGNATION_WINDOW,
  attemptFingerprint,
  createDefaultFixLoopPolicy,
  failureSignature,
  type DefaultFixLoopPolicyOptions,
  type FixLoopDecision,
  type FixLoopPolicyInput,
} from './fixLoopPolicy.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CLOCK_START = '2026-01-01T00:00:00.000Z'
const ONE_MINUTE_LATER = '2026-01-01T00:01:00.000Z'

function fileChange(path: string): FileChange {
  return { path, change: 'modified' }
}

function commandEvidence(command: string): CommandEvidence {
  return { command, exit_code: 0 }
}

function failedValidation(requirementId: string): ValidationEvidence {
  return { requirement_id: requirementId, result: 'failed' }
}

function makeTaskEnvelope(): TaskEnvelopeV01 {
  return {
    kind: 'workbench.task',
    protocol_version: '0.1',
    task_id: 'task-1',
    project_id: 'project-1',
    conversation_ref: { browser_adapter_id: 'fake', conversation_id: 'conversation-1' },
    idempotency_key: 'idem-1',
    requested_execution: { agent_id: 'fake', execution_timeout_ms: 600000 },
    goal: 'exercise the fix-loop policy',
    context_refs: [],
    allowed_scope: { repository_relative_paths: [], action_classes: [] },
    forbidden_scope: { repository_relative_paths: [], action_classes: [] },
    validation_requirements: [],
    approval_requirements: [],
    stop_condition: 'RESULT_READY_FOR_REVIEW',
    created_at: CLOCK_START,
  }
}

function makeTaskProjection(): TaskProjection {
  return {
    task_id: 'task-1',
    state: 'WAITING_REVIEW',
    envelope: makeTaskEnvelope(),
    active_run_id: 'run-1',
    latest_result_id: null,
    version: 2,
    last_event_sequence: 0,
    updated_at: CLOCK_START,
  }
}

function makeResult(overrides: Partial<ResultEnvelopeV01> = {}): ResultEnvelopeV01 {
  return {
    kind: 'workbench.result',
    protocol_version: '0.1',
    result_id: 'result-1',
    task_id: 'task-1',
    run_id: 'run-1',
    executor: { agent_id: 'fake' },
    outcome: { status: 'failed', completion: 'none' },
    summary: 'policy fixture',
    changed_files: [],
    commands: [],
    validations: [],
    git_state: { available: true, commit_performed: false, push_performed: false },
    artifacts: [],
    native_evidence_refs: [],
    risks: [],
    unresolved_work: ['fixture'],
    errors: [{ code: 'FIXTURE', message: 'fixture', retryable: false }],
    next_action: { kind: 'retry' },
    finished_at: CLOCK_START,
    recorded_at: CLOCK_START,
    ...overrides,
  }
}

/** A result that actually attempted something, so NO_PROGRESS cannot fire. */
function makeChangedResult(path: string): ResultEnvelopeV01 {
  return makeResult({ changed_files: [fileChange(path)] })
}

/** A result that attempted something AND reports the given validation failing. */
function makeFailedResultAt(path: string, requirementId: string): ResultEnvelopeV01 {
  return makeResult({
    changed_files: [fileChange(path)],
    validations: [failedValidation(requirementId)],
  })
}

function makeInput(overrides: Partial<FixLoopPolicyInput> = {}): FixLoopPolicyInput {
  return {
    task: makeTaskProjection(),
    lastResult: makeResult(),
    priorResults: [],
    recorded_result_count: 0,
    granted_fix_rounds: 0,
    budget_started_at: CLOCK_START,
    now: ONE_MINUTE_LATER,
    ...overrides,
  }
}

function decide(
  input: Partial<FixLoopPolicyInput>,
  options?: DefaultFixLoopPolicyOptions,
): FixLoopDecision {
  return createDefaultFixLoopPolicy(options).decide(makeInput(input))
}

function stopCode(decision: FixLoopDecision): string {
  expect(decision.action).toBe('stop')
  return decision.action === 'stop' ? decision.blocker_code : ''
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fix loop policy: baseline and cap', () => {
  test('retries when no criterion fires', () => {
    expect(decide({})).toEqual({ action: 'retry' })
  })

  test('stops once the granted rounds reach the cap', () => {
    const decision = decide({
      granted_fix_rounds: DEFAULT_MAX_FIX_ROUNDS,
      lastResult: makeChangedResult('src/a.ts'),
    })

    expect(stopCode(decision)).toBe('FIX_LOOP_EXHAUSTED')
    expect(decision.action === 'stop' ? decision.detail : '').toContain('3 of 3')
  })

  test('retries one round below the cap', () => {
    expect(decide({
      granted_fix_rounds: DEFAULT_MAX_FIX_ROUNDS - 1,
      lastResult: makeChangedResult('src/a.ts'),
    })).toEqual({ action: 'retry' })
  })
})

describe('fix loop policy: no progress', () => {
  test('stops with NO_PROGRESS when a fix round changed nothing', () => {
    const decision = decide({ granted_fix_rounds: 1, lastResult: makeResult() })

    expect(stopCode(decision)).toBe('FIX_LOOP_NO_PROGRESS')
    expect(decision.action === 'stop' ? decision.detail : '').toContain('changed no files')
  })

  test('does not fire NO_PROGRESS on the first attempt', () => {
    expect(decide({ granted_fix_rounds: 0, lastResult: makeResult() })).toEqual({ action: 'retry' })
  })
})

describe('fix loop policy: stagnation', () => {
  test('stops when the attempt fingerprint repeats', () => {
    const attempt = makeChangedResult('src/a.ts')
    const decision = decide({
      granted_fix_rounds: 1,
      lastResult: attempt,
      priorResults: [attempt],
    })

    expect(stopCode(decision)).toBe('FIX_LOOP_STAGNATED')
    expect(decision.action === 'stop' ? decision.detail : '').toContain('identical attempt fingerprint')
  })

  test('does not fire when the attempt changed', () => {
    expect(decide({
      granted_fix_rounds: 1,
      lastResult: makeChangedResult('src/b.ts'),
      priorResults: [makeChangedResult('src/a.ts')],
    })).toEqual({ action: 'retry' })
  })

  test('attemptFingerprint ignores evidence ordering', () => {
    const left = attemptFingerprint(makeResult({
      changed_files: [fileChange('src/b.ts'), fileChange('src/a.ts')],
      commands: [commandEvidence('bun test z'), commandEvidence('bun test a')],
    }))
    const right = attemptFingerprint(makeResult({
      changed_files: [fileChange('src/a.ts'), fileChange('src/b.ts')],
      commands: [commandEvidence('bun test a'), commandEvidence('bun test z')],
    }))

    expect(left).toBe(right)
  })

  test('attemptFingerprint changes when a file changes', () => {
    const left = attemptFingerprint(makeResult({ changed_files: [fileChange('src/a.ts')] }))
    const right = attemptFingerprint(makeResult({ changed_files: [fileChange('src/b.ts')] }))

    expect(left).not.toBe(right)
  })

  test('stops when the same validation fails across the window', () => {
    const first = makeFailedResultAt('src/a.ts', 'req-1')
    const second = makeFailedResultAt('src/b.ts', 'req-1')
    const third = makeFailedResultAt('src/c.ts', 'req-1')

    const decision = decide({
      granted_fix_rounds: 2,
      lastResult: third,
      priorResults: [first, second],
    })

    expect(stopCode(decision)).toBe('FIX_LOOP_STAGNATED')
    expect(decision.action === 'stop' ? decision.detail : '').toContain('3 rounds in a row')
  })

  test('does not fire the window criterion on a shorter history', () => {
    const first = makeFailedResultAt('src/a.ts', 'req-1')
    const second = makeFailedResultAt('src/b.ts', 'req-1')

    expect(decide({
      granted_fix_rounds: 2,
      lastResult: second,
      priorResults: [first],
    })).toEqual({ action: 'retry' })
  })

  test('does not fire the window criterion without failed validations', () => {
    const first = makeChangedResult('src/a.ts')
    const second = makeChangedResult('src/b.ts')
    const third = makeChangedResult('src/c.ts')

    expect(decide({
      granted_fix_rounds: 2,
      lastResult: third,
      priorResults: [first, second],
    })).toEqual({ action: 'retry' })
  })

  test('failureSignature ignores validation ordering', () => {
    const left = failureSignature(makeResult({
      validations: [failedValidation('req-b'), failedValidation('req-a')],
    }))
    const right = failureSignature(makeResult({
      validations: [failedValidation('req-a'), failedValidation('req-b')],
    }))

    expect(left).toBe(right)
  })
})

describe('fix loop policy: budget', () => {
  test('stops when the budget is exceeded', () => {
    const decision = decide({
      budget_started_at: '2026-01-01T00:00:00.000Z',
      now: '2026-01-01T02:00:00.000Z',
    })

    expect(stopCode(decision)).toBe('FIX_LOOP_BUDGET_EXCEEDED')
  })

  test('retries just inside the budget, including the exact boundary', () => {
    expect(decide({
      budget_started_at: '2026-01-01T00:00:00.000Z',
      now: '2026-01-01T00:59:59.000Z',
    })).toEqual({ action: 'retry' })

    expect(decide({
      budget_started_at: '2026-01-01T00:00:00.000Z',
      now: '2026-01-01T01:00:00.000Z',
    })).toEqual({ action: 'retry' })
  })

  test('skips the budget check when the start is absent', () => {
    expect(decide({
      budget_started_at: null,
      now: '2026-01-01T09:00:00.000Z',
    })).toEqual({ action: 'retry' })
  })

  test('skips the budget check when a timestamp is unparseable', () => {
    expect(decide({
      budget_started_at: 'not-a-timestamp',
      now: '2026-01-01T09:00:00.000Z',
    })).toEqual({ action: 'retry' })

    expect(decide({
      budget_started_at: '2026-01-01T00:00:00.000Z',
      now: 'not-a-timestamp',
    })).toEqual({ action: 'retry' })
  })
})

describe('fix loop policy: priority', () => {
  test('prefers NO_PROGRESS over EXHAUSTED', () => {
    const decision = decide({ granted_fix_rounds: 5, lastResult: makeResult() })

    expect(stopCode(decision)).toBe('FIX_LOOP_NO_PROGRESS')
  })

  test('prefers EXHAUSTED over STAGNATED', () => {
    const attempt = makeChangedResult('src/a.ts')
    const decision = decide({
      granted_fix_rounds: DEFAULT_MAX_FIX_ROUNDS,
      lastResult: attempt,
      priorResults: [attempt],
    })

    expect(stopCode(decision)).toBe('FIX_LOOP_EXHAUSTED')
  })
})

describe('fix loop policy: configuration', () => {
  test('honours a configured round cap', () => {
    const decision = decide(
      { granted_fix_rounds: 1, lastResult: makeChangedResult('src/a.ts') },
      { max_fix_rounds: 1 },
    )

    expect(stopCode(decision)).toBe('FIX_LOOP_EXHAUSTED')
  })

  test('honours a configured budget', () => {
    const decision = decide(
      { budget_started_at: '2026-01-01T00:00:00.000Z', now: '2026-01-01T00:00:02.000Z' },
      { budget_ms: 1000 },
    )

    expect(stopCode(decision)).toBe('FIX_LOOP_BUDGET_EXCEEDED')
  })

  test('honours a configured stagnation window', () => {
    const first = makeFailedResultAt('src/a.ts', 'req-1')
    const second = makeFailedResultAt('src/b.ts', 'req-1')

    const decision = decide(
      { granted_fix_rounds: 2, lastResult: second, priorResults: [first] },
      { stagnation_window: 2 },
    )

    expect(stopCode(decision)).toBe('FIX_LOOP_STAGNATED')
  })

  test('exposes the frozen defaults', () => {
    expect(DEFAULT_MAX_FIX_ROUNDS).toBe(3)
    expect(DEFAULT_FIX_LOOP_BUDGET_MS).toBe(3_600_000)
    expect(DEFAULT_STAGNATION_WINDOW).toBe(3)
  })
})
