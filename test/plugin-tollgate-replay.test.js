'use strict';
/*
 * End to end on the Tollgate Islands Race 2026: our own state and wind from Kanreki's
 * log, the fleet's AIS simulated from its YB fixes, and the same fixes as the CYCA
 * tracker feed. Two hours after the start.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {setTimeout: sleep} = require('node:timers/promises');
const {replayTo} = require('./sim/replay');
const {cycaFeed} = require('./sim/cyca-sim');
const {tmpdir} = require('./sim/tmpdir');

const API = '/signalk/v1/api/nemesis';

async function until(cond, ms = 3000) {
    for (let t = 0; t < ms && !(await cond()); t += 20) await sleep(20);
}

test('Tollgate 2026: AIS boats with their real MMSIs, the fleet from the tracker feed, our wind', async (t) => {
    const dataDir = tmpdir();
    fs.writeFileSync(path.join(dataDir, 'cyca-state.json'), JSON.stringify({version: 1, raceId: 198, links: {}}));
    const t0 = Date.now();
    const {app, plugin, fetch, sim} = await replayTo(2, {
        race: 'tollgate2026',
        dataDir,
        selfName: 'Kanreki',
        wind: true,
        fetchFor: (shiftMs, tracker) => cycaFeed({shiftMs, clock: Date.now, data: tracker})
    });
    t.after(() => plugin.stop());
    t.diagnostic(`replay ${Date.now() - t0} ms, ${sim.own.length} own samples, ${sim.reports.length} reports`);
    await until(() => fetch.calls.some((u) => u.endsWith('/status')));
    await sleep(50);

    const snap = (await app.call('GET', API + '/snapshot')).body;
    assert.equal(snap.cyca.lastError, null);
    const byId = new Map(snap.boats.map((b) => [b.id, b]));
    // Real MMSIs.
    for (const [mmsi, name] of [
        ['503073900', 'Supernova'],
        ['503098600', 'Ragtime'],
        ['503097760', 'Disko Trooper (DH)']
    ]) {
        assert.equal(byId.get(mmsi)?.name, name, name);
        assert.equal(byId.get(mmsi).latest.src, 'ais');
    }
    // The tracker feed's boats, but not our own entry (Kanreki is 19073).
    const cyca = snap.boats.filter((b) => b.id.startsWith('cyca:'));
    assert.ok(cyca.length >= 20, `${cyca.length} tracker boats`);
    assert.ok(!byId.has('cyca:19073'), 'our own entry dropped');
    assert.ok(cyca.every((b) => b.latest.src === 'cyca'));
    assert.ok(!byId.has('503029690'), 'we are not a competitor');
    // Our wind is the log's: Kanreki logged TWD 062 to 071 in the 2 minutes to 08:00Z.
    const twdDeg = (snap.own.twdRad * 180) / Math.PI;
    assert.ok(twdDeg > 60 && twdDeg < 73, `TWD ${twdDeg}`);
});
