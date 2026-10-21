'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {RecordedRaces, recordedId} = require('../lib/recorded-race');
const feed = require('../lib/cyca-feed');
const {tmpdir} = require('./sim/tmpdir');

const SLOT = 600e3;
const START = Date.parse('2026-10-16T06:00:00Z');
const iso = (t) => new Date(t).toISOString();
const sample = (t, lat, sog = 8, cog = 180) => [iso(t), lat, 151.3, sog, cog, null, null];

/** Two boats: A has a fix in every slot from before the start; B misses the second slot. */
function race() {
    return {
        race: {id: 198, name: 'Tollgate Islands Race 2026', start: iso(START)},
        boats: [
            {
                id: 1,
                name: 'A',
                samples: [
                    sample(START - SLOT, -33.8, 0),
                    sample(START, -33.85),
                    sample(START + SLOT, -33.9),
                    sample(START + 2 * SLOT, -33.95)
                ]
            },
            {id: 2, name: 'B', samples: [sample(START, -33.86), sample(START + 2 * SLOT, -33.96)]}
        ]
    };
}

async function setup(now, files = {'recorded-race-tollgate.json': JSON.stringify(race())}) {
    const dir = tmpdir();
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
    const clock = {now};
    const rr = new RecordedRaces({dataDir: dir, clock: () => clock.now});
    await rr.scan();
    const passed = [];
    const fetch = rr.fetchWith(async (url) => {
        passed.push(url);
        return {ok: false, status: 503};
    });
    const get = async (p) => {
        const r = await fetch(feed.FEED_BASE + '/v2' + p);
        return r.ok ? r.json() : r.status;
    };
    return {rr, fetch, get, clock, passed};
}

test('recorded races: each recorded-race-<key>.json listed with its own negative id; a bad file reported', async () => {
    const {rr} = await setup(START + 30e3, {
        'recorded-race-tollgate.json': JSON.stringify(race()),
        'recorded-race-broken.json': '{"race":',
        'recorded-race-nostart.json': JSON.stringify({race: {name: 'x'}, boats: []}),
        'cyca-races.json': '{}'
    });
    const id = recordedId('tollgate');
    assert.ok(id < 0 && Number.isInteger(id));
    assert.notEqual(recordedId('tollgate'), recordedId('tollgate2'));
    const l = rr.listings();
    assert.deepEqual(
        l.map((r) => [r.raceId, r.name, r.fleet, r.status, r.running, r.recorded]),
        [[id, 'Recorded: Tollgate Islands Race 2026', 2, 'Racing', true, true]]
    );
    assert.equal(rr.errors.length, 2);
    assert.match(rr.errors.join(), /recorded-race-broken.json/);
    assert.match(rr.errors.join(), /recorded-race-nostart.json: no race start/);
    // No data dir: nothing, no error.
    const none = new RecordedRaces({dataDir: path.join(tmpdir(), 'missing')});
    await none.scan();
    assert.deepEqual([none.listings(), none.errors], [[], []]);
});

test('recorded feed: the race, entries, and only slots at or before now; other requests go to the network', async () => {
    const id = recordedId('tollgate');
    const {get, fetch, passed, clock} = await setup(START + SLOT + 90e3);
    const d = feed.parseRace(await get(`/races/${id}`));
    assert.deepEqual([d.raceId, d.startT, d.status, d.running], [id, START, 'Racing', true]);
    assert.deepEqual(
        feed.parseEntries(await get(`/races/${id}/entries`)).entries.map((e) => [e.entryId, e.name]),
        [
            [1, 'A'],
            [2, 'B']
        ]
    );
    // Status: each boat's latest slot by now; B's is the start slot (it missed the second).
    const st = feed.parseStatus(await get(`/races/${id}/at/live/status`), 'Australia/Sydney');
    assert.deepEqual(
        st.map((s) => [s.entryId, s.t, s.lat]),
        [
            [1, START + SLOT, -33.9],
            [2, START, -33.86]
        ]
    );
    // Tracks: from the start slot, one point per slot up to now.
    const tr = (e) => get(`/races/${id}/entries/${e}/track/at/live`).then((j) => feed.parseTrack(j, START));
    assert.deepEqual(
        (await tr(1)).map((p) => [p.t, p.lat]),
        [
            [START, -33.85],
            [START + SLOT, -33.9]
        ]
    );
    clock.now = START + 2 * SLOT + 60e3;
    // B's missed slot keeps its place: the third point is at its own slot.
    assert.deepEqual(
        (await tr(2)).map((p) => [p.t, p.lat]),
        [
            [START, -33.86],
            [START + 2 * SLOT, -33.96]
        ]
    );
    assert.equal(await get(`/races/${id}/entries/9/track/at/live`), 404);
    // Before the start: pre-race, nothing in the status.
    clock.now = START - 5 * 60e3;
    assert.equal(feed.parseRace(await get(`/races/${id}`)).status, 'Pre-race');
    assert.deepEqual(
        feed.parseStatus(await get(`/races/${id}/at/live/status`), 'Australia/Sydney').map((s) => s.t),
        [START - SLOT]
    );
    // After the last fix: completed.
    clock.now = START + 4 * SLOT;
    assert.equal(feed.parseRace(await get(`/races/${id}`)).status, 'Race completed');
    // A feed race goes to the network.
    await fetch(feed.FEED_BASE + '/v2/races/198/at/live/status');
    await fetch(feed.FEED_BASE + '/v2/years/2026/series');
    assert.deepEqual(passed, [
        feed.FEED_BASE + '/v2/races/198/at/live/status',
        feed.FEED_BASE + '/v2/years/2026/series'
    ]);
});

test('recorded feed: a rewritten file is read again and reported; a file written later is found', async () => {
    const dir = tmpdir();
    const clock = {now: START + SLOT + 90e3};
    const changed = [];
    const rr = new RecordedRaces({dataDir: dir, clock: () => clock.now, onChange: (id) => changed.push(id)});
    await rr.scan();
    const fetch = rr.fetchWith(async () => ({ok: false, status: 503}));
    const id = recordedId('tollgate');
    const url = `${feed.FEED_BASE}/v2/races/${id}`;
    assert.equal((await fetch(url)).status, 503, 'no file yet');
    // Written after the start-up scan: found by the next request 30 s on.
    fs.writeFileSync(path.join(dir, 'recorded-race-tollgate.json'), JSON.stringify(race()));
    clock.now += 30e3;
    assert.equal(feed.parseRace(await (await fetch(url)).json()).startT, START);
    assert.deepEqual(changed, [], 'new, not changed');
    // Rewritten with another start (a new replay run): read again, and reported.
    const later = race();
    later.race.start = iso(START + 3600e3);
    const file = path.join(dir, 'recorded-race-tollgate.json');
    fs.writeFileSync(file, JSON.stringify(later));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000)); // a new mtime, whatever the fs resolution
    assert.equal(feed.parseRace(await (await fetch(url)).json()).startT, START + 3600e3);
    assert.deepEqual(changed, [id]);
});
