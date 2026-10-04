/**
 * Worktree evidence collection.
 *
 * The Codex CLI event stream does not report which files a run changed (verified
 * in the M3-04 tool survey), so an adapter must derive `changed_files` itself.
 * This module is that derivation: it asks git, in the run's own worktree, and
 * converts the answer into contract shapes.
 *
 * It is strictly read-only: it never stages, commits or pushes.
 *
 * Authorized by task package M3-01.
 */

import type { FileChange, GitEvidence } from '../contracts.js'
import type { WorkerProcessHost, WorkerRunOutcome } from './workerProcessHost.js'

export type WorktreeEvidenceOptions = {
  worktree_dir: string
  /** Host used to run git, so tests can inject a fake. */
  host: WorkerProcessHost
  timeout_ms: number
}

export type WorktreeEvidence = {
  changed_files: FileChange[]
  git_state: GitEvidence
}

/** Git quotes paths that contain unusual characters; this unwraps that form. */
function normalizePath(raw: string): string {
  let value = raw.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1)
  }
  return value.split('\\').join('/')
}

/**
 * Parses one `git status --porcelain=v1` line. The two leading columns are the
 * index and worktree states; the rest is the path (or `old -> new` for renames).
 */
export function parsePorcelainLine(line: string): FileChange | null {
  if (line.length < 4) return null
  if (line.startsWith('##')) return null

  const index = line[0] ?? ' '
  const worktree = line[1] ?? ' '
  const rest = line.slice(3).trim()
  if (rest.length === 0) return null

  if (index === '?' && worktree === '?') {
    return { path: normalizePath(rest), change: 'created' }
  }

  if (index === 'R' || worktree === 'R') {
    const arrow = rest.indexOf(' -> ')
    if (arrow === -1) return { path: normalizePath(rest), change: 'modified' }
    return {
      path: normalizePath(rest.slice(arrow + 4)),
      change: 'renamed',
      previous_path: normalizePath(rest.slice(0, arrow)),
    }
  }

  if (index === 'A' || worktree === 'A') return { path: normalizePath(rest), change: 'created' }
  if (index === 'D' || worktree === 'D') return { path: normalizePath(rest), change: 'deleted' }

  return { path: normalizePath(rest), change: 'modified' }
}

function describeGitFailure(outcome: WorkerRunOutcome): string {
  if (outcome.outcome === 'spawn_failed') {
    return `git could not be launched: ${outcome.failure_detail ?? 'unknown reason'}`
  }
  if (outcome.outcome === 'timed_out') {
    return 'git did not finish within the budget'
  }
  const detail = outcome.stderr.trim().length > 0 ? outcome.stderr.trim() : outcome.stdout.trim()
  return `git status exited with ${String(outcome.exit_code)}: ${detail}`
}

export async function collectWorktreeEvidence(
  options: WorktreeEvidenceOptions,
): Promise<WorktreeEvidence> {
  const { worktree_dir: worktreeDir, host, timeout_ms: timeoutMs } = options

  const unavailable = (reason: string): WorktreeEvidence => ({
    changed_files: [],
    git_state: {
      available: false,
      commit_performed: false,
      push_performed: false,
      unavailable_reason: reason,
    },
  })

  const status = await host.run({
    executable: 'git',
    args: ['status', '--porcelain=v1', '--untracked-files=all'],
    cwd: worktreeDir,
    stdin: null,
    timeout_ms: timeoutMs,
  })

  // Any non-zero status means we cannot enumerate the changes, so we must not
  // claim "no changes" — that would make an unattributed edit look clean.
  if (status.outcome !== 'exited' || status.exit_code !== 0) {
    return unavailable(describeGitFailure(status))
  }

  const changedFiles = status.lines
    .map(parsePorcelainLine)
    .filter((entry): entry is FileChange => entry !== null)
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))

  const head = await host.run({
    executable: 'git',
    args: ['rev-parse', 'HEAD'],
    cwd: worktreeDir,
    stdin: null,
    timeout_ms: timeoutMs,
  })
  const branch = await host.run({
    executable: 'git',
    args: ['rev-parse', '--abbrev-ref', 'HEAD'],
    cwd: worktreeDir,
    stdin: null,
    timeout_ms: timeoutMs,
  })

  const headValue = head.outcome === 'exited' && head.exit_code === 0 ? head.stdout.trim() : ''
  const branchValue =
    branch.outcome === 'exited' && branch.exit_code === 0 ? branch.stdout.trim() : ''

  return {
    changed_files: changedFiles,
    git_state: {
      available: true,
      commit_performed: false,
      push_performed: false,
      dirty: changedFiles.length > 0,
      ...(headValue.length > 0 ? { head: headValue } : {}),
      ...(branchValue.length > 0 ? { branch: branchValue } : {}),
    },
  }
}
