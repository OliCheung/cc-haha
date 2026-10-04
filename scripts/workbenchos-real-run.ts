/**
 * L0-001-REAL-001 — first real Codex agent execution through the production
 * composition.
 *
 * This is a MANUAL execution harness, not production code: it is not imported by
 * the server and it is deliberately not named `*.test.ts`. Running it performs
 * ONE real Codex call (real quota).
 *
 *   bun scripts/workbenchos-real-run.ts <workspace-dir>
 *
 * What it proves:
 *   WorkbenchCore → AgentPort → CodexAdapter → workerProcessHost
 *     → codex-cli 0.160.0 → explicit run workspace → Result / Evidence
 *
 * What it deliberately does NOT do:
 *   - no retry, no resubmission (exactly one submit)
 *   - no Git add / commit / push
 *   - no browser, no planner
 *   - no change to the frozen production composition (sandbox stays read-only,
 *     reasoning effort stays the CLI default)
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WORKBENCHOS_AGENT_MODEL_ENV,
  createWorkbenchOSRuntime,
} from '../src/server/workbenchosRuntime.js'

const MODEL = 'gpt-5.6-terra'
const POLL_INTERVAL_MS = 5_000
const MAX_WAIT_MS = 300_000
const TERMINAL = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']

function line(key: string, value: string): void {
  console.log(`${key.padEnd(22)}: ${value}`)
}

async function executeRun(runtime: ReturnType<typeof createWorkbenchOSRuntime>, workspace: string): Promise<void> {
  const core = runtime.core
  if (core === null) return

  const created = await core.createTask({
    conversation_ref: { browser_adapter_id: 'none', conversation_id: 'l0-real-001' },
    idempotency_key: 'l0-real-001',
    goal:
      'Read the file probe.txt in this workspace and reply with a JSON object only, of the form ' +
      '{"verdict":"pass","reason":"<the exact content of probe.txt>"}. Do not modify anything.',
    requested_execution: { agent_id: 'codex-verifier', model_id: MODEL, execution_timeout_ms: 180_000 },
  })
  if (!created.ok) {
    console.log(`FAILED createTask: ${created.error.code} - ${created.error.detail}`)
    return
  }
  line('task', `${created.value.task_id} (${created.value.state})`)

  const ready = await core.markTaskReady(created.value.task_id)
  if (!ready.ok) {
    console.log(`FAILED markTaskReady: ${ready.error.code} - ${ready.error.detail}`)
    return
  }

  const started = await core.startRun(created.value.task_id, workspace)
  if (!started.ok) {
    console.log(`FAILED startRun: ${started.error.code} - ${started.error.detail}`)
    return
  }
  const runId = started.value.run_id
  console.log('\n--- run ---')
  line('run_id', runId)
  line('state after start', started.value.state)
  console.log('(one real Codex call is now in flight; polling, no retry)')

  const deadline = Date.now() + MAX_WAIT_MS
  let state = started.value.state
  while (!TERMINAL.includes(state) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    const reconciled = await core.reconcileRun(runId)
    if (!reconciled.ok) {
      line('reconcile', `${reconciled.error.code} - ${reconciled.error.detail}`)
      break
    }
    state = reconciled.value.state
  }

  console.log('\n--- result ---')
  line('run state', state)
  const run = await runtime.journal.readRun(runId)
  line('native_ref', run?.native_ref ?? 'null')

  const result = await runtime.journal.readResultByRun(runId)
  if (result === null) {
    line('result', 'null (not recorded)')
  } else {
    line('result_id', result.result_id)
    line('outcome', `${result.outcome.status} / ${result.outcome.completion}`)
    line('summary', result.summary)
    line('changed_files', String(result.changed_files.length))
    line('commands', String(result.commands.length))
    line('native evidence', JSON.stringify(result.native_evidence_refs))
    line('artifacts', JSON.stringify(result.artifacts))
    line('risks', JSON.stringify(result.risks))
    line('errors', JSON.stringify(result.errors.map(error => error.code)))
    line('git_state', JSON.stringify(result.git_state))
  }
}

async function main(): Promise<void> {
  const workspace = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'workbenchos-real-'))
  if (!existsSync(workspace)) mkdirSync(workspace, { recursive: true })

  // The probe file is created by this harness, not by the agent: the production
  // composition runs the Codex sandbox read-only, so the agent can read and
  // report but cannot write. `wx` preserves any caller-owned probe.txt.
  const probePath = join(workspace, 'probe.txt')
  writeFileSync(probePath, 'WORKBENCHOS-REAL-RUN-PROBE-1600\n', { encoding: 'utf8', flag: 'wx' })

  process.env[WORKBENCHOS_AGENT_MODEL_ENV] = MODEL

  const runtime = createWorkbenchOSRuntime({ env: process.env })

  console.log('--- composition ---')
  line('model_id', MODEL)
  line('workspace', workspace)
  line('probe file', probePath)
  line('journal path', runtime.databasePath)
  line('agent state dir', runtime.agentDirectories.stateDir)
  line('agent scratch dir', runtime.agentDirectories.scratchDir)
  line('browserAutomation', String(runtime.browserAutomation === null ? 'null (not configured)' : 'present'))
  line('agentPort', String(runtime.agentPort === null ? 'null' : 'present'))
  line('core', String(runtime.core === null ? 'null' : 'present'))
  line('agent failure', runtime.agentFailure?.code ?? 'none')

  if (runtime.core === null) {
    console.log('\nABORT: no production Core; nothing was executed.')
    return
  }

  await runtime.openJournal()
  try {
    await executeRun(runtime, workspace)
  } finally {
    await runtime.closeJournal()
  }
  console.log('\ndone.')
}

await main()
