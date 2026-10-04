/**
 * Codex CLI JSONL event stream parsing.
 *
 * Pure: no I/O, no clock, no randomness. Everything here is derived from the
 * verbatim event streams captured in the Codex tool survey, and the rules are the
 * ones recorded in task package M3-04 §7 F2.
 *
 * Two rules carry most of the weight:
 *   - a terminal state comes from `turn.completed` / `turn.failed`, never from
 *     the process exit code and never from an `error` event;
 *   - the conclusion is the LAST agent message, because a run emits intermediate
 *     ones that look just as well formed.
 *
 * Authorized by task package M3-04.
 */

export type CodexCommandExecution = {
  item_id: string
  command: string
  aggregated_output: string
  exit_code: number | null
  status: string | null
}

export type CodexUsage = {
  input_tokens: number
  cached_input_tokens: number
  cache_write_input_tokens: number
  output_tokens: number
  reasoning_output_tokens: number
}

export type CodexTermination = 'completed' | 'failed' | 'incomplete'

export type CodexStreamSummary = {
  /** Derived from the event stream, never from the process exit code. */
  termination: CodexTermination
  thread_id: string | null
  /** The LAST agent message, or null when the run produced none. */
  final_message: string | null
  /** Every agent message seen, in order. */
  agent_messages: string[]
  command_executions: CodexCommandExecution[]
  usage: CodexUsage | null
  /** Non-fatal notices: reconnects, transport fallback, item-level errors. */
  notices: string[]
  /** The failure reason, with any inner JSON unwrapped. */
  failure_reason: string | null
  /** Lines that were not parseable as a JSON object. Counted, never hidden. */
  unparsed_line_count: number
  /** JSON objects whose `type` is outside the known set. */
  unrecognized_event_count: number
  /** Total JSON objects that parsed. */
  event_count: number
}

export type CodexVerdict = {
  /** The `verdict` field when it parsed; otherwise a synthesized marker. */
  verdict: string
  reason: string
  /** True only when the final message was a JSON object with a string `verdict`. */
  parsed: boolean
  raw: string | null
}

const KNOWN_EVENT_TYPES = new Set([
  'thread.started',
  'turn.started',
  'item.started',
  'item.completed',
  'turn.completed',
  'turn.failed',
  'error',
])

const UNPARSED_VERDICT = 'unparsed'

function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * A turn failure arrives as a JSON document encoded inside a JSON string, so the
 * useful detail sits one parse deeper. A message that is not nested JSON is
 * returned unchanged.
 */
export function unwrapCodexMessage(raw: string | null): string | null {
  if (raw === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw
  }

  const inner = asObject(parsed)
  if (inner === null) return raw

  const direct = asString(inner.detail) ?? asString(inner.message)
  if (direct !== null) return direct

  // A real call produced a second nesting shape, { error: { message } }, so one
  // more level has to be peeled before giving up on the raw text.
  const nested = asObject(inner.error)
  if (nested !== null) {
    const nestedMessage = asString(nested.message) ?? asString(nested.detail)
    if (nestedMessage !== null) return nestedMessage
  }

  return raw
}

function readUsage(value: unknown): CodexUsage | null {
  const usage = asObject(value)
  if (usage === null) return null

  return {
    input_tokens: asNumber(usage.input_tokens) ?? 0,
    cached_input_tokens: asNumber(usage.cached_input_tokens) ?? 0,
    cache_write_input_tokens: asNumber(usage.cache_write_input_tokens) ?? 0,
    output_tokens: asNumber(usage.output_tokens) ?? 0,
    reasoning_output_tokens: asNumber(usage.reasoning_output_tokens) ?? 0,
  }
}

