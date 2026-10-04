/**
 * M3-02A — CodeBuddy discovery tests.
 *
 * The filesystem layout is faked inside temp directories, so no case depends on
 * this machine having CodeBuddy installed.
 *
 * Authorized by task package M3-02A.
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverCodeBuddyRuntime } from './codebuddyDiscovery.js'

const RELATIVE_CLI = ['WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy']

/** Builds a fake app install whose CLI entry sits at the expected relative path. */
function makeInstall(root: string, release = 'app-resources'): string {
  const entry = join(root, ...RELATIVE_CLI)
  mkdirSync(join(entry, '..'), { recursive: true })
  writeFileSync(entry, '#!/usr/bin/env node', 'utf8')
  return entry
}

/** Builds a fake runtime profile with the given version folders. */
function makeProfile(root: string, versions: { name: string; secondsAgo: number }[]): string[] {
  const paths: string[] = []
  for (const version of versions) {
    const dir = join(root, '.workbuddy', 'binaries', 'node', 'versions', version.name)
    mkdirSync(dir, { recursive: true })
    const exe = join(dir, 'node.exe')
    writeFileSync(exe, 'stub', 'utf8')
    const when = new Date(Date.now() - version.secondsAgo * 1000)
    utimesSync(exe, when, when)
    paths.push(exe)
  }
  return paths
}

type EnvPatch = { key: string; value: string | null }

async function withEnv(patch: EnvPatch[], body: () => Promise<void>): Promise<void> {
  const saved: EnvPatch[] = []
  for (const entry of patch) {
    saved.push({ key: entry.key, value: process.env[entry.key] ?? null })
    if (entry.value === null) {
      delete process.env[entry.key]
    } else {
      process.env[entry.key] = entry.value
    }
  }
  try {
    await body()
  } finally {
    for (const entry of saved) {
      if (entry.value === null) {
        delete process.env[entry.key]
      } else {
        process.env[entry.key] = entry.value
      }
    }
  }
}

