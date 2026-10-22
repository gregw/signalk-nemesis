'use strict';
/*
 * IRC TCFs from CYCA, end to end on the Tollgate 2026 replay: the recorded race names
 * its feed race (198), whose IRC results come from the fixture. Each TCF lands on the
 * boats it applies to here: ours on us, a linked entry on its AIS boat, others on their
 * CYCA boat and an AIS boat of the same name.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {replayTo} = require('./sim/replay');
const {tmpdir} = require('./sim/tmpdir');
const {handicapFeed} = require('./sim/cyca-sim');
const {recordedId} = require('../lib/recorded-race');
const {PUT_PATHS} = require('../index');

const API = '/signalk/v1/api/nemesis';

test('IRC TCFs from CYCA: previewed on the right boats, then set in one go', async (t) => {
    const dataDir = tmpdir();
    fs.writeFileSync(
        path.join(dataDir, 'cyca-state.json'),
        JSON.stringify({version: 1, raceId: recordedId('tollgate'), links: {ragtime: '503098600'}})
    );
    const fetch = handicapFeed();
    const {app, plugin} = await replayTo(1, {
        race: 'tollgate2026',
        recorded: 'tollgate',
        dataDir,
        selfName: 'Kanreki',
        fetch
    });
    t.after(() => plugin.stop());
    await plugin.ready;

    const r = await app.call('GET', API + '/cyca/tcfs');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.category, {id: 1148, name: 'IRC'});
    assert.equal(r.body.rows.length, 23);
    const by = (name) => r.body.rows.find((x) => x.name === name);
    assert.deepEqual(by('Kanreki'), {entryId: 19073, name: 'Kanreki', ids: ['self'], tcf: 1.107, current: 1});
    assert.deepEqual(by('Ragtime').ids, ['503098600'], 'linked: on its AIS boat only');
    // Not linked: on its CYCA boat, and on the AIS boat of the same name (the replay's
    // made up MMSI for an entry with no real one).
    assert.deepEqual(by('Smuggler').ids, ['cyca:19079', '500019079']);
    assert.equal(by('Smuggler').tcf, 1.369);

    // Set: all of them, then the snapshot shows them.
    const tcfs = Object.fromEntries(r.body.rows.flatMap((x) => x.ids.map((id) => [id, x.tcf])));
    assert.equal((await app.put(PUT_PATHS.setTcfs, {tcfs})).status, 200);
    const snap = (await app.call('GET', API + '/snapshot')).body;
    assert.equal(snap.tcfUs, 1.107);
    assert.equal(snap.boats.find((b) => b.id === '500019079').tcf, 1.369);
    const after = (await app.call('GET', API + '/cyca/tcfs')).body;
    assert.ok(
        after.rows.every((x) => x.current === x.tcf),
        'nothing left to change'
    );
    // A bad value: nothing set.
    assert.equal((await app.put(PUT_PATHS.setTcfs, {tcfs: {self: 1.2, x: 0}})).status, 400);
    assert.equal((await app.put(PUT_PATHS.setTcfs, {tcfs: [1]})).status, 400);
    assert.equal((await app.call('GET', API + '/snapshot')).body.tcfUs, 1.107);

    // The feed down: an error, not a throw.
    fetch.down = true;
    const down = await app.call('GET', API + '/cyca/tcfs');
    assert.deepEqual([down.status, down.body], [502, {error: 'race detail: fetch failed'}]);
    // No race picked.
    assert.equal((await app.put(PUT_PATHS.setCycaRace, {raceId: null})).status, 200);
    assert.equal((await app.call('GET', API + '/cyca/tcfs')).status, 409);
});
