import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const sourceRoot = import.meta.dir
const hostModule = join(sourceRoot, 'workerProcessHost.ts').replaceAll('\\', '/')
const supervisorModule = join(sourceRoot, 'workerSupervisor.ts').replaceAll('\\', '/')

describe('compiled worker supervisor dispatch', () => {
  test('self-dispatches once and persists fake worker outcome', () => {
    const root = mkdtempSync(join(tmpdir(), 'workbenchos-compiled-supervisor-'))
    const entryPath = join(root, 'compiled-probe.ts')
    const binaryPath = join(root, 'compiled-probe.exe')
    const counterPath = join(root, 'invocations.json')
    const outcomePath = join(root, 'worker-outcome.json')

    const source = `
import { readFileSync, writeFileSync } from 'node:fs'
import { createWorkerProcessHost } from ${JSON.stringify(hostModule)}
import { runWorkerSupervisor } from ${JSON.stringify(supervisorModule)}

const counterPath = process.env.PROBE_COUNTER_PATH!
const counts = JSON.parse(readFileSync(counterPath, 'utf8')) as { main: number; supervisor: number }
if (process.argv[2] === '--workbenchos-worker-supervisor') {
  counts.supervisor += 1
  writeFileSync(counterPath, JSON.stringify(counts))
  await runWorkerSupervisor()
  process.exit(0)
}
counts.main += 1
writeFileSync(counterPath, JSON.stringify(counts))
if (counts.main > 1) process.exit(92)
const outcome = await createWorkerProcessHost().run({
  executable: process.env.PROBE_BUN_EXECUTABLE!,
  args: ['-e', 'process.stdout.write("compiled-worker-ok")'],
  cwd: process.cwd(),
  stdin: null,
  timeout_ms: 5000,
  env_mode: 'replace',
  env: {
    PATH: process.env.PATH ?? '',
    SystemRoot: process.env.SystemRoot ?? '',
  },
  durable_outcome_path: process.env.PROBE_OUTCOME_PATH!,
})
console.log(JSON.stringify(outcome))
`

    try {
      writeFileSync(counterPath, JSON.stringify({ main: 0, supervisor: 0 }), 'utf8')
      writeFileSync(entryPath, source, 'utf8')
      const compile = Bun.spawnSync(
        [process.execPath, 'build', '--compile', entryPath, '--outfile', binaryPath],
        { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 },
      )
      if (compile.exitCode !== 0) {
        throw new Error(
          `compiled supervisor fixture failed (${compile.exitCode}) in ${root}: ` +
          compile.stderr.toString(),
        )
      }
      expect(readFileSync(counterPath, 'utf8')).toBe('{"main":0,"supervisor":0}')

      const run = Bun.spawnSync([binaryPath], {
        env: {
          PATH: process.env.PATH ?? '',
          SystemRoot: process.env.SystemRoot ?? '',
          PROBE_BUN_EXECUTABLE: process.execPath,
          PROBE_COUNTER_PATH: counterPath,
          PROBE_OUTCOME_PATH: outcomePath,
        },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 20_000,
      })
      if (run.exitCode !== 0) {
        throw new Error(
          `compiled supervisor run failed (${run.exitCode}) in ${root}; ` +
          `stdout=${run.stdout.toString()} stderr=${run.stderr.toString()}`,
        )
      }
      expect(run.stderr.toString()).toBe('')
      const counts = JSON.parse(readFileSync(counterPath, 'utf8')) as {
        main: number
        supervisor: number
      }
      expect(counts).toEqual({ main: 1, supervisor: 1 })
      const outcome = JSON.parse(readFileSync(outcomePath, 'utf8')) as {
        outcome: string
        exit_code: number | null
        stdout: string
      }
      expect(outcome).toEqual({
        outcome: 'exited',
        exit_code: 0,
        stdout: 'compiled-worker-ok',
        stderr: '',
        lines: ['compiled-worker-ok'],
        duration_ms: expect.any(Number),
        failure_detail: null,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
