/**
 * M3-04 — Codex event stream parsing contracts.
 *
 * The three samples below are the verbatim streams captured in
 * docs/recon/M3_TOOL_SURVEY_CODEX_2026-10-02.md (§10.1, §4, §11.1). They are
 * reproduced rather than paraphrased, because the parser is only correct if it
 * handles the real shape.
 *
 * Authorized by task package M3-04.
 */

import { describe, expect, test } from 'bun:test'
import {
  parseCodexVerdict,
  summarizeCodexStream,
  unwrapCodexMessage,
} from './codexEventStream.js'

/** Survey §10.1 — a successful call that answered OK. */
const SUCCESS_STREAM = [
  '{"type":"thread.started","thread_id":"01a0fe1b-815f-7b73-a736-16a8df63a624"}',
  '{"type":"turn.started"}',
  '{"type":"error","message":"Reconnecting... 5/5 (request timed out)"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Falling back from WebSockets to HTTPS transport. request timed out"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"OK"}}',
  '{"type":"turn.completed","usage":{"input_tokens":17207,"cached_input_tokens":6912,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
]

/** Survey §4 — a failed call whose failure message is JSON-inside-JSON. */
const FAILURE_STREAM = [
  '{"type":"thread.started","thread_id":"01a0fe16-ab3a-7110-a873-14789b8d6a8c"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `gpt-5.6-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}',
  '{"type":"turn.started"}',
  '{"type":"error","message":"Reconnecting... 2/5 (request timed out)"}',
  '{"type":"error","message":"Reconnecting... 3/5 (request timed out)"}',
  '{"type":"error","message":"Reconnecting... 4/5 (request timed out)"}',
  '{"type":"error","message":"Reconnecting... 5/5 (request timed out)"}',
  '{"type":"item.completed","item":{"id":"item_1","type":"error","message":"Falling back from WebSockets to HTTPS transport. request timed out"}}',
  '{"type":"error","message":"{\\"detail\\":\\"The \'gpt-5.6-sol\' model is not supported when using Codex with a ChatGPT account.\\"}"}',
  '{"type":"turn.failed","error":{"message":"{\\"detail\\":\\"The \'gpt-5.6-sol\' model is not supported when using Codex with a ChatGPT account.\\"}"}}',
]

/** Survey §11.1 — a successful turn that ran two commands and emitted two agent messages. */
const TOOL_CALL_STREAM = [
  '{"type":"thread.started","thread_id":"01a0fe1e-41ff-7743-9c85-e40f53b75f7e"}',
  '{"type":"turn.started"}',
  '{"type":"error","message":"Reconnecting... 2/5 (request timed out)"}',
  '{"type":"error","message":"Reconnecting... 3/5 (request timed out)"}',
  '{"type":"error","message":"Reconnecting... 4/5 (request timed out)"}',
  '{"type":"error","message":"Reconnecting... 5/5 (request timed out)"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Falling back from WebSockets to HTTPS transport. request timed out"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"{\\"verdict\\":\\"working\\",\\"reason\\":\\"I\u2019m creating the requested file with the exact byte content.\\"}"}}',
  '{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"...","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"...","aggregated_output":"","exit_code":0,"status":"completed"}}',
  '{"type":"item.started","item":{"id":"item_3","type":"command_execution","command":"...","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_3","type":"command_execution","command":"...","aggregated_output":"verified\\r\\n","exit_code":0,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":"{\\"verdict\\":\\"pass\\",\\"reason\\":\\"Created probe.txt with exactly the five-byte content hello.\\"}"}}',
  '{"type":"turn.completed","usage":{"input_tokens":53424,"cached_input_tokens":34304,"cache_write_input_tokens":0,"output_tokens":395,"reasoning_output_tokens":99}}',
]

