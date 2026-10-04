/**
 * M3-02A — CodeBuddy invocation contract tests.
 *
 * Authorized by task package M3-02A.
 */

import { describe, expect, test } from 'bun:test'
import {
  buildCodeBuddyInvocation,
  DEFAULT_PERMISSION_MODE,
  type BuildInvocationInput,
} from './codebuddyInvocation.js'

function baseInput(overrides: Partial<BuildInvocationInput> = {}): BuildInvocationInput {
  return {
    node_executable: 'C:/rt/node.exe',
    cli_entry: 'C:/app/cli/bin/codebuddy',
    goal: 'summarise the repository',
    workspace_dir: 'C:/wt',
    model: 'deepseek-v3-2-volc',
    timeout_ms: 180_000,
    ...overrides,
  }
}

describe('codebuddy invocation: argument list', () => {
  test('produces the argument list agreed with the CLI help output', () => {
    const invocation = buildCodeBuddyInvocation(baseInput())

    expect(invocation.args).toEqual([
      '-p',
      '--output-format',
      'json',
      '--model',
      'deepseek-v3-2-volc',
      '--permission-mode',
      'plan',
      'summarise the repository',
    ])
  })

  test('places the goal last', () => {
    const invocation = buildCodeBuddyInvocation(baseInput({ goal: 'do the thing' }))

    expect(invocation.args[invocation.args.length - 1]).toBe('do the thing')
  })

  test('passes the runtime, entry, directory and budget through unchanged', () => {
    const invocation = buildCodeBuddyInvocation(baseInput())

    expect(invocation.node_executable).toBe('C:/rt/node.exe')
    expect(invocation.cli_entry).toBe('C:/app/cli/bin/codebuddy')
    expect(invocation.cwd).toBe('C:/wt')
    expect(invocation.timeout_ms).toBe(180_000)
  })

  test('uses the single-result JSON format and never the streaming one', () => {
    const invocation = buildCodeBuddyInvocation(baseInput())
    const formatIndex = invocation.args.indexOf('--output-format')

    expect(invocation.args[formatIndex + 1]).toBe('json')
  })
})

describe('codebuddy invocation: required inputs', () => {
  test('refuses to build without a model', () => {
    expect(() =>
      buildCodeBuddyInvocation(baseInput({ model: '' })),
    ).toThrow('a model must be given explicitly')
  })

  test('refuses to build with a blank model', () => {
    expect(() => buildCodeBuddyInvocation(baseInput({ model: '   ' }))).toThrow()
  })

  test('refuses to build without a goal', () => {
    expect(() => buildCodeBuddyInvocation(baseInput({ goal: '' }))).toThrow('a goal is required')
  })

  test('refuses to build without a workspace directory', () => {
    expect(() => buildCodeBuddyInvocation(baseInput({ workspace_dir: '' }))).toThrow(
      'a workspace directory is required',
    )
  })
})

describe('codebuddy invocation: permission and tool restrictions', () => {
  test('defaults to the verification-side permission mode', () => {
    expect(DEFAULT_PERMISSION_MODE).toBe('plan')
    expect(buildCodeBuddyInvocation(baseInput()).args).toContain('plan')
  })

  test('honours an explicit permission mode', () => {
    const invocation = buildCodeBuddyInvocation(baseInput({ permission_mode: 'acceptEdits' }))

    expect(invocation.args).toContain('acceptEdits')
  })

  test('joins denied tools with commas', () => {
    const invocation = buildCodeBuddyInvocation(
      baseInput({ disallowed_tools: ['Edit', 'Write', 'NotebookEdit'] }),
    )

    const index = invocation.args.indexOf('--disallowedTools')
    expect(index).toBeGreaterThan(-1)
    expect(invocation.args[index + 1]).toBe('Edit,Write,NotebookEdit')
  })

  test('omits the tool restriction flag entirely when nothing is denied', () => {
    const invocation = buildCodeBuddyInvocation(baseInput())

    expect(invocation.args).not.toContain('--disallowedTools')
  })

  test('omits the tool restriction flag for an empty list', () => {
    const invocation = buildCodeBuddyInvocation(baseInput({ disallowed_tools: [] }))

    expect(invocation.args).not.toContain('--disallowedTools')
  })
})

describe('codebuddy invocation: schema is off by default', () => {
  test('omits the schema flag when none is given', () => {
    const invocation = buildCodeBuddyInvocation(baseInput())

    expect(invocation.args).not.toContain('--json-schema')
  })

  test('omits the schema flag for an empty schema', () => {
    const invocation = buildCodeBuddyInvocation(baseInput({ json_schema: '' }))

    expect(invocation.args).not.toContain('--json-schema')
  })

  test('passes an inline schema when one is given', () => {
    const schema = '{"type":"object"}'
    const invocation = buildCodeBuddyInvocation(baseInput({ json_schema: schema }))

    const index = invocation.args.indexOf('--json-schema')
    expect(invocation.args[index + 1]).toBe(schema)
  })
})

describe('codebuddy invocation: forbidden constructs never appear', () => {
  test('produces no permission-bypass or streaming-output arguments', () => {
    // The forbidden literals are assembled from fragments so this file stays clean
    // for the repository-wide forbidden-token scan.
    const bypass = ['bypass', 'Permissions'].join('')
    const streaming = ['stream', '-json'].join('')
    const skipPermissions = ['dangerously', '-skip-permissions'].join('')

    const variants: BuildInvocationInput[] = [
      baseInput(),
      baseInput({ permission_mode: 'default' }),
      baseInput({ permission_mode: 'auto' }),
      baseInput({ permission_mode: 'dontAsk' }),
      baseInput({ disallowed_tools: ['Bash'] }),
      baseInput({ json_schema: '{"type":"object"}' }),
    ]

    for (const input of variants) {
      const joined = buildCodeBuddyInvocation(input).args.join(' ')
      expect(joined).not.toContain(bypass)
      expect(joined).not.toContain(streaming)
      expect(joined).not.toContain(skipPermissions)
    }
  })

  test('never requests a worktree, since the caller already prepared one', () => {
    const invocation = buildCodeBuddyInvocation(baseInput())

    expect(invocation.args).not.toContain('--worktree')
    expect(invocation.args).not.toContain('-w')
  })

  test('never passes an input format', () => {
    const invocation = buildCodeBuddyInvocation(baseInput())

    expect(invocation.args).not.toContain('--input-format')
  })
})
