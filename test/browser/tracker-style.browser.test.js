'use strict';
/*
 * Tracker fixes drawn hollow, AIS fixes solid, in headless Chromium against the plugin
 * replaying the Tollgate Islands Race 2026 two hours in: AIS simulated from the YB fixes,
 * and the same fixes as a recorded race (already picked). A new nemesis's history shows
 * within seconds, not at the next full resync.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const {startDevServer} = require('../sim/dev-server');
const {tmpdir} = require('../sim/tmpdir');
const {PUT_PATHS} = require('../../index');
const {recordedId} = require('../../lib/recorded-race');
const {handicapFeed} = require('../sim/cyca-sim');

const POLL = 300;
const SHOT_DIR = process.env.SHOT_DIR;
const TABLET = {viewport: {width: 1024, height: 768}, hasTouch: true};

let browser;
let srv;

test.before(async () => {
    browser = await chromium.launch();
    const dataDir = tmpdir();
    fs.writeFileSync(
        path.join(dataDir, 'cyca-state.json'),
        JSON.stringify({version: 1, raceId: recordedId('tollgate'), links: {}})
    );
    srv = await startDevServer({
        hoursIn: 2,
        replayOpts: {
            race: 'tollgate2026',
            recorded: 'tollgate',
            dataDir,
            selfName: 'Kanreki',
            wind: true,
            fetch: handicapFeed() // the recorded race's real one (198): its IRC TCFs
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
    const ctx = await browser.newContext(TABLET);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(srv.url + '?poll=' + POLL);
    await page.locator('#conn', {hasText: 'live'}).waitFor();
    await page.selectOption('#showSel', 'all');

    await page.click('#tabbar button[data-tab="geo"]');
    await page.locator('#mapLine .trkkey').waitFor();
    // A tracker boat only has its live fix until it is a nemesis; then the plugin fills in
    // its history (Ragtime's entry is 19066), and the page shows it within a few polls.
    assert.equal(await page.locator('#mapcontent circle[r="3"]').count(), 0, 'no tracker history yet');
    assert.equal((await srv.app.put(PUT_PATHS.setNemesis, {id: 'cyca:19066', nemesis: true})).status, 200);
    const t0 = Date.now();
    await page.locator('#mapcontent circle[r="3"]').first().waitFor({state: 'attached', timeout: 5000});
    const quick = Date.now() - t0;
    assert.ok(quick < 3000, `history shown after ${quick} ms`);
    const [solidHulls, hollowHulls] = await kinds(page, '#mapcontent polygon');
    assert.ok(hollowHulls >= 15, `tracker hulls hollow: ${hollowHulls}`);
    assert.ok(solidHulls >= 15, `AIS hulls solid: ${solidHulls}`);
    const [solidDots, hollowDots] = await kinds(page, '#mapcontent circle[r="2.2"], #mapcontent circle[r="3"]');
    // Ragtime's slots over the period before its live one.
    assert.ok(solidDots > 100 && hollowDots >= 3, `dots ${solidDots} solid, ${hollowDots} rings`);
    assert.match(await page.textContent('#mapLine'), /tracker \(YB\)/);
    if (SHOT_DIR) await page.screenshot({path: path.join(SHOT_DIR, 'tracker-geo.png')});

    // Boats strip charts: a small dot per report, solid for AIS, a ring for the tracker.
    await page.selectOption('#upSel', 'upwind'); // the replay has our wind, and no waypoint
    await page.click('#tabbar button[data-tab="boats"]');
    await page.locator('#blist .spk .fx.trk').first().waitFor({state: 'attached'});
    const ais = await page.locator('#blist .spk .fx.ais').count();
    const trk = await page.locator('#blist .spk .fx.trk').count();
    assert.ok(ais > 50 && trk >= 3, `strip chart dots: ${ais} AIS, ${trk} tracker`);
    if (SHOT_DIR) await page.screenshot({path: path.join(SHOT_DIR, 'tracker-boats.png')});

    await page.click('#tabbar button[data-tab="vectors"]');
    await page.locator('#scaleLine .trkkey').waitFor();
    const [solidV, hollowV] = await kinds(page, '#polar polygon');
    assert.ok(hollowV >= 15 && solidV >= 15, `vectors: ${solidV} solid, ${hollowV} hollow`);
    if (SHOT_DIR) await page.screenshot({path: path.join(SHOT_DIR, 'tracker-vectors.png')});
    assert.deepEqual(errors, []);
    await ctx.close();
});

test('Show AIS in range: boats with a recent AIS report, not tracker only boats', async () => {
    const ctx = await browser.newContext(TABLET);
    const page = await ctx.newPage();
    await page.goto(srv.url + '?poll=' + POLL);
    await page.locator('#conn', {hasText: 'live'}).waitFor();
    const ids = () => page.$$eval('#blist .brow[data-id]', (els) => els.map((e) => e.dataset.id));
    await page.selectOption('#showSel', 'all');
    await page.locator('#blist .brow[data-id^="cyca:"]').first().waitFor();
    const all = await ids();
    await page.selectOption('#showSel', 'inrange');
    assert.equal(await page.locator('#showSel option:checked').textContent(), 'AIS in range');
    const shown = await ids();
    assert.deepEqual(
        shown.filter((id) => id.startsWith('cyca:')),
        [],
        'no tracker only boat'
    );
    assert.ok(shown.length > 5 && shown.length < all.length, `${shown.length} of ${all.length}`);
    await ctx.close();
});

test('Show Nemeses: our track drawn only at the nemeses report times, the maths on the whole track', async () => {
    const ctx = await browser.newContext(TABLET);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(srv.url + '?poll=' + POLL);
    await page.locator('#conn', {hasText: 'live'}).waitFor();
    assert.equal((await srv.app.put(PUT_PATHS.setNemesis, {id: '503098600', nemesis: true})).status, 200);
    await page.selectOption('#showSel', 'nemeses');
    await page.click('#tabbar button[data-tab="vectors"]');
    await page.waitForFunction(() => {
        const v = ND.view;
        const b = v && v.visible.find((x) => x.id === '503098600');
        return b && b.series.length > 10;
    });
    const r = await page.evaluate(() => {
        const v = ND.view;
        const nem = new Set(v.visible.filter((b) => !b.isUs).flatMap((b) => b.series.map((x) => x.t)));
        const us = v.all[0].series;
        return {
            drawn: us.length,
            whole: v.usSeries.length,
            extra: us.slice(0, -1).filter((u) => !nem.has(u.t)).length,
            latest: us.at(-1).t === v.usSeries.at(-1).t,
            // Our newest hull a polygon, the older ones subpaths of one path per age step.
            hulls:
                document.querySelectorAll('#polar polygon[fill="#1a2a3a"]').length +
                [...document.querySelectorAll('#polar path[fill="#1a2a3a"]')].reduce(
                    (n, e) => n + (e.getAttribute('d').match(/Z/g) || []).length,
                    0
                ),
            inWin: ND.inWindow(us, v).length
        };
    });
    assert.equal(r.extra, 0, 'no sample of ours away from a nemesis report');
    assert.ok(r.drawn > 10 && r.drawn < r.whole / 2, `${r.drawn} of ${r.whole} drawn`);
    assert.ok(r.latest, 'our latest kept');
    // Every one drawn on Vectors, not thinned to one per 2 minutes.
    assert.equal(r.hulls, r.inWin);
    // Show All: our whole track again.
    await page.selectOption('#showSel', 'all');
    await page.waitForFunction(() => ND.view.all[0].series.length === ND.view.usSeries.length);
    assert.deepEqual(errors, []);
    await ctx.close();
});

test('Vectors, Up = COG, Absolute: our newest hull is on the vertical axis', async () => {
    const ctx = await browser.newContext(TABLET);
    const page = await ctx.newPage();
    await page.goto(srv.url + '?poll=' + POLL);
    await page.locator('#conn', {hasText: 'live'}).waitFor();
    await page.selectOption('#upSel', 'cog');
    await page.selectOption('#modeSel', 'abs');
    await page.click('#tabbar button[data-tab="vectors"]');
    await page.locator('#polar text', {hasText: 'US'}).waitFor();
    // Our instruments keep going, COG swinging 20 degrees, as on a live server: each fetch
    // of the snapshot and of the tracks sees a different latest sample.
    const {toDelta} = require('../sim/ais-sim');
    const last = srv.sim.own.at(-1);
    let n = 0;
    const feed = setInterval(() => {
        n++;
        const t = Date.now();
        srv.app.deliver(toDelta(srv.app.selfContext, {...last, t, cogRad: last.cogRad + (n % 2 ? 0.35 : -0.35)}));
    }, 150);
    try {
        await page.waitForTimeout(1500);
        for (let i = 0; i < 6; i++) {
            const off = await page.evaluate(() => {
                const axis = document.querySelector('#polar line[stroke="#8ea3bc"]');
                const us = [...document.querySelectorAll('#polar text')].find((t) => t.textContent === 'US');
                return Number(us.getAttribute('x')) - Number(axis.getAttribute('x1'));
            });
            assert.ok(Math.abs(off) < 0.2, `US ${off.toFixed(1)} px off the axis`);
            await page.waitForTimeout(POLL * 2);
        }
    } finally {
        clearInterval(feed);
        await ctx.close();
    }
});

test('TCF tab: IRC TCFs from CYCA, confirmed, set on our boat and the fleet', async () => {
    const ctx = await browser.newContext(TABLET);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(srv.url + '?poll=' + POLL);
    await page.locator('#conn', {hasText: 'live'}).waitFor();
    await page.selectOption('#showSel', 'all');
    await page.click('#tabbar button[data-tab="tcf"]');
    const btn = page.locator('#tcfCyca');
    await btn.waitFor({state: 'visible'});
    const asked = [];
    page.once('dialog', (d) => {
        asked.push(d.message());
        d.accept();
    });
    await btn.click();
    const tcf = (id) => page.locator(`#tcflist .tcfin[data-id="${id}"]`).inputValue();
    await page.waitForFunction(() => document.querySelector('#tcflist .tcfin[data-id="self"]')?.value === '1.107');
    assert.match(asked[0], /^Set 23 IRC TCFs from the CYCA results\? \d+ change\./);
    assert.match(asked[0], /Ours \(Kanreki\): 1\.000 → 1\.107\./);
    assert.equal(await tcf('cyca:19079'), '1.369', 'Smuggler, on its CYCA boat');
    assert.equal(await tcf('500019102'), '1.264', 'BACK 2 BLACK, on its AIS boat of the same name');
    assert.equal(await tcf('503098600'), '1.095', 'Ragtime, on its AIS boat (named Ragtime)');
    if (SHOT_DIR) await page.screenshot({path: path.join(SHOT_DIR, 'tcf-cyca.png')});
    // Off when no CYCA race is picked.
    assert.equal((await srv.app.put(PUT_PATHS.setCycaRace, {raceId: null})).status, 200);
    await btn.waitFor({state: 'hidden'});
    assert.deepEqual(errors, []);
    await ctx.close();
});
