/**
 * FakeAgentPort — a fully deterministic, scriptable AgentPortV01 implementation.
 *
 * Purpose: every AgentPort outcome and fault injection must be reproducible
 * offline, without timers, without a real clock, and without subprocesses.
 *
 * Determinism rules enforced here (task package M1-001-P5 §7 F5):
 *   - no timer APIs; state changes only through explicit `advance`
 *   - no real clock and no randomness; every timestamp comes from `options.clock`
 *   - `getStatus` / `collectResult` / `lookupSubmission` / `healthCheck` are read-only
 *   - `getCalls()` hands out copies
 *
 * Authorized by task package M1-001-P5.
 */

import {
  AgentPortError,
  type AgentHealth,
  type AgentPortV01,
  type AgentResultMaterial,
  type AgentStatusSnapshot,
  type AgentSubmissionV01,
  type CancelReceipt,
  type CollectResultOutcome,
  type SubmissionReceipt,
} from '../ports/agentPort.js'

// ---------------------------------------------------------------------------
// Public scripted-control types (F2)
// ---------------------------------------------------------------------------

export type FakeAgentPortOptions = {
  /** Prefix for generated native refs. Defaults to 'native'. */
  native_prefix?: string
  /** Capability name reported by healthCheck. Defaults to 'fake'. */
  capability?: string
  /** Timestamp source. Defaults to a constant, so the port is fully deterministic. */
  clock?: () => string
}

export type FakeStatus =
  | 'accepted'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'unknown'

export type FakeTerminalStatus = 'succeeded' | 'failed' | 'cancelled' | 'timed_out'

export type FakeTerminalStep = {
  status: FakeTerminalStatus
  material: AgentResultMaterial
}

export type FakeScenarioStep =
  | { status: 'accepted' }
  | { status: 'running' }
  | { status: 'waiting_approval' }
  | { status: 'unknown' }
  | FakeTerminalStep

export type FakeSubmitBehavior =
  | 'accept'
  | 'timeout'
  | 'unavailable'
  | 'effect_then_lost_ack'

export type FakeScenario = {
  steps: FakeScenarioStep[]
  submit_behavior?: FakeSubmitBehavior
}

export type FakeFault =
  | 'lookup_unavailable'
  | 'status_unknown'
  | 'result_conflicts'
  | 'cancel_ignored'
  | 'cancel_effect_then_lost_ack'

export type FakeCall = {
  method:
    | 'submitTask'
    | 'lookupSubmission'
    | 'getStatus'
    | 'collectResult'
    | 'cancel'
    | 'healthCheck'
  idempotency_key?: string
  native_run_ref?: string
}

// ---------------------------------------------------------------------------
// Internal types and pure helpers
// ---------------------------------------------------------------------------

type FakeBinding = {
  native_run_ref: string
  idempotency_key: string
  status: FakeStatus
  steps: FakeScenarioStep[]
  next_step_index: number
  material: AgentResultMaterial | null
  side_effects: number
  faults: Set<FakeFault>
  cancel_receipts: Map<string, CancelReceipt>
}

const DEFAULT_CLOCK = (): string => '2026-01-01T00:00:00.000Z'
const DEFAULT_SCENARIO: FakeScenario = { steps: [] }

function isTerminalStatus(status: FakeStatus): status is FakeTerminalStatus {
  return (
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'timed_out'
  )
}

function isTerminalStep(step: FakeScenarioStep): step is FakeTerminalStep {
  return isTerminalStatus(step.status)
}

/**
 * F3.4.1: the default material must satisfy the terminal rules in contracts.ts,
 * otherwise P6 would fail because the fake itself produced an illegal Result.
 */
function buildDefaultMaterial(
  nativeRunRef: string,
  status: FakeTerminalStatus,
  at: string,
): AgentResultMaterial {
  const succeeded = status === 'succeeded'

  return {
    native_run_ref: nativeRunRef,
    outcome: status,
    completion: succeeded ? 'complete' : 'none',
    summary: `fake result for ${nativeRunRef}`,
    changed_files: [],
    commands: [],
    validations: [],
    git_state: { available: true, commit_performed: false, push_performed: false },
    artifacts: [],
    native_evidence_refs: [],
    risks: [],
    unresolved_work: succeeded ? [] : ['fake terminal without material'],
    errors: succeeded
      ? []
      : [
          {
            code: 'FAKE_TERMINAL',
            message: 'fake terminal without material',
            retryable: false,
          },
        ],
    finished_at: at,
  }
}

// ---------------------------------------------------------------------------
// FakeAgentPort
// ---------------------------------------------------------------------------

export class FakeAgentPort implements AgentPortV01 {
  readonly protocolVersion = '0.1' as const

