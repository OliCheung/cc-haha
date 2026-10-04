/**
 * CodeBuddy CLI discovery.
 *
 * The CLI is not on PATH: it ships inside the WorkBuddy desktop app, and its
 * entry point is a Node script rather than a native executable, so both the
 * script and a usable runtime have to be located. Nothing here consults PATH.
 *
 * Two shapes of the same product are accepted, because the desktop app installs
 * either machine-wide or per user.
 *
 * Authorized by task package M3-02A.
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type CodeBuddyRuntime = {
  /** Absolute path to the CLI entry, which is a Node script. */
  cli_entry: string
  /** Absolute path to a Node executable able to run that script. */
  node_executable: string
  /** Where the CLI was found, for diagnostics only. */
  source: 'app_resources' | 'app_local' | 'injected'
}

export type CodeBuddyDiscoveryOutcome =
  | { status: 'found'; runtime: CodeBuddyRuntime }
  | { status: 'not_found'; searched: string[]; missing: 'cli' | 'node' | 'both' }

const RELATIVE_CLI = ['WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy']
const RELATIVE_NODE_VERSIONS = ['.workbuddy', 'binaries', 'node', 'versions']

type Located = { path: string; label: string }

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

function env(name: string): string {
  const value = process.env[name]
  return typeof value === 'string' ? value : ''
}

function locateCliEntry(searched: string[]): Located | null {
  const machineWide = env('ProgramFiles')
  const perUser = env('LOCALAPPDATA')

  const candidates: { path: string; label: CodeBuddyRuntime['source'] }[] = []
  if (machineWide.length > 0) {
    candidates.push({ path: join(machineWide, ...RELATIVE_CLI), label: 'app_resources' })
  }
  if (perUser.length > 0) {
    candidates.push({ path: join(perUser, ...RELATIVE_CLI), label: 'app_local' })
  }

  for (const candidate of candidates) {
    searched.push(candidate.path)
    if (isFile(candidate.path)) return { path: candidate.path, label: candidate.label }
  }

  return null
}

/**
 * Picks the newest installed runtime version, breaking ties by version folder
 * name so the choice never depends on directory listing order.
 */
function locateNode(searched: string[]): string | null {
  const profile = env('USERPROFILE')
  if (profile.length === 0) return null

  const versionsRoot = join(profile, ...RELATIVE_NODE_VERSIONS)
  searched.push(versionsRoot)

  let entries: string[]
  try {
    entries = readdirSync(versionsRoot)
  } catch {
    return null
  }

  const found: { path: string; dir: string; mtime: number }[] = []
  for (const entry of entries) {
    const candidate = join(versionsRoot, entry, 'node.exe')
    if (!isFile(candidate)) continue
    found.push({ path: candidate, dir: entry, mtime: mtimeOf(candidate) })
  }

  if (found.length === 0) return null

  found.sort((left, right) => {
    if (right.mtime !== left.mtime) return right.mtime - left.mtime
    if (left.dir === right.dir) return 0
    return left.dir < right.dir ? 1 : -1
  })

  const winner = found[0]
  return winner === undefined ? null : winner.path
}

export type CodeBuddyDiscoveryOptions = {
  /** Overrides the CLI search, for tests and explicit configuration. */
  cli_entry_override?: string
  /** Overrides the runtime search, for tests and explicit configuration. */
  node_override?: string
}

export function discoverCodeBuddyRuntime(
  options: CodeBuddyDiscoveryOptions = {},
): CodeBuddyDiscoveryOutcome {
  const searched: string[] = []

  const cli =
    options.cli_entry_override === undefined
      ? locateCliEntry(searched)
      : { path: options.cli_entry_override, label: 'injected' as const }

  const node =
    options.node_override === undefined ? locateNode(searched) : options.node_override

  if (cli !== null && node !== null) {
    return {
      status: 'found',
      runtime: {
        cli_entry: cli.path,
        node_executable: node,
        source: cli.label,
      },
    }
  }

  return {
    status: 'not_found',
    searched,
    missing: cli === null && node === null ? 'both' : cli === null ? 'cli' : 'node',
  }
}
