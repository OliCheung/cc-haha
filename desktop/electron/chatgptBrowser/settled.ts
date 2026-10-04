/**
 * Streaming → settled heuristic (P0-11 verified approach):
 *   - a Stop control present ⇒ still generating ⇒ not settled
 *   - the latest assistant fingerprint unchanged across calls ⇒ stable streak grows
 *   - settled once the streak reaches the required count AND no Stop control shows
 *
 * Pure and deterministic so it is fully unit-testable without a real page.
 */

export type SettledState = {
  lastAssistantFingerprint: string | null
  stableStreak: number
}

export const DEFAULT_SETTLE_STREAK_REQUIRED = 4

export function initialState(): SettledState {
  return { lastAssistantFingerprint: null, stableStreak: 0 }
}

export function computeSettled(
  state: SettledState,
  currentAssistantFingerprint: string | null,
  stopButtonPresent: boolean,
  streakRequired: number,
): { settled: boolean; next: SettledState } {
  if (currentAssistantFingerprint === null) {
    return { settled: true, next: { lastAssistantFingerprint: null, stableStreak: 0 } }
  }
  if (stopButtonPresent) {
    return {
      settled: false,
      next: { lastAssistantFingerprint: currentAssistantFingerprint, stableStreak: 0 },
    }
  }
  const streak =
    state.lastAssistantFingerprint === currentAssistantFingerprint
      ? state.stableStreak + 1
      : 1
  const settled = streak >= streakRequired
  return {
    settled,
    next: { lastAssistantFingerprint: currentAssistantFingerprint, stableStreak: streak },
  }
}
