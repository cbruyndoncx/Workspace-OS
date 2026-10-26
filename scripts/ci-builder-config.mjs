#!/usr/bin/env node
/**
 * Writes package.json's electron-builder config to a file with every
 * extraResources entry whose source is missing left out, and says which.
 * CI builds a test app without the resources only a developer machine has
 * (the macOS build bundles a LibreOffice.app from /Volumes/LOBuild).
 *
 *   node scripts/ci-builder-config.mjs <out.json>
 */
import fs from 'node:fs'

const out = process.argv[2]
if (!out) { console.error('usage: ci-builder-config.mjs <out.json>'); process.exit(2) }
const build = JSON.parse(fs.readFileSync('package.json', 'utf-8')).build
for (const key of ['mac', 'linux', 'win']) {
  const list = build[key]?.extraResources
  if (!Array.isArray(list)) continue
  build[key].extraResources = list.filter((r) => {
    const from = typeof r === 'string' ? r : r.from
    if (fs.existsSync(from)) return true
    console.log(`[${key}] left out (not on this machine): ${from}`)
    return false
  })
}
fs.writeFileSync(out, JSON.stringify(build, null, 2))
console.log(`wrote ${out}`)
