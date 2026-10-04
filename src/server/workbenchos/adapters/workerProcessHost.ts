import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Generic subprocess host shared by the external CLI adapters.
 *
 * It knows nothing about any particular CLI: it launches an executable, closes or
 * feeds stdin, enforces a wall-clock budget, bounds the captured output, and
 * reports a structured outcome instead of throwing.
 *
 * The timer use in this module is the explicit exemption recorded in task package
 * M3-01 §6.3: a host that cannot bound a child's runtime is not a host. The
 * "no timer" rule elsewhere exists to keep deterministic fakes deterministic; it
 * does not apply to real process plumbing.
 *
 * Authorized by task package M3-01.
 */

/**
 * How a run's `env` relates to the inherited server environment.
 *
 * `'inherit'` (the default) keeps the documented merge semantics. `'replace'` is
 * opt-in and hands the child exactly `spec.env`, which is how a caller
 * establishes an explicit environment boundary (M5-PRE-006 §14). Existing
 * callers that never set `env_mode` keep their behaviour unchanged.
 */
export type WorkerEnvironmentMode = 'inherit' | 'replace'

export type WorkerRunSpec = {
  /** Executable to launch. An absolute path is preferred over a bare name. */
  executable: string
  args: string[]
  /** Working directory for the child process. */
  cwd: string
  /**
   * Text piped to the child's stdin, or `null` to close stdin immediately.
   *
   * Closing it is not optional: `codex exec` reads stdin whenever it is a pipe,
   * so an stdin left open can block the child forever.
   */
  stdin: string | null
  /** Wall-clock budget. The child is killed when it expires. */
  timeout_ms: number
  /** Extra environment entries merged over the inherited environment. */
  env?: Record<string, string>
  /**
   * Defaults to `'inherit'`. `'replace'` gives the child exactly `env` — an
   * empty object when no `env` is supplied — instead of the inherited server
   * environment.
   */
  env_mode?: WorkerEnvironmentMode
  /** Optional durable path for the terminal outcome evidence. */
  durable_outcome_path?: string
}

export type WorkerOutcomeKind = 'exited' | 'timed_out' | 'spawn_failed'

export type WorkerRunOutcome = {
  outcome: WorkerOutcomeKind
  /** Null when the child never ran or was killed before reporting a code. */
  exit_code: number | null
  stdout: string
  stderr: string
  /** stdout split into lines, with empty lines removed, in order. */
  lines: string[]
  /** Real elapsed milliseconds. */
  duration_ms: number
  /** Populated only when `outcome === 'spawn_failed'`. */
  failure_detail: string | null
}

export interface WorkerProcessHost {
  run(spec: WorkerRunSpec): Promise<WorkerRunOutcome>
}

export type WorkerProcessHostOptions = {
  /**
   * Maximum bytes retained per stream. Output beyond this is dropped and the
   * captured text ends with a truncation marker.
   */
  max_output_bytes?: number
}

export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024

const TRUNCATION_MARKER = '\n[truncated]'

/**
 * Reads a stream, retaining at most `limit` bytes but always draining to the
 * end. Draining matters: a child that writes past the pipe buffer would block
 * forever if we stopped reading after hitting the cap.
 */
async function readBounded(
  stream: ReadableStream<Uint8Array> | undefined,
  limit: number,
): Promise<string> {
  if (stream === undefined) return ''

  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let text = ''
  let retained = 0
  let truncated = false

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue

    if (retained + value.byteLength > limit) {
      const remaining = Math.max(0, limit - retained)
      if (remaining > 0) {
        text += decoder.decode(value.subarray(0, remaining), { stream: true })
        retained += remaining
      }
      truncated = true
      continue
    }

    retained += value.byteLength
    text += decoder.decode(value, { stream: true })
  }

  text += decoder.decode()
  return truncated ? `${text}${TRUNCATION_MARKER}` : text
}

