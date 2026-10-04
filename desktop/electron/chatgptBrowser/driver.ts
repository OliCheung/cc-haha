import type { CdpTarget } from './targetResolution.js'

/**
 * Normalized page observation returned by the driver. The adapter turns this into
 * the vendor-neutral `ConversationObservation`. No ChatGPT/DOM specifics leak past
 * this boundary.
 */
export type DriverRawMessage = {
  role: 'user' | 'assistant'
  text: string
  /**
   * Stable per-message identity extracted from the DOM by the driver. This is the
   * source of `ObservedMessage.message_ref` / `UserMessageReceipt.message_ref` and
   * MUST be stable across observations and unique per logical message (M4-01-ID).
   * It must NOT be derived from array position or content alone.
   */
  id: string
}

export type DriverObservation = {
  messages: DriverRawMessage[]
  stopButtonPresent: boolean
}

export type DriverErrorReason =
  | 'target_not_found'
  | 'target_ambiguous'
  | 'target_unavailable'
  | 'composer_unavailable'
  | 'timeout'
  | 'transport'

/**
 * Adapter-internal driver failure. The adapter maps these to the generic Port
 * error codes so Core never sees ChatGPT/CDP specifics.
 */
export class ChatGptDriverError extends Error {
  readonly reason: DriverErrorReason
  constructor(reason: DriverErrorReason, message: string) {
    super(message)
    this.name = 'ChatGptDriverError'
    this.reason = reason
  }
}

/**
 * The CDP/page seam. The production binding is `CdpChatGptDriver`; tests use a
 * scriptable mock. Keeping this interface in the adapter layer is what lets the
 * rest of the system stay deterministic and ChatGPT-free.
 */
export interface ChatGptPageDriver {
  listTargets(): Promise<CdpTarget[]>
  getComposerState(targetId: string): Promise<{ available: boolean }>
  observeConversation(targetId: string): Promise<DriverObservation>
  typeAndSubmit(targetId: string, content: string): Promise<void>
}
