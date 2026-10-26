import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import type { ActionReply } from './actionBridge'

/**
 * Skill scripts a chat may run (docs/BOB-SKILLS.md). The chat writes a script
 * it read from the skills server into this folder, then asks
 * `wos-action run skills.verify` whether it matches the digest the server
 * lists — a chat has no shell to hash it with. Only files inside the folder
 * are hashed.
 */

export function skillScriptsDirIn(userDataDir: string): string {
  return path.join(userDataDir, 'skill-scripts')
}

const DIGEST_RE = /^(?:sha256:)?([0-9a-f]{64})$/i

/** `skills.verify {path, sha256}` → `{ match, sha256 }` for a file inside `dir`. */
export function verifySkillScript(args: unknown, dir: string): ActionReply {
  const a = (args && typeof args === 'object' ? args : {}) as { path?: unknown; sha256?: unknown }
  if (typeof a.path !== 'string' || !a.path) return { ok: false, error: 'skills.verify needs "path": the script you wrote into the skill-scripts folder' }
  const want = typeof a.sha256 === 'string' ? DIGEST_RE.exec(a.sha256.trim()) : null
  if (!want) return { ok: false, error: 'skills.verify needs "sha256": the 64-character hex digest the skills server lists for the file' }
  let real: string
  let root: string
  try {
    root = fs.realpathSync(dir)
    real = fs.realpathSync(path.resolve(dir, a.path))
  } catch {
    return { ok: false, error: `no such file in the skill-scripts folder: ${a.path}` }
  }
  const rel = path.relative(root, real)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: `only files inside ${root} can be verified` }
  if (!fs.statSync(real).isFile()) return { ok: false, error: `not a file: ${a.path}` }
  const actual = createHash('sha256').update(fs.readFileSync(real)).digest('hex')
  return { ok: true, result: { match: actual === want[1].toLowerCase(), sha256: actual } }
}
