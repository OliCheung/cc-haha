/**
 * WorkbenchOS idempotency primitives.
 *
 * Canonical serialization and hashing rules follow DECISION_LOG D-016:
 * semantic equality must produce the same bytes, object key order must not
 * produce false conflicts, and unsupported values must be rejected.
 *
 * Authorized by task package M1-001-P3.
 */

import { createHash } from 'node:crypto'

export type IdempotencyNamespace =
  | 'task-ingest'
  | 'run-create'
  | 'agent-submit'
  | 'result-record'
  | 'result-delivery'
  | 'recovery'

export const IDEMPOTENCY_NAMESPACES: readonly IdempotencyNamespace[] = [
  'task-ingest',
  'run-create',
  'agent-submit',
  'result-record',
  'result-delivery',
  'recovery',
]

// ---------------------------------------------------------------------------
// Namespaced operation keys
// ---------------------------------------------------------------------------

export function taskIngestKey(input: {
  browser_adapter_id: string
  conversation_id: string
  idempotency_key: string
}): string {
  return `${input.browser_adapter_id}|${input.conversation_id}|${input.idempotency_key}`
}

export function runCreateKey(taskId: string, attempt: number): string {
  return `${taskId}:${attempt}`
}

export function agentSubmitKey(runId: string, protocolVersion: string = 'v1'): string {
  return `${runId}:${protocolVersion}`
}

export function resultRecordKey(runId: string): string {
  return runId
}

export function resultDeliveryKey(resultId: string, conversationId: string): string {
  return `${resultId}:${conversationId}`
}

export function recoveryKey(runId: string, checkpoint: string): string {
  return `${runId}:${checkpoint}`
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

export type IdempotencyDecision =
  | { kind: 'new' }
  | { kind: 'unchanged'; outcome_ref: string }
  | { kind: 'conflict'; existing_hash: string; incoming_hash: string }

export function decideIdempotency(
  existing: { payload_hash: string; outcome_ref: string } | null,
  incomingHash: string,
): IdempotencyDecision {
  if (existing === null) return { kind: 'new' }
  if (existing.payload_hash === incomingHash) {
    return { kind: 'unchanged', outcome_ref: existing.outcome_ref }
  }
  return {
    kind: 'conflict',
    existing_hash: existing.payload_hash,
    incoming_hash: incomingHash,
  }
}

// ---------------------------------------------------------------------------
// Canonical serialization and hashing
// ---------------------------------------------------------------------------

/**
 * Accepts `unknown` on purpose: rejecting unsupported values is this function's
 * job, so it must be callable with anything.
 */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, '$', [])
}

export function hashPayload(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

function canonicalize(value: unknown, path: string, seen: unknown[]): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number': {
      if (!Number.isFinite(value)) {
        throw new TypeError(`unsupported numeric value at ${path}: ${String(value)}`)
      }
      return JSON.stringify(value)
    }
    case 'undefined':
      throw new TypeError(`unsupported undefined value at ${path}`)
    case 'function':
      throw new TypeError(`unsupported function value at ${path}`)
    case 'symbol':
      throw new TypeError(`unsupported symbol value at ${path}`)
    case 'bigint':
      throw new TypeError(`unsupported bigint value at ${path}`)
    default:
      break
  }

  if (seen.includes(value)) throw new TypeError(`circular reference at ${path}`)

  if (Array.isArray(value)) {
    seen.push(value)
    try {
      const parts = value.map((item, index) => canonicalize(item, `${path}[${index}]`, seen))
      return `[${parts.join(',')}]`
    } finally {
      seen.pop()
    }
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`unsupported object type at ${path}`)
  }

  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  for (const key of keys) {
    if (key.length === 0) throw new TypeError(`empty object key at ${path}`)
  }
  keys.sort()

  seen.push(value)
  try {
    const parts = keys.map(key => {
      const serializedKey = JSON.stringify(key)
      return `${serializedKey}:${canonicalize(record[key], `${path}.${key}`, seen)}`
    })
    return `{${parts.join(',')}}`
  } finally {
    seen.pop()
  }
}
