/**
 * CodeBuddy CLI adapter, offline portion.
 *
 * The lifecycle is complete and CLI-shape independent: a durable run record is
 * written before the process starts, the process runs in the background, and the
 * record is finalized when it exits. That is the same design the Codex adapter
 * uses, and for the same reason: the CLI runs a whole turn inside one process.
 *
 * What is deliberately missing is result parsing. The shape of
 * `--output-format json` has not been captured from a real call, because the CLI
 * is not authenticated. Rather than guess a shape, this adapter reports itself
 * unavailable and refuses to produce a material.
 *
 * Authorized by task package M3-02A.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Clock } from '../core/workbenchCore.js'
import {
  AgentPortError,
  type AgentHealth,
  type AgentPortV01,
  type AgentStatusSnapshot,
  type AgentStatusValue,
  type AgentSubmissionV01,
  type CancelReceipt,
  type CollectResultOutcome,
  type SubmissionReceipt,
} from '../ports/agentPort.js'
import { createSubmissionIndex } from './submissionIndex.js'
import type { WorkerProcessHost, WorkerRunOutcome, WorkerRunSpec } from './workerProcessHost.js'
import {
  buildCodeBuddyInvocation,
  type CodeBuddyPermissionMode,
} from './codebuddyInvocation.js'

/**
 * The reason an adapter that cannot yet parse results reports itself
 * unavailable. Kept as a constant so the tests assert the same wording.
 */
export const RESULT_PARSER_PENDING =
  'result parsing is pending: the shape of --output-format json has not been captured from a real call'

export type CodeBuddyRunStatus = 'running' | 'exited' | 'timed_out' | 'spawn_failed'

export type CodeBuddyRunRecord = {
  native_run_ref: string
  submission_key: string
  workspace_dir: string
  submitted_at: string
  status: CodeBuddyRunStatus
  exit_code: number | null
  finished_at: string | null
  stdout_lines: string[]
  stderr: string
  failure_detail: string | null
}

export type CodeBuddyAdapterOptions = {
  /** Absolute path to the CLI entry, a Node script. */
  cli_entry: string
  /** Absolute path to a Node executable able to run that script. */
  node_executable: string
  /** Root for durable run records and the submission index. */
  state_dir: string
  /** Working directory for the CLI process. */
  workspace_dir: string
  /** Required: the CLI default is never relied upon. */
  model: string
  /** Defaults to the verification-side plan mode. */
  permission_mode?: CodeBuddyPermissionMode
  /** Tool restrictions; used to keep the verification side read-only. */
  disallowed_tools?: string[]
  host: WorkerProcessHost
  clock: Clock
  ids: { next(): string }
  default_timeout_ms?: number
}

export const DEFAULT_CODEBUDDY_TIMEOUT_MS = 180_000