  private readonly nativePrefix: string
  private readonly capability: string
  private readonly clock: () => string
  private readonly scenarios: FakeScenario[] = []
  private readonly bindings = new Map<string, FakeBinding>()
  private readonly bindingsByKey = new Map<string, string>()
  private readonly calls: FakeCall[] = []
  private scenarioCursor = 0

  constructor(options: FakeAgentPortOptions = {}) {
    this.nativePrefix = options.native_prefix ?? 'native'
    this.capability = options.capability ?? 'fake'
    this.clock = options.clock ?? DEFAULT_CLOCK
  }

  // -------------------------------------------------------------------------
  // Scripted control surface (F2)
  // -------------------------------------------------------------------------

  /**
   * Appends a scenario. Each submit ATTEMPT consumes one scenario - including an
   * attempt that times out or reports unavailability - so a scenario sequence can
   * express "the first attempt times out, the retry succeeds" (F3.1 / CL-1).
   */
  enqueueScenario(scenario: FakeScenario): void {
    this.scenarios.push(scenario)
  }

  /**
   * Advances one binding by exactly one scenario step (F4). Never throws: an
   * unknown ref yields 'unknown', and a terminal or exhausted binding is a no-op.
   */
  advance(nativeRunRef: string): FakeStatus {
    const binding = this.bindings.get(nativeRunRef)
    if (binding === undefined) return 'unknown'
    if (isTerminalStatus(binding.status)) return binding.status

    const step = binding.steps[binding.next_step_index]
    if (step === undefined) return binding.status

    binding.next_step_index += 1
    binding.status = step.status
    if (isTerminalStep(step)) {
      // A terminal step always carries its material. The fallback only triggers
      // if a caller hands us a malformed step object from untyped JavaScript,
      // and it keeps the fake from ever emitting an invalid material.
      binding.material =
        step.material ??
        buildDefaultMaterial(binding.native_run_ref, step.status, this.clock())
    }
    return binding.status
  }

  /**
   * Injects a fault into an existing binding. Unlike `advance`, an unknown ref
   * throws, because a silently ignored fault is a debugging trap.
   */
  injectFault(nativeRunRef: string, fault: FakeFault): void {
    this.requireBinding(nativeRunRef).faults.add(fault)
  }

  getCalls(): FakeCall[] {
    return this.calls.map(call => ({ ...call }))
  }

  getSideEffectCount(nativeRunRef: string): number {
    return this.bindings.get(nativeRunRef)?.side_effects ?? 0
  }

  getBindingStatus(nativeRunRef: string): FakeStatus | null {
    return this.bindings.get(nativeRunRef)?.status ?? null
  }

  listNativeRefs(): string[] {
    return [...this.bindings.keys()]
  }

  /** Clears the call log and every injected fault. Bindings and counters stay. */
  resetCalls(): void {
    this.calls.length = 0
    for (const binding of this.bindings.values()) binding.faults.clear()
  }

  // -------------------------------------------------------------------------
  // AgentPortV01 (F3)
  // -------------------------------------------------------------------------

  async submitTask(
    _input: AgentSubmissionV01,
    idempotencyKey: string,
    _timeoutMs: number,
  ): Promise<SubmissionReceipt> {
    this.calls.push({ method: 'submitTask', idempotency_key: idempotencyKey })

    const bound = this.bindingsByKey.get(idempotencyKey)
    if (bound !== undefined) return this.receiptFor(bound, idempotencyKey)

    // The scenario is consumed by the ATTEMPT, not by the binding (F3.1). This is
    // what lets a retry after a timeout reach its own scenario instead of hitting
    // the timeout scenario forever.
    const scenario = this.scenarios[this.scenarioCursor] ?? DEFAULT_SCENARIO
    this.scenarioCursor += 1
    const behavior = scenario.submit_behavior ?? 'accept'

    if (behavior === 'timeout') {
      throw new AgentPortError({
        code: 'TIMEOUT',
        message: `fake submission ${idempotencyKey} timed out before any effect`,
        retryable: true,
      })
    }
    if (behavior === 'unavailable') {
      throw new AgentPortError({
        code: 'UNAVAILABLE',
        message: `fake agent is unavailable for submission ${idempotencyKey}`,
        retryable: true,
      })
    }

    const nativeRunRef = `${this.nativePrefix}-${this.bindings.size + 1}`
    const binding: FakeBinding = {
      native_run_ref: nativeRunRef,
      idempotency_key: idempotencyKey,
      status: 'accepted',
      steps: scenario.steps,
      next_step_index: 0,
      material: null,
      side_effects: 1,
      faults: new Set<FakeFault>(),
      cancel_receipts: new Map<string, CancelReceipt>(),
    }
    this.bindings.set(nativeRunRef, binding)
    this.bindingsByKey.set(idempotencyKey, nativeRunRef)

    if (behavior === 'effect_then_lost_ack') {
      throw new AgentPortError({
        code: 'TIMEOUT',
        message: `fake acknowledgement for ${nativeRunRef} was lost after the effect`,
        retryable: true,
      })
    }

    return this.receiptFor(nativeRunRef, idempotencyKey)
  }

