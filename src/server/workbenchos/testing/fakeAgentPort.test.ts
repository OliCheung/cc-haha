import { describe, expect, test } from 'bun:test'
import { validateResultEnvelope, type ResultEnvelopeV01 } from '../contracts.js'
import {
  AgentPortError,
  type AgentResultMaterial,
  type AgentSubmissionV01,
  type CollectResultOutcome,
} from '../ports/agentPort.js'
import {
  FakeAgentPort,
  type FakeScenarioStep,
  type FakeTerminalStatus,
} from './fakeAgentPort.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSubmission(): AgentSubmissionV01 {
  return {
    task_id: 'task-1',
    run_id: 'run-1',
    agent_id: 'fake',
    goal: 'exercise the fake agent port',
    context_refs: [],
    allowed_scope: { repository_relative_paths: [], action_classes: [] },
    forbidden_scope: { repository_relative_paths: [], action_classes: [] },
    validation_requirements: [],
  }
}

function makeMaterial(outcome: FakeTerminalStatus): AgentResultMaterial {
  const succeeded = outcome === 'succeeded'

  return {
    native_run_ref: 'native-1',
    outcome,
    completion: succeeded ? 'complete' : 'none',
    summary: `test material for ${outcome}`,
    changed_files: [],
    commands: [],
    validations: [],
    git_state: { available: true, commit_performed: false, push_performed: false },
    artifacts: [],
    native_evidence_refs: [],
    risks: [],
    unresolved_work: succeeded ? [] : ['test terminal without success'],
    errors: succeeded
      ? []
      : [{ code: 'TEST_TERMINAL', message: 'test terminal without success', retryable: false }],
    finished_at: '2026-01-01T00:00:00.000Z',
  }
}

/** Wraps a material in a Result envelope so contracts.ts can judge its terminal rules. */
function toResultEnvelope(material: AgentResultMaterial): ResultEnvelopeV01 {
  return {
    kind: 'workbench.result',
    protocol_version: '0.1',
    result_id: 'result-1',
    task_id: 'task-1',
    run_id: 'run-1',
    executor: { agent_id: 'fake' },
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
    next_action: { kind: 'review' },
    finished_at: material.finished_at,
    recorded_at: '2026-01-01T00:00:00.000Z',
  }
}

function expectReady(outcome: CollectResultOutcome): AgentResultMaterial {
  expect(outcome.status).toBe('ready')
  if (outcome.status !== 'ready') throw new Error('expected a ready collection outcome')
  return outcome.material
}

async function expectAgentPortError(
  call: () => Promise<unknown>,
  code: string,
  retryable: boolean,
): Promise<void> {
  let captured: unknown
  try {
    await call()
  } catch (error) {
    captured = error
  }
  expect(captured).toBeInstanceOf(AgentPortError)
  const typed = captured as AgentPortError
  expect(typed.code).toBe(code)
  expect(typed.retryable).toBe(retryable)
}

/** Submits once and returns the bound native ref. */
async function submitOnce(port: FakeAgentPort, key = 'submit-key'): Promise<string> {
  const receipt = await port.submitTask(makeSubmission(), key, 1000)
  return receipt.native_run_ref
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fake agent port surface', () => {
  test('implements the production AgentPort surface', () => {
    const port = new FakeAgentPort()

    expect(port.protocolVersion).toBe('0.1')
    expect(typeof port.submitTask).toBe('function')
    expect(typeof port.lookupSubmission).toBe('function')
    expect(typeof port.getStatus).toBe('function')
    expect(typeof port.collectResult).toBe('function')
    expect(typeof port.cancel).toBe('function')
    expect(typeof port.healthCheck).toBe('function')
  })

  test('binds a deterministic native ref on submit', async () => {
    const port = new FakeAgentPort()

    const first = await port.submitTask(makeSubmission(), 'key-1', 1000)
    const second = await port.submitTask(makeSubmission(), 'key-2', 1000)

    expect(first.native_run_ref).toBe('native-1')
    expect(second.native_run_ref).toBe('native-2')
    expect(port.listNativeRefs()).toEqual(['native-1', 'native-2'])
  })

  test('returns the same receipt for a duplicate submission key', async () => {
    const port = new FakeAgentPort()

    const first = await port.submitTask(makeSubmission(), 'key-1', 1000)
    const second = await port.submitTask(makeSubmission(), 'key-1', 1000)

    expect(second).toEqual(first)
    expect(port.listNativeRefs()).toEqual(['native-1'])
  })

  test('does not double count a duplicate submission', async () => {
    const port = new FakeAgentPort()

    await port.submitTask(makeSubmission(), 'key-1', 1000)
    await port.submitTask(makeSubmission(), 'key-1', 1000)

    expect(port.getSideEffectCount('native-1')).toBe(1)
  })
})

