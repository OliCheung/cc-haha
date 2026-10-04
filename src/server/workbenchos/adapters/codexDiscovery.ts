/**
 * Codex CLI binary discovery.
 *
 * The survey found that the Codex entry on PATH points at a release folder that
 * no longer exists, while the live binary sits in a different hash-named folder.
 * Hard-coding that folder would break on the next update, so discovery enumerates
 * the release folders and picks the newest binary instead of asking PATH at all.
 *
 * Authorized by task package M3-04.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type CodexBinary = {
  /** Absolute path to the executable. */
  path: string
  /** The release folder name, which changes with every update. */
  release_dir: string
  /** The binary's modification time, used only to pick the newest release. */
  mtime_ms: number
}

export type CodexDiscoveryOutcome =
  | { status: 'found'; binary: CodexBinary }
  | { status: 'not_found'; searched: string[] }

const BINARY_NAME = 'codex.exe'

function defaultSearchRoot(): string {
  const localAppData = process.env.LOCALAPPDATA
  if (typeof localAppData === 'string' && localAppData.length > 0) {
    return join(localAppData, 'OpenAI', 'Codex', 'bin')
  }
  return join('OpenAI', 'Codex', 'bin')
}

export function discoverCodexBinary(options: { search_root?: string } = {}): CodexDiscoveryOutcome {
  const root = options.search_root ?? defaultSearchRoot()
  const searched = [root]

  if (!existsSync(root)) return { status: 'not_found', searched }

  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return { status: 'not_found', searched }
  }

  const candidates: CodexBinary[] = []

  for (const entry of entries) {
    const candidate = join(root, entry, BINARY_NAME)
    try {
      const info = statSync(candidate)
      if (!info.isFile()) continue
      candidates.push({ path: candidate, release_dir: entry, mtime_ms: info.mtimeMs })
    } catch {
      // Not a release folder holding a binary; keep looking.
    }
  }

  if (candidates.length === 0) return { status: 'not_found', searched }

  candidates.sort((left, right) => {
    if (right.mtime_ms !== left.mtime_ms) return right.mtime_ms - left.mtime_ms
    // A tie must still resolve deterministically.
    if (left.release_dir === right.release_dir) return 0
    return left.release_dir < right.release_dir ? 1 : -1
  })

  const winner = candidates[0]
  if (winner === undefined) return { status: 'not_found', searched }

  return { status: 'found', binary: winner }
}