export function summarizeCodexStream(lines: string[]): CodexStreamSummary {
  const agentMessages: string[] = []
  const notices: string[] = []
  const seenNotices = new Set<string>()
  const commandsById = new Map<string, CodexCommandExecution>()
  const commandOrder: string[] = []

  const addNotice = (text: string): void => {
    if (seenNotices.has(text)) return
    seenNotices.add(text)
    notices.push(text)
  }

  let termination: CodexTermination = 'incomplete'
  let threadId: string | null = null
  let usage: CodexUsage | null = null
  let failureReason: string | null = null
  let unparsedLineCount = 0
  let unrecognizedEventCount = 0
  let eventCount = 0

  for (const line of lines) {
    const trimmed = line.trim()
    // A blank line is not a parse failure.
    if (trimmed.length === 0) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      unparsedLineCount += 1
      continue
    }

    const event = asObject(parsed)
    if (event === null) {
      unparsedLineCount += 1
      continue
    }

    eventCount += 1

    const type = asString(event.type)
    if (type === null || !KNOWN_EVENT_TYPES.has(type)) {
      unrecognizedEventCount += 1
      continue
    }

    if (type === 'thread.started') {
      // The first id wins; a later one would belong to a different session.
      if (threadId === null) threadId = asString(event.thread_id)
      continue
    }

    if (type === 'error') {
      addNotice(asString(event.message) ?? 'unnamed error event')
      continue
    }

    if (type === 'turn.completed') {
      termination = 'completed'
      usage = readUsage(event.usage)
      continue
    }

    if (type === 'turn.failed') {
      termination = 'failed'
      const error = asObject(event.error)
      failureReason = unwrapCodexMessage(error === null ? null : asString(error.message))
      continue
    }

    if (type === 'item.completed' || type === 'item.started') {
      const item = asObject(event.item)
      if (item === null) continue

      const itemType = asString(item.type)

      if (itemType === 'error') {
        // Non-fatal by construction: the survey saw a transport fallback notice
        // in the same turn that then completed successfully.
        addNotice(asString(item.message) ?? 'unnamed item error')
        continue
      }

      if (itemType === 'agent_message') {
        // Only completed items carry a settled message.
        if (type !== 'item.completed') continue
        const text = asString(item.text)
        if (text !== null) agentMessages.push(text)
        continue
      }

      if (itemType === 'command_execution') {
        const itemId = asString(item.id) ?? `command-${String(commandOrder.length)}`
        const existing = commandsById.get(itemId)

        // `item.started` reports exit_code null and status in_progress, so a
        // completed item has to be able to replace it.
        commandsById.set(itemId, {
          item_id: itemId,
          command: asString(item.command) ?? existing?.command ?? '',
          aggregated_output: asString(item.aggregated_output) ?? existing?.aggregated_output ?? '',
          exit_code: asNumber(item.exit_code) ?? existing?.exit_code ?? null,
          status: asString(item.status) ?? existing?.status ?? null,
        })
        if (existing === undefined) commandOrder.push(itemId)
        continue
      }
    }
  }

  const commandExecutions: CodexCommandExecution[] = []
  for (const id of commandOrder) {
    const entry = commandsById.get(id)
    if (entry !== undefined) commandExecutions.push(entry)
  }

  const lastMessage = agentMessages.length > 0 ? agentMessages[agentMessages.length - 1] : undefined

  return {
    termination,
    thread_id: threadId,
    final_message: lastMessage ?? null,
    agent_messages: agentMessages,
    command_executions: commandExecutions,
    usage,
    notices,
    failure_reason: failureReason,
    unparsed_line_count: unparsedLineCount,
    unrecognized_event_count: unrecognizedEventCount,
    event_count: eventCount,
  }
}

export function parseCodexVerdict(finalMessage: string | null): CodexVerdict | null {
  if (finalMessage === null) return null

  const unparsedVerdict = (reason: string): CodexVerdict => ({
    verdict: UNPARSED_VERDICT,
    reason,
    parsed: false,
    raw: finalMessage,
  })

  let parsed: unknown
  try {
    parsed = JSON.parse(finalMessage)
  } catch {
    return unparsedVerdict(finalMessage)
  }

  const object = asObject(parsed)
  if (object === null) return unparsedVerdict(finalMessage)

  const verdict = asString(object.verdict)
  if (verdict === null) return unparsedVerdict(finalMessage)

  return {
    verdict,
    reason: asString(object.reason) ?? '',
    parsed: true,
    raw: finalMessage,
  }
}
