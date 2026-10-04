import type { ConversationRef } from '../../../src/server/workbenchos/ports/browserAutomationPort.js'

/**
 * A CDP target as reported by `Target.getTargets` / `/json`.
 */
export type CdpTarget = {
  id: string
  url: string
  type: string
  attached: boolean
}

export type ResolveResult =
  | { ok: true; targetId: string }
  | { ok: false; reason: 'not_found' | 'ambiguous' | 'unavailable' }

/**
 * Fail-closed resolution of a `conversation_ref` to EXACTLY one CDP target.
 * We never guess:
 *   - 0 matches  → not_found
 *   - >1 matches → ambiguous (refuse to pick)
 *   - detached   → unavailable
 */
export function resolveConversationTarget(
  targets: CdpTarget[],
  ref: ConversationRef,
): ResolveResult {
  const pages = targets.filter(t => t.type === 'page')
  const matches = pages.filter(
    t =>
      t.url.includes(`/c/${ref.conversation_id}`) || t.url.includes(ref.conversation_id),
  )
  if (matches.length === 0) return { ok: false, reason: 'not_found' }
  if (matches.length > 1) return { ok: false, reason: 'ambiguous' }
  const target = matches[0]
  // CDP `attached` means "a debugger session is currently attached". A normal
  // foreground tab is `attached: false` until something connects to it, so it must
  // NOT be treated as unusable. Real usability is confirmed at connect time via the
  // target's `webSocketDebuggerUrl` (see CdpChatGptDriver.getWsUrl).
  return { ok: true, targetId: target.id }
}
