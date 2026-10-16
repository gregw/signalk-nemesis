'use strict';
/*
 * The four tabs in real headless Chromium (Playwright) against the plugin running on
 * replayed GC2026 AIS data: rendering, the sign convention, TCF entry, the start time
 * override, selection popups, map gestures (pinch via CDP touch events) and the time
 * window. Screenshots go to $SHOT_DIR when set.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {chromium} = require('playwright');
const {startDevServer} = require('../sim/dev-server');

const POLL = 300;
const SHOT_DIR = process.env.SHOT_DIR;
const PHONE = {viewport: {width: 390, height: 844}, hasTouch: true, isMobile: true, deviceScaleFactor: 2};
const TABLET = {viewport: {width: 1024, height: 768}, hasTouch: true};

let browser;
let srv;

test.before(async () => {
    browser = await chromium.launch();
    // One boat entered in advance under another name (AIS name Ambition).
    // Named waypoints: "Mark A" exists, "Gone" is configured but not in the resources.
    srv = await startDevServer({
        hoursIn: 6,
        config: {
            boats: [{mmsi: '500018921', name: 'Nemo'}],
            waypointNames: ['Mark A', 'Gone', 'Cape Byron Lighthouse Northern Approach']
        },
        resources: {
            waypoints: {
                m1: {
                    name: 'Mark A',
                    feature: {type: 'Feature', geometry: {type: 'Point', coordinates: [153.2, -32.6]}}
                },
                m2: {
                    name: 'Cape Byron Lighthouse Northern Approach',
                    feature: {type: 'Feature', geometry: {type: 'Point', coordinates: [153.64, -28.6]}}
                }
            }
        }
    });
});
test.after(async () => {
    await browser?.close();
    await srv?.close();
});

async function open(device, show = 'all') {
    const ctx = await browser.newContext(device);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(srv.url + '?poll=' + POLL);
    await page.locator('#conn', {hasText: 'live'}).waitFor();
    await page.selectOption('#showSel', show);
    return {ctx, page, errors};
}

async function tab(page, name) {
    await page.click(`#tabbar button[data-tab="${name}"]`);
    await page.waitForTimeout(POLL * 2);
}

async function shot(page, name) {
    if (SHOT_DIR) await page.screenshot({path: path.join(SHOT_DIR, name + '.png')});
}

async function noPageScroll(page) {
    const m = await page.evaluate(() => ({
        vw: innerWidth,
        vh: innerHeight,
        sw: document.scrollingElement.scrollWidth,
        sh: document.scrollingElement.scrollHeight
    }));
    assert.ok(m.sw <= m.vw, `no horizontal page scroll (${m.sw} > ${m.vw})`);
    assert.ok(m.sh <= m.vh + 1, `no vertical page scroll (${m.sh} > ${m.vh})`);
}

const num = (s) => Number(String(s).replace('−', '-').replace('+', ''));

test('every tab renders on phone and tablet, without errors or page scroll', async () => {
    for (const [name, dev] of [
        ['phone', PHONE],
        ['tablet', TABLET]
    ]) {
        const {ctx, page, errors} = await open(dev);
        await tab(page, 'boats');
        assert.ok((await page.locator('#blist .spk .dot').count()) > 5, 'strip chart dots');
        assert.ok((await page.locator('#blist .cv').count()) > 5, 'values over the latest dots');
        await noPageScroll(page);
        await shot(page, `${name}-boats`);
        await tab(page, 'vectors');
        assert.ok((await page.locator('#polar polygon').count()) > 10, 'hulls on the vector plot');
        assert.match(await page.locator('#modeLine').textContent(), /Absolute · waypoint up$/);
        await noPageScroll(page);
        await shot(page, `${name}-vectors`);
        await tab(page, 'tcf');
        assert.ok((await page.locator('#tcflist .tcfin').count()) > 10, 'TCF boxes');
        assert.ok((await page.locator('#tcflist .spk .dot').count()) > 10, 'Net strip charts');
        assert.match(await page.locator('#startVal').textContent(), /signalk-racer/);
        assert.match(await page.locator('#tcfMethod').textContent(), /VMG to the waypoint over 10 min · elapsed 6h0\d/);
        await noPageScroll(page);
        await shot(page, `${name}-tcf`);
        await tab(page, 'geo');
        assert.ok((await page.locator('#mapcontent polygon').count()) > 10, 'hulls on the map');
        await noPageScroll(page);
        await shot(page, `${name}-geo`);
        assert.deepEqual(errors, []);
        await ctx.close();
    }
});

test('sign convention: Boats lead chart agrees with TCF Actual (+ = they are ahead)', async () => {
    const {ctx, page} = await open(TABLET);
    await tab(page, 'boats');
    const leads = await page.$$eval('#blist .brow[data-id]:not(.us)', (rows) =>
        rows.map((r) => ({id: r.dataset.id, v: r.querySelectorAll('.chart')[1].querySelector('.cv')?.textContent}))
    );
    await tab(page, 'tcf');
    const actual = await page.$$eval('#tcflist .brow[data-id]:not(.us)', (rows) =>
        Object.fromEntries(rows.map((r) => [r.dataset.id, r.querySelectorAll('.tn')[1].textContent]))
    );
    let compared = 0;
    let ahead = 0;
    for (const l of leads) {
        if (l.v == null || actual[l.id] == null || actual[l.id] === '–') continue;
        const a = num(actual[l.id]);
        assert.ok(Math.abs(num(l.v) - a) <= 0.6, `${l.id}: lead ${l.v} vs actual ${actual[l.id]}`);
        if (a > 0.1) ahead++;
        compared++;
    }
    assert.ok(compared > 10, `compared ${compared}`);
    assert.ok(ahead > 0 && ahead < compared, 'some boats ahead, some behind');

    // The Net chart's latest value is Actual minus Should, with a TCF that makes Should matter.
    const id = leads.find((l) => l.v != null).id;
    await page.locator(`#tcflist .brow[data-id="${id}"] .tcfin`).fill('1.05');
    await page.keyboard.press('Enter');
    const row = page.locator(`#tcflist .brow[data-id="${id}"]`);
    await waitFor(async () => num(await row.locator('.tn').first().textContent()) > 1, 'Should after TCF set');
    const [should, act] = (await row.locator('.tn').allTextContents()).map(num);
    const net = num(await row.locator('.chart.net .cv').textContent());
    assert.ok(Math.abs(net - (act - should)) <= 0.15, `net ${net} = actual ${act} - should ${should}`);
    await page.locator(`#tcflist .brow[data-id="${id}"] .tcfin`).fill('1');
    await page.keyboard.press('Enter');
    await waitFor(async () => [undefined, 1].includes((await srvUser()).tcf[id]), 'TCF reset');
    await ctx.close();
});

test('TCF: typing is not re-rendered by polls; Enter saves on the server and sets Should', async () => {
    const {ctx, page} = await open(PHONE);
    await tab(page, 'tcf');
    const row = page.locator('#tcflist .brow[data-id]:not(.us)').first();
    const id = await row.getAttribute('data-id');
    const inp = row.locator('.tcfin');
    await inp.click();
    await inp.fill('1.1');
    await inp.evaluate((el) => (el.dataset.mark = '1'));
    await page.waitForTimeout(POLL * 4);
    assert.equal(await page.locator('#tcflist .tcfin[data-mark]').count(), 1, 'same input node while focused');
    assert.equal(await page.locator('#tcflist .tcfin[data-mark]').inputValue(), '1.1');
    await page.keyboard.press('Enter');
    await waitFor(async () => (await srvUser()).tcf[id] === 1.1, 'server saved TCF');
    const should = page.locator(`#tcflist .brow[data-id="${id}"] .tn`).first();
    await waitFor(async () => num(await should.textContent()) > 1, 'Should for a higher rated boat');
    await shot(page, 'phone-tcf-entry');
    // Back to the default so other tests are unaffected.
    await page.locator(`#tcflist .brow[data-id="${id}"] .tcfin`).fill('1');
    await page.keyboard.press('Enter');
    await waitFor(async () => (await srvUser()).tcf[id] == null || (await srvUser()).tcf[id] === 1, 'TCF reset');
    await ctx.close();
});

test('start time: Now sets the override, Clear goes back to signalk-racer', async () => {
    const {ctx, page} = await open(PHONE);
    await tab(page, 'tcf');
    await page.click('#startNow');
    await page.locator('#startVal', {hasText: 'set here'}).waitFor();
    assert.equal((await snapshot()).start.src, 'override');
    await page.click('#startClear');
    await page.locator('#startVal', {hasText: 'signalk-racer'}).waitFor();
    assert.equal((await snapshot()).start.src, 'racer');
    await ctx.close();
});

test('vectors: tapping a boat selects it, draws its velocity shafts, popup inside the viewport', async () => {
    const {ctx, page} = await open(PHONE);
    await tab(page, 'vectors');
    // The current hull furthest right and lowest, so the popup has to be clamped.
    const pt = await page.$$eval('#polar polygon[stroke="#fff"]', (ps) => {
        let best = null;
        for (const p of ps) {
            const r = p.getBoundingClientRect();
            const c = {x: r.left + r.width / 2, y: r.top + r.height / 2};
            if (!best || c.x + c.y > best.x + best.y) best = c;
        }
        return best;
    });
    await page.touchscreen.tap(pt.x, pt.y);
    await page.locator('#tip').waitFor({state: 'visible'});
    const tip = await page.locator('#tip').boundingBox();
    assert.ok(tip.x >= 0 && tip.y >= 0 && tip.x + tip.width <= 390 && tip.y + tip.height <= 844, 'tip in viewport');
    assert.match(await page.locator('#tip').textContent(), /SOG \d+\.\dkn/);
    assert.ok((await page.locator('#polar line[stroke-dasharray]').count()) > 0, 'velocity shafts');
    await shot(page, 'phone-vectors-selected');
    // Tapping empty space clears the selection.
    const box = await page.locator('#polar').boundingBox();
    await page.touchscreen.tap(box.x + 5, box.y + 5);
    await page.locator('#tip').waitFor({state: 'hidden'});
    assert.equal(await page.locator('#polar line[stroke-dasharray]').count(), 0);
    await ctx.close();
});

test('geo: pinch zooms about the fingers, drag pans, a gesture in Relative switches to Absolute', async () => {
    const {ctx, page, errors} = await open(PHONE);
    await tab(page, 'geo');
    const cdp = await ctx.newCDPSession(page);
    const touch = (type, pts) =>
        cdp.send('Input.dispatchTouchEvent', {type, touchPoints: pts.map(([x, y], id) => ({x, y, id}))});
    const box = await page.locator('#map').boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const state = () => page.evaluate(() => ND.tabs.geo.state());
    // World point under a client position, from the map state (inverse of the render).
    const worldAt = (s, x, y) => {
        const px = ((x - box.x) * s.W) / box.width - s.W / 2;
        const py = ((y - box.y) * s.H) / box.height - s.H / 2;
        const a = (s.rotDeg * Math.PI) / 180;
        const sc = 256 * 2 ** s.zoom;
        return [
            s.center.wx + (px * Math.cos(a) - py * Math.sin(a)) / sc,
            s.center.wy + (px * Math.sin(a) + py * Math.cos(a)) / sc
        ];
    };

    const s0 = await state();
    const mid = [cx + 30, cy - 40];
    const before = worldAt(s0, ...mid);
    await touch('touchStart', [
        [mid[0] - 40, mid[1]],
        [mid[0] + 40, mid[1]]
    ]);
    for (let k = 1; k <= 5; k++) {
        await touch('touchMove', [
            [mid[0] - 40 - 8 * k, mid[1]],
            [mid[0] + 40 + 8 * k, mid[1]]
        ]);
    }
    await touch('touchEnd', []);
    const s1 = await state();
    assert.ok(Math.abs(s1.zoom - s0.zoom - 1) < 0.01, `pinch doubled the spread: zoom ${s0.zoom} -> ${s1.zoom}`);
    const after = worldAt(s1, ...mid);
    const px = 256 * 2 ** s1.zoom;
    assert.ok(
        Math.hypot((after[0] - before[0]) * px, (after[1] - before[1]) * px) < 1,
        'point under the fingers stays put'
    );
    assert.equal(s1.follow, false, 'stops following us after a gesture');

    // Relative mode, then a one-finger drag: back to Absolute, and the map pans.
    await page.selectOption('#modeSel', 'rel');
    await page.waitForTimeout(POLL);
    const s2 = await state();
    await touch('touchStart', [[cx, cy]]);
    for (let k = 1; k <= 5; k++) await touch('touchMove', [[cx + 20 * k, cy + 10 * k]]);
    await touch('touchEnd', []);
    assert.equal(await page.locator('#modeSel').inputValue(), 'abs');
    const s3 = await state();
    assert.ok(s3.center.wx !== s2.center.wx || s3.center.wy !== s2.center.wy, 'panned');
    await shot(page, 'phone-geo-gestures');

    // Fit follows us again.
    await page.click('#fitBtn');
    assert.equal((await state()).follow, true);
    assert.deepEqual(errors, []);
    await ctx.close();
});

test('time popup: look back an hour, then back to live', async () => {
    const {ctx, page} = await open(TABLET);
    await tab(page, 'boats');
    await page.click('#timeBtn');
    await page.locator('#timepop').waitFor({state: 'visible'});
    for (let i = 0; i < 6; i++) await page.click('#backBtn');
    await page.locator('#timeBtnVal', {hasText: 'ago'}).waitFor();
    assert.match(await page.locator('#timeBtnVal').textContent(), /\+5h0\d · 1h0\d ago/);
    await waitFor(async () => (await page.evaluate(() => ND.model.tracksKey)).startsWith('at:'), 'history fetched');
    assert.ok((await page.locator('#blist .spk .dot').count()) > 5, 'charts drawn from history');
    await shot(page, 'tablet-history');
    await page.click('#liveBtn');
    await page.locator('#timeBtnVal', {hasText: /^\+6h00 · 60m$/}).waitFor();
    assert.equal(await page.evaluate(() => ND.model.viewT), null);
    await ctx.close();
});

test('relative mode: boats show deltas, vectors centre on us', async () => {
    const {ctx, page} = await open(TABLET);
    await page.selectOption('#modeSel', 'rel');
    await tab(page, 'boats');
    assert.match(await page.locator('#bhead').textContent(), /ΔSOG\/COG/);
    assert.match(await page.locator('#bhead').textContent(), /ΔVMG/);
    await tab(page, 'vectors');
    assert.match(await page.locator('#modeLine').textContent(), /Relative to us/);
    await shot(page, 'tablet-vectors-rel');
    await page.selectOption('#modeSel', 'abs');
    await ctx.close();
});

async function srvUser() {
    return (await srv.app.call('GET', '/signalk/v1/api/nemesis/user')).body;
}
async function snapshot() {
    return (await srv.app.call('GET', '/signalk/v1/api/nemesis/snapshot')).body;
}

async function waitFor(cond, what, timeoutMs = 4000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (await cond()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail('timed out waiting for ' + what);
}

test('configured boat: its configured name everywhere, the AIS name in the popup', async () => {
    const {ctx, page, errors} = await open(PHONE, 'nemesi');
    await tab(page, 'boats');
    const row = page.locator('#blist .brow[data-id="500018921"]');
    assert.equal((await row.locator('.bn').textContent()).trim(), 'Nemo');
    await row.locator('.bn').click();
    await page.locator('#tip').waitFor({state: 'visible'});
    assert.match(await page.locator('#tip').textContent(), /Nemo.*AIS: Ambition/);
    await tab(page, 'tcf');
    assert.equal((await page.locator('#tcflist .brow[data-id="500018921"] .bn').textContent()).trim(), 'Nemo');
    await shot(page, 'phone-configured');
    assert.deepEqual(errors, []);
    await ctx.close();
});

test('Up: a named waypoint picked by hand; one no longer found stays picked and shows no waypoint', async () => {
    const {ctx, page, errors} = await open(PHONE);
    const opts = await page.$$eval('#upSel option', (os) => os.map((o) => [o.value, o.textContent]));
    assert.deepEqual(
        opts.slice(-2).map((o) => o[0]),
        ['wpt:Mark A', 'wpt:Cape Byron Lighthouse Northern Approach'],
        'only those found are offered, in configured order'
    );
    await page.selectOption('#upSel', 'wpt:Cape Byron Lighthouse Northern Approach');
    await noPageScroll(page);
    const up = await page.locator('#upSel').boundingBox();
    assert.ok(up.x + up.width <= 390 - 16, `long name: Up control inside the bar (right edge ${up.x + up.width})`);
    await page.selectOption('#upSel', 'wpt:Mark A');
    await tab(page, 'vectors');
    assert.match(await page.locator('#modeLine').textContent(), /Absolute · Mark A up$/);
    await tab(page, 'boats');
    assert.doesNotMatch(await page.locator('#bhead').textContent(), /no waypoint/);
    assert.ok((await page.locator('#blist .spk .dot').count()) > 5, 'charts toward Mark A');
    await tab(page, 'geo');
    assert.ok(
        (await page.locator('#mapoverlay text, #mapcontent text', {hasText: 'Mark A'}).count()) > 0,
        'Mark A on the map'
    );
    await shot(page, 'phone-up-mark');

    // Picked on another visit, then removed from the server's waypoints.
    await page.evaluate(() => {
        const p = JSON.parse(localStorage.getItem('nd_prefs') || '{}');
        localStorage.setItem('nd_prefs', JSON.stringify({...p, up: 'wpt:Gone', tab: 'boats'}));
    });
    await page.reload();
    await page.locator('#conn', {hasText: 'live'}).waitFor();
    await page.waitForTimeout(POLL * 2);
    assert.equal(await page.locator('#upSel').inputValue(), 'wpt:Gone');
    assert.equal(await page.locator('#upSel option:checked').textContent(), 'WPT Gone (not found)');
    assert.match(await page.locator('#bhead').textContent(), /no waypoint/);
    assert.deepEqual(errors, []);
    await ctx.close();
});

test('Up = Course: each boat toward its own next mark of the named waypoints; COG and North kept', async () => {
    const {ctx, page, errors} = await open(PHONE);
    const opts = await page.$$eval('#upSel option', (os) => os.map((o) => o.value));
    assert.deepEqual(opts.slice(0, 5), ['waypoint', 'course', 'cog', 'north', 'wind']);
    await tab(page, 'boats');
    assert.equal(await page.locator('#blist .rd.nm').count(), 0, 'no next mark unless Up = Course');
    await page.selectOption('#upSel', 'course');
    await tab(page, 'vectors');
    // The course is Mark A then Cape Byron ("Gone" is configured but not found).
    assert.match(await page.locator('#modeLine').textContent(), /course → Mark A \(not found: Gone\) up$/);
    await tab(page, 'boats');
    const head = await page.locator('#bhead').textContent();
    assert.match(head, /VMG→crs/);
    assert.doesNotMatch(head, /no course/);
    assert.ok((await page.locator('#blist .spk .dot').count()) > 5, 'charts along the course');
    const nexts = await page.locator('#blist .brow[data-id] .rd.nm').allTextContents();
    assert.ok(nexts.length > 10, 'next mark on every row with a fix');
    for (const n of nexts) assert.match(n, /^→ (Mark A|Cape Byron Lighthouse Northern Approach)$/);
    await shot(page, 'phone-course-boats');
    await page.locator('#blist .brow[data-id]:not(.us) .bn').first().click();
    await page.locator('#tip').waitFor({state: 'visible'});
    assert.match(await page.locator('#tip').textContent(), /DTF \d+\.\dnm.*next (Mark A|Cape Byron)/);
    await page.locator('#tipClose').click();
    await tab(page, 'geo');
    assert.equal(await page.locator('#mapcontent polyline[stroke-dasharray]').count(), 1, 'course line');
    for (const n of ['Mark A', 'Cape Byron Lighthouse Northern Approach'])
        assert.equal(await page.locator('#mapcontent text', {hasText: n}).count(), 1, n);
    await shot(page, 'phone-course');
    await tab(page, 'tcf');
    assert.match(await page.locator('#tcfNote').textContent(), /toward course → Mark A/);
    assert.doesNotMatch(await page.locator('#tcfNote').textContent(), /compare with Up/);

    // A stored Up of 'course' from before means COG.
    await page.evaluate(() => {
        const p = JSON.parse(localStorage.getItem('nd_prefs') || '{}');
        delete p.upV;
        localStorage.setItem('nd_prefs', JSON.stringify({...p, up: 'course'}));
    });
    await page.reload();
    await page.locator('#conn', {hasText: 'live'}).waitFor();
    assert.equal(await page.locator('#upSel').inputValue(), 'cog');
    assert.deepEqual(errors, []);
    await ctx.close();
});
