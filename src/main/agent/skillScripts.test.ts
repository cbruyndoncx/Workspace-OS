import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { verifySkillScript, skillScriptsDirIn } from './skillScripts'

describe('skills.verify', () => {
  let data: string
  let dir: string
  const body = 'print("hello")\n'
  const digest = createHash('sha256').update(body).digest('hex')

  beforeEach(() => {
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-skills-'))
    dir = skillScriptsDirIn(data)
    fs.mkdirSync(path.join(dir, 'ecl-calculator', 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'ecl-calculator', 'scripts', 'calc.py'), body)
    fs.writeFileSync(path.join(data, 'outside.txt'), body)
  })
  afterEach(() => fs.rmSync(data, { recursive: true, force: true }))

  it('answers match for the digest the server lists, with or without the sha256: prefix', () => {
    expect(verifySkillScript({ path: 'ecl-calculator/scripts/calc.py', sha256: digest }, dir)).toEqual({ ok: true, result: { match: true, sha256: digest } })
    expect(verifySkillScript({ path: 'ecl-calculator/scripts/calc.py', sha256: `sha256:${digest.toUpperCase()}` }, dir)).toMatchObject({ ok: true, result: { match: true } })
  })

  it('answers no match when the file was changed', () => {
    fs.appendFileSync(path.join(dir, 'ecl-calculator', 'scripts', 'calc.py'), 'import os\n')
    expect(verifySkillScript({ path: 'ecl-calculator/scripts/calc.py', sha256: digest }, dir)).toMatchObject({ ok: true, result: { match: false } })
  })

  it('hashes only files inside the skill-scripts folder', () => {
    expect(verifySkillScript({ path: '../outside.txt', sha256: digest }, dir).ok).toBe(false)
    expect(verifySkillScript({ path: path.join(data, 'outside.txt'), sha256: digest }, dir).ok).toBe(false)
    expect(verifySkillScript({ path: 'ecl-calculator', sha256: digest }, dir).ok).toBe(false)
    expect(verifySkillScript({ path: 'missing.py', sha256: digest }, dir).ok).toBe(false)
  })

  it('needs a path and a 64-character digest', () => {
    expect(verifySkillScript({ sha256: digest }, dir).ok).toBe(false)
    expect(verifySkillScript({ path: 'ecl-calculator/scripts/calc.py', sha256: 'abc' }, dir).ok).toBe(false)
    expect(verifySkillScript(null, dir).ok).toBe(false)
  })
})
