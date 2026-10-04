/**
 * M3-01 — durable submission marker contracts.
 *
 * Authorized by task package M3-01.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Clock } from '../core/workbenchCore.js'
import { createSubmissionIndex, type SubmissionMarker } from './submissionIndex.js'

const FIXED_TIME = '2026-10-02T00:00:00.000Z'

function fixedClock(at = FIXED_TIME): Clock {
  return { now: () => at }
}

function marker(overrides: Partial<SubmissionMarker> = {}): SubmissionMarker {
  return {
    submission_key: 'agent-submit:run-1',
    native_ref: 'codex:thread-1',
    session_ref: 'thread-1',
    accepted_at: 'ignored-by-the-index',
    ...overrides,
  }
}

async function withIndex(
  body: (ctx: { dir: string; file: string; make: (clock?: Clock) => ReturnType<typeof createSubmissionIndex> }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'workbenchos-index-'))
  const file = join(dir, 'submissions.json')
  try {
    await body({
      dir,
      file,
      make: clock => createSubmissionIndex({ file_path: file, clock: clock ?? fixedClock() }),
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('submission index: recording and lookup', () => {
  test('reports no marker for a key that was never recorded', async () => {
    await withIndex(async ({ make }) => {
      expect(await make().lookup('never-seen')).toBeNull()
    })
  })

  test('returns the marker it recorded', async () => {
    await withIndex(async ({ make }) => {
      const index = make()
      await index.record(marker())

      const found = await index.lookup('agent-submit:run-1')
      expect(found?.native_ref).toBe('codex:thread-1')
      expect(found?.session_ref).toBe('thread-1')
      expect(found?.submission_key).toBe('agent-submit:run-1')
    })
  })

  test('preserves the original marker when a key is recorded again', async () => {
    await withIndex(async ({ make, file }) => {
      const index = make()
      await index.record(marker({ native_ref: 'first' }))
      const repeated = await index.record(marker({ native_ref: 'second' }))

      expect(repeated.created).toBe(false)
      expect(repeated.marker.native_ref).toBe('first')
      expect((await index.lookup('agent-submit:run-1'))?.native_ref).toBe('first')

      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      expect(Object.keys(parsed)).toHaveLength(1)
    })
  })

  test('reports whether a record was newly reserved', async () => {
    await withIndex(async ({ make }) => {
      const index = make()
      const first = await index.record(marker())
      const repeated = await index.record(marker({ native_ref: 'replacement' }))

      expect(first.created).toBe(true)
      expect(first.marker.native_ref).toBe('codex:thread-1')
      expect(repeated.created).toBe(false)
      expect(repeated.marker.native_ref).toBe('codex:thread-1')
    })
  })

  test('stores keys that collide with object prototype names as ordinary keys', async () => {
    await withIndex(async ({ make }) => {
      const index = make()
      const reserved = await index.record(marker({ submission_key: '__proto__' }))

      expect(reserved.created).toBe(true)
      expect((await index.lookup('__proto__'))?.native_ref).toBe('codex:thread-1')
    })
  })

  test('does not treat inherited object properties as submission markers', async () => {
    await withIndex(async ({ make }) => {
      const index = make()
      await index.record(marker())

      expect(await index.lookup('constructor')).toBeNull()
      expect(await index.lookup('toString')).toBeNull()
    })
  })

  test('stamps accepted_at from the injected clock, ignoring the caller value', async () => {
    await withIndex(async ({ make }) => {
      const index = make(fixedClock('2026-03-04T05:06:07.000Z'))
      await index.record(marker({ accepted_at: 'caller-supplied' }))

      expect((await index.lookup('agent-submit:run-1'))?.accepted_at).toBe('2026-03-04T05:06:07.000Z')
    })
  })
})

describe('submission index: durability', () => {
  test('treats a missing file as an empty index', async () => {
    await withIndex(async ({ make, file }) => {
      expect(existsSync(file)).toBe(false)
      expect(await make().lookup('anything')).toBeNull()
    })
  })

  test('survives being reopened by a fresh index instance', async () => {
    await withIndex(async ({ make, file }) => {
      await make().record(marker())
      expect(existsSync(file)).toBe(true)

      // A different instance over the same path proves the state is on disk.
      const reopened = make(fixedClock('2026-12-31T00:00:00.000Z'))
      expect((await reopened.lookup('agent-submit:run-1'))?.native_ref).toBe('codex:thread-1')
    })
  })

  test('creates a missing parent directory', async () => {
    await withIndex(async ({ dir }) => {
      const nested = join(dir, 'deep', 'nested', 'submissions.json')
      const index = createSubmissionIndex({ file_path: nested, clock: fixedClock() })

      await index.record(marker())
      expect(existsSync(nested)).toBe(true)
      expect((await index.lookup('agent-submit:run-1'))?.native_ref).toBe('codex:thread-1')
    })
  })

  test('leaves no temporary residue behind', async () => {
    await withIndex(async ({ make, file }) => {
      await make().record(marker())
      expect(existsSync(`${file}.tmp`)).toBe(false)
    })
  })
})

describe('submission index: corrupt state fails closed', () => {
  test('throws on lookup when the file is unparseable', async () => {
    await withIndex(async ({ make, file }) => {
      writeFileSync(file, '{ this is not json', 'utf8')

      // Absence cannot be proven from a corrupt index, so it must not look empty.
      await expect(make().lookup('agent-submit:run-1')).rejects.toThrow()
    })
  })

  test('throws on record when the file is unparseable', async () => {
    await withIndex(async ({ make, file }) => {
      writeFileSync(file, 'not json at all', 'utf8')

      await expect(make().record(marker())).rejects.toThrow()
    })
  })

  test('throws when the file holds a non-object payload', async () => {
    await withIndex(async ({ make, file }) => {
      writeFileSync(file, '[1,2,3]', 'utf8')

      await expect(make().lookup('agent-submit:run-1')).rejects.toThrow()
    })
  })

  test('throws when a key maps to a null marker', async () => {
    await withIndex(async ({ make, file }) => {
      writeFileSync(file, JSON.stringify({ 'agent-submit:run-1': null }), 'utf8')

      await expect(make().lookup('agent-submit:run-1')).rejects.toThrow()
    })
  })

  test('throws when the marker key disagrees with its map key', async () => {
    await withIndex(async ({ make, file }) => {
      writeFileSync(file, JSON.stringify({
        'agent-submit:run-1': {
          submission_key: 'agent-submit:other',
          native_ref: 'codex:thread-1',
          session_ref: null,
          accepted_at: FIXED_TIME,
        },
      }), 'utf8')

      await expect(make().lookup('never-seen')).rejects.toThrow()
    })
  })
})
