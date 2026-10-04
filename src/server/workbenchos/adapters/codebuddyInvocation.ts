/**
 * CodeBuddy CLI invocation contract.
 *
 * Pure: zero imports, so the argument list cannot drift through a side effect.
 * Every flag here was taken verbatim from the CLI's own help output, recorded in
 * the M3 tool survey.
 *
 * Two flags are deliberately absent. The project forbids the permission-bypass
 * family outright, and the streaming output format is forbidden in source text,
 * so the single-result JSON format is used instead.
 *
 * Authorized by task package M3-02A.
 */

export type CodeBuddyInvocation = {
  node_executable: string
  cli_entry: string
  args: string[]
  cwd: string
  timeout_ms: number
}

/**
 * Permission modes the adapter may request. The bypass mode exists in the CLI
 * but is excluded here on purpose and must never be added.
 */
export type CodeBuddyPermissionMode = 'default' | 'plan' | 'acceptEdits' | 'dontAsk' | 'auto'

export type BuildInvocationInput = {
  node_executable: string
  cli_entry: string
  goal: string
  workspace_dir: string
  /** Required: the CLI's configured default must never be relied upon. */
  model: string
  /** Wall-clock budget for the turn. */
  timeout_ms: number
  /** Optional inline JSON Schema. Off by default until its strictness is proven. */
  json_schema?: string
  /** Defaults to the verification-side plan mode. */
  permission_mode?: CodeBuddyPermissionMode
  /** Tool restrictions used to keep the verification side read-only. */
  disallowed_tools?: string[]
}

export const DEFAULT_PERMISSION_MODE: CodeBuddyPermissionMode = 'plan'

export function buildCodeBuddyInvocation(input: BuildInvocationInput): CodeBuddyInvocation {
  if (typeof input.model !== 'string' || input.model.trim().length === 0) {
    // Failing while building is strictly better than failing while running.
    throw new TypeError('a model must be given explicitly; the CLI default is not relied upon')
  }
  if (typeof input.goal !== 'string' || input.goal.length === 0) {
    throw new TypeError('a goal is required')
  }
  if (typeof input.workspace_dir !== 'string' || input.workspace_dir.length === 0) {
    throw new TypeError('a workspace directory is required')
  }

  const args = ['-p', '--output-format', 'json', '--model', input.model]

  args.push('--permission-mode', input.permission_mode ?? DEFAULT_PERMISSION_MODE)

  const denied = input.disallowed_tools ?? []
  if (denied.length > 0) {
    args.push('--disallowedTools', denied.join(','))
  }

  // Absent by default: a schema whose strictness has not been proven against the
  // real service is exactly the kind of assumption a real call disproves.
  if (typeof input.json_schema === 'string' && input.json_schema.length > 0) {
    args.push('--json-schema', input.json_schema)
  }

  // The goal is last so a reader of a process listing sees the flags first.
  args.push(input.goal)

  return {
    node_executable: input.node_executable,
    cli_entry: input.cli_entry,
    args,
    cwd: input.workspace_dir,
    timeout_ms: input.timeout_ms,
  }
}
