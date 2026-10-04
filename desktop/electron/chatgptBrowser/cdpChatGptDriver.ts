/**
 * Production ChatGPT Web driver over the Chrome DevTools Protocol (CDP).
 *
 * Requires Chrome launched with `--remote-debugging-port` (default 9222) and a
 * runtime providing global `fetch` and `WebSocket` (bun, Node >= 21, Electron >= 42).
 *
 * This binding is NOT exercised by offline tests — those use the scriptable mock
 * driver. The selectors are an empirical UI contract (see selectors.ts) and must be
 * re-validated if ChatGPT changes its DOM. Treat all behaviors below as "verified
 * against P0 probes, not against a permanent guarantee".
 */

import {
  ChatGptDriverError,
  type ChatGptPageDriver,
  type CdpTarget,
  type DriverObservation,
} from './driver.js'
import { CHATGPT_SELECTORS } from './selectors.js'

export type CdpChatGptDriverOptions = {
  cdpBaseUrl?: string
  callTimeoutMs?: number
}

type CdpTargetInfo = {
  id: string
  url: string
  type: string
  attached?: boolean
  webSocketDebuggerUrl?: string
}

let cdpSeq = 0

export class CdpChatGptDriver implements ChatGptPageDriver {
  private readonly baseUrl: string
  private readonly callTimeoutMs: number

  constructor(options: CdpChatGptDriverOptions = {}) {
    this.baseUrl = options.cdpBaseUrl ?? 'http://127.0.0.1:9222'
    this.callTimeoutMs = options.callTimeoutMs ?? 15000
  }

  async listTargets(): Promise<CdpTarget[]> {
    const res = await fetch(`${this.baseUrl}/json`)
    if (!res.ok) throw new ChatGptDriverError('transport', `list targets failed: ${res.status}`)
    const infos = (await res.json()) as CdpTargetInfo[]
    return infos.map(t => ({
      id: t.id,
      url: t.url,
      type: t.type,
      attached: t.attached ?? false,
    }))
  }

  async getComposerState(targetId: string): Promise<{ available: boolean }> {
    const obs = await this.observeConversation(targetId)
    // A Stop control only appears mid-generation; its absence is treated as a usable
    // composer. A more strict check could also verify the editor node exists.
    return { available: !obs.stopButtonPresent }
  }

  async observeConversation(targetId: string): Promise<DriverObservation> {
    const wsUrl = await this.getWsUrl(targetId)
    const resp = await this.cdpCall<{
      result?: { value?: unknown; type?: string }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }>(wsUrl, 'Runtime.evaluate', {
      expression: buildObserveScript(),
      returnByValue: true,
      awaitPromise: true,
    })
    if (resp.exceptionDetails) {
      throw new ChatGptDriverError(
        'transport',
        `page script threw: ${resp.exceptionDetails.text ?? resp.exceptionDetails.exception?.description ?? 'unknown'}`,
      )
    }
    const raw =
      typeof resp.result?.value === 'string'
        ? resp.result.value
        : String(resp.result?.value ?? '')
    return JSON.parse(raw) as DriverObservation
  }

  async typeAndSubmit(targetId: string, content: string): Promise<void> {
    const wsUrl = await this.getWsUrl(targetId)
    // Focus the composer, then drive it through the CDP Input domain (React-friendly:
    // Input.insertText dispatches a real beforeinput/input sequence the editor listens
    // to, and a real Enter key event triggers submission).
    const focus = await this.cdpCall<{ result?: { value?: unknown } }>(wsUrl, 'Runtime.evaluate', {
      expression: buildFocusScript(),
      returnByValue: true,
    })
    if (focus.result?.value !== 'FOCUSED') {
      throw new ChatGptDriverError('composer_unavailable', 'composer not focusable')
    }
    await this.cdpCall(wsUrl, 'Input.insertText', { text: content })
    await this.cdpCall(wsUrl, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
    })
    await this.cdpCall(wsUrl, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
    })
  }

  // ---- CDP plumbing ----

  private async getWsUrl(targetId: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/json`)
    const infos = (await res.json()) as CdpTargetInfo[]
    const target = infos.find(t => t.id === targetId)
    if (!target || !target.webSocketDebuggerUrl) {
      throw new ChatGptDriverError('target_unavailable', `no websocket url for target ${targetId}`)
    }
    return target.webSocketDebuggerUrl
  }

  private cdpCall<T = unknown>(wsUrl: string, method: string, params: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const ws = new WebSocket(wsUrl)
      const id = ++cdpSeq
      let settled = false
      const fail = (reason: 'timeout' | 'transport', message: string) => {
        if (settled) return
        settled = true
        try {
          ws.close()
        } catch {
          /* ignore */
        }
        reject(new ChatGptDriverError(reason, message))
      }
      const timer = setTimeout(() => fail('timeout', `cdp ${method} timed out`), this.callTimeoutMs)
      ws.onopen = () => {
        ws.send(JSON.stringify({ id, method, params }))
      }
      ws.onmessage = event => {
        try {
          const msg = JSON.parse(String(event.data)) as {
            id?: number
            result?: unknown
            error?: { message?: string }
          }
          if (msg.id !== id) return // ignore unrelated frames
          clearTimeout(timer)
          settled = true
          ws.close()
          if (msg.error) {
            reject(new ChatGptDriverError('transport', msg.error.message ?? 'cdp error'))
            return
          }
          resolve(msg.result as T)
        } catch (e) {
          clearTimeout(timer)
          fail('transport', String(e))
        }
      }
      ws.onerror = () => fail('transport', 'websocket error')
    })
  }
}

function buildObserveScript(): string {
  const s = CHATGPT_SELECTORS
  // Combine both selectors into ONE group-selector string BEFORE JSON.stringify, so the
  // comma ends up INSIDE the string literal (otherwise querySelectorAll gets two args
  // and silently ignores the second).
  const groupSelector = `${s.userMessage},${s.assistantMessage}`
  return `(function(){
  function textOf(el){ return (el.innerText || el.textContent || '').trim(); }
  // Stable per-message identity (M4-01-ID). Prefer a real, durable DOM id; never fall
  // back to array position or content. Empty string means "no stable id available",
  // which must be caught and surfaced by the adapter as a contract failure.
  function stableIdOf(el){
    return el.id || el.getAttribute('data-message-id') || el.getAttribute('data-chatgpt-selection-message-id') || '';
  }
  var all = Array.prototype.slice.call(
    document.querySelectorAll(${JSON.stringify(groupSelector)})
  );
  var ordered = all.map(function(el){
    return { role: el.getAttribute('data-message-author-role'), text: textOf(el), id: stableIdOf(el) };
  });
  var stop = document.querySelector(${JSON.stringify(s.stopButton)}) !== null;
  return JSON.stringify({ messages: ordered, stopButtonPresent: stop });
})()`
}

function buildFocusScript(): string {
  const s = CHATGPT_SELECTORS
  return `(function(){
  var editor = document.querySelector(${JSON.stringify(s.composer)});
  if (!editor) return 'NO_COMPOSER';
  editor.focus();
  return 'FOCUSED';
})()`
}
