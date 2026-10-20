'use strict';
/*
 * The Course tab in headless Chromium against the plugin replaying GC2026: the course
 * seeded from the config, adding, moving and removing waypoints, importing a route,
 * Up = Course following it, and phone layout with six tabs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {chromium} = require('playwright');
const {startDevServer} = require('../sim/dev-server');
const {tmpdir} = require('../sim/tmpdir');

const POLL = 300;
const SHOT_DIR = process.env.SHOT_DIR;
const PHONE = {viewport: {width: 360, height: 740}, hasTouch: true, isMobile: true, deviceScaleFactor: 2};
const TABLET = {viewport: {width: 1024, height: 768}, hasTouch: true};
const point = (name, lat, lon) => ({
    name,
    feature: {type: 'Feature', geometry: {type: 'Point', coordinates: [lon, lat]}}
});

let browser;
let srv;

test.before(async () => {
    browser = await chromium.launch();
    srv = await startDevServer({
        hoursIn: 6,
        config: {waypointNames: ['Coffs', 'Byron']},
        resources: {
            waypoints: {
                'u-c': point('Coffs', -30.3, 153.2),
                'u-b': point('Byron', -28.6, 153.64),
                'u-g': point('Gold Coast', -27.95, 153.44)
            },
            routes: {
                'r-1': {
                    name: 'Coast',
                    feature: {
                        type: 'Feature',
                        geometry: {
                            type: 'LineString',
                            coordinates: [
                                [153.2, -30.3],
                                [153.5, -29.2],
                                [153.44, -27.95]
                            ]
                        },
                        properties: {coordinatesMeta: [{href: '/resources/waypoints/u-c'}, {name: 'Yamba'}, {}]}
                    }
                }
            }
        },
        replayOpts: {dataDir: tmpdir()}
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

const names = (page) => page.$$eval('#courselist .mname b', (bs) => bs.map((b) => b.textContent));

test('seeded, add, move, remove, import a route; Up = Course follows', async () => {
    const {ctx, page, errors} = await open(TABLET);
    await page.click('#tabbar button[data-tab="course"]');
    await page.locator('#courselist .mrow').first().waitFor();
    assert.deepEqual(await names(page), ['Coffs', 'Byron']);
    assert.match(await page.textContent('#courseStatus'), /from the plugin config/);
    assert.match(await page.textContent('#courselist'), /first mark/);

    await page.selectOption('#courseAdd', {label: 'Gold Coast'});
    await page.click('#courseAddBtn');
    await page.locator('#courselist .mrow', {hasText: 'Gold Coast'}).waitFor();
    assert.deepEqual(await names(page), ['Coffs', 'Byron', 'Gold Coast']);
    assert.doesNotMatch(await page.textContent('#courseStatus'), /plugin config/);
    // A leg: distance and bearing from the previous mark.
    assert.match(await page.locator('#courselist .mrow').nth(1).textContent(), /\d+\.\d nm · 0\d\d°T/);

    await page.locator('#courselist .mrow').nth(2).locator('button[data-act="up"]').click();
    await page.waitForFunction(
        () => document.querySelectorAll('#courselist .mname b')[1]?.textContent === 'Gold Coast'
    );
    assert.deepEqual(await names(page), ['Coffs', 'Gold Coast', 'Byron']);
    await page.locator('#courselist .mrow').nth(0).locator('button[data-act="del"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#courselist .mrow').length === 2);
    assert.deepEqual(await names(page), ['Gold Coast', 'Byron']);

    // Up = Course uses the edited course; the Up picker offers its marks.
    await page.selectOption('#upSel', 'course');
    const ups = await page.$$eval('#upSel option[data-wpt]', (os) => os.map((o) => o.textContent));
    assert.ok(ups.includes('WPT Gold Coast') && ups.includes('WPT Byron'), JSON.stringify(ups));

    // Import a route: confirm the replacement.
    page.once('dialog', (d) => d.accept());
    await page.selectOption('#courseRoute', {label: 'Coast (3 points)'});
    await page.click('#courseImport');
    await page.locator('#courselist .mrow', {hasText: 'Yamba'}).waitFor();
    assert.deepEqual(await names(page), ['Coffs', 'Yamba', 'WP3']);
    assert.match(await page.locator('#courselist .mrow').nth(1).textContent(), /fixed point/);
    if (SHOT_DIR) await page.screenshot({path: path.join(SHOT_DIR, 'course-tablet.png')});

    // Kept on the server: a reload shows the same course.
    await page.reload();
    await page.locator('#courselist .mrow', {hasText: 'Yamba'}).waitFor();
    assert.deepEqual(errors, []);
    await ctx.close();
});

test('phone: six tabs fit and the course rows stay inside the screen', async () => {
    const {ctx, page, errors} = await open(PHONE);
    await page.click('#tabbar button[data-tab="course"]');
    await page.locator('#courselist .mrow').first().waitFor();
    const m = await page.evaluate(() => ({
        vw: innerWidth,
        sw: document.scrollingElement.scrollWidth,
        tabs: [...document.querySelectorAll('#tabbar button')].map((b) => [
            b.textContent,
            b.scrollWidth,
            b.clientWidth
        ]),
        right: Math.max(...[...document.querySelectorAll('#pane-course *')].map((e) => e.getBoundingClientRect().right))
    }));
    assert.ok(m.sw <= m.vw, `no horizontal page scroll (${m.sw} > ${m.vw})`);
    for (const [name, sw, cw] of m.tabs) assert.ok(sw <= cw, `tab ${name} fits (${sw} > ${cw})`);
    assert.ok(m.right <= m.vw + 0.5, `course pane inside the screen (${m.right})`);
    if (SHOT_DIR) await page.screenshot({path: path.join(SHOT_DIR, 'course-phone.png')});
    assert.deepEqual(errors, []);
    await ctx.close();
});
