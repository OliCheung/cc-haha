/**
 * Manual end-to-end smoke for the Codex verification adapter.
 *
 * This file is deliberately NOT named `*.test.ts` and contains no test cases: it
 * launches the real CLI and spends real quota, so it must only ever run when a
 * human asks for it.
 *
 *   bun src/server/workbenchos/adapters/codexSmoke.ts probe
 *   bun src/server/workbenchos/adapters/codexSmoke.ts e2e [model]
 *
 * `probe` costs no model quota. `e2e` performs exactly one real turn and drives
 * it through WorkbenchCore, which is the only way to prove that the two sides of
 * the AgentPort contract actually line up.
 *
 * Authorized by task package M3-04S.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkbenchCore, type CoreResult } from '../core/workbenchCore.js'
import { SqliteJournal } from '../persistence/sqliteJournal.js'
import { createCodexAdapter, sanitizeRunRef } from './codexAdapter.js'
import { discoverCodexBinary } from './codexDiscovery.js'
import { summarizeCodexStream } from './codexEventStream.js'
import { createWorkerProcessHost, type WorkerProcessHost } from './workerProcessHost.js'

const DEFAULT_MODEL = 'gpt-5.6-terra'
const PORT_TIMEOUT_MS = 60_000
const EXECUTION_TIMEOUT_MS = 240_000
const TOTAL_BUDGET_MS = 300_000
const POLL_INTERVAL_MS = 2_000

const TERMINAL_RUN_STATES = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']

const PROMPT =
  'Do not modify any files. Reply with a JSON object only, of the form ' +
  '{"verdict":"pass","reason":"<one short sentence describing what you can see in this repository>"}'

function line(key: string, value: string): void {
  console.log(`${key.padEnd(18)}: ${value}`)
}

function isTerminal(state: string): boolean {
  return TERMINAL_RUN_STATES.includes(state)
}

function unwrap<T>(result: CoreResult<T>, label: string): T {
  if (!result.ok) {
    console.log(`FAILED ${label}: ${result.error.code} - ${result.error.detail}`)
    throw new Error(`step ${label} failed`)
  }
  return result.value
}

async function runGit(host: WorkerProcessHost, cwd: string, args: string[]): Promise<void> {
  const outcome = await host.run({
    executable: 'git',
    args: ['-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', ...args],
    cwd,
    stdin: null,
    timeout_ms: 60_000,
  })

  if (outcome.outcome !== 'exited' || outcome.exit_code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${outcome.stderr.trim()}`)
  }
}

async function runEndToEnd(binaryPath: string, modelId: string, host: WorkerProcessHost): Promise<number> {
  const root = mkdtempSync(join(tmpdir(), 'workbenchos-smoke-'))
  const worktree = join(root, 'worktree')
  const stateDir = join(root, 'state')
  const scratchDir = join(root, 'scratch')
  mkdirSync(worktree, { recursive: true })
  // SQLite cannot create its file inside a directory that does not exist yet.
  mkdirSync(stateDir, { recursive: true })

  const journal = new SqliteJournal({ databasePath: join(stateDir, 'journal.sqlite') })

  try {
    // A real repository, so the evidence collector has something to read.
    await runGit(host, worktree, ['init', '-q'])
    writeFileSync(join(worktree, 'README.md'), '# smoke worktree\n', 'utf8')
    await runGit(host, worktree, ['add', 'README.md'])
    await runGit(host, worktree, ['commit', '-q', '-m', 'initial'])

    await journal.open()

    const clock = { now: () => new Date().toISOString() }
    let sequence = 0
    const ids = {
      next: () => {
        sequence += 1
        return `smoke-${String(sequence)}`
      },
    }

    const agentPort = createCodexAdapter({
      binary_path: binaryPath,
      state_dir: join(stateDir, 'codex'),
      scratch_dir: scratchDir,
      model_id: modelId,
      // The Core never carries a filesystem path, so the adapter holds the default.
      workspace_dir: worktree,
      sandbox: 'read-only',
      host,
      clock,
      ids,
      default_timeout_ms: EXECUTION_TIMEOUT_MS,
    })

    const core = new WorkbenchCore({
      journal,
      agentPort,
      clock,
      ids,
      project_id: 'smoke-project',
      port_timeout_ms: PORT_TIMEOUT_MS,
    })

    const task = unwrap(
      await core.createTask({
        conversation_ref: {
          browser_adapter_id: 'smoke-browser',
          conversation_id: 'smoke-conversation',
        },
        idempotency_key: 'smoke-task-key-1',
        goal: PROMPT,
        requested_execution: {
          agent_id: 'codex-verifier',
          model_id: modelId,
          execution_timeout_ms: EXECUTION_TIMEOUT_MS,
        },
      }),
      'createTask',
    )
    line('task', `${task.task_id} (${task.state})`)

    unwrap(await core.markTaskReady(task.task_id), 'markTaskReady')

    const started = unwrap(await core.startRun(task.task_id), 'startRun')
    line('run', started.run_id)
    line('run after start', started.state)

    const deadline = Date.now() + TOTAL_BUDGET_MS
    let observed = ''
    let settled = false

    for (;;) {
      const reconciled = await core.reconcileRun(started.run_id)
      if (!reconciled.ok) {
        line('reconcile', `${reconciled.error.code} - ${reconciled.error.detail}`)
        break
      }

      if (reconciled.value.state !== observed) {
        observed = reconciled.value.state
        line('run state', observed)
      }

      if (isTerminal(observed)) {
        settled = true
        break
      }
      if (Date.now() > deadline) {
        line('budget', 'exhausted before the run reached a terminal state')
        break
      }

      await Bun.sleep(POLL_INTERVAL_MS)
    }

    if (!settled) return 3

    // The Codex usage figures are kept on the run record, since the material has
    // no field for them.
    const run = await journal.readRun(started.run_id)
    if (run?.native_ref != null) {
      const recordPath = join(stateDir, 'codex', 'runs', `${sanitizeRunRef(run.native_ref)}.json`)
      try {
        const record = JSON.parse(readFileSync(recordPath, 'utf8')) as { stdout_lines: string[] }
        const stream = summarizeCodexStream(record.stdout_lines)
        line('codex events', String(stream.event_count))
        line('codex thread', stream.thread_id ?? '(none)')
        line('codex notices', String(stream.notices.length))
        // The material has no field for token usage, so it is reported here.
        line('codex usage', stream.usage === null ? '(none)' : JSON.stringify(stream.usage))
      } catch {
        line('codex record', 'unreadable')
      }
    }

    const result = await journal.readResultByRun(started.run_id)
    if (result === null) {
      line('result', 'none was persisted')
      return 3
    }

    line('outcome', result.outcome.status)
    line('completion', result.outcome.completion)
    line('summary', result.summary)
    line('changed files', result.changed_files.length === 0 ? '(none)' : JSON.stringify(result.changed_files))
    line('commands', String(result.commands.length))
    line('validations', String(result.validations.length))
    line('git dirty', String(result.git_state.dirty ?? 'unknown'))
    line('commit performed', String(result.git_state.commit_performed))
    line('errors', result.errors.length === 0 ? '(none)' : JSON.stringify(result.errors))

    return result.outcome.status === 'succeeded' ? 0 : 4
  } catch (error) {
    line('exception', error instanceof Error ? error.message : String(error))
    return 3
  } finally {
    await journal.close()
    rmSync(root, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const stage = process.argv[2] ?? 'probe'
  const modelId = process.argv[3] ?? DEFAULT_MODEL

  if (stage !== 'probe' && stage !== 'e2e') {
    console.log('usage: bun src/server/workbenchos/adapters/codexSmoke.ts <probe|e2e> [model]')
    process.exitCode = 2
    return
  }

  const discovery = discoverCodexBinary()
  if (discovery.status !== 'found') {
    line('codex binary', 'NOT FOUND')
    line('searched', discovery.searched.join(', '))
    process.exitCode = 1
    return
  }

  line('stage', stage)
  line('codex binary', discovery.binary.path)
  line('release dir', discovery.binary.release_dir)
  line('model', modelId)

  const host = createWorkerProcessHost()

  const version = await host.run({
    executable: discovery.binary.path,
    args: ['--version'],
    cwd: tmpdir(),
    stdin: null,
    timeout_ms: 60_000,
  })
  line('version outcome', version.outcome)
  line('version exit', String(version.exit_code))
  line('version output', version.stdout.trim())

  const health = await createCodexAdapter({
    binary_path: discovery.binary.path,
    state_dir: join(tmpdir(), 'workbenchos-smoke-health'),
    scratch_dir: join(tmpdir(), 'workbenchos-smoke-health-scratch'),
    model_id: modelId,
    host,
    clock: { now: () => '2026-10-02T00:00:00.000Z' },
    ids: { next: () => 'health' },
  }).healthCheck(1000)
  line('health available', String(health.available))
  line('health caps', health.capabilities.join(', '))

  if (stage === 'probe') {
    process.exitCode = 0
    return
  }

  process.exitCode = await runEndToEnd(discovery.binary.path, modelId, host)
}

await main()
