'use strict';
/*
 * End to end on GC2026: the AIS simulator and a fake CYCA feed from the same
 * recorded race. A nemesis boat out of AIS range is backfilled from its CYCA
 * track over the display period; the mapping recommends the right AIS boats.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {setTimeout: sleep} = require('node:timers/promises');
const {replayTo} = require('./sim/replay');
const {cycaFeed} = require('./sim/cyca-sim');
const {PUT_PATHS} = require('../index');
const {tmpdir} = require('./sim/tmpdir');

const API = '/signalk/v1/api/nemesis';
const H = 3600e3;

async function until(cond, ms = 3000) {
    for (let t = 0; t < ms && !(await cond()); t += 20) await sleep(20);
}

test('GC2026: a nemesis out of AIS range is backfilled from CYCA; links are recommended', async (t) => {
    const dataDir = tmpdir();
    fs.writeFileSync(path.join(dataDir, 'cyca-state.json'), JSON.stringify({version: 1, raceId: 194, links: {}}));
    const {app, plugin, fetch, now} = await replayTo(24, {
        dataDir,
        selfName: 'Kanreki',
        fetchFor: (shiftMs) => cycaFeed({shiftMs, clock: Date.now})
    });
    t.after(() => plugin.stop());
    await until(() => fetch.calls.some((u) => u.endsWith('/status')));
    await sleep(50);

    let snap = (await app.call('GET', API + '/snapshot')).body;
    assert.equal(snap.cyca.lastError, null);
    // A boat CYCA reports that AIS has not heard for over an hour.
    const aisHeard = new Map(snap.boats.filter((b) => !b.id.startsWith('cyca:')).map((b) => [b.id, b]));
    const far = snap.boats.find((b) => {
        if (!b.id.startsWith('cyca:')) return false;
        const ais = aisHeard.get(String(500000000 + Number(b.id.slice(5))));
        return !ais || ais.ageMs > H;
    });
    assert.ok(far, 'a CYCA boat out of AIS range');
    // One live slot so far: a gap over the 2 h display period.
    let tr = (await app.call('GET', API + '/tracks', {query: {periodS: '7200', ids: far.id}})).body;
    assert.equal(tr.boats[far.id].length, 1);
    assert.equal((await app.put(PUT_PATHS.setNemesis, {id: far.id, nemesis: true})).status, 200);
    // The /tracks request above asked for 2 h, so the fill covers 2 h: 12 or 13 slots.
    await until(async () => {
        tr = (await app.call('GET', API + '/tracks', {query: {periodS: '7200', ids: far.id}})).body;
        return tr.boats[far.id].length > 10;
    });
    const got = tr.boats[far.id];
    assert.ok(got.length >= 12 && got.length <= 13, `${got.length} slots`);
    assert.ok(got.every((r) => r.src === 'cyca'));
    assert.ok(got[0].t >= now - 2 * H);
    const trackCalls = fetch.calls.filter((u) => u.includes('/track/'));
    assert.deepEqual(trackCalls, [
        `https://feeds.cycaracing.com/v2/races/194/entries/${far.id.slice(5)}/track/at/live`
    ]);
    // Asking again within 10 min does not refetch.
    await app.call('GET', API + '/tracks', {query: {periodS: '7200', ids: far.id}});
    assert.equal((await app.put(PUT_PATHS.setNemesis, {id: far.id, nemesis: true})).status, 200);
    await sleep(50);
    assert.equal(fetch.calls.filter((u) => u.includes('/track/')).length, 1);

    // Mapping: one live slot is not enough to recommend by position, but AIS names equal
    // the CYCA names in the replay, so boats heard on AIS get their AIS boat.
    const map = (await app.call('GET', API + '/cyca/mapping')).body;
    assert.equal(map.needsAction, true);
    const rec = map.rows.filter((r) => r.recommended);
    assert.ok(rec.length > 20, `${rec.length} recommended`);
    for (const r of rec) assert.equal(r.recommended, String(500000000 + r.entryId), r.name);
    snap = (await app.call('GET', API + '/snapshot')).body;
    assert.equal(snap.cyca.needsAction, true);
    const kanreki = require('./data/gc2026-tracks.json').boats.find((b) => b.name === 'Kanreki');
    assert.ok(!snap.boats.some((b) => b.id === 'cyca:' + kanreki.id), 'our own CYCA entry is not a competitor');
});
