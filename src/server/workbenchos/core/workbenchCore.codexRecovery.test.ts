/**
 * REAL-003E — process-loss recovery through the detached supervisor, Codex
 * Adapter, WorkbenchCore, and the real SQLite journal.
 *
 * The provider is replaced by a local fake CLI. No model or network is used.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createCodexAdapter } from '../adapters/codexAdapter.js'
import { createWorkerProcessHost, type WorkerProcessHost, type WorkerRunOutcome } from '../adapters/workerProcessHost.js'
import { SqliteJournal } from '../persistence/sqliteJournal.js'
import { WorkbenchCore, type Clock, type CoreResult } from './workbenchCore.js'

function expectOk<T>(result: CoreResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.detail}`)
  return result.value
}

function gitOutcome(spec: {
  args: string[]
}): WorkerRunOutcome {
  const stdout = spec.args[0] === 'rev-parse'
    ? (spec.args[1] === 'HEAD' ? 'test-head\n' : 'main\n')
    : ''
  return {
    outcome: 'exited',
    exit_code: 0,
    stdout,
    stderr: '',
    lines: stdout.trim().length === 0 ? [] : [stdout.trim()],
    duration_ms: 1,
    failure_detail: null,
  }
}

describe('WorkbenchCore Codex durable result recovery', () => {
  test('records one Result after the Workbench host exits and the supervisor saves terminal evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workbenchos-codex-recovery-'))
    const stateDir = join(root, 'state')
    const scratchDir = join(root, 'scratch')
    const workspaceDir = join(root, 'worktree')
    const databasePath = join(root, 'workbench.sqlite3')
    const binaryPath = join(root, 'codex.exe')
    const fakeCodexPath = join(root, 'fake-codex.ts')
    const releasePath = join(root, 'release-codex')
    const launchInfoPath = join(root, 'launch-info.json')
    let durableOutcomePath: string | null = null
    let journalOpened = false
    mkdirSync(stateDir, { recursive: true })
    mkdirSync(scratchDir, { recursive: true })
    mkdirSync(workspaceDir, { recursive: true })
    writeFileSync(binaryPath, 'test binary marker', 'utf8')
    writeFileSync(fakeCodexPath, `
import { existsSync } from 'node:fs'
const releasePath = process.argv[2]
for (let attempt = 0; attempt < 200 && !existsSync(releasePath); attempt += 1) {
  await Bun.sleep(50)
}
if (!existsSync(releasePath)) process.exit(70)
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-recovered' }))
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'item-1', type: 'agent_message', text: JSON.stringify({ verdict: 'pass', reason: 'recovered' }) } }))
console.log(JSON.stringify({ type: 'turn.completed' }))
process.exit(0)
`, 'utf8')

    const hostModuleUrl = pathToFileURL(join(import.meta.dir, '..', 'adapters', 'workerProcessHost.ts')).href
    const adapterModuleUrl = pathToFileURL(join(import.meta.dir, '..', 'adapters', 'codexAdapter.ts')).href
    const journalModuleUrl = pathToFileURL(join(import.meta.dir, '..', 'persistence', 'sqliteJournal.ts')).href
    const coreModuleUrl = pathToFileURL(join(import.meta.dir, 'workbenchCore.ts')).href
    const launcherPath = join(root, 'first-workbench-host.ts')
    const launcherSource = `
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCodexAdapter } from ${JSON.stringify(adapterModuleUrl)}
import { createWorkerProcessHost } from ${JSON.stringify(hostModuleUrl)}
import { SqliteJournal } from ${JSON.stringify(journalModuleUrl)}
import { WorkbenchCore } from ${JSON.stringify(coreModuleUrl)}

let tick = 0
const clock = { now: () => '2026-10-03T01:00:' + String(++tick % 60).padStart(2, '0') + '.000Z' }
let id = 0
const ids = { next: () => 'first-' + String(++id) }
const nativeHost = createWorkerProcessHost()
const host = {
  run(spec) {
    if (spec.executable === 'git') {
      const stdout = spec.args[0] === 'rev-parse' ? (spec.args[1] === 'HEAD' ? 'test-head\\n' : 'main\\n') : ''
      return Promise.resolve({ outcome: 'exited', exit_code: 0, stdout, stderr: '', lines: stdout.trim() ? [stdout.trim()] : [], duration_ms: 1, failure_detail: null })
    }
    return nativeHost.run({ ...spec, executable: process.execPath, args: [${JSON.stringify(fakeCodexPath)}, ${JSON.stringify(releasePath)}] })
  },
}
const journal = new SqliteJournal({ databasePath: ${JSON.stringify(databasePath)} })
await journal.open()
const agent = createCodexAdapter({ binary_path: ${JSON.stringify(binaryPath)}, state_dir: ${JSON.stringify(stateDir)}, scratch_dir: ${JSON.stringify(scratchDir)}, model_id: 'gpt-5.6-terra', host, clock, ids })
const core = new WorkbenchCore({ journal, agentPort: agent, clock, ids, project_id: 'project-codex-recovery', port_timeout_ms: 1000 })
const created = await core.createTask({ conversation_ref: { browser_adapter_id: 'chatgpt-web', conversation_id: 'conversation-1' }, idempotency_key: 'codex-recovery-task-key', goal: 'verify durable Codex result recovery', requested_execution: { agent_id: 'codex-verifier', execution_timeout_ms: 600000 } })
if (!created.ok) throw new Error(created.error.detail)
const ready = await core.markTaskReady(created.value.task_id)
if (!ready.ok) throw new Error(ready.error.detail)
const started = await core.startRun(created.value.task_id, ${JSON.stringify(workspaceDir)})
if (!started.ok) throw new Error(started.error.detail)
const run = await journal.readRun(started.value.run_id)
const safeRef = (run?.native_ref ?? '').replace(/[^A-Za-z0-9._-]/g, '-')
const outcomePath = join(${JSON.stringify(stateDir)}, 'runs', safeRef + '.outcome.json')
writeFileSync(${JSON.stringify(launchInfoPath)}, JSON.stringify({ task_id: created.value.task_id, run_id: started.value.run_id, native_ref: run?.native_ref, outcome_path: outcomePath }), 'utf8')
process.exit(0)
`
    writeFileSync(launcherPath, launcherSource, 'utf8')

    let journal = new SqliteJournal({ databasePath })
    try {
      const launcher = Bun.spawn([process.execPath, launcherPath], {
        cwd: root,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [launcherExit, launcherStdout, launcherStderr] = await Promise.all([
        launcher.exited,
        new Response(launcher.stdout).text(),
        new Response(launcher.stderr).text(),
      ])
      expect({ exit: launcherExit, stdout: launcherStdout, stderr: launcherStderr }).toEqual({
        exit: 0,
        stdout: '',
        stderr: '',
      })
      const launchInfo = JSON.parse(await Bun.file(launchInfoPath).text()) as {
        task_id: string
        run_id: string
        native_ref: string
        outcome_path: string
      }
      durableOutcomePath = launchInfo.outcome_path
      expect(existsSync(durableOutcomePath)).toBe(false)
      expect(launchInfo.native_ref).toMatch(/^codex:first-/)

      await journal.open()
      journalOpened = true
      let nextId = 1000
      const clock: Clock = {
        now: () => `2026-10-03T02:00:${String(nextId % 60).padStart(2, '0')}.000Z`,
      }
      const secondHost: WorkerProcessHost = {
        run: async spec => {
          if (spec.executable === 'git') return gitOutcome(spec)
          throw new Error('recovery must not spawn Codex again')
        },
      }
      const secondAgent = createCodexAdapter({
        binary_path: binaryPath,
        state_dir: stateDir,
        scratch_dir: scratchDir,
        model_id: 'gpt-5.6-terra',
        host: secondHost,
        clock,
        ids: { next: () => `second-${String(++nextId)}` },
      })
      const secondCore = new WorkbenchCore({
        journal,
        agentPort: secondAgent,
        clock,
        ids: { next: () => `core-${String(++nextId)}` },
        project_id: 'project-codex-recovery',
        port_timeout_ms: 1000,
      })

      const withoutEvidence = expectOk(await secondCore.recoverPendingRuns())
      expect(withoutEvidence.reconciled).toEqual([])
      expect(withoutEvidence.recovery_required).toEqual([launchInfo.run_id])
      expect(await journal.readResultByRun(launchInfo.run_id)).toBeNull()
      expect((await journal.readRun(launchInfo.run_id))?.state).toBe('RECOVERY_REQUIRED')

      writeFileSync(releasePath, 'continue fake Codex', 'utf8')
      for (let attempt = 0; attempt < 150 && !existsSync(durableOutcomePath); attempt += 1) {
        await Bun.sleep(50)
      }
      expect(existsSync(durableOutcomePath)).toBe(true)

      const withEvidence = expectOk(await secondCore.recoverPendingRuns())
      expect(withEvidence.reconciled).toEqual([launchInfo.run_id])
      expect(withEvidence.recovery_required).toEqual([])
      const recoveredRun = await journal.readRun(launchInfo.run_id)
      const result = await journal.readResultByRun(launchInfo.run_id)
      expect(recoveredRun?.native_ref).toBe(launchInfo.native_ref)
      expect(recoveredRun?.state).toBe('SUCCEEDED')
      expect(result?.outcome.status).toBe('succeeded')
      expect(result?.summary).toBe('{"verdict":"pass","reason":"recovered"}')
      const events = await journal.listEventsForTask(launchInfo.task_id)
      expect(events.filter(event => event.event_type === 'run.result_recorded')).toHaveLength(1)
      expect((await journal.listNonTerminalRuns()).map(run => run.run_id)).toEqual([])
    } finally {
      writeFileSync(releasePath, 'release during cleanup', 'utf8')
      if (journalOpened) await journal.close()
      for (
        let attempt = 0;
        attempt < 50 && durableOutcomePath !== null && !existsSync(durableOutcomePath);
        attempt += 1
      ) {
        await Bun.sleep(50)
      }
      rmSync(root, { recursive: true, force: true })
    }
  })
})
