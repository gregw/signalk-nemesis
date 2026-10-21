'use strict';
/*
 * Clearing history and unlinking every CYCA boat, on the Tollgate 2026 replay.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {setTimeout: sleep} = require('node:timers/promises');
const {replayTo} = require('./sim/replay');
const {toDelta} = require('./sim/ais-sim');
const {tmpdir} = require('./sim/tmpdir');
const {recordedId} = require('../lib/recorded-race');
const {PUT_PATHS} = require('../index');

const API = '/signalk/v1/api/nemesis';

async function until(cond, ms = 3000) {
    for (let t = 0; t < ms && !(await cond()); t += 20) await sleep(20);
}

test('clear history: tracks and journal emptied, names and links kept; unlink all: no links', async (t) => {
    const dataDir = tmpdir();
    // A link left from another race, to a made-up MMSI no boat here has.
    const links = {supernova: '500018891', ragtime: '503098600'};
    fs.writeFileSync(
        path.join(dataDir, 'cyca-state.json'),
        JSON.stringify({version: 1, raceId: recordedId('tollgate'), links})
    );
    const {app, plugin} = await replayTo(2, {race: 'tollgate2026', recorded: 'tollgate', dataDir, selfName: 'Kanreki'});
    t.after(() => plugin.stop());
    const snap = async () => (await app.call('GET', API + '/snapshot')).body;
    const segs = () => fs.readdirSync(path.join(dataDir, 'journal')).filter((f) => /^seg-/.test(f));
    await until(async () => (await snap()).boats.some((b) => b.id.startsWith('cyca:')) && segs().length > 0);
    const before = await snap();
    assert.ok(before.boats.length > 20);
    assert.ok(segs().length > 0, 'journal written');

    assert.equal((await app.put(PUT_PATHS.clearHistory, {})).status, 400);
    assert.equal((await app.put(PUT_PATHS.clearHistory, true)).status, 200);
    const after = await snap();
    assert.deepEqual(after.boats, []);
    assert.equal(after.own, null);
    assert.ok(after.cyca.filled > before.cyca.filled, 'the page is told to refetch');
    assert.deepEqual(segs(), []);
    const tr = (await app.call('GET', API + '/tracks', {query: {periodS: '3600'}})).body;
    assert.deepEqual(tr.boats, {});

    // A boat that reports again comes back with its name.
    app.deliver(
        toDelta('vessels.urn:mrn:imo:mmsi:503073900', {t: Date.now(), lat: -34, lon: 151.3, cogRad: 3, sogMs: 4})
    );
    await until(async () => (await snap()).boats.some((b) => b.id === '503073900'));
    assert.equal((await snap()).boats.find((b) => b.id === '503073900').name, 'Supernova');
    // Links survive a clear.
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'cyca-state.json'), 'utf8')).links, links);

    // Clear all TCFs.
    assert.equal((await app.put(PUT_PATHS.setTcf, {id: '503073900', tcf: 1.05})).status, 200);
    assert.equal((await snap()).boats.find((b) => b.id === '503073900').tcf, 1.05);
    assert.equal((await app.put(PUT_PATHS.clearTcfs, 1)).status, 400);
    assert.equal((await app.put(PUT_PATHS.clearTcfs, true)).status, 200);
    assert.equal((await snap()).boats.find((b) => b.id === '503073900').tcf, 1);

    assert.equal((await app.put(PUT_PATHS.unlinkAllCyca, true)).status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'cyca-state.json'), 'utf8')).links, {});
});