describe('codex event stream: terminal state', () => {
  test('reads a completed turn and its thread id', () => {
    const summary = summarizeCodexStream(SUCCESS_STREAM)

    expect(summary.termination).toBe('completed')
    expect(summary.thread_id).toBe('01a0fe1b-815f-7b73-a736-16a8df63a624')
    expect(summary.final_message).toBe('OK')
  })

  test('reads a failed turn and unwraps the nested failure message', () => {
    const summary = summarizeCodexStream(FAILURE_STREAM)

    expect(summary.termination).toBe('failed')
    expect(summary.failure_reason).toBe(
      "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
    )
  })

  test('reports an incomplete turn when no terminal event arrives', () => {
    const summary = summarizeCodexStream([
      '{"type":"thread.started","thread_id":"t-1"}',
      '{"type":"turn.started"}',
      '{"type":"error","message":"Reconnecting... 2/5 (request timed out)"}',
    ])

    expect(summary.termination).toBe('incomplete')
    expect(summary.failure_reason).toBeNull()
    expect(summary.notices).toEqual(['Reconnecting... 2/5 (request timed out)'])
  })

  test('treats an error event as a notice rather than a failure', () => {
    const summary = summarizeCodexStream(SUCCESS_STREAM)

    expect(summary.termination).toBe('completed')
    expect(summary.notices).toContain('Reconnecting... 5/5 (request timed out)')
  })

  test('treats an item-level error as a notice rather than a failure', () => {
    const summary = summarizeCodexStream(SUCCESS_STREAM)

    expect(summary.termination).toBe('completed')
    expect(summary.notices).toContain(
      'Falling back from WebSockets to HTTPS transport. request timed out',
    )
  })

  test('records each distinct notice once', () => {
    const summary = summarizeCodexStream([
      '{"type":"error","message":"Reconnecting... 2/5 (request timed out)"}',
      '{"type":"error","message":"Reconnecting... 2/5 (request timed out)"}',
    ])

    expect(summary.notices).toEqual(['Reconnecting... 2/5 (request timed out)'])
  })

  test('handles an empty stream without throwing', () => {
    const summary = summarizeCodexStream([])

    expect(summary.termination).toBe('incomplete')
    expect(summary.agent_messages).toEqual([])
    expect(summary.command_executions).toEqual([])
    expect(summary.event_count).toBe(0)
  })
})

describe('codex event stream: the final message', () => {
  test('takes the LAST agent message, not the first', () => {
    const summary = summarizeCodexStream(TOOL_CALL_STREAM)

    // item_1 is an intermediate "working" message that also satisfies the schema.
    expect(summary.agent_messages).toHaveLength(2)
    expect(summary.agent_messages[0]).toContain('"verdict":"working"')
    expect(summary.final_message).toContain('"verdict":"pass"')
  })

  test('keeps agent messages in order', () => {
    const summary = summarizeCodexStream(TOOL_CALL_STREAM)

    expect(summary.agent_messages[0]?.startsWith('{"verdict":"working"')).toBe(true)
    expect(summary.agent_messages[1]?.startsWith('{"verdict":"pass"')).toBe(true)
  })

  test('reports no final message when the run produced none', () => {
    const summary = summarizeCodexStream(['{"type":"turn.completed","usage":{}}'])

    expect(summary.final_message).toBeNull()
    expect(summary.agent_messages).toEqual([])
  })
})

describe('codex event stream: command executions', () => {
  test('collects command executions with their output and exit codes', () => {
    const summary = summarizeCodexStream(TOOL_CALL_STREAM)

    expect(summary.command_executions).toHaveLength(2)
    expect(summary.command_executions[0]?.exit_code).toBe(0)
    expect(summary.command_executions[1]?.aggregated_output).toBe('verified\r\n')
  })

  test('merges a started item with its completed counterpart by id', () => {
    const summary = summarizeCodexStream(TOOL_CALL_STREAM)

    const ids = summary.command_executions.map(entry => entry.item_id)
    expect(ids).toEqual(['item_2', 'item_3'])
    // The started item reported a null exit code; the completed one must win.
    expect(summary.command_executions.every(entry => entry.status === 'completed')).toBe(true)
  })

  test('records a command with no exit code without inventing one', () => {
    const summary = summarizeCodexStream([
      '{"type":"item.started","item":{"id":"a","type":"command_execution","command":"ls","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
    ])

    expect(summary.command_executions[0]?.exit_code).toBeNull()
    expect(summary.command_executions[0]?.status).toBe('in_progress')
  })
})

describe('codex event stream: usage', () => {
  test('reads every usage field from a completed turn', () => {
    const summary = summarizeCodexStream(TOOL_CALL_STREAM)

    expect(summary.usage).toEqual({
      input_tokens: 53424,
      cached_input_tokens: 34304,
      cache_write_input_tokens: 0,
      output_tokens: 395,
      reasoning_output_tokens: 99,
    })
  })

  test('reports null usage when the completed turn carries none', () => {
    const summary = summarizeCodexStream(['{"type":"turn.completed"}'])

    expect(summary.usage).toBeNull()
  })
})

