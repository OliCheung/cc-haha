/**
 * M3-04 — Codex verification adapter contracts.
 *
 * Fully offline: the process host is replaced by a recorder that returns canned
 * event streams, so no real CLI runs and no network is touched.
 *
 * Authorized by task package M3-04.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSubmissionV01 } from '../ports/agentPort.js'
import { AgentPortError, type AgentPortV01 } from '../ports/agentPort.js'
import {
  CODEX_CHILD_ENV_ALLOWLIST,
  CODEX_VERDICT_SCHEMA,
  createCodexAdapter,
  MIN_CODEX_TIMEOUT_MS,
  type CodexAdapterOptions,
} from './codexAdapter.js'
import type { WorkerProcessHost, WorkerRunOutcome, WorkerRunSpec } from './workerProcessHost.js'

const SUCCESS_LINES = [
  '{"type":"thread.started","thread_id":"thread-abc"}',
  '{"type":"turn.started"}',
  '{"type":"error","message":"Reconnecting... 5/5 (request timed out)"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\\"verdict\\":\\"pass\\",\\"reason\\":\\"probe.txt is correct\\"}"}}',
  '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":7,"reasoning_output_tokens":1}}',
]

const TURN_FAILED_LINES = [
  '{"type":"thread.started","thread_id":"thread-abc"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\\"verdict\\":\\"working\\",\\"reason\\":\\"starting\\"}"}}',
  '{"type":"turn.failed","error":{"message":"{\\"detail\\":\\"the model refused\\"}"}}',
]

const COMMAND_LINES = [
  ...SUCCESS_LINES.slice(0, 3),
  '{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"ls","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"ls","aggregated_output":"probe.txt","exit_code":0,"status":"completed"}}',
  SUCCESS_LINES[3] ?? '',
  SUCCESS_LINES[4] ?? '',
]

function outcome(lines: string[], exitCode = 0): WorkerRunOutcome {
  return {
    outcome: 'exited',
    exit_code: exitCode,
    stdout: lines.join('\n'),
    stderr: '',
    lines,
    duration_ms: 12,
    failure_detail: null,
  }
}

function gitOutcome(text: string): WorkerRunOutcome {
  return {
    outcome: 'exited',
    exit_code: 0,
    stdout: text,
    stderr: '',
    lines: text.split('\n').filter(line => line.length > 0),
    duration_ms: 1,
    failure_detail: null,
  }
}

type Harness = {
  readonly stateDir: string
  readonly scratchDir: string
  readonly workspaceDir: string
  readonly indexFile: string
  readonly specs: WorkerRunSpec[]
  readonly codexRunCount: () => number
  setCodexOutcome(next: WorkerRunOutcome): void
  onCodexRun(handler: (() => void) | null): void
  /** Keeps codex runs pending, so an in-flight run can actually be observed. */
  holdRuns(): void
  /** Makes the next Codex host call reject without outcome evidence. */
  rejectCodexRun(): void
  releaseRuns(): void
  makeAdapter(overrides?: Partial<CodexAdapterOptions>): AgentPortV01
}

function createHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'workbenchos-codex-adapter-'))
  const stateDir = join(root, 'state')
  const scratchDir = join(root, 'scratch')
  const workspaceDir = join(root, 'worktree')
  const binaryPath = join(root, 'codex.exe')

  writeFileSync(binaryPath, 'stub', 'utf8')
  // Present from the start, so a test can plant a corrupt index before any run.
  mkdirSync(stateDir, { recursive: true })

  const specs: WorkerRunSpec[] = []
  let codexOutcome = outcome(SUCCESS_LINES)
  let codexRuns = 0
  let rejectNextCodexRun = false
  let handler: (() => void) | null = null
  let holding = false
  let pending: (() => void)[] = []

  const host: WorkerProcessHost = {
    async run(spec: WorkerRunSpec): Promise<WorkerRunOutcome> {
      specs.push(spec)

      if (spec.executable === 'git') {
        return spec.args[0] === 'status' ? gitOutcome('?? probe.txt\n') : gitOutcome('')
      }

      codexRuns += 1
      if (handler !== null) handler()

      if (rejectNextCodexRun) {
        rejectNextCodexRun = false
        throw new Error('supervisor outcome unavailable')
      }

      if (holding) {
        await new Promise<void>((resolve) => {
          pending.push(resolve)
        })
      }

      return codexOutcome
    },
  }

  let counter = 0

  return {
    stateDir,
    scratchDir,
    workspaceDir,
    indexFile: join(stateDir, 'submissions.json'),
    specs,
    codexRunCount: () => codexRuns,
    setCodexOutcome: (next) => {
      codexOutcome = next
    },
    onCodexRun: (next) => {
      handler = next
    },
    holdRuns: () => {
      holding = true
    },
    rejectCodexRun: () => {
      rejectNextCodexRun = true
    },
    releaseRuns: () => {
      holding = false
      const waiting = pending
      pending = []
      for (const resolve of waiting) resolve()
    },
    makeAdapter: (overrides = {}) =>
      createCodexAdapter({
        binary_path: binaryPath,
        state_dir: stateDir,
        scratch_dir: scratchDir,
        model_id: 'gpt-5.6-terra',
        host,
        clock: { now: () => '2026-10-02T00:00:00.000Z' },
        ids: {
          next: () => {
            counter += 1
            return `run-${String(counter)}`
          },
        },
        ...overrides,
      }),
  }
}

/**
 * Lets the adapter's un-awaited run promise and its finalize step run. A resolved
 * microtask chain needs the event loop to turn once.
 */
async function settle(): Promise<void> {
  await Bun.sleep(20)
}

function submission(h: Harness, overrides: Partial<AgentSubmissionV01> = {}): AgentSubmissionV01 {
  return {
    task_id: 'task-1',
    run_id: 'run-1',
    agent_id: 'codex-verifier',
    goal: 'verify that probe.txt exists',
    context_refs: [],
    allowed_scope: { repository_relative_paths: [], action_classes: [] },
    forbidden_scope: { repository_relative_paths: [], action_classes: [] },
    validation_requirements: [],
    workspace_ref: h.workspaceDir,
    ...overrides,
  }
}

async function withHarness(body: (h: Harness) => Promise<void>): Promise<void> {
  const h = createHarness()
  try {
    await body(h)
  } finally {
    // Never leave a held run dangling past the cleanup.
    h.releaseRuns()
    await settle()
    rmSync(h.workspaceDir, { recursive: true, force: true })
    rmSync(h.stateDir, { recursive: true, force: true })
    rmSync(h.scratchDir, { recursive: true, force: true })
  }
}

