/**
 * M3-01 — worktree evidence contracts.
 *
 * Uses real temporary git repositories, plus a recording host for the argument
 * assertions.
 *
 * Authorized by task package M3-01.
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkerProcessHost, type WorkerRunOutcome, type WorkerRunSpec } from './workerProcessHost.js'
import { collectWorktreeEvidence, parsePorcelainLine } from './worktreeEvidence.js'

const REAL_HOST = createWorkerProcessHost()
const TIMEOUT_MS = 20_000

async function git(cwd: string, args: string[]): Promise<void> {
  const outcome = await REAL_HOST.run({
    executable: 'git',
    args: ['-c', 'user.email=m3@example.invalid', '-c', 'user.name=M3 Fixture', ...args],
    cwd,
    stdin: null,
    timeout_ms: TIMEOUT_MS,
  })
  if (outcome.outcome !== 'exited' || outcome.exit_code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${outcome.stderr || outcome.failure_detail}`)
  }
}

async function withRepo(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'workbenchos-evidence-'))
  try {
    await git(dir, ['init', '-q'])
    await git(dir, ['commit', '-q', '--allow-empty', '-m', 'initial'])
    await body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function collect(dir: string) {
  return collectWorktreeEvidence({ worktree_dir: dir, host: REAL_HOST, timeout_ms: TIMEOUT_MS })
}

describe('worktree evidence: change classification', () => {
  test('reports a clean tree as available and not dirty', async () => {
    await withRepo(async (dir) => {
      const evidence = await collect(dir)

      expect(evidence.git_state.available).toBe(true)
      expect(evidence.git_state.dirty).toBe(false)
      expect(evidence.changed_files).toEqual([])
    })
  })

  test('reports an untracked file as created', async () => {
    await withRepo(async (dir) => {
      writeFileSync(join(dir, 'new.txt'), 'hello', 'utf8')
      const evidence = await collect(dir)

      expect(evidence.changed_files).toEqual([{ path: 'new.txt', change: 'created' }])
      expect(evidence.git_state.dirty).toBe(true)
    })
  })

  test('reports an edited tracked file as modified', async () => {
    await withRepo(async (dir) => {
      writeFileSync(join(dir, 'tracked.txt'), 'one', 'utf8')
      await git(dir, ['add', 'tracked.txt'])
      await git(dir, ['commit', '-q', '-m', 'add tracked'])
      writeFileSync(join(dir, 'tracked.txt'), 'two', 'utf8')

      const evidence = await collect(dir)
      expect(evidence.changed_files).toEqual([{ path: 'tracked.txt', change: 'modified' }])
    })
  })

  test('reports a removed tracked file as deleted', async () => {
    await withRepo(async (dir) => {
      writeFileSync(join(dir, 'gone.txt'), 'one', 'utf8')
      await git(dir, ['add', 'gone.txt'])
      await git(dir, ['commit', '-q', '-m', 'add gone'])
      rmSync(join(dir, 'gone.txt'))

      const evidence = await collect(dir)
      expect(evidence.changed_files).toEqual([{ path: 'gone.txt', change: 'deleted' }])
    })
  })

  test('reports a staged rename with its previous path', async () => {
    await withRepo(async (dir) => {
      writeFileSync(join(dir, 'before.txt'), 'stable content for rename detection', 'utf8')
      await git(dir, ['add', 'before.txt'])
      await git(dir, ['commit', '-q', '-m', 'add before'])
      await git(dir, ['mv', 'before.txt', 'after.txt'])

      const evidence = await collect(dir)
      const renamed = evidence.changed_files.find(entry => entry.change === 'renamed')

      expect(renamed?.path).toBe('after.txt')
      expect(renamed?.previous_path).toBe('before.txt')
    })
  })

  test('sorts changed files by path', async () => {
    await withRepo(async (dir) => {
      for (const name of ['zebra.txt', 'alpha.txt', 'middle.txt']) {
        writeFileSync(join(dir, name), 'x', 'utf8')
      }

      const evidence = await collect(dir)
      expect(evidence.changed_files.map(entry => entry.path)).toEqual([
        'alpha.txt',
        'middle.txt',
        'zebra.txt',
      ])
    })
  })
})

describe('worktree evidence: git unavailable', () => {
  test('reports git as unavailable outside a repository, without throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'workbenchos-norepo-'))
    try {
      const evidence = await collect(dir)

      expect(evidence.git_state.available).toBe(false)
      expect(evidence.git_state.unavailable_reason?.length ?? 0).toBeGreaterThan(0)
      expect(evidence.changed_files).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('never claims a commit or a push happened', async () => {
    await withRepo(async (dir) => {
      writeFileSync(join(dir, 'new.txt'), 'x', 'utf8')
      const evidence = await collect(dir)

      expect(evidence.git_state.commit_performed).toBe(false)
      expect(evidence.git_state.push_performed).toBe(false)
    })
  })

  test('reports the current branch and head on a clean repository', async () => {
    await withRepo(async (dir) => {
      const evidence = await collect(dir)

      expect(evidence.git_state.head?.length ?? 0).toBeGreaterThan(0)
      expect(evidence.git_state.branch?.length ?? 0).toBeGreaterThan(0)
    })
  })
})

describe('worktree evidence: porcelain parsing', () => {
  test('normalizes windows separators to forward slashes', () => {
    expect(parsePorcelainLine('?? src\\nested\\file.ts')).toEqual({
      path: 'src/nested/file.ts',
      change: 'created',
    })
  })

  test('treats an unrecognized status as modified', () => {
    expect(parsePorcelainLine('T  typechange.txt')).toEqual({
      path: 'typechange.txt',
      change: 'modified',
    })
  })

  test('ignores the branch header and blank lines', () => {
    expect(parsePorcelainLine('## main...origin/main')).toBeNull()
    expect(parsePorcelainLine('')).toBeNull()
  })
})

describe('worktree evidence: host wiring', () => {
  test('asks git for porcelain output and never writes', async () => {
    const specs: WorkerRunSpec[] = []
    const fakeHost = {
      async run(spec: WorkerRunSpec): Promise<WorkerRunOutcome> {
        specs.push(spec)
        return {
          outcome: 'exited',
          exit_code: 0,
          stdout: spec.args.includes('--porcelain=v1') ? '?? a.txt\n' : '',
          stderr: '',
          lines: spec.args.includes('--porcelain=v1') ? ['?? a.txt'] : [],
          duration_ms: 1,
          failure_detail: null,
        }
      },
    }

    const evidence = await collectWorktreeEvidence({
      worktree_dir: '/nowhere',
      host: fakeHost,
      timeout_ms: 100,
    })

    const statusSpec = specs.find(spec => spec.args.includes('--porcelain=v1'))
    expect(statusSpec?.args).toContain('--untracked-files=all')
    expect(statusSpec?.stdin).toBeNull()

    // Read-only: the only git verbs are status and rev-parse.
    const verbs = specs.map(spec => spec.args[0])
    expect(verbs.every(verb => verb === 'status' || verb === 'rev-parse')).toBe(true)

    expect(evidence.changed_files).toEqual([{ path: 'a.txt', change: 'created' }])
  })
})

describe('worktree evidence: nested directories', () => {
  test('reports files created inside a new directory', async () => {
    await withRepo(async (dir) => {
      mkdirSync(join(dir, 'pkg', 'src'), { recursive: true })
      writeFileSync(join(dir, 'pkg', 'src', 'index.ts'), 'export {}\n', 'utf8')

      const evidence = await collect(dir)
      expect(evidence.changed_files.map(entry => entry.path)).toEqual(['pkg/src/index.ts'])
    })
  })
})
