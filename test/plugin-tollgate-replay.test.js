'use strict';
/*
 * End to end on the Tollgate Islands Race 2026: our own state and wind from Kanreki's
 * log, the fleet's AIS simulated from its YB fixes, and the same fixes as a recorded race
 * file the plugin offers on the CYCA tab (already picked). Two hours after the start.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {setTimeout: sleep} = require('node:timers/promises');
const {replayTo} = require('./sim/replay');
const {tmpdir} = require('./sim/tmpdir');
const {recordedId} = require('../lib/recorded-race');
const {PUT_PATHS} = require('../index');

const API = '/signalk/v1/api/nemesis';
const RACE_ID = recordedId('tollgate');

async function until(cond, ms = 3000) {
    for (let t = 0; t < ms && !(await cond()); t += 20) await sleep(20);
}

test('Tollgate 2026: AIS boats with their real MMSIs, the fleet from the recorded race, our wind', async (t) => {
    const dataDir = tmpdir();
    fs.writeFileSync(path.join(dataDir, 'cyca-state.json'), JSON.stringify({version: 1, raceId: RACE_ID, links: {}}));
    const t0 = Date.now();
    const {app, plugin, sim, shiftMs, tracker} = await replayTo(2, {
        race: 'tollgate2026',
        recorded: 'tollgate',
        dataDir,
        selfName: 'Kanreki',
        wind: true
    });
    t.after(() => plugin.stop());
    t.diagnostic(`replay ${Date.now() - t0} ms, ${sim.own.length} own samples, ${sim.reports.length} reports`);
    let snap;
    await until(async () => {
        snap = (await app.call('GET', API + '/snapshot')).body;
        return snap.boats.some((b) => b.id.startsWith('cyca:'));
    });

    // The picker lists the recorded race.
    const races = (await app.call('GET', API + '/cyca/races')).body;
    const row = races.races.find((r) => r.raceId === RACE_ID);
    assert.equal(row.name, 'Recorded: Tollgate Islands Race 2026');
    assert.deepEqual([row.fleet, row.running, races.selected], [25, true, RACE_ID]);
    assert.equal(snap.cyca.lastError, null);
    assert.equal(snap.cyca.listing.raceId, RACE_ID);

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
    // The recorded race's boats, but not our own entry (Kanreki is 19073); nothing ahead of now.
    const cyca = snap.boats.filter((b) => b.id.startsWith('cyca:'));
    assert.ok(cyca.length >= 20, `${cyca.length} tracker boats`);
    assert.ok(!byId.has('cyca:19073'), 'our own entry dropped');
    assert.ok(cyca.every((b) => b.latest.src === 'cyca' && b.latest.t <= Date.now()));
    assert.ok(!byId.has('503029690'), 'we are not a competitor');
    // Our wind is the log's: Kanreki logged TWD 062 to 071 in the 2 minutes to 08:00Z.
    const twdDeg = (snap.own.twdRad * 180) / Math.PI;
    assert.ok(twdDeg > 60 && twdDeg < 73, `TWD ${twdDeg}`);

    // A new nemesis is filled in from the recorded track at its YB slot times and places.
    assert.equal((await app.put(PUT_PATHS.setNemesis, {id: 'cyca:19066', nemesis: true})).status, 200);
    let got = [];
    await until(async () => {
        got =
            (await app.call('GET', API + '/tracks', {query: {periodS: '3600', ids: 'cyca:19066'}})).body.boats[
                'cyca:19066'
            ] || [];
        return got.length >= 6;
    });
    assert.ok(got.length >= 6, `${got.length} filled`);
    const yb = new Map(tracker.boats.find((b) => b.id === 19066).samples.map((s) => [Date.parse(s[0]), s]));
    for (const r of got) {
        const s = yb.get(r.t - shiftMs);
        assert.ok(s, `a YB slot at ${new Date(r.t - shiftMs).toISOString()}`);
        assert.deepEqual([r.lat, r.lon], [s[1], s[2]]);
    }
    // The page refetches tracks when this count moves.
    assert.ok((await app.call('GET', API + '/snapshot')).body.cyca.filled >= 1);
});
