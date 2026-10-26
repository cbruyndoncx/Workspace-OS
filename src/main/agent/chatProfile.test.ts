import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/wos-test', isPackaged: false } }))

import { buildChatSystemPrompt } from './chatProfile'

describe('buildChatSystemPrompt and skill scripts', () => {
  it('keeps the plain shell limits by default', () => {
    const p = buildChatSystemPrompt('/ws')
    expect(p).toContain('you may run ONLY `wos-gen` and `wos-action`')
    expect(p).not.toContain('SKILL SCRIPTS')
  })

  it('adds `uv run` and the rules for skill scripts when the setting is on', () => {
    const p = buildChatSystemPrompt('/ws', '', { skillScriptsDir: '/data/skill-scripts' })
    expect(p).toContain('`wos-gen`, `wos-action` and `uv run`')
    expect(p).toContain('SKILL SCRIPTS')
    expect(p).toContain('/data/skill-scripts')
  })
})
