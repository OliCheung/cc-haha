import { describe, expect, test } from 'bun:test'
import {
  agentSubmitKey,
  canonicalJson,
  decideIdempotency,
  hashPayload,
  recoveryKey,
  resultDeliveryKey,
  resultRecordKey,
  runCreateKey,
  taskIngestKey,
} from './idempotency.js'

const SHA256_HEX = /^[0-9a-f]{64}$/

describe('canonicalJson', () => {
  test('canonicalizes object keys in stable order', () => {
    const expected = '{"a":2,"b":1}'
    expect(canonicalJson({ b: 1, a: 2 })).toBe(expected)
    expect(canonicalJson({ a: 2, b: 1 })).toBe(expected)
  })

  test('preserves array order', () => {
    expect(canonicalJson({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}')
  })

  test('emits no whitespace', () => {
    expect(canonicalJson({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}')
  })

  test('serializes primitives', () => {
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson(true)).toBe('true')
    expect(canonicalJson(false)).toBe('false')
    expect(canonicalJson('x')).toBe('"x"')
    expect(canonicalJson(0)).toBe('0')
  })

  test('rejects NaN', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError)
  })

  test('rejects Infinity', () => {
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError)
    expect(() => canonicalJson(Number.NEGATIVE_INFINITY)).toThrow(TypeError)
  })

  test('rejects undefined property', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(TypeError)
  })

  test('rejects undefined array element', () => {
    expect(() => canonicalJson([undefined])).toThrow(TypeError)
  })

  test('rejects functions', () => {
    expect(() => canonicalJson(() => 0)).toThrow(TypeError)
  })

  test('rejects bigint', () => {
    expect(() => canonicalJson(BigInt(1))).toThrow(TypeError)
  })

  test('rejects Date instances', () => {
    expect(() => canonicalJson(new Date(0))).toThrow(TypeError)
  })

  test('rejects Map and Set', () => {
    expect(() => canonicalJson(new Map())).toThrow(TypeError)
    expect(() => canonicalJson(new Set())).toThrow(TypeError)
  })

  test('rejects circular references', () => {
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    expect(() => canonicalJson(circular)).toThrow(TypeError)
  })

  test('rejects empty object key', () => {
    expect(() => canonicalJson({ '': 1 })).toThrow(TypeError)
  })

  test('includes the offending path in the error message', () => {
    expect(() => canonicalJson({ a: [1, undefined] })).toThrow(/\$\.a\[1\]/)
  })
})

describe('hashPayload', () => {
  test('hashPayload is stable across key order', () => {
    const first = hashPayload({ b: [1, 2], a: 'x' })
    const second = hashPayload({ a: 'x', b: [1, 2] })
    expect(first).toBe(second)
    expect(SHA256_HEX.test(first)).toBe(true)
  })

  test('hashPayload differs for different values', () => {
    expect(hashPayload({ a: 1 })).not.toBe(hashPayload({ a: 2 }))
  })
})

describe('namespaced keys', () => {
  test('builds namespaced idempotency keys', () => {
    expect(taskIngestKey({
      browser_adapter_id: 'adapter-1',
      conversation_id: 'conversation-1',
      idempotency_key: 'idem-1',
    })).toBe('adapter-1|conversation-1|idem-1')
    expect(runCreateKey('task-1', 2)).toBe('task-1:2')
    expect(agentSubmitKey('run-1')).toBe('run-1:v1')
    expect(agentSubmitKey('run-1', 'v2')).toBe('run-1:v2')
    expect(resultRecordKey('run-1')).toBe('run-1')
    expect(resultDeliveryKey('result-1', 'conversation-1')).toBe('result-1:conversation-1')
    expect(recoveryKey('run-1', 'checkpoint-1')).toBe('run-1:checkpoint-1')
  })
})

describe('decideIdempotency', () => {
  test('decides new when nothing exists', () => {
    expect(decideIdempotency(null, 'hash-1')).toEqual({ kind: 'new' })
  })

  test('decides unchanged for the same hash', () => {
    const decision = decideIdempotency(
      { payload_hash: 'hash-1', outcome_ref: 'task-0001' },
      'hash-1',
    )
    expect(decision).toEqual({ kind: 'unchanged', outcome_ref: 'task-0001' })
  })

  test('decides conflict for a different hash', () => {
    const decision = decideIdempotency(
      { payload_hash: 'hash-1', outcome_ref: 'task-0001' },
      'hash-2',
    )
    expect(decision).toEqual({
      kind: 'conflict',
      existing_hash: 'hash-1',
      incoming_hash: 'hash-2',
    })
  })
})
