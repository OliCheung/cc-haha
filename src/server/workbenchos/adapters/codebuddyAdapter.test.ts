/**
 * M3-02A — CodeBuddy adapter lifecycle tests.
 *
 * Fully offline: the process host is a recorder returning canned outcomes, so no
 * CLI runs and no network is touched.
 *
 * Authorized by task package M3-02A.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSubmissionV01 } from '../ports/agentPort.js'
import { AgentPortError, type AgentPortV01 } from '../ports/agentPort.js'
import {
  createCodeBuddyAdapter,
  RESULT_PARSER_PENDING,
  type CodeBuddyAdapterOptions,
} from './codebuddyAdapter.js'
import type { WorkerProcessHost, WorkerRunOutcome, WorkerRunSpec } from './workerProcessHost.js'

function outcome(overrides: Partial<WorkerRunOutcome> = {}): WorkerRunOutcome {
  return {
    outcome: 'exited',
    exit_code: 0,
    stdout: '{}',
    stderr: '',
    lines: ['{}'],
    duration_ms: 5,
    failure_detail: null,
    ...overrides,
  }
}

type Harness = {
  readonly stateDir: string
  readonly workspaceDir: string
  readonly indexFile: string
  readonly specs: WorkerRunSpec[]
  holdRuns(): void
  releaseRuns(): void
  setOutcome(next: WorkerRunOutcome): void
  onCodexRun(handler: (() => void) | null): void
  makeAdapter(overrides?: Partial<CodeBuddyAdapterOptions>): AgentPortV01
}

function createHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'workbenchos-cb-adapter-'))
  const stateDir = join(root, 'state')
  const workspaceDir = join(root, 'worktree')
  mkdirSync(workspaceDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })

  const cliEntry = join(root, 'cli', 'bin', 'codebuddy')
  const nodeExecutable = join(root, 'rt', 'node.exe')
  mkdirSync(join(cliEntry, '..'), { recursive: true })
  mkdirSync(join(nodeExecutable, '..'), { recursive: true })
  writeFileSync(cliEntry, '#!/usr/bin/env node', 'utf8')
  writeFileSync(nodeExecutable, 'stub', 'utf8')

  const specs: WorkerRunSpec[] = []
  let codexOutcome = outcome()
  let holding = false
  let pending: (() => void)[] = []
  let handler: (() => void) | null = null

  const host: WorkerProcessHost = {
    async run(spec: WorkerRunSpec): Promise<WorkerRunOutcome> {
      specs.push(spec)
      if (handler !== null) handler()
      if (holding) {
        await new Promise<void>(resolve => {
          pending.push(resolve)
        })
      }
      return codexOutcome
    },
  }

  let counter = 0

  return {
    stateDir,
    workspaceDir,
    indexFile: join(stateDir, 'submissions.json'),
    specs,
    holdRuns: () => {
      holding = true
    },
    releaseRuns: () => {
      holding = false
      const waiting = pending
      pending = []
      for (const resolve of waiting) resolve()
    },
    setOutcome: (next) => {
      codexOutcome = next
    },
    onCodexRun: (next) => {
      handler = next
    },
    makeAdapter: (overrides = {}) =>
      createCodeBuddyAdapter({
        cli_entry: cliEntry,
        node_executable: nodeExecutable,
        state_dir: stateDir,
        workspace_dir: workspaceDir,
        model: 'deepseek-v3-2-volc',
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

async function settle(): Promise<void> {
  await Bun.sleep(20)
}

function submission(h: Harness, overrides: Partial<AgentSubmissionV01> = {}): AgentSubmissionV01 {
  return {
    task_id: 'task-1',
    run_id: 'run-1',
    agent_id: 'codebuddy-executor',
    goal: 'describe this repository',
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
    h.releaseRuns()
    await settle()
    rmSync(h.stateDir, { recursive: true, force: true })
    rmSync(h.workspaceDir, { recursive: true, force: true })
  }
}

describe('codebuddy adapter: submission', () => {
  test('returns a receipt whose reference identifies the adapter', async () => {
    await withHarness(async (h) => {
      const receipt = await h.makeAdapter().submitTask(submission(h), 'key-1', 1000)

      expect(receipt.native_run_ref).toBe('codebuddy:run-1')
      expect(receipt.idempotency_key).toBe('key-1')
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

      expect(observed).toEqual([true])
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

  test('launches node with the CLI entry as the first argument', async () => {
    await withHarness(async (h) => {
      await h.makeAdapter().submitTask(submission(h), 'key-argv', 1000)
      await settle()

      const spec = h.specs[0]
      expect(spec?.executable.endsWith('node.exe')).toBe(true)
      expect(spec?.args[0]?.endsWith('codebuddy')).toBe(true)
      expect(spec?.args).toContain('-p')
      expect(spec?.args).toContain('--output-format')
      expect(spec?.args).toContain('json')
      expect(spec?.args).toContain('--model')
      expect(spec?.args).toContain('deepseek-v3-2-volc')
      expect(spec?.cwd).toBe(h.workspaceDir)
      expect(spec?.stdin).toBeNull()
    })
  })

  test('falls back to the configured worktree when the submission carries none', async () => {
    await withHarness(async (h) => {
      const adapter = h.makeAdapter()
      await adapter.submitTask(submission(h, { workspace_ref: undefined }), 'key-fb', 1000)
      await settle()

      expect(h.specs[0]?.cwd).toBe(h.workspaceDir)
    })
  })

  test('refuses to build without an explicit model', async () => {
    await withHarness(async (h) => {
      let captured: unknown = null
      try {
        await h.makeAdapter({ model: '' }).submitTask(submission(h), 'key-nm', 1000)
      } catch (error) {
        captured = error
      }

      expect(captured).toBeInstanceOf(TypeError)
    })
  })

  test('refuses a submission with no worktree at all', async () => {
    await withHarness(async (h) => {
      const adapter = h.makeAdapter({ workspace_dir: undefined })
      let captured: unknown = null
      try {
        await adapter.submitTask(submission(h, { workspace_ref: undefined }), 'key-nw', 1000)
      } catch (error) {
        captured = error
      }

      expect((captured as AgentPortError).code).toBe('INVALID_REQUEST')
    })
  })

  test('reports no lookup result for a key that was never submitted', async () => {
    await withHarness(async (h) => {
      expect(await h.makeAdapter().lookupSubmission('never', 1000)).toBeNull()
    })
  })

  test('refuses to answer lookup when the index is unreadable', async () => {
    await withHarness(async (h) => {
      writeFileSync(h.indexFile, '{ broken', 'utf8')

      let captured: unknown = null
      try {
        await h.makeAdapter().lookupSubmission('key', 1000)
      } catch (error) {
        captured = error
      }

      // Reporting null here would look like "never submitted".
      expect((captured as AgentPortError).code).toBe('UNAVAILABLE')
    })
  })
})

describe('codebuddy adapter: status', () => {
  test('reports running until the process reports back', async () => {
    await withHarness(async (h) => {
      h.holdRuns()
      const adapter = h.makeAdapter()
      const receipt = await adapter.submitTask(submission(h), 'key-run', 1000)

      expect((await adapter.getStatus(receipt.native_run_ref, 1000)).status).toBe('running')
    })
  })

  test('reports success for a zero exit code', async () => {
    await withHarness(async (h) => {
      const adapter = h.makeAdapter()
      const receipt = await adapter.submitTask(submission(h), 'key-ok', 1000)
      await settle()

      expect((await adapter.getStatus(receipt.native_run_ref, 1000)).status).toBe('succeeded')
    })
  })

  test('reports failure for a non-zero exit code', async () => {
    await withHarness(async (h) => {
      h.setOutcome(outcome({ exit_code: 1, lines: [] }))

      const adapter = h.makeAdapter()
      const receipt = await adapter.submitTask(submission(h), 'key-bad', 1000)
      await settle()

      expect((await adapter.getStatus(receipt.native_run_ref, 1000)).status).toBe('failed')
    })
  })

  test('reports timed_out for a killed run', async () => {
    await withHarness(async (h) => {
      h.setOutcome(outcome({ outcome: 'timed_out', exit_code: null, lines: [] }))

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
        await h.makeAdapter().getStatus('codebuddy:missing', 1000)
      } catch (error) {
        captured = error
      }

      expect((captured as AgentPortError).code).toBe('NOT_FOUND')
    })
  })
})

describe('codebuddy adapter: result parsing is deliberately absent', () => {
  test('collectResult refuses rather than inventing a material', async () => {
    await withHarness(async (h) => {
      const adapter = h.makeAdapter()
      const receipt = await adapter.submitTask(submission(h), 'key-cr', 1000)
      await settle()

      let captured: unknown = null
      try {
        await adapter.collectResult(receipt.native_run_ref, 1000)
      } catch (error) {
        captured = error
      }

      expect(captured).toBeInstanceOf(AgentPortError)
      expect((captured as AgentPortError).code).toBe('UNSUPPORTED_CAPABILITY')
      expect((captured as AgentPortError).message).toBe(RESULT_PARSER_PENDING)
    })
  })

  test('collectResult refuses even for an unknown reference', async () => {
    await withHarness(async (h) => {
      let captured: unknown = null
      try {
        await h.makeAdapter().collectResult('codebuddy:missing', 1000)
      } catch (error) {
        captured = error
      }

      expect((captured as AgentPortError).code).toBe('UNSUPPORTED_CAPABILITY')
    })
  })
})

describe('codebuddy adapter: cancel, durability and health', () => {
  test('never claims to have cancelled a run it cannot reach', async () => {
    await withHarness(async (h) => {
      const adapter = h.makeAdapter()
      const receipt = await adapter.submitTask(submission(h), 'key-cancel', 1000)

      const cancelled = await adapter.cancel(receipt.native_run_ref, 'ck', 'reason', 1000)

      expect(cancelled.accepted).toBe(false)
    })
  })

  test('rejects cancelling an unknown reference', async () => {
    await withHarness(async (h) => {
      let captured: unknown = null
      try {
        await h.makeAdapter().cancel('codebuddy:missing', 'k', 'reason', 1000)
      } catch (error) {
        captured = error
      }

      expect((captured as AgentPortError).code).toBe('NOT_FOUND')
    })
  })

  test('lets a fresh adapter instance read a run it did not start', async () => {
    await withHarness(async (h) => {
      const first = h.makeAdapter()
      const receipt = await first.submitTask(submission(h), 'key-durable', 1000)
      await settle()

      const second = h.makeAdapter()
      expect((await second.getStatus(receipt.native_run_ref, 1000)).status).toBe('succeeded')
    })
  })

  test('reports itself unavailable while result parsing is pending', async () => {
    await withHarness(async (h) => {
      const health = await h.makeAdapter().healthCheck(1000)

      // Unavailable is the protective choice: the Core must not route work to an
      // adapter that cannot produce a result.
      expect(health.protocol_version).toBe('0.1')
      expect(health.available).toBe(false)
      expect(health.detail).toBe(RESULT_PARSER_PENDING)
      expect(health.capabilities).toContain('json_output')
    })
  })

  test('names the missing pieces when the runtime is absent', async () => {
    await withHarness(async (h) => {
      const health = await h
        .makeAdapter({ node_executable: join(h.workspaceDir, 'nope', 'node.exe') })
        .healthCheck(1000)

      expect(health.available).toBe(false)
      expect(health.detail).toContain('Node runtime')
    })
  })

  test('exposes the protocol version on the instance', async () => {
    await withHarness(async (h) => {
      expect(h.makeAdapter().protocolVersion).toBe('0.1')
    })
  })
})
