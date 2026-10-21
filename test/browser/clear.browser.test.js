'use strict';
/*
 * Clear history (Time popup) and Unlink all (CYCA tab) in headless Chromium, on the
 * Tollgate 2026 replay with links left from another race.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const {startDevServer} = require('../sim/dev-server');
const {tmpdir} = require('../sim/tmpdir');
const {recordedId} = require('../../lib/recorded-race');

const POLL = 300;
const TABLET = {viewport: {width: 1024, height: 768}, hasTouch: true};
let browser;
let srv;
let dataDir;

test.before(async () => {
    browser = await chromium.launch();
    dataDir = tmpdir();
    const links = {supernova: '500018891', ragtime: '500018865'};
    fs.writeFileSync(
        path.join(dataDir, 'cyca-state.json'),
        JSON.stringify({version: 1, raceId: recordedId('tollgate'), links})
    );
    srv = await startDevServer({
        hoursIn: 2,
        replayOpts: {race: 'tollgate2026', recorded: 'tollgate', dataDir, selfName: 'Kanreki'}
    });
});
test.after(async () => {
    await browser?.close();
    await srv?.close();
});

test('Clear history empties the boats after a confirm; Unlink all removes the old links', async () => {
    const ctx = await browser.newContext(TABLET);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const dialogs = [];
    page.on('dialog', (d) => {
        dialogs.push(d.message());
        d.accept();
    });
    await page.goto(srv.url + '?poll=' + POLL);
    await page.locator('#conn', {hasText: 'live'}).waitFor();
    await page.selectOption('#showSel', 'all');
    const count = async () => Number((await page.textContent('#fleetCount')).split('/')[1]);
    await page.waitForFunction(() => /\/\s*[1-9]/.test(document.querySelector('#fleetCount')?.textContent || ''));
    assert.ok((await count()) > 20);

    await page.click('#timeBtn');
    await page.click('#clearHist');
    // Only us left in the count.
    await page.waitForFunction(() => /\/\s*1\b/.test(document.querySelector('#fleetCount').textContent));
    assert.match(dialogs[0], /Clear all track history/);
    assert.deepEqual(
        fs.readdirSync(path.join(dataDir, 'journal')).filter((f) => /^seg-/.test(f)),
        [],
        'journal cleared'
    );

    await page.click('body', {position: {x: 5, y: 700}}); // close the popup
    // Clear all TCFs: shown once a TCF is set.
    await page.click('#tabbar button[data-tab="tcf"]');
    const clr = page.locator('#tcfClearAll');
    assert.equal(await clr.isVisible(), false, 'no TCFs set');
    await srv.app.put('navigation.racing.nemesis.setTcf', {id: 'self', tcf: 1.02});
    await clr.waitFor();
    await clr.click();
    await clr.waitFor({state: 'hidden'});
    assert.match(dialogs[1], /every TCF back to 1.000/);

    await page.click('#tabbar button[data-tab="cyca"]');
    const un = page.locator('#cycaUnlinkAll');
    await un.waitFor();
    assert.equal((await un.textContent()).trim(), 'Unlink all 2');
    await un.click();
    await un.waitFor({state: 'hidden'});
    assert.match(dialogs[2], /Remove every CYCA link/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'cyca-state.json'), 'utf8')).links, {});
    assert.deepEqual(errors, []);
    await ctx.close();
});