describe('codex event stream: tolerance', () => {
  test('counts lines that are not JSON objects', () => {
    const summary = summarizeCodexStream(['not json', '{"type":"turn.started"}', '[1,2]'])

    expect(summary.unparsed_line_count).toBe(2)
    expect(summary.event_count).toBe(1)
  })

  test('does not count blank lines as unparsed', () => {
    const summary = summarizeCodexStream(['', '   ', '{"type":"turn.started"}'])

    expect(summary.unparsed_line_count).toBe(0)
    expect(summary.event_count).toBe(1)
  })

  test('counts unrecognized event types without changing the terminal state', () => {
    const summary = summarizeCodexStream([
      '{"type":"something.new","payload":1}',
      '{"type":"turn.completed"}',
    ])

    expect(summary.unrecognized_event_count).toBe(1)
    expect(summary.termination).toBe('completed')
  })

  test('degrades a wrongly typed field instead of throwing', () => {
    const summary = summarizeCodexStream(['{"type":"thread.started","thread_id":42}'])

    expect(summary.thread_id).toBeNull()
  })

  test('keeps the first thread id when several appear', () => {
    const summary = summarizeCodexStream([
      '{"type":"thread.started","thread_id":"first"}',
      '{"type":"thread.started","thread_id":"second"}',
    ])

    expect(summary.thread_id).toBe('first')
  })

  test('ignores an item payload that is not an object', () => {
    const summary = summarizeCodexStream(['{"type":"item.completed","item":"nope"}'])

    expect(summary.agent_messages).toEqual([])
    expect(summary.command_executions).toEqual([])
  })
})

describe('codex verdict parsing', () => {
  test('returns null when there is no final message', () => {
    expect(parseCodexVerdict(null)).toBeNull()
  })

  test('parses a verdict object', () => {
    const verdict = parseCodexVerdict('{"verdict":"pass","reason":"all good"}')

    expect(verdict?.parsed).toBe(true)
    expect(verdict?.verdict).toBe('pass')
    expect(verdict?.reason).toBe('all good')
  })

  test('marks unparseable text as unparsed and keeps the raw text', () => {
    const verdict = parseCodexVerdict('I could not decide')

    expect(verdict?.parsed).toBe(false)
    expect(verdict?.verdict).toBe('unparsed')
    expect(verdict?.raw).toBe('I could not decide')
    expect(verdict?.reason).toBe('I could not decide')
  })

  test('marks a JSON object without a verdict field as unparsed', () => {
    const verdict = parseCodexVerdict('{"reason":"missing the field"}')

    expect(verdict?.parsed).toBe(false)
  })

  test('keeps an unknown verdict value verbatim', () => {
    const verdict = parseCodexVerdict('{"verdict":"uncertain","reason":"needs a human"}')

    expect(verdict?.parsed).toBe(true)
    expect(verdict?.verdict).toBe('uncertain')
  })

  test('tolerates a missing reason', () => {
    const verdict = parseCodexVerdict('{"verdict":"fail"}')

    expect(verdict?.parsed).toBe(true)
    expect(verdict?.reason).toBe('')
  })

  test('reads the verdict out of the surveyed tool-call stream', () => {
    const summary = summarizeCodexStream(TOOL_CALL_STREAM)
    const verdict = parseCodexVerdict(summary.final_message)

    expect(verdict?.verdict).toBe('pass')
    expect(verdict?.reason).toBe('Created probe.txt with exactly the five-byte content hello.')
  })
})

describe('codex message unwrapping', () => {
  test('unwraps a nested detail field', () => {
    expect(unwrapCodexMessage('{"detail":"inner reason"}')).toBe('inner reason')
  })

  test('unwraps a nested message field', () => {
    expect(unwrapCodexMessage('{"message":"inner message"}')).toBe('inner message')
  })

  test('unwraps the error.message shape that a real call produced', () => {
    // Observed verbatim during the M3-04S end-to-end smoke. The survey only ever
    // recorded the `detail` shape, so this nesting was unknown until then.
    const raw =
      '{"error":{"message":"Invalid schema for response_format","type":"invalid_request_error"}}'

    expect(unwrapCodexMessage(raw)).toBe('Invalid schema for response_format')
  })

  test('keeps the raw text when no known field is present', () => {
    expect(unwrapCodexMessage('{"unexpected":"shape"}')).toBe('{"unexpected":"shape"}')
  })

  test('returns plain text unchanged', () => {
    expect(unwrapCodexMessage('plain text')).toBe('plain text')
  })

  test('returns null for null', () => {
    expect(unwrapCodexMessage(null)).toBeNull()
  })
})
