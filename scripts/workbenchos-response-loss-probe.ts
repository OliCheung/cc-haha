/**
 * L0-001-REAL-002B — isolated host-crash recovery probe.
 *
 * This is an explicit manual harness. `stub-supervisor` is local-only and
 * deterministic. `real-supervisor` performs exactly one real Codex operation.
 * Never rerun `real-supervisor` after it has created its operation lock.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  WORKBENCHOS_AGENT_MODEL_ENV,
  createWorkbenchOSRuntime,
} from '../src/server/workbenchosRuntime.js'
import { discoverCodexBinary } from '../src/server/workbenchos/adapters/codexDiscovery.js'
import { taskIngestKey } from '../src/server/workbenchos/core/idempotency.js'
import type { CoreResult } from '../src/server/workbenchos/core/workbenchCore.js'
import { sanitizeRunRef } from '../src/server/workbenchos/adapters/codexAdapter.js'

const MODEL = 'gpt-5.6-terra'
const OPERATION = 'l0-real-002'
const WAIT_MS = 300_000
const POLL_MS = 100
const mode = process.argv[2]

type ProcessInfo = {
  ProcessId: number
  ParentProcessId: number
  ExecutablePath: string | null
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' })
}

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms))
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = WAIT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(POLL_MS)
  }
  throw new Error(`timed out waiting for ${label} after ${timeoutMs}ms`)
}

function processTable(): ProcessInfo[] {
  if (process.platform !== 'win32') throw new Error('this probe requires Windows process controls')
  const command =
    '$ProgressPreference="SilentlyContinue"; Get-CimInstance Win32_Process | ' +
    'Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress'
  const result = Bun.spawnSync(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(`process snapshot failed: ${result.stderr.toString().trim()}`)
  }
  const output = result.stdout.toString().trim()
  if (output.length === 0) return []
  const parsed = JSON.parse(output) as ProcessInfo | ProcessInfo[]
  return Array.isArray(parsed) ? parsed : [parsed]
}

function processByPid(pid: number): ProcessInfo | undefined {
  return processTable().find(entry => Number(entry.ProcessId) === pid)
}

function directChildren(parentPid: number, executablePath?: string): ProcessInfo[] {
  const normalize = (value: string) => resolve(value).toLowerCase()
  return processTable().filter(entry =>
    Number(entry.ParentProcessId) === parentPid &&
    (executablePath === undefined ||
      (entry.ExecutablePath !== null && normalize(entry.ExecutablePath) === normalize(executablePath))),
  )
}

function stopOnly(pid: number): void {
  const result = Bun.spawnSync(['taskkill.exe', '/PID', String(pid), '/F'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0 && processByPid(pid) !== undefined) {
    throw new Error(`could not stop only host PID ${pid}: ${result.stderr.toString().trim()}`)
  }
}

function assertOk<T>(result: CoreResult<T>, operation: string): T {
  if (!result.ok) throw new Error(`${operation}: ${result.error.code}: ${result.error.detail}`)
  return result.value
}

function runtimeOptions(scope: string | undefined, binaryPath: string) {
  const discovery = discoverCodexBinary()
  assert(discovery.status === 'found', 'Codex release directory could not be identified')
  const env = { [WORKBENCHOS_AGENT_MODEL_ENV]: scope === undefined ? MODEL : 'codex-probe-stub' }
  return {
    ...(scope === undefined ? {} : { scope }),
    env,
    discoverBinary: () => ({
      status: 'found' as const,
      binary: {
        path: binaryPath,
        release_dir: scope === undefined ? discovery.binary.release_dir : 'probe-stub',
        mtime_ms: scope === undefined ? discovery.binary.mtime_ms : 0,
      },
    }),
  }
}

function submissionIndexPath(scope: string): string {
  return join(scope, 'cc-haha', 'workbenchos', 'agent', 'state', 'submissions.json')
}

function runFiles(stateDir: string): string[] {
  const path = join(stateDir, 'runs')
  return existsSync(path) ? readdirSync(path).filter(name => name.endsWith('.json')).sort() : []
}

function submissionKeysAt(stateDir: string): string[] {
  const path = join(stateDir, 'submissions.json')
  return existsSync(path) ? Object.keys(readJson<Record<string, unknown>>(path)).sort() : []
}

async function compileStub(root: string): Promise<string> {
  const sourcePath = join(root, 'codex-probe-stub.ts')
  const binaryPath = join(root, 'codex-probe-stub.exe')
  const source = String.raw`
import { existsSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(1)
const outputIndex = args.indexOf('-o')
if (outputIndex < 0 || typeof args[outputIndex + 1] !== 'string') process.exit(91)
const lastMessagePath = args[outputIndex + 1]!
const startPath = lastMessagePath + '.stub-start.json'
const releasePath = lastMessagePath + '.stub-release'
writeFileSync(startPath, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }), { flag: 'wx' })
while (!existsSync(releasePath)) await new Promise(resolve => setTimeout(resolve, 50))
process.exit(0)
`
  writeFileSync(sourcePath, source, 'utf8')
  const result = Bun.spawnSync([process.execPath, 'build', '--compile', sourcePath, '--outfile', binaryPath], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0 || !existsSync(binaryPath)) {
    throw new Error(`failed to compile deterministic stub: ${result.stderr.toString().trim()}`)
  }
  return binaryPath
}

async function createAndSubmit(root: string, binaryPath: string, real: boolean): Promise<never> {
  const scope = real ? undefined : join(root, 'app-state')
  const workspace = real ? join(root, 'workspace') : join(root, 'workspace')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'probe.txt'), `WORKBENCHOS-${real ? 'REAL' : 'STUB'}-002\n`, {
    encoding: 'utf8',
    flag: 'wx',
  })

  if (!real) {
    mkdirSync(join(root, 'empty-codex-home'), { recursive: true })
    process.env.CODEX_HOME = join(root, 'empty-codex-home')
  }

  const runtime = createWorkbenchOSRuntime(runtimeOptions(scope, binaryPath))
  assert(runtime.core !== null, `Core unavailable: ${runtime.agentFailure?.code ?? 'unknown'}`)
  await runtime.openJournal()
  try {
    const identity = real ? OPERATION : 'l0-stub-002'
    const input = {
      conversation_ref: { browser_adapter_id: 'codex-probe', conversation_id: identity },
      idempotency_key: identity,
      goal:
        `Read probe.txt in the supplied workspace and report its exact text as JSON. ` +
        `Do not change files. Operation identity: ${identity}.`,
      requested_execution: {
        agent_id: 'codex-verifier',
        model_id: real ? MODEL : 'codex-probe-stub',
        execution_timeout_ms: 180_000,
      },
    }
    const created = assertOk(await runtime.core.createTask(input), 'createTask')
    assertOk(await runtime.core.markTaskReady(created.task_id), 'markTaskReady')
    const started = assertOk(await runtime.core.startRun(created.task_id, workspace), 'startRun')
    const run = await runtime.journal.readRun(started.run_id)
    assert(run !== null, 'run projection missing after startRun')

    const submittedPath = join(root, 'submitted.json')
    writeJson(submittedPath, {
      host_pid: process.pid,
      task_id: created.task_id,
      run_id: started.run_id,
      native_ref: run.native_ref,
      submission_key: run.submission_key,
      workspace,
      started_state: started.state,
      submitted_at: new Date().toISOString(),
      real,
    })
    console.log(JSON.stringify({ event: 'submitted', host_pid: process.pid, run_id: started.run_id }))
    await new Promise<never>(() => {})
  } finally {
    await runtime.closeJournal()
  }
}

async function recover(root: string, real: boolean, stubBinary?: string): Promise<Record<string, unknown>> {
  const scope = real ? undefined : join(root, 'app-state')
  if (!real && scope !== undefined) process.env.CODEX_HOME = join(root, 'empty-codex-home')
  const binaryPath = real
    ? discoverCodexBinary().status === 'found'
      ? (discoverCodexBinary() as { status: 'found'; binary: { path: string } }).binary.path
      : ''
    : stubBinary ?? ''
  assert(binaryPath.length > 0, 'Codex binary unavailable during recovery')

  const runtime = createWorkbenchOSRuntime(runtimeOptions(scope, binaryPath))
  assert(runtime.core !== null, `Core unavailable during recovery: ${runtime.agentFailure?.code ?? 'unknown'}`)
  await runtime.openJournal()
  try {
    const submitted = readJson<{ task_id: string; run_id: string; native_ref: string | null }>(join(root, 'submitted.json'))
    const outcome = assertOk(await runtime.core.recoverPendingRuns(), 'recoverPendingRuns')
    const run = await runtime.journal.readRun(submitted.run_id)
    const result = await runtime.journal.readResultByRun(submitted.run_id)
    const detail = {
      recovered: outcome,
      task_id: submitted.task_id,
      run_id: submitted.run_id,
      original_native_ref: submitted.native_ref,
      recovered_native_ref: run?.native_ref ?? null,
      run_state: run?.state ?? null,
      result_id: result?.result_id ?? null,
      result_status: result?.outcome.status ?? null,
      run_record_files: runFiles(runtime.agentDirectories.stateDir),
      submission_keys: submissionKeysAt(runtime.agentDirectories.stateDir),
    }
    writeJson(join(root, 'recovery.json'), detail)
    return detail
  } finally {
    await runtime.closeJournal()
  }
}

async function stubSupervisor(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'workbenchos-real-002-stub-'))
  const binaryPath = await compileStub(root)
  const host = Bun.spawn([process.execPath, import.meta.path, 'stub-host', root, binaryPath], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const hostPid = host.pid
  let recovery: Record<string, unknown> | null = null
  try {
    await waitFor(() => existsSync(join(root, 'submitted.json')), 'stub host submission')
    const submitted = readJson<{ host_pid: number; native_ref: string | null }>(join(root, 'submitted.json'))
    assert(submitted.host_pid === hostPid, 'submitted host PID does not match supervisor child')
    const markerDir = join(root, 'app-state', 'cc-haha', 'workbenchos', 'agent', 'scratch')
    await waitFor(
      () => existsSync(markerDir) && readdirSync(markerDir).some(name => name.endsWith('.stub-start.json')),
      'stub process start marker',
    )
    const markerName = readdirSync(markerDir).find(name => name.endsWith('.stub-start.json'))
    assert(markerName !== undefined, 'stub start marker disappeared')
    const markerPath = join(markerDir, markerName)
    const marker = readJson<{ pid: number }>(markerPath)
    const child = processByPid(marker.pid)
    assert(child !== undefined, 'stub child is not present in the Windows process table')
    assert(Number(child.ParentProcessId) === hostPid, 'stub process parent PID is not the WorkbenchOS host')
    assert(
      child.ExecutablePath !== null && resolve(child.ExecutablePath).toLowerCase() === resolve(binaryPath).toLowerCase(),
      'stub executable path does not match the compiled probe binary',
    )

    stopOnly(hostPid)
    await host.exited
    await delay(500)
    const childAfterCrash = processByPid(marker.pid)
    const survived = childAfterCrash !== undefined
    assert(survived, 'Windows terminated the stub child with its WorkbenchOS host')

    recovery = await recover(root, false, binaryPath)
    const runCount = runFiles(join(root, 'app-state', 'cc-haha', 'workbenchos', 'agent', 'state')).length
    const markerCount = readdirSync(markerDir).filter(name => name.endsWith('.stub-start.json')).length
    assert(runCount === 1, `expected one durable adapter run record, found ${runCount}`)
    assert(markerCount === 1, `expected one native stub execution, found ${markerCount}`)
    assert(recovery.recovered_native_ref === submitted.native_ref, 'recovery changed the native reference')
    assert(recovery.run_state === 'RUNNING', `expected RUNNING after orphaned child, got ${String(recovery.run_state)}`)

    const releasePath = markerPath.replace(/\.stub-start\.json$/, '.stub-release')
    writeFileSync(releasePath, 'release\n', { flag: 'wx' })
    await waitFor(() => processByPid(marker.pid) === undefined, 'stub child exit', 15_000)
    console.log(JSON.stringify({
      status: 'STUB_PASS',
      root,
      host_pid: hostPid,
      child_pid: marker.pid,
      child_survived_host_crash: survived,
      native_execution_count: markerCount,
      adapter_run_record_count: runCount,
      recovery,
      result_available: recovery.result_id !== null,
    }, null, 2))
  } catch (error) {
    try {
      if (processByPid(hostPid) !== undefined) stopOnly(hostPid)
    } catch {
      // Preserve the primary failure and do not kill any process except our host PID.
    }
    throw error
  }
}

async function hostMode(args: string[], real: boolean): Promise<void> {
  const root = args[0]
  const stubBinary = args[1]
  assert(root !== undefined, 'host mode requires a run root')
  assert(real || stubBinary !== undefined, 'stub host mode requires the compiled executable')
  let binaryPath = stubBinary
  if (real) {
    const discovery = discoverCodexBinary()
    assert(discovery.status === 'found', 'Codex binary not found')
    binaryPath = discovery.binary.path
  }
  assert(binaryPath !== undefined, 'Codex binary path missing')
  await createAndSubmit(root, binaryPath, real)
}

async function runRealSupervisor(): Promise<void> {
  const lockPath = join(tmpdir(), `${OPERATION}.lock`)
  assert(!existsSync(lockPath), `one-time operation lock already exists: ${lockPath}`)
  const binary = discoverCodexBinary()
  assert(binary.status === 'found', 'Codex binary not found')
  assert(binary.binary.path.toLowerCase().endsWith('codex.exe'), 'discovered binary is not codex.exe')

  const preflightRuntime = createWorkbenchOSRuntime({
    env: { [WORKBENCHOS_AGENT_MODEL_ENV]: MODEL },
  })
  await preflightRuntime.openJournal()
  let before: Record<string, unknown>
  try {
    const operationKey = taskIngestKey({
      browser_adapter_id: 'codex-probe',
      conversation_id: OPERATION,
      idempotency_key: OPERATION,
    })
    const prior = await preflightRuntime.journal.readIdempotency('task-ingest', operationKey)
    assert(prior === null, `operation identity already exists in journal (${prior?.outcome_ref ?? 'unknown'})`)
    const keys = submissionKeysAt(preflightRuntime.agentDirectories.stateDir)
    assert(!keys.some(key => key.includes(OPERATION)), 'matching operation key exists in submission index')
    before = {
      run_record_files: runFiles(preflightRuntime.agentDirectories.stateDir),
      submission_keys: keys,
      scratch_last_files: existsSync(preflightRuntime.agentDirectories.scratchDir)
        ? readdirSync(preflightRuntime.agentDirectories.scratchDir).filter(name => name.endsWith('-last.json')).sort()
        : [],
      task_ingest_record: prior,
      codex_version: Bun.spawnSync([binary.binary.path, '--version'], { stdout: 'pipe', stderr: 'pipe' }).stdout.toString().trim(),
      model: MODEL,
    }
  } finally {
    await preflightRuntime.closeJournal()
  }
  assert(before.codex_version === 'codex-cli 0.160.0', `unexpected Codex version: ${String(before.codex_version)}`)

  writeFileSync(lockPath, JSON.stringify({ operation: OPERATION, created_at: new Date().toISOString() }), {
    encoding: 'utf8',
    flag: 'wx',
  })
  const root = mkdtempSync(join(tmpdir(), `${OPERATION}-`))
  const host = Bun.spawn([process.execPath, import.meta.path, 'real-host', root], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const hostPid = host.pid
  let childPid: number | null = null
  try {
    await waitFor(() => existsSync(join(root, 'submitted.json')), 'real Codex submission')
    const submitted = readJson<{ host_pid: number; native_ref: string | null }>(join(root, 'submitted.json'))
    assert(submitted.host_pid === hostPid, 'submitted host PID does not match supervisor child')
    const children = directChildren(hostPid, binary.binary.path)
    assert(children.length === 1, `expected one direct Codex child, found ${children.length}`)
    childPid = Number(children[0]!.ProcessId)
    stopOnly(hostPid)
    await host.exited
    console.log(JSON.stringify({ event: 'host_crashed', host_pid: hostPid, codex_pid: childPid, operation: OPERATION }))

    const finishDeadline = Date.now() + WAIT_MS
    while (Date.now() < finishDeadline && processByPid(childPid) !== undefined) await delay(500)
    if (processByPid(childPid) !== undefined) {
      stopOnly(childPid)
      throw new Error(`Codex process PID ${childPid} exceeded the five-minute limit and was stopped; do not retry`)
    }

    const recovery = await recover(root, true)
    const postRuntime = createWorkbenchOSRuntime({ env: { [WORKBENCHOS_AGENT_MODEL_ENV]: MODEL } })
    const lastFiles = existsSync(postRuntime.agentDirectories.scratchDir)
      ? readdirSync(postRuntime.agentDirectories.scratchDir).filter(name => name.endsWith('-last.json')).sort()
      : []
    const expectedLastMessage = submitted.native_ref === null
      ? null
      : `${sanitizeRunRef(submitted.native_ref)}-last.json`
    const beforeRuns = before.run_record_files as string[]
    const beforeKeys = before.submission_keys as string[]
    const beforeLastFiles = before.scratch_last_files as string[]
    const newRunRecords = recovery.run_record_files instanceof Array
      ? recovery.run_record_files.filter(name => !beforeRuns.includes(String(name)))
      : []
    const newSubmissionKeys = recovery.submission_keys instanceof Array
      ? recovery.submission_keys.filter(key => !beforeKeys.includes(String(key)))
      : []
    const newLastFiles = lastFiles.filter(name => !beforeLastFiles.includes(name))
    const evidence = {
      status: 'REAL_OPERATION_COMPLETED_NO_RETRY',
      operation: OPERATION,
      root,
      lock_path: lockPath,
      host_pid: hostPid,
      codex_pid: childPid,
      codex_version: before.codex_version,
      before,
      recovery,
      scratch_last_files: lastFiles,
      new_run_records: newRunRecords,
      new_submission_keys: newSubmissionKeys,
      new_last_files: newLastFiles,
      expected_last_message: expectedLastMessage,
      expected_last_message_present: expectedLastMessage === null ? false : lastFiles.includes(expectedLastMessage),
    }
    writeJson(join(root, 'real-evidence.json'), evidence)
    console.log(JSON.stringify(evidence, null, 2))
    assert(newRunRecords.length === 1, `expected exactly one new adapter run record, found ${newRunRecords.length}`)
    assert(newSubmissionKeys.length === 1, `expected exactly one new submission key, found ${newSubmissionKeys.length}`)
    assert(newLastFiles.length <= 1, `expected no more than one new Codex last-message file, found ${newLastFiles.length}`)
    if (newLastFiles.length === 1) {
      assert(newLastFiles[0] === expectedLastMessage, 'new last-message file does not match the submitted native reference')
    }
  } catch (error) {
    try {
      if (processByPid(hostPid) !== undefined) stopOnly(hostPid)
    } catch {
      // Preserve the primary failure.
    }
    throw error
  }
}

async function recoverReal(): Promise<void> {
  const root = process.argv[3]
  assert(root !== undefined, 'real-recover requires the run root')
  console.log(JSON.stringify(await recover(root, true), null, 2))
}

try {
  if (mode === 'stub-supervisor') await stubSupervisor()
  else if (mode === 'stub-host') await hostMode(process.argv.slice(3), false)
  else if (mode === 'stub-recover') {
    const root = process.argv[3]
    const binaryPath = process.argv[4]
    assert(root !== undefined, 'stub-recover requires the run root')
    console.log(JSON.stringify(await recover(root, false, binaryPath), null, 2))
  } else if (mode === 'real-supervisor') await runRealSupervisor()
  else if (mode === 'real-host') await hostMode(process.argv.slice(3), true)
  else if (mode === 'real-recover') await recoverReal()
  else throw new Error('mode must be stub-supervisor, stub-host, stub-recover, real-supervisor, real-host, or real-recover')
} catch (error) {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  process.exitCode = 1
}
