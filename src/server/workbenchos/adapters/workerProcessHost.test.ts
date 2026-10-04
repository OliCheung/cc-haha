/**
 * M3-01 — worker process host contracts.
 *
 * The fake CLI is written into a temp directory at test time, so this package
 * adds no fixture file to the repository.
 *
 * Authorized by task package M3-01.
 */

import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createWorkerProcessHost,
  DEFAULT_MAX_OUTPUT_BYTES,
  type WorkerEnvironmentMode,
  type WorkerProcessHostOptions,
  type WorkerRunOutcome,
  type WorkerRunSpec,
} from './workerProcessHost.js'

const FAKE_CLI = `
const mode = process.argv[2] ?? 'echo'

if (mode === 'echo') {
  console.log('line-1')
  console.log('')
  console.log('line-2')
  process.exit(0)
}

if (mode === 'exit-code') {
  process.exit(Number(process.argv[3] ?? '3'))
}

if (mode === 'sleep') {
  await Bun.sleep(Number(process.argv[3] ?? '5000'))
  console.log('slept')
  process.exit(0)
}

if (mode === 'read-stdin') {
  const text = await new Response(Bun.stdin.stream()).text()
  console.log('stdin:[' + text + ']')
  process.exit(0)
}

if (mode === 'cwd') {
  console.log('cwd:' + process.cwd())
  process.exit(0)
}

if (mode === 'env') {
  console.log('probe:' + (process.env.M3_PROBE ?? 'missing'))
  console.log('home:' + (process.env.USERPROFILE ?? process.env.HOME ?? 'missing'))
  console.log('local-token:' + (process.env.CC_HAHA_LOCAL_ACCESS_TOKEN ?? 'missing'))
  process.exit(0)
}

if (mode === 'big') {
  process.stdout.write('x'.repeat(Number(process.argv[3] ?? '100000')))
  process.exit(0)
}

if (mode === 'stderr') {
  console.log('to-stdout')
  console.error('to-stderr')
  process.exit(0)
}

if (mode === 'codex-event') {
  await Bun.sleep(Number(process.argv[3] ?? '1000'))
  console.log(JSON.stringify({ type: 'turn.completed' }))
  process.exit(0)
}
`

type Harness = {
  readonly dir: string
  readonly sub: string
  readonly cli: string
  run(spec: {
    args: string[]
    stdin?: string | null
    timeout_ms?: number
    cwd?: string
    env?: Record<string, string>
    env_mode?: WorkerEnvironmentMode
    durable_outcome_path?: string
    /** Overrides the executable, so a missing binary can be exercised. */
    executable?: string
  }): Promise<WorkerRunOutcome>
}