describe('codex adapter: submission', () => {
  test('returns a receipt whose reference identifies the adapter', async () => {
    await withHarness(async (h) => {
      const receipt = await h.makeAdapter().submitTask(submission(h), 'key-1', 1000)

      expect(receipt.native_run_ref).toBe('codex:run-1')
      expect(receipt.idempotency_key).toBe('key-1')
      expect(receipt.accepted_at).toBe('2026-10-02T00:00:00.000Z')
    })
  })

  test('persists the submission marker before the process is launched', async () => {
    await withHarness(async (h) => {
      const observed: boolean[] = []
      h.onCodexRun(() => {
        const raw = existsSync(h.indexFile) ? readFileSync(h.indexFile, 'utf8') : ''
        observed.push(raw.includes('key-order'))
      })

      await h.makeAdapter().submitTask(submission(h), 'key-order', 1000)
      await settle()

      // If the spawn happened first this would be false, and a crash in between
      // would leave no way to prove the submission occurred.
      expect(observed).toEqual([true])
    })
  })

  test('reports no lookup result for a key that was never submitted', async () => {
    await withHarness(async (h) => {
      expect(await h.makeAdapter().lookupSubmission('never', 1000)).toBeNull()
    })
  })

  test('reports the receipt back through lookup', async () => {
    await withHarness(async (h) => {
      const adapter = h.makeAdapter()
      await adapter.submitTask(submission(h), 'key-2', 1000)
      await settle()

      const found = await adapter.lookupSubmission('key-2', 1000)
      expect(found?.native_run_ref).toBe('codex:run-1')
    })
  })

  test('does not launch a second process when a submission key is repeated', async () => {
    await withHarness(async (h) => {
      let launches = 0
      h.onCodexRun(() => { launches += 1 })
      const adapter = h.makeAdapter()

      const first = await adapter.submitTask(submission(h), 'same-key', 1000)
      const repeated = await adapter.submitTask(submission(h), 'same-key', 1000)

      expect(repeated).toEqual(first)
      expect(launches).toBe(1)
    })
  })

  test('refuses to answer lookup when the index is unreadable', async () => {
    await withHarness(async (h) => {
      writeFileSync(h.indexFile, '{ broken', 'utf8')

      const adapter = h.makeAdapter()
      let captured: unknown = null
      try {
        await adapter.lookupSubmission('key-3', 1000)
      } catch (error) {
        captured = error
      }

      // Reporting null here would look like "never submitted" and invite a
      // duplicate side effect.
      expect(captured).toBeInstanceOf(AgentPortError)
      expect((captured as AgentPortError).code).toBe('UNAVAILABLE')
    })
  })

  test('rejects a submission without a workspace', async () => {
    await withHarness(async (h) => {
      let captured: unknown = null
      try {
        await h.makeAdapter().submitTask(submission(h, { workspace_ref: undefined }), 'key-4', 1000)
      } catch (error) {
        captured = error
      }

      expect((captured as AgentPortError).code).toBe('INVALID_REQUEST')
    })
  })

  test('falls back to the configured worktree when the submission carries none', async () => {
    await withHarness(async (h) => {
      // The Core is denied runtime handles, so it can never supply a path; a
      // filesystem-bound adapter has to own its default.
      const adapter = h.makeAdapter({ workspace_dir: h.workspaceDir })
      const receipt = await adapter.submitTask(
        submission(h, { workspace_ref: undefined }),
        'key-fallback',
        1000,
      )
      await settle()

      const spec = h.specs.find(entry => entry.executable !== 'git')
      expect(spec?.cwd).toBe(h.workspaceDir)
      expect(spec?.args).toContain(h.workspaceDir)
      expect(receipt.native_run_ref).toBe('codex:run-1')
    })
  })

  test('prefers the submission workspace over the configured fallback', async () => {
    await withHarness(async (h) => {
      const other = join(h.workspaceDir, 'nested')
      const adapter = h.makeAdapter({ workspace_dir: h.workspaceDir })
      await adapter.submitTask(submission(h, { workspace_ref: other }), 'key-override', 1000)
      await settle()

      const spec = h.specs.find(entry => entry.executable !== 'git')
      expect(spec?.cwd).toBe(other)
    })
  })
})

