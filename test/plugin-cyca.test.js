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

test('the selected CYCA race is polled into the snapshot and journal', async () => {
    const dataDir = tmpdir();
    fs.writeFileSync(path.join(dataDir, 'cyca-state.json'), JSON.stringify({version: 1, raceId: 194, links: {}}));
    const fetch = fakeFeed(Date.now());
    const {app, plugin} = await replayTo(6, {dataDir, fetch});
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

test('with no race selected the feed is not touched', async () => {
    const fetch = fakeFeed(Date.now());
    const {plugin} = await replayTo(1, {dataDir: tmpdir(), fetch});
    await sleep(50);
    assert.equal(fetch.calls.length, 0);
    plugin.stop();
});
