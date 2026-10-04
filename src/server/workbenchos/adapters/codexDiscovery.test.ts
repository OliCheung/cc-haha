/**
 * M3-04 — Codex binary discovery contracts.
 *
 * Every case runs against a temporary directory, so nothing here depends on this
 * machine having Codex installed.
 *
 * Authorized by task package M3-04.
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverCodexBinary } from './codexDiscovery.js'

function withRoot(body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'workbenchos-codex-'))
  try {
    body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** Creates a release folder holding a fake binary, with a controlled mtime. */
function placeRelease(root: string, releaseDir: string, secondsAgo: number): string {
  const dir = join(root, releaseDir)
  mkdirSync(dir, { recursive: true })
  const binary = join(dir, 'codex.exe')
  writeFileSync(binary, 'stub', 'utf8')

  const when = new Date(Date.now() - secondsAgo * 1000)
  utimesSync(binary, when, when)
  return binary
}

describe('codex discovery: locating the binary', () => {
  test('reports not_found with the searched roots when the root is missing', () => {
    const outcome = discoverCodexBinary({
      search_root: join(tmpdir(), 'workbenchos-codex-absent-root'),
    })

    expect(outcome.status).toBe('not_found')
    if (outcome.status === 'not_found') {
      expect(outcome.searched.length).toBeGreaterThan(0)
    }
  })

  test('finds a binary inside a single release folder', () => {
    withRoot((root) => {
      const binary = placeRelease(root, 'aaa111', 10)
      const outcome = discoverCodexBinary({ search_root: root })

      expect(outcome.status).toBe('found')
      if (outcome.status === 'found') {
        expect(outcome.binary.path).toBe(binary)
        expect(outcome.binary.release_dir).toBe('aaa111')
      }
    })
  })

  test('picks the newest release when several exist', () => {
    withRoot((root) => {
      placeRelease(root, 'old-release', 5000)
      const newest = placeRelease(root, 'new-release', 5)
      placeRelease(root, 'middle-release', 2000)

      const outcome = discoverCodexBinary({ search_root: root })

      expect(outcome.status).toBe('found')
      if (outcome.status === 'found') {
        expect(outcome.binary.path).toBe(newest)
        expect(outcome.binary.release_dir).toBe('new-release')
      }
    })
  })

  test('breaks an mtime tie by descending release folder name', () => {
    withRoot((root) => {
      placeRelease(root, 'alpha', 100)
      placeRelease(root, 'zulu', 100)

      const outcome = discoverCodexBinary({ search_root: root })

      expect(outcome.status).toBe('found')
      if (outcome.status === 'found') {
        expect(outcome.binary.release_dir).toBe('zulu')
      }
    })
  })

  test('reports not_found when a release folder holds no binary', () => {
    withRoot((root) => {
      mkdirSync(join(root, 'empty-release'), { recursive: true })

      expect(discoverCodexBinary({ search_root: root }).status).toBe('not_found')
    })
  })

  test('ignores a directory named like the binary', () => {
    withRoot((root) => {
      mkdirSync(join(root, 'weird-release', 'codex.exe'), { recursive: true })

      expect(discoverCodexBinary({ search_root: root }).status).toBe('not_found')
    })
  })

  test('ignores a binary sitting directly in the root', () => {
    withRoot((root) => {
      writeFileSync(join(root, 'codex.exe'), 'stub', 'utf8')

      expect(discoverCodexBinary({ search_root: root }).status).toBe('not_found')
    })
  })

  test('reports the binary mtime so callers can reason about recency', () => {
    withRoot((root) => {
      const binary = placeRelease(root, 'timed-release', 30)
      const outcome = discoverCodexBinary({ search_root: root })

      expect(outcome.status).toBe('found')
      if (outcome.status === 'found') {
        expect(outcome.binary.mtime_ms).toBe(statSync(binary).mtimeMs)
      }
    })
  })
})

describe('codex discovery: no PATH reliance', () => {
  test('never consults PATH or an external lookup tool', () => {
    const source = readFileSync(new URL('./codexDiscovery.ts', import.meta.url), 'utf8')

    // Discovery is pure filesystem enumeration, so it cannot be broken by the
    // stale PATH entry the survey found.
    expect(source).not.toContain('process.env.PATH')
    expect(source).not.toContain('node:child_process')
    expect(source).not.toContain('where.exe')
  })

  test('resolves an injected root without touching the real machine layout', () => {
    withRoot((root) => {
      const binary = placeRelease(root, 'injected', 1)
      const outcome = discoverCodexBinary({ search_root: root })

      expect(outcome.status).toBe('found')
      if (outcome.status === 'found') {
        expect(outcome.binary.path.startsWith(root)).toBe(true)
        expect(outcome.binary.path).toBe(binary)
      }
    })
  })
})
