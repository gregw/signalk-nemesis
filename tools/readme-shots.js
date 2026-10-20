'use strict';
/*
 * README screenshots: the webapp on a phone in portrait, against the plugin replaying the
 * recorded GC2026 race (test/sim/dev-server.js), with the boats nearest us as nemeses.
 * The TCFs are made up for the picture. Writes docs/screenshots/<tab>.png.
 *
 *   node tools/readme-shots.js [hoursIn]
 */
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const {startDevServer} = require('../test/sim/dev-server');

const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
const PHONE = {viewport: {width: 390, height: 844}, hasTouch: true, isMobile: true, deviceScaleFactor: 2};
const TCF_US = 1.012;
const TCFS = [0.987, 1.034, 1.005, 1.021];
const SHOTS = [
    {tab: 'boats', periodMin: 60},
    {tab: 'tcf', periodMin: 60},
    {tab: 'vectors', periodMin: 15},
    {tab: 'geo', periodMin: 60}
];

async function main() {
    const hoursIn = Number(process.argv[2] || 6);
    const srv = await startDevServer({hoursIn});
    const snap = (await srv.app.call('GET', '/signalk/v1/api/nemesis/snapshot', {query: {}})).body;
    const nearest = snap.boats
        .filter((b) => b.current && b.rangeM != null)
        .sort((a, b) => a.rangeM - b.rangeM)
        .slice(0, TCFS.length);
    await srv.app.put('navigation.racing.nemesis.setTcf', {id: 'self', tcf: TCF_US});
    for (const [i, b] of nearest.entries()) {
        await srv.app.put('navigation.racing.nemesis.setNemesis', {id: b.id, nemesis: true});
        await srv.app.put('navigation.racing.nemesis.setTcf', {id: b.id, tcf: TCFS[i]});
        console.log('nemesis', b.name, TCFS[i]);
    }

    fs.mkdirSync(OUT, {recursive: true});
    const browser = await chromium.launch();
    try {
        for (const s of SHOTS) {
            const ctx = await browser.newContext(PHONE);
            const prefs = {tab: s.tab, periodMin: s.periodMin, show: 'nemesi'};
            await ctx.addInitScript((p) => localStorage.setItem('nd_prefs', JSON.stringify(p)), prefs);
            const page = await ctx.newPage();
            await page.goto(srv.url);
            await page.locator('#conn', {hasText: 'live'}).waitFor();
            if (s.tab === 'geo') {
                // Fit frames where the boats are now; zoom out 1 level (3 wheel steps) for their tails.
                await page.locator('#fitBtn').click();
                const m = await page.locator('#map').boundingBox();
                await page.mouse.move(m.x + m.width / 2, m.y + m.height / 2);
                for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 100);
            }
            await page.waitForTimeout(1500); // charts settle
            const file = path.join(OUT, s.tab + '.png');
            await page.screenshot({path: file});
            console.log('wrote', file);
            await ctx.close();
        }
    } finally {
        await browser.close();
        await srv.close();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
