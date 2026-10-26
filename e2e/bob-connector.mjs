#!/usr/bin/env node
/**
 * The BOB skills connector on a packaged app (docs/BOB-SKILLS.md), as a person
 * uses it on the Connectors page, against a skills server that needs no
 * sign-in. Runs on macOS and Linux in CI (.github/workflows/bob-skills.yml).
 *
 *   node e2e/bob-connector.mjs <app executable> [server url]
 *
 * Checks: the row starts unset; an http address on another computer is
 * refused; the local server connects without sign-in; the chat-scripts switch
 * is off, turns on and is stored; Forget clears it. Exit 1 on any failure.
 */
import { _electron as electron } from 'playwright'
import fs from 'fs'
import os from 'os'
import path from 'path'

const exe = process.argv[2]
const serverUrl = process.argv[3] ?? 'http://127.0.0.1:3939/mcp'
if (!exe || !fs.existsSync(exe)) { console.error(`app not found: ${exe}`); process.exit(2) }
const OUT = path.resolve('e2e/shots-bob-connector')
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-bob-ud-'))
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-bob-ws-'))
fs.writeFileSync(path.join(WS, 'README.md'), '# Test workspace\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const failures = []
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what) }
const settings = () => {
  try { return JSON.parse(fs.readFileSync(path.join(UD, 'mcp-connector-settings.json'), 'utf-8')) } catch { return {} }
}

const app = await electron.launch({
  executablePath: exe,
  args: process.platform === 'linux' ? ['--no-sandbox'] : [],
  env: { ...process.env, WOS_USERDATA_DIR: UD, WORKSPACE_TEST_ROOT: WS, WOS_NO_TIDY: '1' },
})
try {
  const win = await app.firstWindow({ timeout: 90000 })
  await win.waitForSelector('#root', { timeout: 90000 })
  // The splash can come back after the first paint: dismiss it until it stays gone.
  const noSplash = async () => {
    let clear = 0
    for (let i = 0; i < 150 && clear < 6; i++) {
      if (await win.$('[class*="_splash_"]')) {
        clear = 0
        await win.keyboard.press('Enter').catch(() => {})
        await win.getByRole('button', { name: /^Enter$/ }).first().click({ timeout: 500 }).catch(() => {})
      } else clear++
      await sleep(300)
    }
  }
  await noSplash()
  const shot = (n) => win.screenshot({ path: path.join(OUT, `${n}.png`) })

  await win.evaluate(() => window.dispatchEvent(new CustomEvent('wos:open-rail', { detail: { rail: 'connectors' } })))
  const row = win.locator('[data-testid="connection-row"]').filter({ hasText: 'BOB skills' }).first()
  await row.waitFor({ timeout: 30000 })
  await noSplash()
  check((await row.getAttribute('data-status')) === 'setup', 'BOB skills starts as not set up')
  await shot('1-setup')

  await row.locator('button[aria-expanded]').click()
  const address = row.locator('[data-testid="connector-address"]')
  const connect = row.locator('[data-testid="connector-address-connect"]')

  await address.fill('http://example.com/mcp')
  await connect.click()
  await sleep(1500)
  check(/plain http only works for one on this computer/.test((await row.textContent()) ?? ''), 'plain http to another computer is refused')
  check(!settings().bob_skills, 'a refused address is not stored')

  await address.fill(serverUrl)
  await connect.click()
  for (let i = 0; i < 60 && (await row.getAttribute('data-status')) !== 'connected'; i++) await sleep(500)
  check((await row.getAttribute('data-status')) === 'connected', 'the local skills server connects')
  check(settings().bob_skills?.url === serverUrl && settings().bob_skills?.auth === 'none', 'stored as an address without sign-in')
  await shot('2-connected')

  if (!(await row.locator('[data-testid="connector-chat-scripts"]').count())) await row.locator('button[aria-expanded]').click()
  const box = row.locator('[data-testid="connector-chat-scripts"]')
  check((await box.count()) === 1 && !(await box.isChecked()), 'chat scripts switch is there and off')
  await box.click()
  for (let i = 0; i < 40 && settings().bob_skills?.chatScripts !== true; i++) await sleep(300)
  check(await box.isChecked(), 'the switch shows as on')
  check(settings().bob_skills?.chatScripts === true, 'switching chat scripts on is stored')
  await shot('3-scripts-on')

  await row.locator('[data-testid="connection-signout"]').click()
  for (let i = 0; i < 20 && (await row.getAttribute('data-status')) !== 'setup'; i++) await sleep(300)
  check((await row.getAttribute('data-status')) === 'setup' && !settings().bob_skills, 'Forget and turn off clears the address')
  await shot('4-forgotten')
} catch (err) {
  failures.push(String(err))
  console.error(err)
} finally {
  await app.close().catch(() => {})
}
console.log(failures.length ? `${failures.length} check(s) failed` : 'all checks passed')
process.exit(failures.length ? 1 : 0)
