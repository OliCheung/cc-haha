/**
 * Codex CLI verification adapter.
 *
 * `codex exec` runs an entire turn inside one process and only then exits, so
 * there is no remote handle to poll. The adapter therefore builds its own
 * lifecycle: a durable run record is written before the process starts, the
 * process runs in the background, and the record is finalized when it exits.
 * That is what lets `getStatus` and `collectResult` answer questions at all, and
 * what lets a fresh adapter instance read a run it never started.
 *
 * Two survey findings shape the implementation:
 *   - the terminal state comes from the event stream (`turn.completed` /
 *     `turn.failed`), never from the exit code alone;
 *   - the event stream never reports file changes, so `changed_files` is
 *     collected from git in the run's own worktree.
 *
 * Authorized by task package M3-04.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CommandEvidence, FileChange, GitEvidence, NormalizedError } from '../contracts.js'
import type { Clock } from '../core/workbenchCore.js'
import {
  AgentPortError,
  type AgentHealth,
  type AgentPortV01,
  type AgentResultMaterial,
  type AgentStatusSnapshot,
  type AgentStatusValue,
  type AgentSubmissionV01,
  type CancelReceipt,
  type CollectResultOutcome,
  type SubmissionReceipt,
} from '../ports/agentPort.js'
import { summarizeCodexStream, type CodexStreamSummary } from './codexEventStream.js'
import { createSubmissionIndex } from './submissionIndex.js'
import type { WorkerProcessHost, WorkerRunOutcome, WorkerRunSpec } from './workerProcessHost.js'
import { collectWorktreeEvidence } from './worktreeEvidence.js'

/** The survey measured five reconnect cycles before HTTPS fallback. */
export const MIN_CODEX_TIMEOUT_MS = 180_000

export const DEFAULT_CODEX_TIMEOUT_MS = 180_000

const OUTPUT_EXCERPT_LIMIT = 500

/**
 * `additionalProperties: false` is not optional. A real call rejected a schema
 * without it:
 *
 *   Invalid schema for response_format 'codex_output_schema':
 *   In context=(), 'additionalProperties' is required to be supplied and to be false.
 *
 * Omitting it looks permissive but is in fact the one shape the CLI refuses.
 */
export const CODEX_VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['verdict', 'reason'],
  additionalProperties: false,
} as const

/**
 * The variables a Codex child may receive when the production composition turns
 * on the explicit environment boundary (M5-PRE-006 §15).
 *
 * This is an allowlist, never a `CC_HAHA_*` blocklist: the browser-seam URL and
 * credential, the local/pet access tokens and every provider credential are
 * absent because they are not listed, and a future non-secret runtime variable
 * can be added deliberately. Codex authenticates from its own home
 * (`CODEX_HOME`), not from a server credential, and any provider credential the
 * runtime genuinely needs (for example an env-based provider key) must be added
 * here explicitly rather than inherited by accident.
 */
export const CODEX_CHILD_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'COMSPEC',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'CODEX_HOME',
  'LANG',
  'LC_ALL',
  'NO_COLOR',
]

export type CodexRunStatus = 'running' | 'exited' | 'timed_out' | 'spawn_failed'

export type CodexRunRecord = {
  native_run_ref: string
  submission_key: string
  workspace_dir: string
  submitted_at: string
  status: CodexRunStatus
  exit_code: number | null
  finished_at: string | null
  thread_id: string | null
  stdout_lines: string[]
  stderr: string
  failure_detail: string | null
}

