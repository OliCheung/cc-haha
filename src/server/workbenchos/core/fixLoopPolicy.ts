/**
 * Bounded fix-loop policy.
 *
 * Frozen by `docs/decisions/DECISION_2026-10-02_FIX_LOOP_DELIVERY_AND_M2.md`:
 *   DEC-01 iteration cap · DEC-02 stagnation criteria · DEC-03 budget and terminal state.
 *
 * This module is a pure decision function. It never reads a clock, never reads the
 * environment, and performs no I/O: the Core injects `now`, and every judgement is
 * derived from the supplied input alone.
 *
 * Authorized by task package M5-01.
 */

import type { ResultEnvelopeV01, TaskProjection } from '../contracts.js'
import { hashPayload } from './idempotency.js'

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type FixLoopBlockerCode =
  | 'FIX_LOOP_EXHAUSTED'
  | 'FIX_LOOP_STAGNATED'
  | 'FIX_LOOP_NO_PROGRESS'
  | 'FIX_LOOP_BUDGET_EXCEEDED'

export type FixLoopDecision =
  | { action: 'retry' }
  | { action: 'stop'; blocker_code: FixLoopBlockerCode; detail: string }

export type FixLoopPolicyInput = {
  /** Current Task projection, still at WAITING_REVIEW. */
  task: TaskProjection
  /** The Result that was just judged terminal and is not persisted yet. */
  lastResult: ResultEnvelopeV01
  /** Results of the same Task already persisted, in ascending order. Excludes lastResult. */
  priorResults: ResultEnvelopeV01[]
  /** Number of persisted Results (= priorResults.length). */
  recorded_result_count: number
  /** Fix rounds this policy has already granted for the Task. */
  granted_fix_rounds: number
  /** recorded_at of the Task's first run.created; null when the Task has no Run. */
  budget_started_at: string | null
  /** Supplied by the Core's injected clock. The policy must never take its own time. */
  now: string
}

export interface FixLoopPolicy {
  decide(input: FixLoopPolicyInput): FixLoopDecision
}

export type DefaultFixLoopPolicyOptions = {
  max_fix_rounds?: number
  budget_ms?: number
  stagnation_window?: number
}

export const DEFAULT_MAX_FIX_ROUNDS = 3
export const DEFAULT_FIX_LOOP_BUDGET_MS = 3_600_000
export const DEFAULT_STAGNATION_WINDOW = 3

// ---------------------------------------------------------------------------
// Fingerprints (DEC-02)
// ---------------------------------------------------------------------------

/**
 * Fingerprint of what a Run actually attempted. Order-independent, so a mere
 * reordering of the evidence never looks like a new attempt.
 */
export function attemptFingerprint(result: ResultEnvelopeV01): string {
  return hashPayload({
    files: result.changed_files.map(item => `${item.change}:${item.path}`).sort(),
    commands: result.commands.map(item => item.command).sort(),
  })
}

/**
 * Fingerprint of where a Run failed. Order-independent.
 */
export function failureSignature(result: ResultEnvelopeV01): string {
  return hashPayload({
    failed: result.validations
      .filter(item => item.result === 'failed')
      .map(item => item.requirement_id)
      .sort(),
  })
}

function hasFailedValidation(result: ResultEnvelopeV01): boolean {
  return result.validations.some(item => item.result === 'failed')
}

/**
 * Returns null when the value is absent or unparseable, which makes the budget
 * check fail open: an unreadable timestamp must not stop work, and the round cap
 * still bounds the loop on its own.
 */
function parseTimestamp(value: string | null): number | null {
  if (value === null) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

// ---------------------------------------------------------------------------
// Default policy
// ---------------------------------------------------------------------------

/**
 * Judgement order is priority order; the first matching criterion decides the
 * blocker code:
 *
 *   1. NO_PROGRESS        the most specific, cheapest diagnosis
 *   2. EXHAUSTED          the hard cap, which no soft criterion may bypass
 *   3. STAGNATED          the loop is not converging
 *   4. BUDGET_EXCEEDED    time ran out
 *   5. otherwise          retry
 */
export function createDefaultFixLoopPolicy(
  options: DefaultFixLoopPolicyOptions = {},
): FixLoopPolicy {
  const maxFixRounds = options.max_fix_rounds ?? DEFAULT_MAX_FIX_ROUNDS
  const budgetMs = options.budget_ms ?? DEFAULT_FIX_LOOP_BUDGET_MS
  const stagnationWindow = options.stagnation_window ?? DEFAULT_STAGNATION_WINDOW

  return {
    decide(input: FixLoopPolicyInput): FixLoopDecision {
      // 1. NO_PROGRESS — a repair round that changed nothing cannot converge.
      if (input.granted_fix_rounds > 0 && input.lastResult.changed_files.length === 0) {
        return {
          action: 'stop',
          blocker_code: 'FIX_LOOP_NO_PROGRESS',
          detail: 'FIX_LOOP_NO_PROGRESS: the last fix round changed no files',
        }
      }

      // 2. EXHAUSTED — the hard cap.
      if (input.granted_fix_rounds >= maxFixRounds) {
        return {
          action: 'stop',
          blocker_code: 'FIX_LOOP_EXHAUSTED',
          detail: `FIX_LOOP_EXHAUSTED: granted ${input.granted_fix_rounds} of ${maxFixRounds} fix rounds`,
        }
      }

      // 3a. STAGNATED — the repeat attempt produced the identical attempt.
      const previous = input.priorResults[input.priorResults.length - 1]
      if (previous !== undefined) {
        const lastPrint = attemptFingerprint(input.lastResult)
        if (lastPrint === attemptFingerprint(previous)) {
          return {
            action: 'stop',
            blocker_code: 'FIX_LOOP_STAGNATED',
            detail: `FIX_LOOP_STAGNATED: identical attempt fingerprint ${lastPrint.slice(0, 8)}`,
          }
        }
      }

      // 3b. STAGNATED — the same validation keeps failing across the window.
      // A window shorter than 2 cannot express "repeated", so it never fires.
      // Requiring a failed validation on every entry keeps an evidence-less
      // failure from looking like a stuck validation.
      if (stagnationWindow >= 2) {
        const window = [
          ...input.priorResults.slice(-(stagnationWindow - 1)),
          input.lastResult,
        ]
        if (
          window.length === stagnationWindow &&
          window.every(hasFailedValidation) &&
          new Set(window.map(failureSignature)).size === 1
        ) {
          return {
            action: 'stop',
            blocker_code: 'FIX_LOOP_STAGNATED',
            detail: `FIX_LOOP_STAGNATED: the same validation failed ${stagnationWindow} rounds in a row`,
          }
        }
      }

      // 4. BUDGET_EXCEEDED.
      const started = parseTimestamp(input.budget_started_at)
      const current = parseTimestamp(input.now)
      if (started !== null && current !== null && current - started > budgetMs) {
        return {
          action: 'stop',
          blocker_code: 'FIX_LOOP_BUDGET_EXCEEDED',
          detail: `FIX_LOOP_BUDGET_EXCEEDED: ${current - started}ms of ${budgetMs}ms`,
        }
      }

      // 5. Nothing fired: the loop may continue.
      return { action: 'retry' }
    },
  }
}
