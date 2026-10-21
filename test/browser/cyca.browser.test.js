'use strict';
/*
 * The CYCA tab in headless Chromium against the plugin replaying GC2026 at 24 h,
 * with the fake CYCA feed (test/sim/cyca-sim.js): race picker, the badge, linking
 * from a suggested chip, unlink, No AIS, persistence across reload, and phone layout.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {chromium} = require('playwright');
const {startDevServer} = require('../sim/dev-server');
const {cycaFeed} = require('../sim/cyca-sim');
const {tmpdir} = require('../sim/tmpdir');

const POLL = 300;
const SHOT_DIR = process.env.SHOT_DIR;
const PHONE = {viewport: {width: 360, height: 740}, hasTouch: true, isMobile: true, deviceScaleFactor: 2};
const TABLET = {viewport: {width: 1024, height: 768}, hasTouch: true};

let browser;
let srv;

test.before(async () => {
    browser = await chromium.launch();
    srv = await startDevServer({
        hoursIn: 24,
        replayOpts: {
            dataDir: tmpdir(),
            selfName: 'Kanreki',
            fetchFor: (shiftMs) => cycaFeed({shiftMs, clock: Date.now})
        }
    });
});
test.after(async () => {
    await browser?.close();
    await srv?.close();
});

async function open(device) {
    const ctx = await browser.newContext(device);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(srv.url + '?poll=' + POLL);
    await page.locator('#conn', {hasText: 'live'}).waitFor();
    return {ctx, page, errors};
}

async function shot(page, name) {
    if (SHOT_DIR) await page.screenshot({path: path.join(SHOT_DIR, name + '.png')});
}

async function layoutOk(page) {
    const m = await page.evaluate(() => ({
        vw: innerWidth,
        sw: document.scrollingElement.scrollWidth,
        tabs: [...document.querySelectorAll('#tabbar button')].map((b) => [
            b.textContent,
            b.scrollWidth,
            b.clientWidth
        ]),
        rows: [...document.querySelectorAll('#cycalist .crow')].map((r) => r.getBoundingClientRect().right)
    }));
    assert.ok(m.sw <= m.vw, `no horizontal page scroll (${m.sw} > ${m.vw})`);
    for (const [name, sw, cw] of m.tabs) assert.ok(sw <= cw, `tab ${name} fits (${sw} > ${cw})`);
    for (const right of m.rows) assert.ok(right <= m.vw + 0.5, `row inside the viewport (${right})`);
}

test('pick the race, link from a suggestion, unlink, No AIS; state survives reload', async () => {
    const {ctx, page, errors} = await open(TABLET);
    const badge = page.locator('#tabbar button[data-tab="cyca"]');
    assert.equal(await badge.evaluate((b) => b.classList.contains('attn')), false, 'no badge with no race');
    await badge.click();
    await page.locator('#cycaRace option', {hasText: 'we are entered'}).waitFor({state: 'attached'});
    assert.match(await page.textContent('#cycaStatus'), /Pick the race/);
    // On a wide screen the race picker is as wide as its names, Refresh straight after.
    const [s, b] = [await page.locator('#cycaRace').boundingBox(), await page.locator('#cycaRefresh').boundingBox()];
    assert.ok(s.width < 500, `race picker not stretched: ${s.width}px`);
    assert.ok(b.x - (s.x + s.width) < 12 && Math.abs(b.y - s.y) < 10, 'Refresh right after the picker');
    await page.selectOption('#cycaRace', '194');
    await page.locator('#cycaStatus', {hasText: 'last fetch'}).waitFor();
    // AIS names equal CYCA names in the replay: boats heard on AIS get a suggestion.
    await page.locator('#tabbar button.attn[data-tab="cyca"]').waitFor();
    const first = page.locator('#cycalist .crow.attn').first();
    const name = await first.locator('.cname b').textContent();
    await shot(page, 'cyca-tablet');
    await first.locator('button.cand.rec').first().click();
    const row = page.locator('#cycalist .crow', {has: page.locator('.cname b', {hasText: name})});
    await row.locator('.linked').waitFor();
    assert.match(await row.locator('.linked').textContent(), new RegExp(name));

    // Survives a reload: the plugin holds the race and the link.
    await page.reload();
    await page.locator('#conn', {hasText: 'live'}).waitFor();
    await row.locator('.linked').waitFor();
    assert.equal(await page.inputValue('#cycaRace'), '194');

    await row.locator('button[data-act="unlink"]').click();
    await row.locator('button.cand').first().waitFor();
    await row.locator('button[data-act="noais"]').click();
    await row.locator('.noais').waitFor();
    assert.equal(await row.evaluate((r) => r.classList.contains('attn')), false);
    await row.locator('button[data-act="noais"]').click();
    await row.locator('button.cand').first().waitFor();
    assert.deepEqual(errors, []);
    await ctx.close();
});

test('phone: the tab bar and the table fit, and an open pick list is not rebuilt', async () => {
    const {ctx, page, errors} = await open(PHONE);
    await page.click('#tabbar button[data-tab="cyca"]');
    await page.locator('#cycalist .crow').first().waitFor();
    await layoutOk(page);
    await shot(page, 'cyca-phone');
    const pick = page.locator('#cycalist select.pick').first();
    await pick.focus();
    await pick.evaluate((s) => (s.dataset.mark = 'kept'));
    await page.waitForTimeout(POLL * 3 * 2 + 500); // two tab refreshes
    assert.equal(await page.locator('#cycalist select.pick[data-mark="kept"]').count(), 1, 'focused select kept');
    assert.deepEqual(errors, []);
    await ctx.close();
});

test('Link all links every clear suggestion and clears the badge; our own entry is not listed', async () => {
    const {ctx, page, errors} = await open(TABLET);
    await page.click('#tabbar button[data-tab="cyca"]');
    const all = page.locator('#cycaLinkAll');
    await all.waitFor();
    const n = Number((await all.textContent()).match(/\d+/)[0]);
    assert.ok(n > 20, `${n} suggested`);
    await all.click();
    await page.locator('#cycaStatus', {hasText: `${n} linked`}).waitFor();
    assert.equal(await all.isHidden(), true);
    await page.locator('#tabbar button[data-tab="cyca"]:not(.attn)').waitFor();
    // Ambiguous rows (no clear winner) may remain; every clear one is linked.
    assert.equal(await page.locator('#cycalist .crow.attn button.cand.rec').count(), 0);
    await shot(page, 'cyca-linked');
    assert.equal(await page.locator('#cycalist .cname b', {hasText: /^Kanreki$/}).count(), 0);
    // Linked boats show as their AIS boats: no cyca: ids left for them in the snapshot.
    const snap = await page.evaluate(() => fetch('/signalk/v1/api/nemesis/snapshot').then((r) => r.json()));
    assert.equal(snap.boats.filter((b) => b.cycaId && !b.id.startsWith('cyca:')).length, n);
    assert.deepEqual(errors, []);
    await ctx.close();
});