async function withHarness(
  body: (h: Harness) => Promise<void>,
  options: WorkerProcessHostOptions = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'workbenchos-host-'))
  const sub = join(dir, 'workdir')
  mkdirSync(sub)
  const cli = join(dir, 'fake-cli.ts')
  writeFileSync(cli, FAKE_CLI, 'utf8')

  const host = createWorkerProcessHost(options)

  try {
    await body({
      dir,
      sub,
      cli,
      run: spec =>
        host.run({
          executable: spec.executable ?? process.execPath,
          args: spec.executable === undefined ? [cli, ...spec.args] : spec.args,
          cwd: spec.cwd ?? dir,
          stdin: spec.stdin ?? null,
          timeout_ms: spec.timeout_ms ?? 10_000,
          ...(spec.env === undefined ? {} : { env: spec.env }),
          ...(spec.env_mode === undefined ? {} : { env_mode: spec.env_mode }),
          ...(spec.durable_outcome_path === undefined
            ? {}
            : { durable_outcome_path: spec.durable_outcome_path }),
        } satisfies WorkerRunSpec),
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('worker process host: outcomes', () => {
  test('reports a clean exit with its code', async () => {
    await withHarness(async (h) => {
      const outcome = await h.run({ args: ['echo'] })

      expect(outcome.outcome).toBe('exited')
      expect(outcome.exit_code).toBe(0)
      expect(outcome.failure_detail).toBeNull()
    })
  })

  test('reports a non-zero exit as exited, not as a failure to run', async () => {
    await withHarness(async (h) => {
      const outcome = await h.run({ args: ['exit-code', '3'] })

      expect(outcome.outcome).toBe('exited')
      expect(outcome.exit_code).toBe(3)
    })
  })

  test('reports a missing executable without throwing', async () => {
    await withHarness(async (h) => {
      const outcome = await h.run({
        args: [],
        executable: join(h.dir, 'no-such-binary-here'),
      })

      expect(outcome.outcome).toBe('spawn_failed')
      expect(outcome.failure_detail).not.toBeNull()
      expect(outcome.stdout).toBe('')
    })
  })

  test('kills a child that outruns its budget', async () => {
    await withHarness(async (h) => {
      const outcome = await h.run({ args: ['sleep', '8000'], timeout_ms: 400 })

      expect(outcome.outcome).toBe('timed_out')
      expect(outcome.duration_ms).toBeLessThan(6000)
      expect(outcome.duration_ms).toBeGreaterThan(50)
    })
  })

  test('persists the full outcome through the optional durable path', async () => {
    await withHarness(async (h) => {
      const outcomePath = join(h.dir, 'outcome.json')
      const outcome = await h.run({
        args: ['codex-event', '50'],
        durable_outcome_path: outcomePath,
      })
      const persisted = JSON.parse(readFileSync(outcomePath, 'utf8')) as WorkerRunOutcome

      expect(persisted).toEqual(outcome)
      expect(persisted.lines).toEqual(['{"type":"turn.completed"}'])
      expect(persisted.exit_code).toBe(0)
      expect(persisted.outcome).toBe('exited')
      expect(
        readdirSync(h.dir).some(name => name.startsWith('outcome.json.') && name.endsWith('.tmp')),
      ).toBe(false)
    })
  })

  test('supervisor persists terminal evidence after the host process exits', async () => {
    await withHarness(async (h) => {
      const outcomePath = join(h.dir, 'crash-outcome.json')
      const launcherPath = join(h.dir, 'host-launcher.ts')
      const hostModuleUrl = new URL('./workerProcessHost.ts', import.meta.url).href
      const launcherSource = `
import { createWorkerProcessHost } from ${JSON.stringify(hostModuleUrl)}
void createWorkerProcessHost().run({
  executable: ${JSON.stringify(process.execPath)},
  args: [${JSON.stringify(h.cli)}, 'codex-event', '1800'],
  cwd: ${JSON.stringify(h.dir)},
  stdin: null,
  timeout_ms: 5000,
  durable_outcome_path: ${JSON.stringify(outcomePath)},
})
process.exit(0)
`
      writeFileSync(launcherPath, launcherSource, 'utf8')

      const launcher = Bun.spawn([process.execPath, launcherPath], {
        cwd: h.dir,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(await launcher.exited).toBe(0)
      expect(existsSync(outcomePath)).toBe(false)

      for (let attempt = 0; attempt < 100 && !existsSync(outcomePath); attempt += 1) {
        await Bun.sleep(100)
      }
      expect(existsSync(outcomePath)).toBe(true)

      const outcome = JSON.parse(readFileSync(outcomePath, 'utf8')) as WorkerRunOutcome
      expect(outcome.lines).toEqual(['{"type":"turn.completed"}'])
      expect(outcome.exit_code).toBe(0)
      expect(outcome.outcome).toBe('exited')
      expect(
        readdirSync(h.dir).some(name => name.startsWith('crash-outcome.json.') && name.endsWith('.tmp')),
      ).toBe(false)
    })
  })
})

describe('worker process host: stdio', () => {
  test('closes stdin immediately when the spec asks for no input', async () => {
    await withHarness(async (h) => {
      const outcome = await h.run({ args: ['read-stdin'], stdin: null, timeout_ms: 5000 })

      // A host that left stdin open would hang here and be killed instead.
      expect(outcome.outcome).toBe('exited')
      expect(outcome.stdout).toContain('stdin:[]')
    })
  })

  test('feeds stdin when the spec provides text', async () => {
    await withHarness(async (h) => {
      const outcome = await h.run({ args: ['read-stdin'], stdin: 'prompt-body' })

      expect(outcome.stdout).toContain('stdin:[prompt-body]')
    })
  })

  test('drops empty lines while preserving order', async () => {
    await withHarness(async (h) => {
      const outcome = await h.run({ args: ['echo'] })

      expect(outcome.lines).toEqual(['line-1', 'line-2'])
    })
  })

  test('captures stderr separately from stdout', async () => {
    await withHarness(async (h) => {
      const outcome = await h.run({ args: ['stderr'] })

      expect(outcome.stdout).toContain('to-stdout')
      expect(outcome.stdout).not.toContain('to-stderr')
      expect(outcome.stderr).toContain('to-stderr')
    })
  })

  test('bounds captured output and marks the truncation', async () => {
    await withHarness(async (h) => {
      const outcome = await h.run({ args: ['big', '200000'] })

      expect(outcome.stdout.endsWith('[truncated]')).toBe(true)
      expect(outcome.stdout.length).toBeLessThan(2000)
    }, { max_output_bytes: 1000 })
  })

  test('exposes a default output budget', () => {
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBe(8 * 1024 * 1024)
  })
})

describe('worker process host: execution context', () => {
  test('runs the child in the requested directory', async () => {
    await withHarness(async (h) => {
      const outcome = await h.run({ args: ['cwd'], cwd: h.sub })

      expect(outcome.stdout).toContain(join('workdir'))
    })
  })

  test('merges the extra environment over the inherited one', async () => {
    await withHarness(async (h) => {
      const outcome = await h.run({ args: ['env'], env: { M3_PROBE: 'injected' } })

      expect(outcome.stdout).toContain('probe:injected')
      // A host that replaced the environment wholesale would print "missing".
      expect(outcome.stdout).not.toContain('home:missing')
    })
  })

  test('hands a replace-mode child an explicit environment instead of the inherited one', async () => {
    await withHarness(async (h) => {
      process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = 'host-test-token'
      process.env.M3_PROBE = 'from-server'
      try {
        const explicit: Record<string, string> = {}
        if (process.env.PATH !== undefined) explicit.PATH = process.env.PATH
        if (process.env.SystemRoot !== undefined) {
          explicit.SystemRoot = process.env.SystemRoot
        }

        const outcome = await h.run({ args: ['env'], env: explicit, env_mode: 'replace' })

        // A variable that exists in the server environment is not inherited …
        expect(outcome.stdout).toContain('probe:missing')
        // … and neither is a server credential. (Bun still injects a minimal
        // Windows baseline such as USERPROFILE, so the guarantee stated here is
        // the one that matters: no server value reaches the child.)
        expect(outcome.stdout).toContain('local-token:missing')
      } finally {
        delete process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
        delete process.env.M3_PROBE
      }
    })
  })

  test('measures real elapsed time', async () => {
    await withHarness(async (h) => {
      const outcome = await h.run({ args: ['echo'] })

      expect(outcome.duration_ms).toBeGreaterThanOrEqual(0)
      expect(Number.isFinite(outcome.duration_ms)).toBe(true)
    })
  })
})
