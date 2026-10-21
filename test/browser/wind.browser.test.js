'use strict';
/*
 * Up = Upwind and Downwind in headless Chromium, against the plugin replaying GC2026 with
 * a made-up true wind (test/sim/ais-sim.js simTwdRad): the frame's labels, the Geo wind
 * ladder (rungs level on screen, about 12 to the view, a whole 1/2/5 step, rescaled on
 * zoom; in other frames at the wind's angle; the Wind box), and a server with no wind
 * (said so, never guessed).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {chromium} = require('playwright');
const {startDevServer} = require('../sim/dev-server');

const POLL = 300;
const SHOT_DIR = process.env.SHOT_DIR;
const PHONE = {viewport: {width: 390, height: 844}, hasTouch: true, isMobile: true, deviceScaleFactor: 2};

let browser;
let srv;
let still;

test.before(async () => {
    browser = await chromium.launch();
    srv = await startDevServer({hoursIn: 6});
    still = await startDevServer({hoursIn: 6, replayOpts: {wind: false}});
});
test.after(async () => {
    await browser?.close();
    await srv?.close();
    await still?.close();
});

async function open(server, prefs) {
    const ctx = await browser.newContext(PHONE);
    // Seeded once per context, so a reload keeps what the page stored.
    await ctx.addInitScript(
        (p) => localStorage.getItem('nd_prefs') || localStorage.setItem('nd_prefs', JSON.stringify(p)),
        {show: 'all', ...prefs}
    );
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(server.url + '?poll=' + POLL);
    await page.locator('#conn', {hasText: 'live'}).waitFor();
    await page.waitForTimeout(POLL * 3);
    return {ctx, page, errors};
}

async function shot(page, name) {
    if (SHOT_DIR) await page.screenshot({path: path.join(SHOT_DIR, name + '.png')});
}

/** The ladder rungs drawn on Geo: their screen y, the step between them and the labels. */
async function rungs(page) {
    return page.$$eval('#maprings line', (ls) =>
        ls.map((l) => ({
            y1: Number(l.getAttribute('y1')),
            y2: Number(l.getAttribute('y2')),
            x2: Number(l.getAttribute('x2'))
        }))
    );
}

test('Upwind: Boats labels, and Geo turned with a ladder of about 12 whole-step rungs', async () => {
    const {ctx, page, errors} = await open(srv, {tab: 'boats', up: 'upwind'});
    const head = await page.locator('#bhead').textContent();
    assert.match(head, /VMG upwind/);
    assert.match(head, /Lead upwind/);
    assert.doesNotMatch(head, /no wind/);
    // Charts drawn for us and others (values, not just empty boxes).
    assert.ok((await page.locator('#blist .brow[data-id] svg polyline, #blist .brow[data-id] svg path').count()) > 4);

    await page.click('#tabbar button[data-tab="geo"]');
    await page.waitForTimeout(POLL * 3);
    assert.match(await page.locator('#mapLine').textContent(), /upwind up/);
    assert.doesNotMatch(await page.locator('#mapLine').textContent(), /unknown/);
    let rs = await rungs(page);
    assert.ok(rs.length >= 8 && rs.length <= 18, `about 12 rungs: ${rs.length}`);
    for (const r of rs) assert.equal(r.y1, r.y2, 'level on screen');
    const step = (xs) => xs[1].y1 - xs[0].y1;
    const labels = await page.$$eval('#maprings text', (ts) => ts.map((t) => t.textContent));
    assert.ok(labels.includes('us'), 'a rung through us');
    // Labels are whole steps of 1, 2 or 5 x 10^n nm.
    const nums = labels.filter((l) => l !== 'us').map(Number);
    const d = Math.min(...nums.map(Math.abs));
    const mant = d / Math.pow(10, Math.floor(Math.log10(d) + 1e-9));
    assert.ok(
        [1, 2, 5].some((m) => Math.abs(mant - m) < 1e-6),
        `step ${d} nm`
    );
    for (const n of nums) assert.ok(Math.abs(n / d - Math.round(n / d)) < 1e-6, `${n} a whole step`);
    assert.ok(nums.some((n) => n > 0) && nums.some((n) => n < 0), '+ ahead (up) and - behind');
    await shot(page, 'phone-geo-upwind');

    // Zoom in: the rungs rescale, still about 12 to the view.
    const before = step(rs);
    const m = await page.locator('#map').boundingBox();
    await page.mouse.move(m.x + m.width / 2, m.y + m.height / 2);
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -100);
    await page.waitForTimeout(POLL);
    rs = await rungs(page);
    assert.ok(rs.length >= 8 && rs.length <= 18, `about 12 rungs after zoom: ${rs.length}`);
    const labels2 = await page.$$eval('#maprings text', (ts) => ts.map((t) => t.textContent).filter((l) => l !== 'us'));
    const d2 = Math.min(...labels2.map((l) => Math.abs(Number(l))));
    assert.ok(d2 < d, `finer step zoomed in: ${d2} < ${d} nm`);
    assert.ok(Number.isFinite(before));
    assert.deepEqual(errors, []);
    await ctx.close();
});

/** Screen angle of a line (deg, 0..180), as atan2 of its direction. */
const lineDeg = (l) => ((((Math.atan2(l.y2 - l.y1, l.x2 - l.x1) * 180) / Math.PI) % 180) + 180) % 180;
const mod = (a, m) => ((a % m) + m) % m;