/** The reference is embedded in a file name, and `:` is not legal on Windows. */
export function sanitizeCodeBuddyRef(nativeRunRef: string): string {
  return nativeRunRef
    .split('')
    .map(char => (/[A-Za-z0-9._-]/.test(char) ? char : '-'))
    .join('')
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

export function createCodeBuddyAdapter(options: CodeBuddyAdapterOptions): AgentPortV01 {
  const {
    cli_entry: cliEntry,
    node_executable: nodeExecutable,
    state_dir: stateDir,
    workspace_dir: workspaceDirOption,
    model: model,
    permission_mode: permissionMode,
    disallowed_tools: disallowedTools,
    host,
    clock,
    ids,
  } = options

  const timeoutMs = Math.max(1, options.default_timeout_ms ?? DEFAULT_CODEBUDDY_TIMEOUT_MS)

  const runsDir = join(stateDir, 'runs')
  const index = createSubmissionIndex({
    file_path: join(stateDir, 'submissions.json'),
    clock,
  })

  const recordPath = (nativeRunRef: string): string =>
    join(runsDir, `${sanitizeCodeBuddyRef(nativeRunRef)}.json`)

  const readRecord = (nativeRunRef: string): CodeBuddyRunRecord | null => {
    const path = recordPath(nativeRunRef)
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8')) as CodeBuddyRunRecord
  }

  const writeRecord = (record: CodeBuddyRunRecord): void => {
    mkdirSync(runsDir, { recursive: true })
    const path = recordPath(record.native_run_ref)
    const temporary = `${path}.tmp`
    writeFileSync(temporary, JSON.stringify(record, null, 2), 'utf8')
    renameSync(temporary, path)
  }

  const readRecordOrThrow = (nativeRunRef: string): CodeBuddyRunRecord | null => {
    try {
      return readRecord(nativeRunRef)
    } catch (error) {
      throw new AgentPortError({
        code: 'INTERNAL',
        message: `codebuddy run record for ${nativeRunRef} is unreadable: ${describeError(error)}`,
        retryable: false,
      })
    }
  }

  const notFound = (nativeRunRef: string): AgentPortError =>
    new AgentPortError({
      code: 'NOT_FOUND',
      message: `no codebuddy run record for ${nativeRunRef}`,
      retryable: false,
    })

  const finalize = (nativeRunRef: string, outcome: WorkerRunOutcome): void => {
    let current: CodeBuddyRunRecord | null
    try {
      current = readRecord(nativeRunRef)
    } catch {
      return
    }
    if (current === null) return

    writeRecord({
      ...current,
      status: outcome.outcome,
      exit_code: outcome.exit_code,
      finished_at: clock.now(),
      stdout_lines: outcome.lines,
      stderr: outcome.stderr,
      failure_detail: outcome.failure_detail,
    })
  }

  const statusFor = (record: CodeBuddyRunRecord): AgentStatusValue => {
    if (record.status === 'running') return 'running'
    if (record.status === 'timed_out') return 'timed_out'
    if (record.status === 'spawn_failed') return 'failed'
    // Provisional: without a parsed result this reflects the process verdict
    // only. The authoritative outcome belongs to collectResult.
    return record.exit_code === 0 ? 'succeeded' : 'failed'
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

      const nativeRunRef = `codebuddy:${ids.next()}`
      const invocation = buildCodeBuddyInvocation({
        node_executable: nodeExecutable,
        cli_entry: cliEntry,
        goal: input.goal,
        workspace_dir: workspaceDir,
        model,
        timeout_ms: timeoutMs,
        ...(permissionMode === undefined ? {} : { permission_mode: permissionMode }),
        ...(disallowedTools === undefined ? {} : { disallowed_tools: disallowedTools }),
      })

      // The marker lands before the side effect, so a crash afterwards still
      // leaves evidence that a submission happened.
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

      writeRecord({
        native_run_ref: nativeRunRef,
        submission_key: idempotencyKey,
        workspace_dir: workspaceDir,
        submitted_at: clock.now(),
        status: 'running',
        exit_code: null,
        finished_at: null,
        stdout_lines: [],
        stderr: '',
        failure_detail: null,
      })

      const spec: WorkerRunSpec = {
        executable: invocation.node_executable,
        args: [invocation.cli_entry, ...invocation.args],
        cwd: invocation.cwd,
        // A Node script with no piped input must not wait on an open channel.
        stdin: null,
        timeout_ms: invocation.timeout_ms,
      }

      // Deliberately not awaited: a whole turn runs inside this one process.
      void host.run(spec).then(
        outcome => {
          finalize(nativeRunRef, outcome)
        },
        error => {
          finalize(nativeRunRef, {
            outcome: 'spawn_failed',
            exit_code: null,
            stdout: '',
            stderr: '',
            lines: [],
            duration_ms: 0,
            failure_detail: describeError(error),
          })
        },
      )

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
      const record = readRecordOrThrow(nativeRunRef)
      if (record === null) throw notFound(nativeRunRef)

      return { status: statusFor(record), observed_at: clock.now() }
    },

    async collectResult(
      _nativeRunRef: string,
      _timeoutMs: number,
    ): Promise<CollectResultOutcome> {
      throw new AgentPortError({
        code: 'UNSUPPORTED_CAPABILITY',
        message: RESULT_PARSER_PENDING,
        retryable: false,
      })
    },

    async cancel(
      nativeRunRef: string,
      _idempotencyKey: string,
      _reason: string,
      _timeoutMs: number,
    ): Promise<CancelReceipt> {
      const record = readRecordOrThrow(nativeRunRef)
      if (record === null) throw notFound(nativeRunRef)

      // Terminating a live run is not implemented: the process host exposes no
      // handle, and the CLI's own session kill has not been proven for one-shot
      // print invocations. Claiming otherwise would be a false acceptance.
      return {
        native_run_ref: nativeRunRef,
        accepted: false,
        cancelled_at: clock.now(),
      }
    },

    async healthCheck(_timeoutMs: number): Promise<AgentHealth> {
      const entryPresent = existsSync(cliEntry)
      const nodePresent = existsSync(nodeExecutable)

      const missing: string[] = []
      if (!entryPresent) missing.push(`CLI entry ${cliEntry}`)
      if (!nodePresent) missing.push(`Node runtime ${nodeExecutable}`)

      return {
        protocol_version: '0.1',
        // Unavailable until a result can actually be produced, so the Core cannot
        // route work here by mistake.
        available: false,
        capabilities: ['json_output', 'background_run_record'],
        detail:
          missing.length > 0
            ? `missing ${missing.join(' and ')}`
            : RESULT_PARSER_PENDING,
      }
    },
  }
}
