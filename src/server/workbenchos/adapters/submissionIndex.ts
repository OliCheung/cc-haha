/**
 * Durable submission marker index.
 *
 * The Core can recompute a submission key from a run id, but it cannot know
 * whether the side effect already happened after a crash. This index is the
 * adapter-side answer: the key is persisted BEFORE the side effect is attempted,
 * so a later `lookupSubmission` can distinguish two situations that otherwise
 * look identical - the run was never submitted, or it was submitted and the
 * acknowledgement was lost.
 *
 * Safety rule: a corrupt index means absence cannot be proven, so reads and
 * writes both fail loudly rather than silently reporting "never submitted".
 * Resubmitting on an unproven absence is exactly what the design forbids.
 *
 * Authorized by task package M3-01.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Clock } from '../core/workbenchCore.js'

export type SubmissionMarker = {
  submission_key: string
  /** Opaque reference the Core stores and hands back. */
  native_ref: string
  /** Runtime-specific session handle, when the CLI exposes one. */
  session_ref: string | null
  /** Stamped by the index from its injected clock. */
  accepted_at: string
}

export interface SubmissionIndex {
  /**
   * Persists the intent. MUST be awaited before the side effect is attempted, so
   * that a crash afterwards still leaves a record.
   *
   * The index owns `accepted_at`: whatever the caller passes is replaced, so the
   * recorded time always comes from the injected clock.
   */
  /**
   * Records the marker once. If the key already exists, returns the original
   * marker unchanged; a key must never be rebound to another native run.
   */
  record(marker: SubmissionMarker): Promise<SubmissionIndexRecord>
  /** Returns the marker, or null when the key was never recorded. */
  lookup(submissionKey: string): Promise<SubmissionMarker | null>
}

export type SubmissionIndexRecord = {
  marker: SubmissionMarker
  created: boolean
}

export type SubmissionIndexOptions = {
  file_path: string
  clock: Clock
}

type Entries = Record<string, SubmissionMarker>

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

export function createSubmissionIndex(options: SubmissionIndexOptions): SubmissionIndex {
  const { file_path: filePath, clock } = options

  const read = (): Entries => {
    if (!existsSync(filePath)) return Object.create(null) as Entries

    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    } catch (error) {
      throw new Error(`submission index at ${filePath} is unreadable: ${describe(error)}`)
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`submission index at ${filePath} is not an object`)
    }

    const entries = parsed as Record<string, unknown>
    for (const key of Object.keys(entries)) {
      const entry = entries[key]
      if (
        key.length === 0 ||
        entry === null ||
        typeof entry !== 'object' ||
        Array.isArray(entry)
      ) {
        throw new Error(`submission index at ${filePath} has an invalid entry for key ${JSON.stringify(key)}`)
      }
      const marker = entry as Record<string, unknown>
      if (
        marker.submission_key !== key ||
        typeof marker.native_ref !== 'string' ||
        marker.native_ref.length === 0 ||
        !(marker.session_ref === null || typeof marker.session_ref === 'string') ||
        typeof marker.accepted_at !== 'string' ||
        marker.accepted_at.length === 0
      ) {
        throw new Error(`submission index at ${filePath} has a malformed marker for key ${JSON.stringify(key)}`)
      }
    }

    return entries as Entries
  }

  const write = (entries: Entries): void => {
    mkdirSync(dirname(filePath), { recursive: true })

    // Sorted keys keep the file byte-stable for the same logical content.
    const ordered = Object.create(null) as Entries
    for (const key of Object.keys(entries).sort()) {
      const entry = entries[key]
      if (entry !== undefined) ordered[key] = entry
    }

    // Written beside the target and renamed into place, so a crash mid-write can
    // never leave a half-written index that would look like a corrupt one.
    const temporary = `${filePath}.tmp`
    writeFileSync(temporary, JSON.stringify(ordered, null, 2), 'utf8')
    renameSync(temporary, filePath)
  }

  return {
    async record(marker: SubmissionMarker): Promise<SubmissionIndexRecord> {
      if (marker.submission_key.length === 0 || marker.native_ref.length === 0) {
        throw new Error('submission marker requires a non-empty key and native reference')
      }
      const entries = read()
      const existing = Object.prototype.hasOwnProperty.call(entries, marker.submission_key)
        ? entries[marker.submission_key]
        : undefined
      if (existing !== undefined) return { marker: existing, created: false }

      const recorded: SubmissionMarker = {
        submission_key: marker.submission_key,
        native_ref: marker.native_ref,
        session_ref: marker.session_ref,
        accepted_at: clock.now(),
      }
      if (recorded.accepted_at.length === 0) {
        throw new Error('submission index clock returned an empty timestamp')
      }
      entries[marker.submission_key] = recorded
      write(entries)
      return { marker: recorded, created: true }
    },

    async lookup(submissionKey: string): Promise<SubmissionMarker | null> {
      const entries = read()
      if (!Object.prototype.hasOwnProperty.call(entries, submissionKey)) return null
      return entries[submissionKey]
    },
  }
}