describe('codex adapter: argv', () => {
  test('builds the surveyed non-interactive command line', async () => {
    await withHarness(async (h) => {
      await h.makeAdapter({ reasoning_effort: 'low' }).submitTask(
        submission(h),
        'key-argv',
        1000,
      )
      await settle()

      const spec = h.specs.find(entry => entry.executable !== 'git')
      expect(spec?.args).toEqual([
        'exec',
        '--json',
        '--color',
        'never',
        '-m',
        'gpt-5.6-terra',
        '-C',
        h.workspaceDir,
        '-s',
        'read-only',
        '--skip-git-repo-check',
        '-c',
        'model_reasoning_effort=low',
        '--output-schema',
        join(h.scratchDir, 'codex-run-1-schema.json'),
        '-o',
        join(h.scratchDir, 'codex-run-1-last.json'),
        'verify that probe.txt exists',
      ])
    })
  })

  test('defaults to the read-only sandbox and closes stdin', async () => {
    await withHarness(async (h) => {
      await h.makeAdapter().submitTask(submission(h), 'key-sandbox', 1000)
      await settle()

      const spec = h.specs.find(entry => entry.executable !== 'git')
      expect(spec?.args).toContain('read-only')
      expect(spec?.stdin).toBeNull()
      expect(spec?.cwd).toBe(h.workspaceDir)
    })
  })

  test('omits the reasoning override when none was configured', async () => {
    await withHarness(async (h) => {
      await h.makeAdapter().submitTask(submission(h), 'key-no-effort', 1000)
      await settle()

      const spec = h.specs.find(entry => entry.executable !== 'git')
      expect(spec?.args).not.toContain('-c')
    })
  })

  test('writes a BOM-free schema file', async () => {
    await withHarness(async (h) => {
      await h.makeAdapter().submitTask(submission(h), 'key-schema', 1000)
      await settle()

      const raw = readFileSync(join(h.scratchDir, 'codex-run-1-schema.json'))
      expect(raw[0]).not.toBe(0xef)
      expect(JSON.parse(raw.toString('utf8'))).toMatchObject({ type: 'object' })
    })
  })

  test('marks the verdict schema strict, which the real CLI requires', () => {
    // A real call rejected the schema while this flag was absent, so it is a
    // requirement rather than a preference.
    expect(CODEX_VERDICT_SCHEMA.additionalProperties).toBe(false)
    expect(CODEX_VERDICT_SCHEMA.required).toEqual(['verdict', 'reason'])
  })

  test('raises an over-short budget up to the surveyed minimum', async () => {
    await withHarness(async (h) => {
      await h.makeAdapter({ default_timeout_ms: 1000 }).submitTask(submission(h), 'key-t', 1000)
      await settle()

      const spec = h.specs.find(entry => entry.executable !== 'git')
      // The survey measured five reconnect cycles before the HTTPS fallback.
      expect(spec?.timeout_ms).toBeGreaterThanOrEqual(MIN_CODEX_TIMEOUT_MS)
    })
  })
})

describe('codex adapter: status', () => {
  test('reports running until the process reports back', async () => {
    await withHarness(async (h) => {
      h.holdRuns()

      const adapter = h.makeAdapter()
      const receipt = await adapter.submitTask(submission(h), 'key-run', 1000)

      const snapshot = await adapter.getStatus(receipt.native_run_ref, 1000)
      expect(snapshot.status).toBe('running')
      expect(snapshot.observed_at).toBe('2026-10-02T00:00:00.000Z')
    })
  })

  test('reports unknown for a running record not owned by this adapter instance', async () => {
    await withHarness(async (h) => {
      h.holdRuns()

      const first = h.makeAdapter()
      const receipt = await first.submitTask(submission(h), 'key-stale', 1000)
      const restarted = h.makeAdapter()

      expect((await first.getStatus(receipt.native_run_ref, 1000)).status).toBe('running')
      expect((await restarted.getStatus(receipt.native_run_ref, 1000)).status).toBe('unknown')
      expect(await restarted.collectResult(receipt.native_run_ref, 1000)).toEqual({
        status: 'not_ready',
      })

      const replayed = await restarted.submitTask(submission(h), 'key-stale', 1000)
      expect(replayed.native_run_ref).toBe(receipt.native_run_ref)
      expect(h.codexRunCount()).toBe(1)
    })
  })

  test('reports success for a completed turn', async () => {
    await withHarness(async (h) => {
      const adapter = h.makeAdapter()
      const receipt = await adapter.submitTask(submission(h), 'key-ok', 1000)
      await settle()

      expect((await adapter.getStatus(receipt.native_run_ref, 1000)).status).toBe('succeeded')
    })
  })

  test('does not report success for a failed turn that exited zero', async () => {
    await withHarness(async (h) => {
      h.setCodexOutcome(outcome(TURN_FAILED_LINES, 0))

      const adapter = h.makeAdapter()
      const receipt = await adapter.submitTask(submission(h), 'key-q', 1000)
      await settle()

      expect((await adapter.getStatus(receipt.native_run_ref, 1000)).status).toBe('failed')
    })
  })

  test('reports timed_out for a killed run', async () => {
    await withHarness(async (h) => {
      h.setCodexOutcome({
        outcome: 'timed_out',
        exit_code: null,
        stdout: '',
        stderr: '',
        lines: [],
        duration_ms: 5000,
        failure_detail: null,
      })

      const adapter = h.makeAdapter()
      const receipt = await adapter.submitTask(submission(h), 'key-to', 1000)
      await settle()

      expect((await adapter.getStatus(receipt.native_run_ref, 1000)).status).toBe('timed_out')
    })
  })

  test('rejects an unknown reference', async () => {
    await withHarness(async (h) => {
      let captured: unknown = null
      try {
        await h.makeAdapter().getStatus('codex:missing', 1000)
      } catch (error) {
        captured = error
      }

      expect((captured as AgentPortError).code).toBe('NOT_FOUND')
    })
  })
})

