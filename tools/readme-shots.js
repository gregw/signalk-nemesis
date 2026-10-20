'use strict';
/*
 * README screenshots: the webapp on a phone in portrait, against the plugin replaying the
 * recorded GC2026 race (test/sim/dev-server.js), with the boats nearest us as nemeses.
 * The TCFs are made up for the picture. Writes docs/screenshots/<tab>.png. The Geo shot is
 * earlier in the race, near the coast, on the Sea basemap (it needs internet for the tiles).
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
// hoursIn: null = the command line's; zoomOut: wheel steps out after Fit (3 = 1 zoom level).
const SHOTS = [
    {tab: 'boats', periodMin: 60, hoursIn: null},
    {tab: 'tcf', periodMin: 60, hoursIn: null},
    {tab: 'vectors', periodMin: 15, hoursIn: null},
    {tab: 'geo', periodMin: 60, hoursIn: 1.5, base: 'sea', zoomOut: 6}
];

async function main() {
    const hoursIn = Number(process.argv[2] || 6);
    const servers = new Map(); // hoursIn -> dev server, each with the same nemeses and TCFs
    const serverAt = async (h) => {
        if (!servers.has(h)) servers.set(h, await startDevServer({hoursIn: h}));
        return servers.get(h);
    };
    // The nemeses are the boats nearest us at the main time.
    const snap = (await (await serverAt(hoursIn)).app.call('GET', '/signalk/v1/api/nemesis/snapshot', {query: {}})).body;
    const nearest = snap.boats
        .filter((b) => b.current && b.rangeM != null)
        .sort((a, b) => a.rangeM - b.rangeM)
        .slice(0, TCFS.length);
    nearest.forEach((b, i) => console.log('nemesis', b.name, TCFS[i]));
    const setUp = async (srv) => {
        await srv.app.put('navigation.racing.nemesis.setTcf', {id: 'self', tcf: TCF_US});
        for (const [i, b] of nearest.entries()) {
            await srv.app.put('navigation.racing.nemesis.setNemesis', {id: b.id, nemesis: true});
            await srv.app.put('navigation.racing.nemesis.setTcf', {id: b.id, tcf: TCFS[i]});
        }
    };

    fs.mkdirSync(OUT, {recursive: true});
    const browser = await chromium.launch();
    try {
        for (const s of SHOTS) {
            const h = s.hoursIn ?? hoursIn;
            const fresh = !servers.has(h);
            const srv = await serverAt(h);
            if (fresh || h === hoursIn) await setUp(srv);
            const ctx = await browser.newContext(PHONE);
            const prefs = {tab: s.tab, periodMin: s.periodMin, show: 'nemeses', base: s.base || 'white'};
            await ctx.addInitScript((p) => localStorage.setItem('nd_prefs', JSON.stringify(p)), prefs);
            const page = await ctx.newPage();
            await page.goto(srv.url);
            await page.locator('#conn', {hasText: 'live'}).waitFor();
            if (s.tab === 'geo') {
                // Fit frames where the boats are now; zoom out for their tails (and the land).
                await page.waitForTimeout(1000); // the first data in, so Fit has boats to frame
                await page.locator('#fitBtn').click();
                const m = await page.locator('#map').boundingBox();
                await page.mouse.move(m.x + m.width / 2, m.y + m.height / 2);
                for (let i = 0; i < (s.zoomOut || 0); i++) await page.mouse.wheel(0, 100);
                await page.waitForLoadState('networkidle'); // map tiles
            }
            await page.waitForTimeout(1500); // charts settle
            const file = path.join(OUT, s.tab + '.png');
            await page.screenshot({path: file});
            console.log('wrote', file);
            await ctx.close();
        }
    } finally {
        await browser.close();
        for (const srv of servers.values()) await srv.close();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
