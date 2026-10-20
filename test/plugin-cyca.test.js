'use strict';
/*
 * The CYCA adapter wired into the plugin: the selected race (from cyca-state.json)
 * is polled, its boats land in the snapshot as cyca:<entryId> with their names,
 * and their reports are journaled.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {setTimeout: sleep} = require('node:timers/promises');
const {replayTo} = require('./sim/replay');
const {snapshotToken} = require('../lib/cyca-feed');
const {tmpdir} = require('./sim/tmpdir');

const API = '/signalk/v1/api/nemesis';
const detail = require('./data/cyca/race-194.json');
const entries = require('./data/cyca/entries-194.json');
const status = require('./data/cyca/status-194-202607261200.json');

/** The recorded status, restamped to the slot before now (race-local time). */
function liveStatus(now) {
    const tok = snapshotToken(now - 600e3, 'Australia/Sydney');
    const local = `${tok.slice(0, 4)}-${tok.slice(4, 6)}-${tok.slice(6, 8)}T${tok.slice(8, 10)}:${tok.slice(10)}:00`;
    return status.map((s) => ({...s, raceTime: local}));
}

function fakeFeed(now) {
    const calls = [];
    const routes = {
        '/races/194': {
            ...detail,
            status: 'Racing',
            isRunning: true,
            startDateUtc: new Date(now - 6 * 3600e3).toISOString().slice(0, 19)
        },
        '/races/194/entries': entries,
        '/races/194/at/live/status': liveStatus(now)
    };
    const f = async (url) => {
        calls.push(url);
        const r = routes[url.replace('https://feeds.cycaracing.com/v2', '')];
        return r === undefined ? {ok: false, status: 404} : {ok: true, json: async () => r};
    };
    return Object.assign(f, {calls});
}

test('the selected CYCA race is polled into the snapshot and journal', async (t) => {
    const dataDir = tmpdir();
    fs.writeFileSync(path.join(dataDir, 'cyca-state.json'), JSON.stringify({version: 1, raceId: 194, links: {}}));
    const fetch = fakeFeed(Date.now());
    const {app, plugin} = await replayTo(6, {dataDir, fetch});
    t.after(() => plugin.stop());
    for (let i = 0; i < 50 && !fetch.calls.some((u) => u.endsWith('/status')); i++) await sleep(20);
    await sleep(50);
    const {body} = await app.call('GET', API + '/snapshot');
    const ambition = body.boats.find((b) => b.id === 'cyca:18921');
    assert.ok(ambition, 'CYCA boat listed');
    assert.equal(ambition.name, 'Ambition');
    // Retired boats are not reported.
    assert.ok(!body.boats.some((b) => b.id === 'cyca:18955'));
    plugin.stop();
    const journal = fs
        .readdirSync(path.join(dataDir, 'journal'))
        .map((f) => fs.readFileSync(path.join(dataDir, 'journal', f), 'utf8'))
        .join('');
    assert.match(journal, /"boatId":"cyca:18921","src":"cyca"/);
    assert.match(journal, /"id":"cyca:18921","name":"Ambition"/);
});

test('with no race selected the feed is not touched', async (t) => {
    const fetch = fakeFeed(Date.now());
    const {plugin} = await replayTo(1, {dataDir: tmpdir(), fetch});
    t.after(() => plugin.stop());
    await sleep(50);
    assert.equal(fetch.calls.length, 0);
    plugin.stop();
});

test('race picked and boats linked and unlinked over PUT; the snapshot follows at once', async (t) => {
    const dataDir = tmpdir();
    const fetch = fakeFeed(Date.now());
    const {app, plugin} = await replayTo(6, {dataDir, fetch});
    t.after(() => plugin.stop()); // a failed assertion must not leave the poll timer running
    const {PUT_PATHS} = require('../index');
    assert.equal((await app.put(PUT_PATHS.setCycaRace, {raceId: '194'})).status, 400);
    assert.equal((await app.put(PUT_PATHS.setCycaRace, {raceId: 194})).status, 200);
    for (let i = 0; i < 50 && !fetch.calls.some((u) => u.endsWith('/status')); i++) await sleep(20);
    await sleep(50);
    let snap = (await app.call('GET', API + '/snapshot')).body;
    assert.equal(snap.cyca.raceId, 194);
    assert.equal(snap.cyca.lastError, null);
    assert.ok(snap.boats.some((b) => b.id === 'cyca:18921'));

    // Ambition is heard on AIS right now in the replay (500018921), so its tracker reports
    // would all be within 10 min of an AIS report and dropped. Link it to a boat AIS has
    // not heard: it shows under that MMSI, from the tracker alone.
    assert.equal((await app.put(PUT_PATHS.setCycaLink, {name: 'Ambition', mmsi: 'x'})).status, 400);
    assert.equal((await app.put(PUT_PATHS.setCycaLink, {name: 'Ambition', mmsi: '503999001'})).status, 200);
    snap = (await app.call('GET', API + '/snapshot')).body;
    assert.ok(!snap.boats.some((b) => b.id === 'cyca:18921'), 'shown as its AIS boat only');
    const merged = snap.boats.find((b) => b.id === '503999001');
    assert.equal(merged.cycaId, 'cyca:18921');
    assert.equal(merged.name, 'Ambition');
    assert.equal(merged.latest.src, 'cyca');
    const map = (await app.call('GET', API + '/cyca/mapping')).body;
    const row = map.rows.find((r) => r.entryId === 18921);
    assert.equal(row.link, '503999001');
    assert.equal(row.linkName, null); // not heard on AIS
    const tracks = (await app.call('GET', API + '/tracks', {query: {periodS: '3600', ids: '503999001'}})).body;
    assert.deepEqual(
        tracks.boats['503999001'].map((r) => r.src),
        ['cyca']
    );
    // Linked to the AIS boat heard now: the tracker report within 10 min is dropped.
    assert.equal((await app.put(PUT_PATHS.setCycaLink, {name: 'Ambition', mmsi: '500018921'})).status, 200);
    snap = (await app.call('GET', API + '/snapshot')).body;
    assert.ok(!snap.boats.some((b) => b.id === '503999001'));
    assert.equal(snap.boats.find((b) => b.id === '500018921').latest.src, 'ais');
    const t2 = (await app.call('GET', API + '/tracks', {query: {periodS: '3600', ids: '500018921'}})).body;
    assert.ok(!t2.boats['500018921'].some((r) => r.src === 'cyca'));

    // No AIS mark, then unlink.
    assert.equal((await app.put(PUT_PATHS.setCycaNoAis, {entryId: 18866, noAis: true})).status, 200);
    assert.equal((await app.call('GET', API + '/cyca/mapping')).body.rows.find((r) => r.entryId === 18866).noAis, true);
    assert.equal((await app.put(PUT_PATHS.setCycaLink, {name: 'Ambition', mmsi: null})).status, 200);
    snap = (await app.call('GET', API + '/snapshot')).body;
    assert.ok(snap.boats.some((b) => b.id === 'cyca:18921'));
    assert.equal(snap.boats.find((b) => b.id === '500018921').cycaId, null);

    // Turning the feed off stops polling.
    assert.equal((await app.put(PUT_PATHS.setCycaRace, {raceId: null})).status, 200);
    assert.equal((await app.call('GET', API + '/cyca')).body.raceId, null);
    await sleep(20);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'cyca-state.json'), 'utf8')).raceId, null);
});
