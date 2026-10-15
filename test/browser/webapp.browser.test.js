'use strict'
/*
 * Webapp checks in real headless Chromium (Playwright), against the plugin
 * running on replayed GC2026 AIS data behind a stand-in HTTP server.
 *
 * Screenshots go to $SHOT_DIR when set, for eyeballing layout.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { chromium } = require('playwright')
const { startDevServer } = require('../sim/dev-server')

const POLL = 300
const SHOT_DIR = process.env.SHOT_DIR

let browser
let srv

test.before(async () => {
  browser = await chromium.launch()
  srv = await startDevServer({ hoursIn: 6 })
})
test.after(async () => {
  await browser?.close()
  await srv?.close()
})

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
const TABLET = { viewport: { width: 1024, height: 768 }, hasTouch: true }

async function open (device) {
  const ctx = await browser.newContext(device)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(srv.url + '?poll=' + POLL)
  await page.locator('#conn', { hasText: 'live' }).waitFor()
  return { ctx, page, errors }
}

async function shot (page, name) {
  if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, name + '.png') })
}

/** Layout invariants that must hold at every width. */
async function assertLayout (page) {
  const m = await page.evaluate(() => {
    const vw = window.innerWidth
    const rect = (sel) => document.querySelector(sel).getBoundingClientRect()
    const tabs = [...document.querySelectorAll('#tabbar button')].map((b) => b.getBoundingClientRect())
    return {
      vw,
      vh: window.innerHeight,
      scrollW: document.scrollingElement.scrollWidth,
      docH: document.scrollingElement.scrollHeight,
      tabs: tabs.map((r) => ({ l: r.left, r: r.right, h: r.height })),
      stage: rect('.stage')
    }
  })
  assert.ok(m.scrollW <= m.vw, `no horizontal page scroll (${m.scrollW} > ${m.vw})`)
  assert.ok(m.docH <= m.vh + 1, `page itself does not scroll vertically (${m.docH} > ${m.vh})`)
  assert.equal(m.tabs.length, 4)
  for (const t of m.tabs) {
    assert.ok(t.l >= 0 && t.r <= m.vw, 'tab inside viewport')
    assert.ok(t.h >= 30, `tab tall enough to tap (${t.h}px)`)
  }
  assert.ok(m.stage.height > m.vh * 0.4, `stage gets most of the height (${m.stage.height}px)`)
}

test('phone: loads live data, shows the fleet, layout fits', async () => {
  const { ctx, page, errors } = await open(PHONE)
  await page.selectOption('#showSel', 'all')
  const rows = page.locator('#blist .brow[data-id]')
  await rows.first().waitFor()
  const n = await rows.count()
  assert.ok(n > 3, `fleet rows ${n}`)
  assert.equal(await page.locator('#blist .brow.us').count(), 1, 'our own row')
  assert.match(await page.locator('#fleetCount').textContent(), new RegExp(`^${n}/${n}$`))
  // Values reach the UI converted from SI: range in nm, SOG in kn, COG in degrees.
  const first = await rows.first().textContent()
  assert.match(first, /\d+\.\d nm/)
  assert.match(first, /\d+\.\d kn\s+\d+°/)
  await assertLayout(page)
  await shot(page, 'phone-all')
  assert.deepEqual(errors, [])
  await ctx.close()
})

test('tablet: layout fits', async () => {
  const { ctx, page, errors } = await open(TABLET)
  await page.selectOption('#showSel', 'all')
  await page.locator('#blist .brow[data-id]').first().waitFor()
  await assertLayout(page)
  await shot(page, 'tablet-all')
  assert.deepEqual(errors, [])
  await ctx.close()
})

test('tapping the nemesis button persists on the server and survives reload', async () => {
  const { ctx, page } = await open(PHONE)
  await page.selectOption('#showSel', 'all')
  const row = page.locator('#blist .brow[data-id]').first()
  await row.waitFor()
  const id = await row.getAttribute('data-id')
  await row.locator('.nem').tap()
  await page.locator(`#blist .brow[data-id="${id}"] .nem.on`).waitFor()
  await waitFor(async () => (await srvUser()).nemesis.includes(id), 'server recorded nemesis')

  await page.reload()
  await page.locator('#conn', { hasText: 'live' }).waitFor()
  // Show filter was remembered (localStorage) and the default Nemesi view lists the boat.
  await page.selectOption('#showSel', 'nemesi')
  await page.locator(`#blist .brow[data-id="${id}"] .nem.on`).waitFor()
  assert.equal(await page.locator('#blist .brow[data-id]').count(), 1)
  await shot(page, 'phone-nemesi')

  // Untoggle so other tests start clean.
  await page.locator(`#blist .brow[data-id="${id}"] .nem`).tap()
  await waitFor(async () => !(await srvUser()).nemesis.includes(id), 'server cleared nemesis')
  await ctx.close()
})

test('list scroll position survives re-renders from polling', async () => {
  const { ctx, page } = await open({ ...PHONE, viewport: { width: 390, height: 500 } })
  await page.selectOption('#showSel', 'all')
  await page.locator('#blist .brow[data-id]').first().waitFor()
  const scrollable = await page.$eval('#blist', (el) => el.scrollHeight > el.clientHeight + 50)
  assert.ok(scrollable, 'list is long enough to scroll at this height')
  // Tag the current row nodes; a re-render replaces them.
  await page.$eval('#blist', (el) => { el.scrollTop = 120; el.querySelector('.brow[data-id]').dataset.old = '1' })
  await page.waitForTimeout(POLL * 4) // several polls and re-renders
  assert.equal(await page.locator('#blist [data-old]').count(), 0, 'list was re-rendered')
  assert.equal(await page.$eval('#blist', (el) => el.scrollTop), 120)
  await ctx.close()
})

test('server outage shows stale, keeps last data, and recovers', async () => {
  const { ctx, page } = await open(PHONE)
  await page.selectOption('#showSel', 'all')
  await page.locator('#blist .brow[data-id]').first().waitFor()
  const before = await page.locator('#blist .brow[data-id]').count()

  srv.setDown(true)
  await page.locator('#conn', { hasText: 'stale' }).waitFor()
  assert.equal(await page.locator('#blist .brow[data-id]').count(), before, 'last data still shown')
  await shot(page, 'phone-stale')

  srv.setDown(false)
  // Backoff is short with a 300 ms poll, so recovery is quick.
  await page.locator('#conn', { hasText: 'live' }).waitFor({ timeout: 10000 })
  await ctx.close()
})

/** User state read through the plugin's own REST handler, as the webapp would. */
async function srvUser () { return (await srv.app.call('GET', '/user')).body }

async function waitFor (cond, what, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await cond()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.fail('timed out waiting for ' + what)
}
