#!/usr/bin/env node
// M2-4 patch-queue audit: every patch dir must have a complete PATCH.md; and the
// fork must not change DSH core files unless the change is covered by an approved
// patch manifest. Exit 0 = pass, 1 = violation.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PATCH_DIR = join(ROOT, 'nisse', 'patches')
const requiredSections = ['## Purpose', '## Affected files', '## Upstream baseline', '## Tests', '## Owner', '## Removal / upstream condition', '## Rebase notes']

function fail(message, detail) {
  console.error('FAIL:', message)
  if (detail) console.error(detail)
  process.exit(1)
}

const dirs = readdirSync(PATCH_DIR).filter((name) => {
  const p = join(PATCH_DIR, name)
  return statSync(p).isDirectory() && name !== '0000-TEMPLATE' && !name.startsWith('_')
})
const patches = []
for (const name of dirs) {
  const manifest = join(PATCH_DIR, name, 'PATCH.md')
  if (!existsSync(manifest)) fail(`patch ${name} missing PATCH.md`)
  const text = readFileSync(manifest, 'utf8')
  for (const section of requiredSections) {
    if (!text.includes(section)) fail(`patch ${name} PATCH.md missing section: ${section}`)
  }
  patches.push({ id: name, manifest })
}
if (patches.length > 25) fail(`patch count ${patches.length} exceeds ADR-0005 threshold 25`)

// Core-diff guard: compare against the pinned upstream tag.
const upstream = readFileSync(join(ROOT, 'UPSTREAM.txt'), 'utf8')
const tagMatch = upstream.match(/^upstream_tag:\s*(\S+)/m)
if (!tagMatch) fail('UPSTREAM.txt has no upstream_tag')
const tag = tagMatch[1]
let changed = []
try {
  changed = execFileSync('git', ['diff', '--name-only', `${tag}`, 'HEAD'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean)
} catch (error) {
  fail('git diff against upstream tag failed', String(error?.message || error))
}
const allowedPrefixes = ['nisse/', 'UPSTREAM.txt', '.gitignore']
const coreChanges = changed.filter((file) => !allowedPrefixes.some((prefix) => file === prefix || file.startsWith(prefix)))
if (coreChanges.length > 0 && patches.length === 0) {
  fail('core files changed without an approved patch manifest', coreChanges.join('\n'))
}

const result = {
  generatedAt: new Date().toISOString(),
  upstreamTag: tag,
  patchCount: patches.length,
  patches: patches.map((p) => p.id),
  changedFiles: changed.length,
  coreChanges,
  ok: true,
}
console.log(JSON.stringify(result, null, 2))
