/**
 * Detached supervisor for a single WorkerProcessHost invocation.
 *
 * The WorkbenchOS host sends one JSON request over stdin. This process runs the
 * child with the same WorkerProcessHost implementation and publishes its full
 * terminal outcome atomically, so a host crash does not erase the final event
 * stream or exit code.
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { runWorkerProcess, type WorkerRunSpec } from './workerProcessHost.js'

type SupervisorRequest = {
  spec: Omit<WorkerRunSpec, 'durable_outcome_path'>
  max_output_bytes: number
  outcome_file_path: string
}

export async function runWorkerSupervisor(): Promise<void> {
  const requestText = await new Response(Bun.stdin.stream()).text()
  const request = JSON.parse(requestText) as SupervisorRequest
  const outcome = await runWorkerProcess(request.spec, request.max_output_bytes)

  mkdirSync(dirname(request.outcome_file_path), { recursive: true })
  const temporaryPath = `${request.outcome_file_path}.${String(process.pid)}.tmp`
  writeFileSync(temporaryPath, JSON.stringify(outcome), 'utf8')
  renameSync(temporaryPath, request.outcome_file_path)
}

if (import.meta.main) await runWorkerSupervisor()