describe('codex adapter: results', () => {
  test('reports not_ready while the run is still going', async () => {
    await withHarness(async (h) => {
      h.holdRuns()

      const adapter = h.makeAdapter()
      const receipt = await adapter.submitTask(submission(h), 'key-wait', 1000)

      expect(await adapter.collectResult(receipt.native_run_ref, 1000)).toEqual({
        status: 'not_ready',
      })
    })
  })

  test('builds a complete result for a successful turn', async () => {
    await withHarness(async (h) => {
      const adapter = h.makeAdapter()
      const receipt = await adapter.submitTask(submission(h), 'key-done', 1000)
      await settle()

      const collected = await adapter.collectResult(receipt.native_run_ref, 1000)
      expect(collected.status).toBe('ready')
      if (collected.status !== 'ready') return

      const material = collected.material
      expect(material.outcome).toBe('succeeded')
      expect(material.completion).toBe('complete')
      expect(material.summary).toContain('"verdict":"pass"')
      expect(material.started_at).toBe('2026-10-02T00:00:00.000Z')
      expect(material.unresolved_work).toEqual([])
    })
  })

  test('collects changed files from git rather than from the event stream', async () => {
    await withHarness(async (h) => {
      const adapter = h.makeAdapter()
      const receipt = await adapter.submitTask(submission(h), 'key-files', 1000)
      await settle()

      const collected = await adapter.collectResult(receipt.native_run_ref, 1000)
      if (collected.status !== 'ready') throw new Error('expected a ready result')

      expect(collected.material.changed_files).toEqual([
        { path: 'probe.txt', change: 'created' },
      ])
      expect(collected.material.git_state.available).toBe(true)
      expect(collected.material.git_state.commit_performed).toBe(false)
    })
  })

  test('maps command executions into command evidence', async () => {
    await withHarness(async (h) => {
      h.setCodexOutcome(outcome(COMMAND_LINES))

      const adapter = h.makeAdapter()
      const receipt = await adapter.submitTask(submission(h), 'key-cmd', 1000)
      await settle()

      const collected = await adapter.collectResult(receipt.native_run_ref, 1000)
      if (collected.status !== 'ready') throw new Error('expected a ready result')

      expect(collected.material.commands).toEqual([
        { command: 'ls', exit_code: 0, output_excerpt: 'probe.txt' },
      ])
    })
  })

  test('truncates a long command excerpt', async () => {
    await withHarness(async (h) => {
      const long = 'x'.repeat(900)
      h.setCodexOutcome(
        outcome([
          '{"type":"thread.started","thread_id":"thread-abc"}',
          `{"type":"item.completed","item":{"id":"i","type":"command_execution","command":"cat","aggregated_output":"${long}","exit_code":0,"status":"completed"}}`,
          '{"type":"turn.completed"}',
        ]),
      )

      const adapter = h.makeAdapter()
      const receipt = await adapter.submitTask(submission(h), 'key-long', 1000)
      await settle()

      const collected = await adapter.collectResult(receipt.native_run_ref, 1000)
      if (collected.status !== 'ready') throw new Error('expected a ready result')

      expect(collected.material.commands[0]?.output_excerpt).toHaveLength(500)
    })
  })

  test('reports a failed turn even though the process exited zero', async () => {
    await withHarness(async (h) => {
      h.setCodexOutcome(outcome(TURN_FAILED_LINES, 0))

      const adapter = h.makeAdapter()
      const receipt = await adapter.submitTask(submission(h), 'key-fail', 1000)
      await settle()

      const collected = await adapter.collectResult(receipt.native_run_ref, 1000)
      if (collected.status !== 'ready') throw new Error('expected a ready result')

      expect(collected.material.outcome).toBe('failed')
      expect(collected.material.completion).toBe('partial')
      expect(collected.material.errors.map(entry => entry.code)).toContain('CODEX_TURN_FAILED')
      expect(collected.material.errors[0]?.message).toBe('the model refused')
      expect(collected.material.unresolved_work.length).toBeGreaterThan(0)
    })
  })

  test('reports a timeout with a retryable error and a risk', async () => {
    await withHarness(async (h) => {
      h.setCodexOutcome({
        outcome: 'timed_out',
        exit_code: null,
        stdout: '',
        stderr: '',
        lines: ['{"type":"thread.started","thread_id":"thread-abc"}'],
        duration_ms: 180000,
        failure_detail: null,
      })

      const adapter = h.makeAdapter()
      const receipt = await adapter.submitTask(submission(h), 'key-tt', 1000)
      await settle()

      const collected = await adapter.collectResult(receipt.native_run_ref, 1000)
      if (collected.status !== 'ready') throw new Error('expected a ready result')

      expect(collected.material.outcome).toBe('timed_out')
      expect(collected.material.errors[0]?.code).toBe('CODEX_TIMEOUT')
      expect(collected.material.errors[0]?.retryable).toBe(true)
      expect(collected.material.risks.some(risk => risk.includes('wall-clock budget'))).toBe(true)
    })
  })

  test('reports a launch failure as a failure with no completion', async () => {
    await withHarness(async (h) => {
      h.setCodexOutcome({
        outcome: 'spawn_failed',
        exit_code: null,
        stdout: '',
        stderr: '',
        lines: [],
        duration_ms: 2,
        failure_detail: 'ENOENT: codex.exe not found',
      })

      const adapter = h.makeAdapter()
      const receipt = await adapter.submitTask(submission(h), 'key-spawn', 1000)
      await settle()

      const collected = await adapter.collectResult(receipt.native_run_ref, 1000)
      if (collected.status !== 'ready') throw new Error('expected a ready result')

      expect(collected.material.outcome).toBe('failed')
      expect(collected.material.completion).toBe('none')
      expect(collected.material.errors[0]?.code).toBe('CODEX_SPAWN_FAILED')
    })
  })

  test('surfaces non-fatal notices as risks without failing the run', async () => {
    await withHarness(async (h) => {
      const adapter = h.makeAdapter()
      const receipt = await adapter.submitTask(submission(h), 'key-notice', 1000)
      await settle()

      const collected = await adapter.collectResult(receipt.native_run_ref, 1000)
      if (collected.status !== 'ready') throw new Error('expected a ready result')

      expect(collected.material.outcome).toBe('succeeded')
      expect(collected.material.risks.some(risk => risk.includes('non-fatal notices'))).toBe(true)
    })
  })

  test('rejects an unknown reference when collecting', async () => {
    await withHarness(async (h) => {
      let captured: unknown = null
      try {
        await h.makeAdapter().collectResult('codex:missing', 1000)
      } catch (error) {
        captured = error
      }

      expect((captured as AgentPortError).code).toBe('NOT_FOUND')
    })
  })
})

