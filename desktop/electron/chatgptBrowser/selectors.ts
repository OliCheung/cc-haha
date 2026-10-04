/**
 * Empirical ChatGPT Web UI selectors — P0-09 / P0-10B / P0-11 verified.
 *
 * WARNING: these are an EMPIRICAL UI CONTRACT, not a stable API. ChatGPT can
 * change its DOM at any time. They must live only in this Electron-main adapter
 * layer (never in Core / workbenchos), and must be re-validated if the UI shifts.
 */

export const CHATGPT_SELECTORS = {
  composer: '[role="textbox"][contenteditable="true"]',
  userMessage: '[data-message-author-role="user"]',
  assistantMessage: '[data-message-author-role="assistant"]',
  stopButton:
    'button[aria-label*="Stop" i], button[aria-label*="停止" i], button[data-testid="stop-button"]',
} as const

export type ChatGptRole = 'user' | 'assistant'

/**
 * Runtime guard used by the CDP driver's in-page script. Confirms the empirical
 * contract still holds before trusting any extraction; absence ⇒ treat as failure
 * (do not silently misread the page).
 */
export function selectorsPresent(doc: {
  querySelectorAll(selector: string): ArrayLike<unknown>
}): { ok: boolean; missing: string[] } {
  const missing: string[] = []
  if (doc.querySelectorAll(CHATGPT_SELECTORS.composer).length === 0) missing.push('composer')
  if (doc.querySelectorAll(CHATGPT_SELECTORS.userMessage).length === 0) missing.push('userMessage')
  if (doc.querySelectorAll(CHATGPT_SELECTORS.assistantMessage).length === 0)
    missing.push('assistantMessage')
  return { ok: missing.length === 0, missing }
}
