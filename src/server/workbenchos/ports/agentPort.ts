/**
 * WorkbenchOS AgentPort V0.1.
 *
 * Boundary rule (M0-02 §13): the core sees only normalized receipts, statuses
 * and results. No vendor wire data, no runtime handles.
 *
 * Authorized by task package M1-001-P1.
 */

import type {
  CommandEvidence,
  EvidenceRef,
  FileChange,
  GitEvidence,
  NormalizedError,
  ValidationEvidence,
  ValidationRequirement,
} from '../contracts.js'

export type AgentSubmissionV01 = {
  task_id: string
  run_id: string
  agent_id: string
  model_id?: string
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
  workspace_ref?: string
}

export type SubmissionReceipt = {
  native_run_ref: string
  idempotency_key: string
  accepted_at: string
}

export type AgentStatusValue =
  | 'accepted'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'unknown'

export type AgentStatusSnapshot = {
  status: AgentStatusValue
  observed_at: string
  evidence_ref?: EvidenceRef
}

export type AgentResultMaterial = {
  native_run_ref: string
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'timed_out'
  completion: 'complete' | 'partial' | 'none'
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
  started_at?: string
  finished_at: string
}

export type CancelReceipt = {
  native_run_ref: string
  accepted: boolean
  cancelled_at: string
}

/**
 * `collectResult` wraps the material in an outcome object so that "not ready"
 * can never be confused with a result whose own fields are absent.
 */
export type CollectResultOutcome =
  | { status: 'ready'; material: AgentResultMaterial }
  | { status: 'not_ready' }

export type AgentHealth = {
  protocol_version: '0.1'
  available: boolean
  capabilities: string[]
  detail?: string
}

export type AgentPortErrorCode =
  | 'VERSION_MISMATCH'
  | 'INVALID_REQUEST'
  | 'IDEMPOTENCY_CONFLICT'
  | 'NOT_FOUND'
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'PERMISSION_REQUIRED'
  | 'UNSUPPORTED_CAPABILITY'
  | 'INTERNAL'

/**
 * The only error type an AgentPort implementation may throw.
 */
export class AgentPortError extends Error {
  readonly code: AgentPortErrorCode
  readonly retryable: boolean
  readonly evidenceRef?: EvidenceRef

  constructor(input: {
    code: AgentPortErrorCode
    message: string
    retryable: boolean
    evidenceRef?: EvidenceRef
  }) {
    super(input.message)
    this.name = 'AgentPortError'
    this.code = input.code
    this.retryable = input.retryable
    this.evidenceRef = input.evidenceRef
  }
}

export interface AgentPortV01 {
  readonly protocolVersion: '0.1'

  submitTask(
    input: AgentSubmissionV01,
    idempotencyKey: string,
    timeoutMs: number,
  ): Promise<SubmissionReceipt>

  lookupSubmission(
    idempotencyKey: string,
    timeoutMs: number,
  ): Promise<SubmissionReceipt | null>

  getStatus(
    nativeRunRef: string,
    timeoutMs: number,
  ): Promise<AgentStatusSnapshot>

  collectResult(
    nativeRunRef: string,
    timeoutMs: number,
  ): Promise<CollectResultOutcome>

  cancel(
    nativeRunRef: string,
    idempotencyKey: string,
    reason: string,
    timeoutMs: number,
  ): Promise<CancelReceipt>

  healthCheck(timeoutMs: number): Promise<AgentHealth>
}
