/**
 * Content fingerprint for message-identity comparison (P0-11 verified scheme:
 * length + first 40 chars + last 40 chars of normalized text).
 *
 * This lives only in the adapter layer; Core receives the opaque fingerprint and
 * only ever compares it for equality.
 */

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function fingerprintOf(text: string): string {
  const n = normalizeText(text)
  const head = n.slice(0, 40)
  const tail = n.length > 40 ? n.slice(-40) : ''
  return `${n.length}|${head}|${tail}`
}