describe('fake agent port submission faults', () => {
  test('times out without binding when the scenario says so', async () => {
    const port = new FakeAgentPort()
    port.enqueueScenario({ steps: [], submit_behavior: 'timeout' })

    await expectAgentPortError(
      () => port.submitTask(makeSubmission(), 'key-1', 1000),
      'TIMEOUT',
      true,
    )
    expect(port.listNativeRefs()).toEqual([])
  })

  test('reports unavailability without binding', async () => {
    const port = new FakeAgentPort()
    port.enqueueScenario({ steps: [], submit_behavior: 'unavailable' })

    await expectAgentPortError(
      () => port.submitTask(makeSubmission(), 'key-1', 1000),
      'UNAVAILABLE',
      true,
    )
    expect(port.listNativeRefs()).toEqual([])
  })

  test('records the effect when the acknowledgement is lost', async () => {
    const port = new FakeAgentPort()
    port.enqueueScenario({ steps: [], submit_behavior: 'effect_then_lost_ack' })

    await expectAgentPortError(
      () => port.submitTask(makeSubmission(), 'key-1', 1000),
      'TIMEOUT',
      true,
    )
    expect(port.listNativeRefs()).toEqual(['native-1'])
    expect(port.getSideEffectCount('native-1')).toBe(1)
  })

  test('discovers a lost acknowledgement through lookup', async () => {
    const port = new FakeAgentPort()
    port.enqueueScenario({ steps: [], submit_behavior: 'effect_then_lost_ack' })

    await expectAgentPortError(
      () => port.submitTask(makeSubmission(), 'key-1', 1000),
      'TIMEOUT',
      true,
    )

    const receipt = await port.lookupSubmission('key-1', 1000)
    expect(receipt?.native_run_ref).toBe('native-1')
    expect(receipt?.idempotency_key).toBe('key-1')
  })

  test('leaves the retry scenario available after a timeout attempt', async () => {
    const port = new FakeAgentPort()
    port.enqueueScenario({ steps: [], submit_behavior: 'timeout' })
    port.enqueueScenario({ steps: [{ status: 'running' }] })

    await expectAgentPortError(
      () => port.submitTask(makeSubmission(), 'key-1', 1000),
      'TIMEOUT',
      true,
    )

    const receipt = await port.submitTask(makeSubmission(), 'key-1', 1000)
    expect(receipt.native_run_ref).toBe('native-1')
    expect(port.advance(receipt.native_run_ref)).toBe('running')
  })

  test('returns null for an unknown lookup key', async () => {
    const port = new FakeAgentPort()

    expect(await port.lookupSubmission('never-submitted', 1000)).toBeNull()
  })

  test('throws when lookup is unavailable', async () => {
    const port = new FakeAgentPort()
    const ref = await submitOnce(port)
    port.injectFault(ref, 'lookup_unavailable')

    await expectAgentPortError(() => port.lookupSubmission('submit-key', 1000), 'UNAVAILABLE', true)
  })
})

describe('fake agent port status and result observation', () => {
  test('starts accepted before any advance', async () => {
    const port = new FakeAgentPort()
    port.enqueueScenario({ steps: [{ status: 'running' }] })
    const ref = await submitOnce(port)

    const snapshot = await port.getStatus(ref, 1000)
    expect(snapshot.status).toBe('accepted')
  })

  test('advances through the scenario steps in order', async () => {
    const port = new FakeAgentPort()
    port.enqueueScenario({
      steps: [
        { status: 'running' },
        { status: 'waiting_approval' },
        { status: 'succeeded', material: makeMaterial('succeeded') },
      ],
    })
    const ref = await submitOnce(port)

    expect(port.advance(ref)).toBe('running')
    expect(port.advance(ref)).toBe('waiting_approval')
    expect(port.advance(ref)).toBe('succeeded')
    expect(port.getBindingStatus(ref)).toBe('succeeded')
  })

  test('observes without advancing', async () => {
    const port = new FakeAgentPort()
    port.enqueueScenario({
      steps: [{ status: 'running' }, { status: 'succeeded', material: makeMaterial('succeeded') }],
    })
    const ref = await submitOnce(port)

    expect(port.advance(ref)).toBe('running')

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = await port.getStatus(ref, 1000)
      expect(snapshot.status).toBe('running')
    }

    // Exactly one step remains, so the next advance consumes it rather than
    // skipping ahead.
    expect(port.advance(ref)).toBe('succeeded')
  })

  test('reports unknown when the scenario step says so', async () => {
    const port = new FakeAgentPort()
    port.enqueueScenario({ steps: [{ status: 'unknown' }] })
    const ref = await submitOnce(port)

    expect(port.advance(ref)).toBe('unknown')
    expect(port.getBindingStatus(ref)).toBe('unknown')

    const snapshot = await port.getStatus(ref, 1000)
    expect(snapshot.status).toBe('unknown')
  })

  test('returns unknown for an unknown native ref from advance', () => {
    const port = new FakeAgentPort()

    expect(port.advance('native-999')).toBe('unknown')
  })

  test('throws NOT_FOUND for an unknown native ref from getStatus', async () => {
    const port = new FakeAgentPort()

    await expectAgentPortError(() => port.getStatus('native-999', 1000), 'NOT_FOUND', false)
  })

  test('returns not_ready while the binding is active', async () => {
    const port = new FakeAgentPort()
    port.enqueueScenario({ steps: [{ status: 'running' }] })
    const ref = await submitOnce(port)

    const outcome = await port.collectResult(ref, 1000)
    expect(outcome.status).toBe('not_ready')
  })

  test('returns a terminal material and keeps it stable', async () => {
    const port = new FakeAgentPort()
    port.enqueueScenario({ steps: [{ status: 'succeeded', material: makeMaterial('succeeded') }] })
    const ref = await submitOnce(port)

    port.advance(ref)
    const first = expectReady(await port.collectResult(ref, 1000))
    const second = expectReady(await port.collectResult(ref, 1000))

    expect(second).toEqual(first)
    expect(validateResultEnvelope(toResultEnvelope(first)).ok).toBe(true)
  })

  test('builds a contract-valid default material when the step omits one', async () => {
    const port = new FakeAgentPort()
    // A malformed step can only arrive from untyped JavaScript. The fake must
    // still produce a material that survives the terminal rules.
    const malformed = { status: 'succeeded' } as unknown as FakeScenarioStep
    port.enqueueScenario({ steps: [malformed] })
    const ref = await submitOnce(port)

    expect(port.advance(ref)).toBe('succeeded')
    const material = expectReady(await port.collectResult(ref, 1000))

    expect(material.outcome).toBe('succeeded')
    expect(material.completion).toBe('complete')
    expect(material.errors).toEqual([])
    expect(validateResultEnvelope(toResultEnvelope(material)).ok).toBe(true)
  })
})

