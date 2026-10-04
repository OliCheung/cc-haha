import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

// Repo root = four levels up from .../src/server/workbenchos/adapters
const repoRoot = join(import.meta.dir, '..', '..', '..', '..')
const sidecarEntry = join(repoRoot, 'desktop', 'sidecars', 'claude-sidecar.ts').replaceAll('\\', '/')

// Read-only copy of `desktop/scripts/build-sidecars.ts` mapTargetTripleToBun (lines 165-188).
// We do NOT modify build-sidecars.ts; this only reproduces the same target selection.
function bunTarget(): string {
  const platform = process.platform
  const arch = process.arch
  if (platform === 'darwin') {
    if (arch === 'arm64') return 'bun-darwin-arm64'
    if (arch === 'x64') return 'bun-darwin-x64'
  }
  if (platform === 'win32') {
    if (arch === 'x64') return 'bun-windows-x64-baseline'
    if (arch === 'arm64') return 'bun-windows-arm64'
  }
  if (platform === 'linux') {
    if (arch === 'x64') return 'bun-linux-x64-baseline'
    if (arch === 'arm64') return 'bun-linux-arm64'
  }
  throw new Error(`unsupported platform/arch: ${platform}/${arch}`)
}

// Read-only copy of `desktop/scripts/build-sidecars.ts` external list (lines 212-236).
const EXTERNAL = [
  '@opentelemetry/exporter-trace-otlp-grpc',
  '@opentelemetry/exporter-trace-otlp-http',
  '@opentelemetry/exporter-trace-otlp-proto',
  '@opentelemetry/exporter-logs-otlp-grpc',
  '@opentelemetry/exporter-logs-otlp-http',
  '@opentelemetry/exporter-logs-otlp-proto',
  '@opentelemetry/exporter-metrics-otlp-grpc',
  '@opentelemetry/exporter-metrics-otlp-http',
  '@opentelemetry/exporter-metrics-otlp-proto',
  '@opentelemetry/exporter-prometheus',
  '@aws-sdk/client-bedrock',
  '@aws-sdk/client-sts',
  '@anthropic-ai/bedrock-sdk',
  '@anthropic-ai/foundry-sdk',
  '@anthropic-ai/vertex-sdk',
  '@azure/identity',
  '@anthropic-ai/mcpb',
  'fflate',
  'sharp',
  'react-devtools-core',
]

describe('production sidecar entry compile + supervisor self-dispatch', () => {
  test('compiles real claude-sidecar.ts and runs --workbenchos-worker-supervisor', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wbos-003g-'))
    const binaryPath = join(root, 'claude-sidecar-test.exe')
    const outcomePath = join(root, 'worker-outcome.json')

    try {
      // Step 1 — zero-side-effect compile probe of the REAL production entry.
      let result: any
      try {
        result = await Bun.build({
          entrypoints: [sidecarEntry],
          target: 'bun',
          sourcemap: 'none',
          features: ['TRANSCRIPT_CLASSIFIER'],
          external: EXTERNAL,
          compile: {
            target: bunTarget(),
            outfile: binaryPath,
          },
        })
      } catch (err) {
        throw new Error(
          'PRODUCTION ENTRY COMPILE THREW (BLOCKED; do NOT modify build config or code):\n' +
            (err instanceof Error ? (err.stack ?? err.message) : String(err)),
        )
      }

      // Compile failure => BLOCKED. Do NOT modify build config / code to force success.
      if (!result || result.success !== true) {
        const logs: any[] = (result && (result.logs ?? result.errors)) ?? []
        const text = logs
          .map((l) => (typeof l === 'string' ? l : l?.message ?? JSON.stringify(l)))
          .join('\n')
        const diag = result ? `keys=${Object.keys(result).join(',')}` : 'result=undefined'
        throw new Error(
          `PRODUCTION ENTRY COMPILE FAILED (BLOCKED; do NOT modify build config or code): ${diag}\n${
            text || '(no logs emitted)'
          }`,
        )
      }

      // Step 2 — run the compiled supervisor branch with a fake worker request.
      const request = {
        spec: {
          executable: process.execPath,
          args: ['-e', "process.stdout.write('003g-supervisor-ok')"],
          cwd: process.cwd(),
          stdin: null,
          timeout_ms: 5000,
          env_mode: 'replace',
          env: {
            PATH: process.env.PATH ?? '',
            SystemRoot: process.env.SystemRoot ?? '',
          },
        },
        max_output_bytes: 1_000_000,
        outcome_file_path: outcomePath,
      }

      const run = Bun.spawnSync([binaryPath, '--workbenchos-worker-supervisor'], {
        stdin: Buffer.from(JSON.stringify(request)),
        env: {
          PATH: process.env.PATH ?? '',
          SystemRoot: process.env.SystemRoot ?? '',
        },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 30_000,
      })

      if (run.exitCode !== 0) {
        throw new Error(
          `supervisor run failed (exit ${run.exitCode}):\nstdout=${run.stdout.toString()}\nstderr=${run.stderr.toString()}`,
        )
      }
      expect(run.stderr.toString()).toBe('')

      const outcome = JSON.parse(readFileSync(outcomePath, 'utf8')) as {
        outcome: string
        exit_code: number | null
        stdout: string
      }
      expect(outcome).toMatchObject({
        outcome: 'exited',
        exit_code: 0,
        stdout: '003g-supervisor-ok',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 180_000)
})