describe('codex adapter: durability, cancel and health', () => {
  test('derives a stable durable outcome path from the native run reference', async () => {
    await withHarness(async (h) => {
      await h.makeAdapter().submitTask(submission(h), 'key-outcome-path', 1000)
      await settle()

      const spec = h.specs.find(entry => entry.executable !== 'git')
      expect(spec?.durable_outcome_path).toBe(
        join(h.stateDir, 'runs', 'codex-run-1.outcome.json'),
      )
    })
  })

  test('imports valid durable terminal evidence in a fresh adapter instance', async () => {
    await withHarness(async (h) => {
      h.holdRuns()
      const first = h.makeAdapter()
      const receipt = await first.submitTask(submission(h), 'key-late-outcome', 1000)
      await settle()

      const spec = h.specs.find(entry => entry.executable !== 'git')
      if (spec?.durable_outcome_path === undefined) {
        throw new Error('expected a durable outcome path')
      }
      writeFileSync(spec.durable_outcome_path, JSON.stringify(outcome(SUCCESS_LINES)), 'utf8')

      const second = h.makeAdapter()
      const snapshot = await second.getStatus(receipt.native_run_ref, 1000)
      expect(snapshot.status).toBe('succeeded')

      const collected = await second.collectResult(receipt.native_run_ref, 1000)
      if (collected.status !== 'ready') throw new Error('expected a ready recovered result')
      expect(collected.material.outcome).toBe('succeeded')
      expect(h.codexRunCount()).toBe(1)
    })
  })

  test('keeps missing and corrupt durable outcome evidence unknown', async () => {
    await withHarness(async (h) => {
      h.holdRuns()
      const first = h.makeAdapter()
      const receipt = await first.submitTask(submission(h), 'key-missing-outcome', 1000)
      await settle()

      const second = h.makeAdapter()
      expect((await second.getStatus(receipt.native_run_ref, 1000)).status).toBe('unknown')
      expect(await second.collectResult(receipt.native_run_ref, 1000)).toEqual({ status: 'not_ready' })

      const outcomePath = join(h.stateDir, 'runs', 'codex-run-1.outcome.json')
      writeFileSync(outcomePath, '{ malformed', 'utf8')
      expect((await second.getStatus(receipt.native_run_ref, 1000)).status).toBe('unknown')
      expect(JSON.parse(readFileSync(join(h.stateDir, 'runs', 'codex-run-1.json'), 'utf8')).status)
        .toBe('running')

      writeFileSync(outcomePath, JSON.stringify({
        outcome: 'exited',
        exit_code: null,
        stdout: '',
        stderr: '',
        lines: [],
        duration_ms: 1,
        failure_detail: null,
      }), 'utf8')
      expect((await second.getStatus(receipt.native_run_ref, 1000)).status).toBe('unknown')
      expect(await second.collectResult(receipt.native_run_ref, 1000)).toEqual({ status: 'not_ready' })
    })
  })

  test('keeps a rejected host promise unknown instead of inventing spawn failure', async () => {
    await withHarness(async (h) => {
      h.rejectCodexRun()
      const adapter = h.makeAdapter()
      const receipt = await adapter.submitTask(submission(h), 'key-host-rejected', 1000)
      await settle()

      expect((await adapter.getStatus(receipt.native_run_ref, 1000)).status).toBe('unknown')
      expect(await adapter.collectResult(receipt.native_run_ref, 1000)).toEqual({ status: 'not_ready' })
      expect(JSON.parse(readFileSync(join(h.stateDir, 'runs', 'codex-run-1.json'), 'utf8')).status)
        .toBe('running')
    })
  })

  test('preserves terminal-event and exit-code mapping when importing evidence', async () => {
    await withHarness(async (h) => {
      h.holdRuns()
      const adapter = h.makeAdapter()
      const cases = [
        { key: 'key-failed-event', lines: TURN_FAILED_LINES, exitCode: 0 },
        { key: 'key-incomplete-event', lines: ['{"type":"turn.started"}'], exitCode: 0 },
        { key: 'key-nonzero-exit', lines: SUCCESS_LINES, exitCode: 3 },
      ]

      for (const scenario of cases) {
        const receipt = await adapter.submitTask(submission(h), scenario.key, 1000)
        await settle()
        const spec = h.specs.find(entry => entry.args.at(-1) === 'verify that probe.txt exists' &&
          entry.durable_outcome_path !== undefined &&
          !existsSync(entry.durable_outcome_path))
        if (spec?.durable_outcome_path === undefined) {
          throw new Error('expected the current run durable outcome path')
        }
        writeFileSync(spec.durable_outcome_path, JSON.stringify(outcome(scenario.lines, scenario.exitCode)), 'utf8')

        expect((await adapter.getStatus(receipt.native_run_ref, 1000)).status).toBe('failed')
        const collected = await adapter.collectResult(receipt.native_run_ref, 1000)
        if (collected.status !== 'ready') throw new Error('expected a ready failed result')
        expect(collected.material.outcome).toBe('failed')
      }
      expect(h.codexRunCount()).toBe(3)
    })
  })

  test('lets a fresh adapter instance read a run it did not start', async () => {
    await withHarness(async (h) => {
      const first = h.makeAdapter()
      const receipt = await first.submitTask(submission(h), 'key-durable', 1000)
      await settle()

      const second = h.makeAdapter()
      const collected = await second.collectResult(receipt.native_run_ref, 1000)
      if (collected.status !== 'ready') throw new Error('expected a ready result')

      expect(collected.material.outcome).toBe('succeeded')
    })
  })

  test('never claims to have cancelled a live run it cannot reach', async () => {
    await withHarness(async (h) => {
      const adapter = h.makeAdapter()
      const receipt = await adapter.submitTask(submission(h), 'key-cancel', 1000)

      const cancelled = await adapter.cancel(receipt.native_run_ref, 'cancel-key', 'user asked', 1000)

      // The M3-01 host hands back no process handle, so a false acceptance here
      // would be a lie about the child's fate.
      expect(cancelled.accepted).toBe(false)
      expect(cancelled.native_run_ref).toBe(receipt.native_run_ref)
    })
  })

  test('rejects cancelling an unknown reference', async () => {
    await withHarness(async (h) => {
      let captured: unknown = null
      try {
        await h.makeAdapter().cancel('codex:missing', 'k', 'reason', 1000)
      } catch (error) {
        captured = error
      }

      expect((captured as AgentPortError).code).toBe('NOT_FOUND')
    })
  })

  test('reports a healthy adapter with the expected capabilities', async () => {
    await withHarness(async (h) => {
      const health = await h.makeAdapter().healthCheck(1000)

      expect(health.protocol_version).toBe('0.1')
      expect(health.available).toBe(true)
      expect(health.capabilities).toContain('verified_verdict')
      // M5-PRE-006 §12 (D1 = A): `session_resume` is required by the frozen M3-04
      // capability contract. The declaration is a contract requirement, not
      // evidence that resume behaviour is implemented.
      expect(health.capabilities).toContain('session_resume')
    })
  })

  test('exposes the protocol version on the instance', async () => {
    await withHarness(async (h) => {
      expect(h.makeAdapter().protocolVersion).toBe('0.1')
    })
  })
})