  async lookupSubmission(
    idempotencyKey: string,
    _timeoutMs: number,
  ): Promise<SubmissionReceipt | null> {
    this.calls.push({ method: 'lookupSubmission', idempotency_key: idempotencyKey })

    if (this.hasAnyFault('lookup_unavailable')) {
      throw new AgentPortError({
        code: 'UNAVAILABLE',
        message: 'fake submission lookup is unavailable',
        retryable: true,
      })
    }

    const bound = this.bindingsByKey.get(idempotencyKey)
    if (bound === undefined) return null
    return this.receiptFor(bound, idempotencyKey)
  }

  /** Observes only: it never advances a binding, no matter how often it is called. */
  async getStatus(nativeRunRef: string, _timeoutMs: number): Promise<AgentStatusSnapshot> {
    this.calls.push({ method: 'getStatus', native_run_ref: nativeRunRef })

    const binding = this.requireBinding(nativeRunRef)
    if (binding.faults.has('status_unknown')) {
      return { status: 'unknown', observed_at: this.clock() }
    }
    return { status: binding.status, observed_at: this.clock() }
  }

  async collectResult(nativeRunRef: string, _timeoutMs: number): Promise<CollectResultOutcome> {
    this.calls.push({ method: 'collectResult', native_run_ref: nativeRunRef })

    const binding = this.requireBinding(nativeRunRef)
    if (!isTerminalStatus(binding.status)) return { status: 'not_ready' }

    if (binding.faults.has('result_conflicts')) {
      throw new AgentPortError({
        code: 'INTERNAL',
        message: `fake result for ${nativeRunRef} is conflicting`,
        retryable: false,
      })
    }

    // The material is pinned when the terminal step is applied, so repeated
    // collection is deeply equal without this read path mutating any state.
    const material =
      binding.material ??
      buildDefaultMaterial(binding.native_run_ref, binding.status, this.clock())

    return { status: 'ready', material }
  }

  /** Cancelling never changes a binding's status; only `advance` reaches terminal. */
  async cancel(
    nativeRunRef: string,
    idempotencyKey: string,
    _reason: string,
    _timeoutMs: number,
  ): Promise<CancelReceipt> {
    this.calls.push({
      method: 'cancel',
      idempotency_key: idempotencyKey,
      native_run_ref: nativeRunRef,
    })

    const binding = this.requireBinding(nativeRunRef)

    const existing = binding.cancel_receipts.get(idempotencyKey)
    if (existing !== undefined) return existing

    if (binding.faults.has('cancel_ignored')) {
      return {
        native_run_ref: nativeRunRef,
        accepted: false,
        cancelled_at: this.clock(),
      }
    }

    binding.side_effects += 1
    const receipt: CancelReceipt = {
      native_run_ref: nativeRunRef,
      accepted: true,
      cancelled_at: this.clock(),
    }
    // Recorded before the acknowledgement is lost, so a retry with the same key
    // returns this receipt and never applies the effect twice (F6).
    binding.cancel_receipts.set(idempotencyKey, receipt)

    if (binding.faults.has('cancel_effect_then_lost_ack')) {
      throw new AgentPortError({
        code: 'TIMEOUT',
        message: `fake cancel acknowledgement for ${nativeRunRef} was lost after the effect`,
        retryable: true,
      })
    }

    return receipt
  }

  async healthCheck(_timeoutMs: number): Promise<AgentHealth> {
    this.calls.push({ method: 'healthCheck' })
    return {
      protocol_version: '0.1',
      available: true,
      capabilities: [this.capability],
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireBinding(nativeRunRef: string): FakeBinding {
    const binding = this.bindings.get(nativeRunRef)
    if (binding === undefined) {
      throw new AgentPortError({
        code: 'NOT_FOUND',
        message: `unknown native run ref ${nativeRunRef}`,
        retryable: false,
      })
    }
    return binding
  }

  private hasAnyFault(fault: FakeFault): boolean {
    for (const binding of this.bindings.values()) {
      if (binding.faults.has(fault)) return true
    }
    return false
  }

  private receiptFor(nativeRunRef: string, idempotencyKey: string): SubmissionReceipt {
    return {
      native_run_ref: nativeRunRef,
      idempotency_key: idempotencyKey,
      accepted_at: this.clock(),
    }
  }
}
