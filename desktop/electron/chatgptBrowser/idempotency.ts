import type { UserMessageReceipt } from '../../../src/server/workbenchos/ports/browserAutomationPort.js'

/**
 * Idempotency index for submit operations. The adapter reserves intent BEFORE any
 * CDP side effect, then completes with the receipt AFTER the user message is
 * confirmed observed. A crash between send and completion leaves a reserved-but-
 * uncompleted record; recovery re-checks the conversation instead of resending.
 *
 * The production binding is expected to be a SQLite-backed store (M4-03). This
 * in-memory implementation is the standalone/default used by tests and by the
 * adapter when no external store is wired in.
 */
export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | null>
  reserve(key: string): Promise<IdempotencyRecord>
  complete(key: string, receipt: UserMessageReceipt): Promise<void>
}

export type IdempotencyRecord = {
  key: string
  receipt: UserMessageReceipt | null
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly map = new Map<string, IdempotencyRecord>()

  async get(key: string): Promise<IdempotencyRecord | null> {
    return this.map.get(key) ?? null
  }

  async reserve(key: string): Promise<IdempotencyRecord> {
    const existing = this.map.get(key)
    if (existing) return existing
    const record: IdempotencyRecord = { key, receipt: null }
    this.map.set(key, record)
    return record
  }

  async complete(key: string, receipt: UserMessageReceipt): Promise<void> {
    const existing = this.map.get(key)
    if (!existing) {
      this.map.set(key, { key, receipt })
      return
    }
    existing.receipt = receipt
  }
}