describe('fake agent port cancel', () => {
  test('accepts a cancel and counts the effect once', async () => {
    const port = new FakeAgentPort()
    port.enqueueScenario({ steps: [{ status: 'running' }] })
    const ref = await submitOnce(port)
    expect(port.getSideEffectCount(ref)).toBe(1)

    const cancelled = await port.cancel(ref, 'cancel-key', 'user request', 1000)
    expect(cancelled.accepted).toBe(true)
    // F3.5 requires an accepted cancel to be counted, so the running total is
    // submission (1) + cancel (1) = 2. See D8 in the P5 report.
    expect(port.getSideEffectCount(ref)).toBe(2)

    const repeated = await port.cancel(ref, 'cancel-key', 'user request', 1000)
    expect(repeated).toEqual(cancelled)
    expect(port.getSideEffectCount(ref)).toBe(2)

    // Cancel never changes the binding status.
    expect(port.getBindingStatus(ref)).toBe('accepted')
  })

  test('ignores a cancel when instructed', async () => {
    const port = new FakeAgentPort()
    port.enqueueScenario({ steps: [{ status: 'running' }] })
    const ref = await submitOnce(port)
    port.advance(ref)
    port.injectFault(ref, 'cancel_ignored')

    const attempted = await port.cancel(ref, 'cancel-key', 'user request', 1000)

    expect(attempted.accepted).toBe(false)
    expect(port.getBindingStatus(ref)).toBe('running')
    expect(port.getSideEffectCount(ref)).toBe(1)
  })

  test('records the cancel effect then loses the acknowledgement', async () => {
    const port = new FakeAgentPort()
    port.enqueueScenario({ steps: [{ status: 'running' }] })
    const ref = await submitOnce(port)
    port.injectFault(ref, 'cancel_effect_then_lost_ack')

    await expectAgentPortError(
      () => port.cancel(ref, 'cancel-key', 'user request', 1000),
      'TIMEOUT',
      true,
    )
    // The effect was applied before the acknowledgement was lost: 1 + 1 = 2.
    expect(port.getSideEffectCount(ref)).toBe(2)

    // A retry with the same key returns the recorded receipt and applies nothing.
    const retried = await port.cancel(ref, 'cancel-key', 'user request', 1000)
    expect(retried.accepted).toBe(true)
    expect(port.getSideEffectCount(ref)).toBe(2)
  })
})

describe('fake agent port call log', () => {
  test('records the call order and hands out copies', async () => {
    const port = new FakeAgentPort()
    port.enqueueScenario({ steps: [] })
    const receipt = await port.submitTask(makeSubmission(), 'key-1', 1000)

    await port.getStatus(receipt.native_run_ref, 1000)
    await port.healthCheck(1000)

    const calls = port.getCalls()
    expect(calls.map(call => call.method)).toEqual(['submitTask', 'getStatus', 'healthCheck'])
    expect(calls[0]?.idempotency_key).toBe('key-1')
    expect(calls[1]?.native_run_ref).toBe('native-1')

    calls.push({ method: 'cancel' })
    expect(port.getCalls().length).toBe(3)
  })
})