export type CodexAdapterOptions = {
  /** Absolute path to the executable; obtain it from discoverCodexBinary. */
  binary_path: string
  /** Root for durable run records and the submission index. */
  state_dir: string
  /** Root for the schema file and the last-message file. */
  scratch_dir: string
  /** Required: never rely on the CLI's configured default model. */
  model_id: string
  /**
   * Worktree used when the submission carries none.
   *
   * The Core cannot supply one: it is denied any runtime handle (M0-02 §13), and
   * a filesystem path is exactly that. A filesystem-bound adapter therefore owns
   * its own default, and `input.workspace_ref` only overrides it.
   */
  workspace_dir?: string
  /** Optional reasoning effort override. */
  reasoning_effort?: 'low' | 'medium' | 'high'
  /** Verification uses read-only by default. */
  sandbox?: 'read-only' | 'workspace-write'
  /**
   * Enables the explicit child-environment boundary (M5-PRE-006 §13-§15). When
   * supplied, the child process receives exactly these variables — read from the
   * server environment — and nothing else. When omitted, the historical
   * inherited-environment behaviour is unchanged.
   */
  child_env_allowlist?: readonly string[]
  host: WorkerProcessHost
  clock: Clock
  ids: { next(): string }
  /** Raised to MIN_CODEX_TIMEOUT_MS when the caller asks for less. */
  default_timeout_ms?: number
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

function isDurableWorkerOutcome(value: unknown): value is WorkerRunOutcome {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<WorkerRunOutcome>
  const hasValidOutcome =
    candidate.outcome === 'exited' ||
    candidate.outcome === 'timed_out' ||
    candidate.outcome === 'spawn_failed'
  const hasValidExitCode =
    candidate.exit_code === null ||
    (typeof candidate.exit_code === 'number' && Number.isInteger(candidate.exit_code))

  return (
    hasValidOutcome &&
    hasValidExitCode &&
    (candidate.outcome !== 'exited' || typeof candidate.exit_code === 'number') &&
    typeof candidate.stdout === 'string' &&
    typeof candidate.stderr === 'string' &&
    Array.isArray(candidate.lines) &&
    candidate.lines.every(line => typeof line === 'string') &&
    typeof candidate.duration_ms === 'number' &&
    Number.isFinite(candidate.duration_ms) &&
    (candidate.failure_detail === null || typeof candidate.failure_detail === 'string')
  )
}

/**
 * The reference is embedded in a file name, and the `:` separator is not a legal
 * file name character on Windows.
 */
export function sanitizeRunRef(nativeRunRef: string): string {
  return nativeRunRef.split('').map(char => (/[A-Za-z0-9._-]/.test(char) ? char : '-')).join('')
}

function excerpt(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text
}

/**
 * M5-PRE-006 §13-§15. Without an allowlist the child inherits the server
 * environment exactly as before; with one it receives only the listed variables,
 * so no server credential can reach the CLI by accident.
 */
function childEnvironmentFor(
  allowlist: readonly string[] | undefined,
): Pick<WorkerRunSpec, 'env' | 'env_mode'> {
  if (allowlist === undefined) return {}
  const env: Record<string, string> = {}
  for (const name of allowlist) {
    const value = process.env[name]
    if (typeof value === 'string' && value.length > 0) env[name] = value
  }
  return { env, env_mode: 'replace' }
}

export function createCodexAdapter(options: CodexAdapterOptions): AgentPortV01 {
  const {
    binary_path: binaryPath,
    state_dir: stateDir,
    scratch_dir: scratchDir,
    model_id: modelId,
    workspace_dir: workspaceDirOption,
    reasoning_effort: reasoningEffort,
    sandbox = 'read-only',
    child_env_allowlist: childEnvAllowlist,
    host,
    clock,
    ids,
  } = options

  const effectiveTimeoutMs = Math.max(
    MIN_CODEX_TIMEOUT_MS,
    options.default_timeout_ms ?? DEFAULT_CODEX_TIMEOUT_MS,
  )

  const runsDir = join(stateDir, 'runs')
  const indexPath = join(stateDir, 'submissions.json')
  const index = createSubmissionIndex({ file_path: indexPath, clock })
  const activeNativeRunRefs = new Set<string>()

  const recordPath = (nativeRunRef: string): string =>
    join(runsDir, `${sanitizeRunRef(nativeRunRef)}.json`)
  const outcomePath = (nativeRunRef: string): string =>
    join(runsDir, `${sanitizeRunRef(nativeRunRef)}.outcome.json`)

  const readRecord = (nativeRunRef: string): CodexRunRecord | null => {
    const path = recordPath(nativeRunRef)
    if (!existsSync(path)) return null
    // A record that exists but cannot be read is an internal fault, not an absent
    // run: reporting NOT_FOUND would hide a lost result.
    return JSON.parse(readFileSync(path, 'utf8')) as CodexRunRecord
  }

  const writeRecord = (record: CodexRunRecord): void => {
    mkdirSync(runsDir, { recursive: true })
    const path = recordPath(record.native_run_ref)
    const temporary = `${path}.tmp`
    writeFileSync(temporary, JSON.stringify(record, null, 2), 'utf8')
    renameSync(temporary, path)
  }

  const readRecordOrThrow = (nativeRunRef: string): CodexRunRecord | null => {
    try {
      return readRecord(nativeRunRef)
    } catch (error) {
      throw new AgentPortError({
        code: 'INTERNAL',
        message: `codex run record for ${nativeRunRef} is unreadable: ${describeError(error)}`,
        retryable: false,
      })
    }
  }

  const notFound = (nativeRunRef: string): AgentPortError =>
    new AgentPortError({
      code: 'NOT_FOUND',
      message: `no codex run record for ${nativeRunRef}`,
      retryable: false,
    })

  const finalize = (nativeRunRef: string, outcome: WorkerRunOutcome): void => {
    let current: CodexRunRecord | null
    try {
      current = readRecord(nativeRunRef)
    } catch {
      return
    }
    if (current === null) return

    const summary = summarizeCodexStream(outcome.lines)

    writeRecord({
      ...current,
      status: outcome.outcome,
      exit_code: outcome.exit_code,
      finished_at: clock.now(),
      thread_id: summary.thread_id,
      stdout_lines: outcome.lines,
      stderr: outcome.stderr,
      failure_detail: outcome.failure_detail,
    })
  }

  const importDurableOutcome = (
    nativeRunRef: string,
    record: CodexRunRecord,
  ): CodexRunRecord => {
    if (record.status !== 'running') return record
    const path = outcomePath(nativeRunRef)
    if (!existsSync(path)) return record

    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    } catch {
      return record
    }
    if (!isDurableWorkerOutcome(parsed)) return record

    try {
      finalize(nativeRunRef, parsed)
      return readRecord(nativeRunRef) ?? record
    } catch {
      // A failed durable-record write leaves the Run unknown; it cannot prove a
      // terminal business outcome to the Core.
      return record
    }
  }

  /**
   * Derives the coarse status the same way `collectResult` derives the outcome,
   * so a poll can never claim success for a turn that failed inside a zero exit.
   */
  const statusFor = (record: CodexRunRecord, summary: CodexStreamSummary): AgentStatusValue => {
    if (record.status === 'running') return 'running'
    if (record.status === 'timed_out') return 'timed_out'
    if (record.status === 'spawn_failed') return 'failed'
    if (record.exit_code !== 0) return 'failed'
    return summary.termination === 'completed' ? 'succeeded' : 'failed'
  }

  const outcomeFor = (
    record: CodexRunRecord,
    summary: CodexStreamSummary,
  ): { outcome: AgentResultMaterial['outcome']; completion: AgentResultMaterial['completion'] } => {
    if (record.status === 'timed_out') return { outcome: 'timed_out', completion: 'partial' }
    if (record.status === 'spawn_failed') return { outcome: 'failed', completion: 'none' }
    if (record.exit_code !== 0) return { outcome: 'failed', completion: 'partial' }
    if (summary.termination === 'completed') return { outcome: 'succeeded', completion: 'complete' }
    return { outcome: 'failed', completion: 'partial' }
  }

  const buildRisks = (
    record: CodexRunRecord,
    summary: CodexStreamSummary,
    gitState: GitEvidence,
  ): string[] => {
    const risks: string[] = []

    if (summary.termination === 'incomplete') {
      risks.push('the event stream ended without a terminal event')
    }
    if (summary.unparsed_line_count > 0) {
      risks.push(`${String(summary.unparsed_line_count)} output lines could not be parsed as JSON`)
    }
    if (summary.notices.length > 0) {
      risks.push(
        `${String(summary.notices.length)} non-fatal notices were observed (network reconnects or transport fallback)`,
      )
    }
    if (!gitState.available) {
      risks.push(
        `changed files could not be collected: ${gitState.unavailable_reason ?? 'unknown reason'}`,
      )
    }
    if (record.status === 'timed_out') {
      risks.push('the run exceeded its wall-clock budget and was killed')
    }

    return risks
  }

  const buildErrors = (record: CodexRunRecord, summary: CodexStreamSummary): NormalizedError[] => {
    const errors: NormalizedError[] = []

    if (record.status === 'timed_out') {
      errors.push({
        code: 'CODEX_TIMEOUT',
        message: `codex did not finish within ${String(effectiveTimeoutMs)}ms`,
        retryable: true,
      })
    }
    if (record.status === 'spawn_failed') {
      errors.push({
        code: 'CODEX_SPAWN_FAILED',
        message: record.failure_detail ?? 'codex could not be launched',
        retryable: true,
      })
    }
    if (summary.termination === 'failed') {
      errors.push({
        code: 'CODEX_TURN_FAILED',
        message: summary.failure_reason ?? 'the turn failed without a reason',
        retryable: false,
      })
    }

    return errors
  }

  const buildSummaryText = (summary: CodexStreamSummary): string => {
    if (summary.final_message !== null && summary.final_message.length > 0) {
      return summary.final_message
    }
    if (summary.failure_reason !== null && summary.failure_reason.length > 0) {
      return summary.failure_reason
    }
    return 'codex produced no final message'
  }

  const buildArgv = (
    goal: string,
    workspaceDir: string,
    schemaPath: string,
    lastMessagePath: string,
  ): string[] => {
    const args = [
      'exec',
      '--json',
      '--color',
      'never',
      '-m',
      modelId,
      '-C',
      workspaceDir,
      '-s',
      sandbox,
      '--skip-git-repo-check',
    ]

    if (reasoningEffort !== undefined) {
      args.push('-c', `model_reasoning_effort=${reasoningEffort}`)
    }

    args.push('--output-schema', schemaPath, '-o', lastMessagePath, goal)
    return args
  }

  return {
    protocolVersion: '0.1',

    async submitTask(
      input: AgentSubmissionV01,
      idempotencyKey: string,
      _timeoutMs: number,
    ): Promise<SubmissionReceipt> {
      const workspaceDir = input.workspace_ref ?? workspaceDirOption
      if (typeof workspaceDir !== 'string' || workspaceDir.length === 0) {
        throw new AgentPortError({
          code: 'INVALID_REQUEST',
          message: 'no worktree: neither workspace_ref nor the workspace_dir option was provided',
          retryable: false,
        })
      }

      const nativeRunRef = `codex:${ids.next()}`
      const sanitized = sanitizeRunRef(nativeRunRef)
      const schemaPath = join(scratchDir, `${sanitized}-schema.json`)
      const lastMessagePath = join(scratchDir, `${sanitized}-last.json`)

      // The marker lands before the side effect, so a crash between the spawn and
      // the acknowledgement still leaves evidence that a submission happened.
      let reservation: Awaited<ReturnType<typeof index.record>>
      try {
        reservation = await index.record({
          submission_key: idempotencyKey,
          native_ref: nativeRunRef,
          session_ref: null,
          accepted_at: clock.now(),
        })
      } catch (error) {
        throw new AgentPortError({
          code: 'UNAVAILABLE',
          message: `submission index could not record the request: ${describeError(error)}`,
          retryable: true,
        })
      }
      if (!reservation.created) {
        return {
          native_run_ref: reservation.marker.native_ref,
          idempotency_key: reservation.marker.submission_key,
          accepted_at: reservation.marker.accepted_at,
        }
      }

      mkdirSync(scratchDir, { recursive: true })
      // Written without a BOM: the survey recorded that the CLI rejects one.
      writeFileSync(schemaPath, JSON.stringify(CODEX_VERDICT_SCHEMA, null, 2), 'utf8')

      writeRecord({
        native_run_ref: nativeRunRef,
        submission_key: idempotencyKey,
        workspace_dir: workspaceDir,
        submitted_at: clock.now(),
        status: 'running',
        exit_code: null,
        finished_at: null,
        thread_id: null,
        stdout_lines: [],
        stderr: '',
        failure_detail: null,
      })

      const spec: WorkerRunSpec = {
        executable: binaryPath,
        args: buildArgv(input.goal, workspaceDir, schemaPath, lastMessagePath),
        cwd: workspaceDir,
        // The CLI reads stdin whenever it is a pipe, so it has to be closed.
        stdin: null,
        timeout_ms: effectiveTimeoutMs,
        durable_outcome_path: outcomePath(nativeRunRef),
        ...childEnvironmentFor(childEnvAllowlist),
      }

      // This instance can attest that a run is active only while it owns the
      // process-host promise. A later adapter instance must treat a durable
      // `running` record as unknown rather than assume its child still exists.
      activeNativeRunRefs.add(nativeRunRef)
      const finalizeAndRelease = (outcome: WorkerRunOutcome): void => {
        try {
          finalize(nativeRunRef, outcome)
        } finally {
          activeNativeRunRefs.delete(nativeRunRef)
        }
      }
      const releaseWithoutOutcome = (): void => {
        activeNativeRunRefs.delete(nativeRunRef)
      }

      // Deliberately not awaited: a whole turn runs inside this one process.
      try {
        void host.run(spec).then(
          finalizeAndRelease,
          releaseWithoutOutcome,
        )
      } catch {
        releaseWithoutOutcome()
      }

      return {
        native_run_ref: nativeRunRef,
        idempotency_key: idempotencyKey,
        accepted_at: clock.now(),
      }
    },

    async lookupSubmission(
      idempotencyKey: string,
      _timeoutMs: number,
    ): Promise<SubmissionReceipt | null> {
      let marker: Awaited<ReturnType<typeof index.lookup>>
      try {
        marker = await index.lookup(idempotencyKey)
      } catch (error) {
        // Absence cannot be proven from an unreadable index, and treating that as
        // "never submitted" is exactly the resubmission the design forbids.
        throw new AgentPortError({
          code: 'UNAVAILABLE',
          message: `submission index is unreadable: ${describeError(error)}`,
          retryable: true,
        })
      }

      if (marker === null) return null

      return {
        native_run_ref: marker.native_ref,
        idempotency_key: marker.submission_key,
        accepted_at: marker.accepted_at,
      }
    },

    async getStatus(nativeRunRef: string, _timeoutMs: number): Promise<AgentStatusSnapshot> {
      const storedRecord = readRecordOrThrow(nativeRunRef)
      if (storedRecord === null) throw notFound(nativeRunRef)
      const record = importDurableOutcome(nativeRunRef, storedRecord)

      const summary = summarizeCodexStream(record.stdout_lines)
      const status =
        record.status === 'running' && !activeNativeRunRefs.has(nativeRunRef)
          ? 'unknown'
          : statusFor(record, summary)

      return {
        status,
        observed_at: clock.now(),
      }
    },

    async collectResult(
      nativeRunRef: string,
      timeoutMs: number,
    ): Promise<CollectResultOutcome> {
      const storedRecord = readRecordOrThrow(nativeRunRef)
      if (storedRecord === null) throw notFound(nativeRunRef)
      const record = importDurableOutcome(nativeRunRef, storedRecord)
      if (record.status === 'running') return { status: 'not_ready' }

      const summary = summarizeCodexStream(record.stdout_lines)

      // The event stream never reports file changes, so the worktree is asked.
      const evidence = await collectWorktreeEvidence({
        worktree_dir: record.workspace_dir,
        host,
        timeout_ms: timeoutMs,
      })

      const { outcome, completion } = outcomeFor(record, summary)

      const commands: CommandEvidence[] = summary.command_executions.map(entry => ({
        command: entry.command,
        exit_code: entry.exit_code,
        ...(entry.aggregated_output.length > 0
          ? { output_excerpt: excerpt(entry.aggregated_output, OUTPUT_EXCERPT_LIMIT) }
          : {}),
      }))

      const material: AgentResultMaterial = {
        native_run_ref: nativeRunRef,
        outcome,
        completion,
        summary: buildSummaryText(summary),
        changed_files: evidence.changed_files,
        commands,
        // Codex produces no validation evidence; the verdict lives in the summary.
        validations: [],
        git_state: evidence.git_state,
        artifacts: [],
        native_evidence_refs: [{ kind: 'codex_run_record', ref: recordPath(nativeRunRef) }],
        risks: buildRisks(record, summary, evidence.git_state),
        unresolved_work:
          completion === 'complete'
            ? []
            : [`the run finished with completion "${completion}"`],
        errors: buildErrors(record, summary),
        started_at: record.submitted_at,
        finished_at: record.finished_at ?? clock.now(),
      }

      return { status: 'ready', material }
    },

    async cancel(
      nativeRunRef: string,
      _idempotencyKey: string,
      _reason: string,
      _timeoutMs: number,
    ): Promise<CancelReceipt> {
      const record = readRecordOrThrow(nativeRunRef)
      if (record === null) throw notFound(nativeRunRef)

      // The M3-01 host does not hand back a process handle, so a live run cannot
      // be killed from here. Claiming otherwise would be a false acceptance.
      return {
        native_run_ref: nativeRunRef,
        accepted: false,
        cancelled_at: clock.now(),
      }
    },

    async healthCheck(_timeoutMs: number): Promise<AgentHealth> {
      const available = existsSync(binaryPath)

      return {
        protocol_version: '0.1',
        available,
        // M5-PRE-006 §12 (D1 = A): `session_resume` is declared because the frozen
        // M3-04 capability contract requires this set; the current argv
        // construction does not independently demonstrate full resume behaviour,
        // so the declaration is a contract requirement rather than implementation
        // evidence. Recorded, not removed and not faked.
        capabilities: ['verified_verdict', 'session_resume'],
        ...(available ? {} : { detail: `no codex binary at ${binaryPath}` }),
      }
    },
  }
}
