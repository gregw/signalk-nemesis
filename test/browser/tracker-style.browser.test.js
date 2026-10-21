'use strict';
/*
 * Tracker fixes drawn hollow, AIS fixes solid, in headless Chromium against the plugin
 * replaying the Tollgate Islands Race 2026 two hours in: AIS simulated from the YB fixes,
 * and the same fixes as the CYCA tracker feed (race 198 already picked).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const {startDevServer} = require('../sim/dev-server');
const {cycaFeed} = require('../sim/cyca-sim');
const {tmpdir} = require('../sim/tmpdir');
const {PUT_PATHS} = require('../../index');

const POLL = 300;
const SHOT_DIR = process.env.SHOT_DIR;
const TABLET = {viewport: {width: 1024, height: 768}, hasTouch: true};

let browser;
let srv;

test.before(async () => {
    browser = await chromium.launch();
    const dataDir = tmpdir();
    fs.writeFileSync(path.join(dataDir, 'cyca-state.json'), JSON.stringify({version: 1, raceId: 198, links: {}}));
    srv = await startDevServer({
        hoursIn: 2,
        replayOpts: {
            race: 'tollgate2026',
            dataDir,
            selfName: 'Kanreki',
            wind: true,
            fetchFor: (shiftMs, tracker) => cycaFeed({shiftMs, clock: Date.now, data: tracker})
        }
    });
});
test.after(async () => {
    await browser?.close();
    await srv?.close();
});

/** The fills of the drawn hulls and dots, by kind: [solid, hollow] counts. */
function kinds(page, sel) {
    return page.evaluate((sel) => {
        const els = [...document.querySelectorAll(sel)];
        const hollow = els.filter((e) => e.getAttribute('fill') === '#fff').length;
        return [els.length - hollow, hollow];
    }, sel);
}

test('Geo and Vectors: tracker boats hollow with a key, AIS boats solid', async () => {
    // A tracker boat only has its live fix until it is a nemesis, then it is backfilled
    // over the period (Ragtime's CYCA entry is 19066). Before the page loads its tracks.
    assert.equal((await srv.app.put(PUT_PATHS.setNemesis, {id: 'cyca:19066', nemesis: true})).status, 200);
    const tracks = () =>
        srv.app.call('GET', '/signalk/v1/api/nemesis/tracks', {query: {periodS: '3600', ids: 'cyca:19066'}});
    for (let i = 0; i < 100 && ((await tracks()).body.boats['cyca:19066'] || []).length < 3; i++)
        await new Promise((r) => setTimeout(r, 50));
    const ctx = await browser.newContext(TABLET);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(srv.url + '?poll=' + POLL);
    await page.locator('#conn', {hasText: 'live'}).waitFor();
    await page.selectOption('#showSel', 'all');

    await page.click('#tabbar button[data-tab="geo"]');
    await page.locator('#mapLine .trkkey').waitFor();
    const [solidHulls, hollowHulls] = await kinds(page, '#mapcontent polygon');
    assert.ok(hollowHulls >= 15, `tracker hulls hollow: ${hollowHulls}`);
    assert.ok(solidHulls >= 15, `AIS hulls solid: ${solidHulls}`);
    const [solidDots, hollowDots] = await kinds(page, '#mapcontent circle[r="2.2"], #mapcontent circle[r="3"]');
    // Ragtime's slots over the period before its live one.
    assert.ok(solidDots > 100 && hollowDots >= 3, `dots ${solidDots} solid, ${hollowDots} rings`);
    assert.match(await page.textContent('#mapLine'), /tracker \(YB\)/);
    if (SHOT_DIR) await page.screenshot({path: path.join(SHOT_DIR, 'tracker-geo.png')});

    await page.click('#tabbar button[data-tab="vectors"]');
    await page.locator('#scaleLine .trkkey').waitFor();
    const [solidV, hollowV] = await kinds(page, '#polar polygon');
    assert.ok(hollowV >= 15 && solidV >= 15, `vectors: ${solidV} solid, ${hollowV} hollow`);
    if (SHOT_DIR) await page.screenshot({path: path.join(SHOT_DIR, 'tracker-vectors.png')});
    assert.deepEqual(errors, []);
    await ctx.close();
});