function toLines(text: string): string[] {
  return text.split(/\r?\n/).filter(line => line.length > 0)
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/**
 * M5-PRE-006 §14. `'inherit'` is the historical behaviour and stays the default;
 * `'replace'` is the minimal, backwards-compatible way for a caller to express
 * an explicit child environment instead of an inherited one.
 */
function resolveChildEnvironment(spec: WorkerRunSpec): { env?: Record<string, string> } {
  if (spec.env_mode === 'replace') return { env: { ...spec.env } }
  return spec.env === undefined ? {} : { env: { ...process.env, ...spec.env } }
}

export function createWorkerProcessHost(
  options: WorkerProcessHostOptions = {},
): WorkerProcessHost {
  const maxOutputBytes = options.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES

  return {
    async run(spec: WorkerRunSpec): Promise<WorkerRunOutcome> {
      if (spec.durable_outcome_path !== undefined) {
        return runWithSupervisor(spec, maxOutputBytes)
      }

      return runWorkerProcess(spec, maxOutputBytes)
    },
  }
}

/** Executes one process in the current host; used directly and by the supervisor. */
export async function runWorkerProcess(
  spec: Omit<WorkerRunSpec, 'durable_outcome_path'>,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
): Promise<WorkerRunOutcome> {
  const startedAt = performance.now()
  const elapsed = () => Math.round(performance.now() - startedAt)

  const spawnFailed = (error: unknown): WorkerRunOutcome => ({
    outcome: 'spawn_failed',
    exit_code: null,
    stdout: '',
    stderr: '',
    lines: [],
    duration_ms: elapsed(),
    failure_detail: describeError(error),
  })

  let child: Bun.Subprocess<'pipe', 'pipe', 'pipe'>
  try {
    child = Bun.spawn([spec.executable, ...spec.args], {
      cwd: spec.cwd,
      // Always a pipe, so that "no input" is expressed by closing it rather
      // than by leaving an open channel the child keeps waiting on.
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      ...resolveChildEnvironment(spec),
    })
  } catch (error) {
    return spawnFailed(error)
  }

  try {
    if (spec.stdin === null) {
      child.stdin.end()
    } else {
      child.stdin.write(spec.stdin)
      child.stdin.end()
    }
  } catch {
    // A child that exits before reading stdin is not a host failure.
  }

  // Start draining immediately so a chatty child never blocks on a full pipe.
  const stdoutPromise = readBounded(child.stdout, maxOutputBytes).catch(() => '')
  const stderrPromise = readBounded(child.stderr, maxOutputBytes).catch(() => '')

  const timer = AbortSignal.timeout(spec.timeout_ms)
  const timedOutPromise = new Promise<'timed_out'>(resolve => {
    timer.addEventListener('abort', () => resolve('timed_out'), { once: true })
  })

  let timedOut = false
  let exitCode: number | null = null

  try {
    const winner = await Promise.race([
      child.exited.then((code): 'exited' | 'timed_out' => {
        exitCode = code
        return 'exited'
      }),
      timedOutPromise,
    ])

    if (winner === 'timed_out') {
      timedOut = true
      child.kill()
      exitCode = await child.exited
    }
  } catch (error) {
    // Bun surfaces a missing executable as a rejection from `exited`.
    try {
      child.kill()
    } catch {
      // Nothing to kill when the spawn itself failed.
    }
    await Promise.all([stdoutPromise, stderrPromise])
    return spawnFailed(error)
  }

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])

  return {
    outcome: timedOut ? 'timed_out' : 'exited',
    exit_code: exitCode,
    stdout,
    stderr,
    lines: toLines(stdout),
    duration_ms: elapsed(),
    failure_detail: null,
  }
}

function isWorkerRunOutcome(value: unknown): value is WorkerRunOutcome {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<WorkerRunOutcome>
  return (
    (candidate.outcome === 'exited' ||
      candidate.outcome === 'timed_out' ||
      candidate.outcome === 'spawn_failed') &&
    (candidate.exit_code === null || typeof candidate.exit_code === 'number') &&
    typeof candidate.stdout === 'string' &&
    typeof candidate.stderr === 'string' &&
    Array.isArray(candidate.lines) &&
    candidate.lines.every(line => typeof line === 'string') &&
    typeof candidate.duration_ms === 'number' &&
    (candidate.failure_detail === null || typeof candidate.failure_detail === 'string')
  )
}

async function runWithSupervisor(
  spec: WorkerRunSpec,
  maxOutputBytes: number,
): Promise<WorkerRunOutcome> {
  const outcomePath = spec.durable_outcome_path
  if (outcomePath === undefined) throw new Error('durable outcome path is required')
  if (existsSync(outcomePath)) throw new Error('durable outcome path already exists')
  const workerSpec = { ...spec }
  delete workerSpec.durable_outcome_path
  const supervisorPath = fileURLToPath(new URL('./workerSupervisor.ts', import.meta.url))
  const supervisorArgs = existsSync(supervisorPath)
    ? [supervisorPath]
    : ['--workbenchos-worker-supervisor']
  const supervisor = Bun.spawn([process.execPath, ...supervisorArgs], {
    cwd: process.cwd(),
    detached: true,
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'ignore',
  })

  try {
    supervisor.stdin.write(JSON.stringify({
      spec: workerSpec,
      max_output_bytes: maxOutputBytes,
      outcome_file_path: outcomePath,
    }))
    supervisor.stdin.end()
  } catch (error) {
    try {
      supervisor.kill()
    } catch {
      // The supervisor may already have exited.
    }
    throw error
  }

  const supervisorExitCode = await supervisor.exited
  if (!existsSync(outcomePath)) {
    throw new Error(
      `worker supervisor exited ${String(supervisorExitCode)} without durable outcome evidence`,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(outcomePath, 'utf8')) as unknown
  } catch (error) {
    throw new Error(`worker supervisor outcome evidence is unreadable: ${describeError(error)}`)
  }
  if (!isWorkerRunOutcome(parsed)) {
    throw new Error('worker supervisor outcome evidence has an invalid shape')
  }
  if (supervisorExitCode !== 0) {
    throw new Error(`worker supervisor exited ${String(supervisorExitCode)} after writing outcome evidence`)
  }
  return parsed
}
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

