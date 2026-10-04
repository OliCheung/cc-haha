/**
 * Architecture contract test.
 *
 * The WorkbenchOS core must not couple to high-churn cc-haha runtime internals,
 * to Electron, or to any new dependency. See DECISION_LOG D-014 and M0-03 §5.2.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PRODUCTION_ROOT = dirname(fileURLToPath(import.meta.url))

const FORBIDDEN_SPECIFIER_PREFIXES = [
  'src/server/index.ts',
  'src/server/router.ts',
  'src/server/server.ts',
  'src/server/ws/',
  'src/server/services/conversationService.ts',
  'src/server/services/sessionService.ts',
  'src/server/services/repositoryLaunchService.ts',
  'src/server/services/localIndex/',
  'desktop/',
]

const FORBIDDEN_TOKENS = [
  'bypassPermissions',
  'WebContentsView',
  'webContents',
  'cookie',
  'selector',
  'stream-json',
  'localStorage',
  // BrowserAutomationPort must never leak ChatGPT / CDP specifics into Core
  // (C-04 / C-06). Case-sensitive on purpose: 'chatgpt-web' adapter_id strings in
  // contracts/tests are allowed; only the capitalized vendor/CDP spellings are banned.
  'ChatGPT',
  'CDP',
]

const IMPORT_PATTERNS = [
  /\bfrom\s+['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s+['"]([^'"]+)['"]/g,
]

type Violation = {
  file: string
  specifier: string
  kind: string
}

function toPosix(value: string): string {
  return value.split(sep).join('/')
}

function listProductionFiles(root: string): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.ts')) continue
      if (entry.name.endsWith('.test.ts')) continue
      files.push(full)
    }
  }
  walk(root)
  return files
}

function extractSpecifiers(source: string): string[] {
  const found: string[] = []
  for (const pattern of IMPORT_PATTERNS) {
    const scanner = new RegExp(pattern.source, pattern.flags)
    let match = scanner.exec(source)
    while (match !== null) {
      if (typeof match[1] === 'string' && match[1].length > 0) found.push(match[1])
      match = scanner.exec(source)
    }
  }
  return found
}

function displayPath(file: string): string {
  return toPosix(relative(process.cwd(), file))
}

function classifySpecifier(file: string, specifier: string): Violation | null {
  const record = (kind: string): Violation => ({
    file: displayPath(file),
    specifier,
    kind,
  })

  if (specifier.startsWith('.')) {
    const resolved = toPosix(resolve(dirname(file), specifier))
    const root = toPosix(PRODUCTION_ROOT)
    return resolved === root || resolved.startsWith(`${root}/`) ? null : record('RELATIVE_ESCAPE')
  }

  if (specifier === 'electron' || specifier.startsWith('electron/')) {
    return record('FORBIDDEN_ELECTRON')
  }

  if (specifier.startsWith('bun:') || specifier.startsWith('node:')) return null

  if (FORBIDDEN_SPECIFIER_PREFIXES.some(prefix => specifier.startsWith(prefix))) {
    return record('FORBIDDEN_CC_HAHA_INTERNAL')
  }

  if (specifier.startsWith('src/server/workbenchos/')) return null

  if (specifier.startsWith('src/')) return record('OUTSIDE_WORKBENCHOS')

  if (specifier.startsWith('@')) return record('SCOPED_PACKAGE_IMPORT')

  if (!specifier.includes('/')) return record('BARE_PACKAGE_IMPORT')

  return record('UNCLASSIFIED_IMPORT')
}

function collectImportViolations(): Violation[] {
  const violations: Violation[] = []
  for (const file of listProductionFiles(PRODUCTION_ROOT)) {
    const source = readFileSync(file, 'utf8')
    for (const specifier of extractSpecifiers(source)) {
      const violation = classifySpecifier(file, specifier)
      if (violation) violations.push(violation)
    }
  }
  return violations
}

function collectTokenViolations(): Violation[] {
  const violations: Violation[] = []
  for (const file of listProductionFiles(PRODUCTION_ROOT)) {
    const source = readFileSync(file, 'utf8')
    for (const token of FORBIDDEN_TOKENS) {
      if (source.includes(token)) {
        violations.push({ file: displayPath(file), specifier: token, kind: 'FORBIDDEN_TOKEN' })
      }
    }
  }
  return violations
}

describe('workbenchos dependency boundary', () => {
  test('workbenchos production files do not import cc-haha internals', () => {
    expect(collectImportViolations()).toEqual([])
  })

  test('workbenchos production files do not contain forbidden tokens', () => {
    expect(collectTokenViolations()).toEqual([])
  })

  test('the boundary scan actually sees the production files', () => {
    const files = listProductionFiles(PRODUCTION_ROOT).map(displayPath)
    expect(files.some(file => file.endsWith('workbenchos/contracts.ts'))).toBe(true)
    expect(files.some(file => file.endsWith('workbenchos/ports/agentPort.ts'))).toBe(true)
    expect(files.some(file => file.endsWith('workbenchos/ports/journalPort.ts'))).toBe(true)
    expect(
      files.some(file => file.endsWith('workbenchos/ports/browserAutomationPort.ts')),
    ).toBe(true)
    expect(files.some(file => file.endsWith('.test.ts'))).toBe(false)
  })
})