test('Downwind: the opposite way up from Upwind', async () => {
    const angle = async (up) => {
        const {ctx, page} = await open(srv, {tab: 'geo', up});
        const tr = await page.locator('#maprot').getAttribute('transform');
        const n = await rungs(page);
        await ctx.close();
        return {deg: Number(/rotate\((-?[\d.]+)/.exec(tr)[1]), n: n.length};
    };
    const up = await angle('upwind');
    const down = await angle('downwind');
    const diff = mod(down.deg - up.deg, 360);
    assert.ok(Math.abs(diff - 180) < 1, `turned 180 deg: ${up.deg} vs ${down.deg}`);
    assert.ok(down.n > 0, 'downwind has a ladder');
});

test('North up: the ladder lies across the wind, + upwind; the Wind box hides it and is remembered', async () => {
    // Upwind turns the map by -TWD: that gives the TWD the page is using.
    const {ctx: c0, page: p0} = await open(srv, {tab: 'geo', up: 'upwind'});
    const twdDeg = -Number(/rotate\((-?[\d.]+)/.exec(await p0.locator('#maprot').getAttribute('transform'))[1]);
    await c0.close();

    const {ctx, page, errors} = await open(srv, {tab: 'geo', up: 'north'});
    assert.equal(await page.locator('#windChk').isChecked(), true, 'on by default');
    assert.equal(await page.locator('#windChk').isDisabled(), false);
    assert.equal(await page.locator('#courseChk').isDisabled(), true, 'no course set: Course greyed out');
    const rs = await page.$$eval('#maprings line', (ls) =>
        ls.map((l) => ['x1', 'y1', 'x2', 'y2'].reduce((o, k) => ({...o, [k]: Number(l.getAttribute(k))}), {}))
    );
    assert.ok(rs.length >= 8 && rs.length <= 18, `about 12 rungs: ${rs.length}`);
    // North up: a rung across a wind from TWD runs along screen angle TWD (mod 180).
    for (const l of rs) {
        const d = mod(lineDeg(l) - mod(twdDeg, 180) + 90, 180) - 90;
        assert.ok(Math.abs(d) < 2, `rung at ${lineDeg(l).toFixed(1)} deg, wind ${twdDeg.toFixed(1)}`);
    }
    // + labels lie toward the wind: screen direction (sin TWD, -cos TWD) with north up.
    const labels = await page.$$eval('#maprings text', (ts) => ts.map((t) => t.textContent));
    const usI = labels.indexOf('us');
    assert.ok(usI >= 0, 'a rung through us');
    const mid = (l) => [(l.x1 + l.x2) / 2, (l.y1 + l.y2) / 2];
    const a = (twdDeg * Math.PI) / 180;
    const along = (l) => {
        const [x, y] = mid(l);
        const [ux, uy] = mid(rs[usI]);
        return (x - ux) * Math.sin(a) - (y - uy) * Math.cos(a);
    };
    for (let i = 0; i < rs.length; i++) {
        if (i === usI) continue;
        const n = Number(labels[i]);
        assert.ok(
            Math.sign(n) === Math.sign(along(rs[i])),
            `${labels[i]} on the ${along(rs[i]) > 0 ? 'upwind' : 'downwind'} side`
        );
    }
    // The Geo header still fits a phone with the Wind box.
    const fit = await page.evaluate(() => ({
        vw: window.innerWidth,
        right: document.getElementById('fitBtn').getBoundingClientRect().right,
        sw: document.scrollingElement.scrollWidth
    }));
    assert.ok(fit.right <= fit.vw && fit.sw <= fit.vw, `header fits: ${JSON.stringify(fit)}`);
    await shot(page, 'phone-geo-north-ladder');

    await page.locator('#windLbl').tap();
    await page.waitForTimeout(POLL);
    assert.equal((await rungs(page)).length, 0, 'unticked: no ladder');
    await page.reload();
    await page.locator('#conn', {hasText: 'live'}).waitFor();
    await page.waitForTimeout(POLL * 3);
    assert.equal(await page.locator('#windChk').isChecked(), false, 'remembered');
    assert.equal((await rungs(page)).length, 0);
    assert.deepEqual(errors, []);
    await ctx.close();
});

test('no wind instruments: Upwind says no wind, draws no ladder, and does not throw', async () => {
    const {ctx, page, errors} = await open(still, {tab: 'boats', up: 'upwind'});
    assert.match(await page.locator('#bhead').textContent(), /no wind/);
    await page.click('#tabbar button[data-tab="geo"]');
    await page.waitForTimeout(POLL * 2);
    assert.match(await page.locator('#mapLine').textContent(), /unknown: north up/);
    assert.equal((await rungs(page)).length, 0);
    assert.equal(await page.locator('#windChk').isDisabled(), true, 'Wind box greyed out');
    await page.selectOption('#upSel', 'north');
    await page.waitForTimeout(POLL * 2);
    assert.equal((await rungs(page)).length, 0, 'no ladder in another frame either');
    for (const t of ['vectors', 'tcf']) {
        await page.click(`#tabbar button[data-tab="${t}"]`);
        await page.waitForTimeout(POLL * 2);
    }
    assert.deepEqual(errors, []);
    await ctx.close();
});