describe('codex adapter: child environment boundary', () => {
  test('drops every non-allowlisted variable when the boundary is enabled', async () => {
    await withHarness(async (h) => {
      process.env.CC_HAHA_BROWSER_SEAM_TOKEN = 'seam-secret-value'
      process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = 'local-secret-value'
      process.env.CC_HAHA_PET_ACCESS_TOKEN = 'pet-secret-value'
      try {
        const adapter = h.makeAdapter({ child_env_allowlist: CODEX_CHILD_ENV_ALLOWLIST })
        await adapter.submitTask(submission(h, {}), 'key-env-boundary', 1000)
        await settle()

        const codexSpec = h.specs.find(spec => spec.executable !== 'git')
        expect(codexSpec?.env_mode).toBe('replace')
        expect(codexSpec?.env?.CC_HAHA_BROWSER_SEAM_TOKEN).toBeUndefined()
        expect(codexSpec?.env?.CC_HAHA_LOCAL_ACCESS_TOKEN).toBeUndefined()
        expect(codexSpec?.env?.CC_HAHA_PET_ACCESS_TOKEN).toBeUndefined()
        // Only allowlisted names are present at all.
        for (const name of Object.keys(codexSpec?.env ?? {})) {
          expect(CODEX_CHILD_ENV_ALLOWLIST).toContain(name)
        }
      } finally {
        delete process.env.CC_HAHA_BROWSER_SEAM_TOKEN
        delete process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
        delete process.env.CC_HAHA_PET_ACCESS_TOKEN
      }
    })
  })

  test('leaves the inherited environment untouched without an allowlist', async () => {
    await withHarness(async (h) => {
      const adapter = h.makeAdapter()
      await adapter.submitTask(submission(h, {}), 'key-env-inherit', 1000)
      await settle()

      const codexSpec = h.specs.find(spec => spec.executable !== 'git')
      expect(codexSpec?.env_mode).toBeUndefined()
      expect(codexSpec?.env).toBeUndefined()
    })
  })
})