async function withTemp(body: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'workbenchos-cb-discovery-'))
  try {
    await body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('codebuddy discovery: explicit overrides', () => {
  test('returns a runtime when both overrides are supplied', async () => {
    const outcome = discoverCodeBuddyRuntime({
      cli_entry_override: 'C:/app/cli/bin/codebuddy',
      node_override: 'C:/rt/node.exe',
    })

    expect(outcome.status).toBe('found')
    if (outcome.status !== 'found') return
    expect(outcome.runtime.cli_entry).toBe('C:/app/cli/bin/codebuddy')
    expect(outcome.runtime.node_executable).toBe('C:/rt/node.exe')
    expect(outcome.runtime.source).toBe('injected')
  })

  test('reports a missing runtime when only the entry is supplied', async () => {
    // The unset half falls back to a real filesystem search, so the environment
    // has to be neutralised or this machine's own install would satisfy it.
    await withEnv(
      [
        { key: 'ProgramFiles', value: null },
        { key: 'LOCALAPPDATA', value: null },
        { key: 'USERPROFILE', value: null },
      ],
      async () => {
        const outcome = discoverCodeBuddyRuntime({ cli_entry_override: 'C:/app/codebuddy' })

        expect(outcome.status).toBe('not_found')
        if (outcome.status === 'not_found') {
          expect(outcome.missing).toBe('node')
        }
      },
    )
  })

  test('reports a missing entry when only the runtime is supplied', async () => {
    await withEnv(
      [
        { key: 'ProgramFiles', value: null },
        { key: 'LOCALAPPDATA', value: null },
        { key: 'USERPROFILE', value: null },
      ],
      async () => {
        const outcome = discoverCodeBuddyRuntime({ node_override: 'C:/rt/node.exe' })

        expect(outcome.status).toBe('not_found')
        if (outcome.status === 'not_found') {
          expect(outcome.missing).toBe('cli')
        }
      },
    )
  })
})

describe('codebuddy discovery: filesystem search', () => {
  test('finds both the entry and the newest runtime version', async () => {
    await withTemp(async (root) => {
      const appRoot = join(root, 'app')
      mkdirSync(appRoot, { recursive: true })
      const entry = makeInstall(appRoot)
      const profileRoot = join(root, 'profile')
      const versions = makeProfile(profileRoot, [
        { name: '20.0.0', secondsAgo: 9000 },
        { name: '22.22.2', secondsAgo: 5 },
      ])

      await withEnv(
        [
          { key: 'ProgramFiles', value: appRoot },
          { key: 'LOCALAPPDATA', value: null },
          { key: 'USERPROFILE', value: profileRoot },
        ],
        async () => {
          const outcome = discoverCodeBuddyRuntime()

          expect(outcome.status).toBe('found')
          if (outcome.status !== 'found') return
          expect(outcome.runtime.cli_entry).toBe(entry)
          expect(outcome.runtime.node_executable).toBe(versions[1])
          expect(outcome.runtime.source).toBe('app_resources')
        },
      )
    })
  })

  test('accepts the per-user install layout', async () => {
    await withTemp(async (root) => {
      const localRoot = join(root, 'local')
      mkdirSync(localRoot, { recursive: true })
      const entry = makeInstall(localRoot)
      const profileRoot = join(root, 'profile')
      makeProfile(profileRoot, [{ name: '22.0.0', secondsAgo: 1 }])

      await withEnv(
        [
          { key: 'ProgramFiles', value: null },
          { key: 'LOCALAPPDATA', value: localRoot },
          { key: 'USERPROFILE', value: profileRoot },
        ],
        async () => {
          const outcome = discoverCodeBuddyRuntime()

          expect(outcome.status).toBe('found')
          if (outcome.status !== 'found') return
          expect(outcome.runtime.cli_entry).toBe(entry)
          expect(outcome.runtime.source).toBe('app_local')
        },
      )
    })
  })

  test('breaks an equal-age tie by version folder name', async () => {
    await withTemp(async (root) => {
      const appRoot = join(root, 'app')
      mkdirSync(appRoot, { recursive: true })
      makeInstall(appRoot)
      const profileRoot = join(root, 'profile')
      makeProfile(profileRoot, [
        { name: 'alpha', secondsAgo: 100 },
        { name: 'zulu', secondsAgo: 100 },
      ])

      await withEnv(
        [
          { key: 'ProgramFiles', value: appRoot },
          { key: 'LOCALAPPDATA', value: null },
          { key: 'USERPROFILE', value: profileRoot },
        ],
        async () => {
          const outcome = discoverCodeBuddyRuntime()

          expect(outcome.status).toBe('found')
          if (outcome.status !== 'found') return
          expect(outcome.runtime.node_executable).toContain('zulu')
        },
      )
    })
  })

  test('reports not_found with the searched paths when nothing is installed', async () => {
    await withTemp(async (root) => {
      await withEnv(
        [
          { key: 'ProgramFiles', value: join(root, 'absent-app') },
          { key: 'LOCALAPPDATA', value: join(root, 'absent-local') },
          { key: 'USERPROFILE', value: join(root, 'absent-profile') },
        ],
        async () => {
          const outcome = discoverCodeBuddyRuntime()

          expect(outcome.status).toBe('not_found')
          if (outcome.status !== 'not_found') return
          expect(outcome.missing).toBe('both')
          expect(outcome.searched.length).toBeGreaterThan(0)
        },
      )
    })
  })

  test('does not throw when the search roots do not exist', async () => {
    await withEnv(
      [
        { key: 'ProgramFiles', value: null },
        { key: 'LOCALAPPDATA', value: null },
        { key: 'USERPROFILE', value: null },
      ],
      async () => {
        const outcome = discoverCodeBuddyRuntime()

        expect(outcome.status).toBe('not_found')
        if (outcome.status !== 'not_found') return
        expect(outcome.searched).toEqual([])
      },
    )
  })

  test('ignores a directory that merely shares the entry name', async () => {
    await withTemp(async (root) => {
      const appRoot = join(root, 'app')
      const profileRoot = join(root, 'profile')
      mkdirSync(join(appRoot, ...RELATIVE_CLI), { recursive: true })
      makeProfile(profileRoot, [{ name: '22.0.0', secondsAgo: 1 }])

      await withEnv(
        [
          { key: 'ProgramFiles', value: appRoot },
          { key: 'LOCALAPPDATA', value: null },
          { key: 'USERPROFILE', value: profileRoot },
        ],
        async () => {
          const outcome = discoverCodeBuddyRuntime()

          expect(outcome.status).toBe('not_found')
          if (outcome.status !== 'not_found') {
            return
          }
          expect(outcome.missing).toBe('cli')
        },
      )
    })
  })
})

describe('codebuddy discovery: no PATH reliance', () => {
  test('never consults PATH or an external lookup tool', () => {
    const source = readFileSync(new URL('./codebuddyDiscovery.ts', import.meta.url), 'utf8')

    expect(source).not.toContain('process.env.PATH')
    expect(source).not.toContain('node:child_process')
    expect(source).not.toContain('where.exe')
  })
})
