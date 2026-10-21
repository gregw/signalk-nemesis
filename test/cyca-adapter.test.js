'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {CycaAdapter} = require('../lib/cyca-adapter');

const detail194 = require('./data/cyca/race-194.json');
const status1200 = require('./data/cyca/status-194-202607261200.json');
const status1210 = require('./data/cyca/status-194-202607261210.json');
const entries194 = require('./data/cyca/entries-194.json');

const RUNNING = {...detail194, status: 'Racing', isRunning: true, endDateUtc: null};

/** Manual timers: run() fires the pending timer (there is at most one). */
function fakeTimers() {
    const t = {pending: null};
    t.setTimeout = (fn, ms) => (t.pending = {fn, ms});
    t.clearTimeout = (h) => {
        if (t.pending === h) t.pending = null;
    };
    return t;
}

function fakeFeed(routes) {
    const calls = [];
    const f = async (url) => {
        calls.push(url);
        const p = url.replace('https://feeds.cycaracing.com/v2', '');
        const r = routes[p];
        if (r instanceof Error) throw r;
        if (r === undefined) return {ok: false, status: 404};
        return {ok: true, json: async () => (typeof r === 'function' ? r() : r)};
    };
    return Object.assign(f, {calls});
}

function make(routes, now) {
    const clock = {now};
    const timers = fakeTimers();
    const reports = [];
    const named = [];
    const fetch = fakeFeed(routes);
    const a = new CycaAdapter({
        fetch,
        timers,
        clock: () => clock.now,
        onReport: (r) => reports.push(r),
        onEntries: (e) => named.push(...e)
    });
    return {a, clock, timers, reports, named, fetch};
}

test('polls at once, then 2 minutes after each 10 minute boundary, reporting racing boats at their slot', async () => {
    const live = {v: status1200};
    const routes = {'/races/194': RUNNING, '/races/194/entries': entries194, '/races/194/at/live/status': () => live.v};
    const {a, clock, timers, reports, named} = make(routes, Date.parse('2026-07-26T02:05:30Z'));
    a.setRace(194);
    assert.equal(timers.pending.ms, 0);
    await a.pollNow();
    assert.deepEqual(
        named.map((e) => e.name),
        entries194.map((e) => e.name)
    );
    // Three racing, two retired (not reported).
    assert.equal(reports.length, 3);
    assert.deepEqual(reports[0], {
        boatId: 'cyca:18921',
        src: 'cyca',
        t: Date.parse('2026-07-26T02:00:00Z'),
        lat: -30.91191,
        lon: 153.13005,
        cogRad: (324 * Math.PI) / 180,
        sogMs: 9.9 * (1852 / 3600)
    });
    assert.equal(timers.pending.ms, Date.parse('2026-07-26T02:12:00Z') - clock.now);
    // The next slot.
    clock.now = Date.parse('2026-07-26T02:12:00Z');
    live.v = status1210;
    await a.pollNow();
    assert.equal(reports.length, 6);
    assert.ok(reports.slice(3).every((r) => r.t === Date.parse('2026-07-26T02:10:00Z')));
    assert.equal(timers.pending.ms, 600e3);
    assert.equal(a.toJSON().lastOkT, clock.now);
    // The same slot again reports nothing.
    await a.pollNow();
    assert.equal(reports.length, 6);
});

test('an unchanged position in a new slot is a missed report', async () => {
    const moved = JSON.parse(JSON.stringify(status1200)).map((s) => ({...s, raceTime: '2026-07-26T12:10:00'}));
    const live = {v: status1200};
    const routes = {'/races/194': RUNNING, '/races/194/entries': entries194, '/races/194/at/live/status': () => live.v};
    const {a, reports, clock} = make(routes, Date.parse('2026-07-26T02:05:00Z'));
    a.setRace(194);
    await a.pollNow();
    live.v = moved;
    clock.now = Date.parse('2026-07-26T02:12:00Z');
    await a.pollNow();
    assert.equal(reports.length, 3);
    assert.equal(a.fleet().find((e) => e.entryId === 18921).last.t, Date.parse('2026-07-26T02:10:00Z'));
});

test('a feed failure is recorded, never thrown, and the next slot is still scheduled', async () => {
    const routes = {'/races/194': new TypeError('fetch failed')};
    const {a, timers, reports} = make(routes, Date.parse('2026-07-26T02:05:00Z'));
    a.setRace(194);
    await a.pollNow();
    assert.equal(a.toJSON().lastError, 'fetch failed');
    assert.equal(reports.length, 0);
    assert.ok(timers.pending && timers.pending.ms > 0);
    // Detail fine, status down.
    routes['/races/194'] = RUNNING;
    routes['/races/194/at/live/status'] = new TypeError('socket hang up');
    await a.pollNow();
    assert.equal(a.toJSON().lastError, 'socket hang up');
    assert.ok(timers.pending);
});

test('before the start, only detail and entries are read, and the next poll is 10 minutes before the start', async () => {
    const pre = {...RUNNING, status: 'Pre-race', isRunning: false};
    const routes = {'/races/194': pre, '/races/194/entries': entries194};
    const now = Date.parse('2026-07-25T00:00:00Z');
    const {a, timers, fetch} = make(routes, now);
    a.setRace(194);
    await a.pollNow();
    assert.ok(!fetch.calls.some((u) => u.includes('/status')));
    assert.equal(timers.pending.ms, Date.parse('2026-07-25T02:50:00Z') - now);
    assert.equal(a.toJSON().lastError, null);
});

test('a completed race stops polling', async () => {
    const routes = {'/races/194': detail194, '/races/194/entries': entries194, '/races/194/at/live/status': []};
    const {a, timers} = make(routes, Date.parse('2026-07-29T00:00:00Z'));
    a.setRace(194);
    await a.pollNow();
    assert.equal(a.toJSON().completed, true);
    assert.equal(timers.pending, null);
});

test('changing race mid-poll drops the old poll results', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const routes = {
        '/races/194': RUNNING,
        '/races/194/entries': entries194,
        '/races/194/at/live/status': () => status1200
    };
    const {a, reports, fetch} = make(routes, Date.parse('2026-07-26T02:05:00Z'));
    const inner = fetch;
    a.fetch = async (url) => {
        if (url.endsWith('/status')) await gate;
        return inner(url);
    };
    a.setRace(194);
    const p = a.pollNow();
    await new Promise((r) => setImmediate(r));
    a.setRace(null);
    release();
    await p;
    assert.equal(reports.length, 0);
    assert.equal(a.toJSON().raceId, null);
});

test('a fix from more than 2 minutes in the future is dropped, from the status and from a track', async () => {
    // The 12:10 slot polled at 12:05 local (02:05Z): not happened yet.
    const ahead = JSON.parse(JSON.stringify(status1200)).map((s) => ({...s, raceTime: '2026-07-26T12:10:00'}));
    const routes = {'/races/194': RUNNING, '/races/194/entries': entries194, '/races/194/at/live/status': ahead};
    const {a, reports, clock} = make(routes, Date.parse('2026-07-26T02:05:00Z'));
    a.setRace(194);
    await a.pollNow();
    assert.equal(reports.length, 0);
    assert.equal(a.fleet().find((e) => e.entryId === 18921).last, null, 'not kept either');
    // Within 2 minutes it is taken.
    clock.now = Date.parse('2026-07-26T02:08:30Z');
    await a.pollNow();
    assert.equal(reports.length, 3);
    // A track: slots up to now + 2 min only.
    const start = Date.parse(RUNNING.startDateUtc + 'Z');
    const pt = {latitude: -33.9, longitude: 151.3, speedOverGround: '8', courseOverGround: '180', isRacing: true};
    routes['/races/194/entries/18921/track/at/live'] = Array.from({length: 6}, () => pt);
    clock.now = start + 3 * 600e3 + 60e3;
    reports.length = 0;
    await a.fillTrack(18921, start, start + 10 * 600e3, () => false);
    assert.deepEqual(
        reports.map((r) => (r.t - start) / 600e3),
        [0, 1, 2, 3]
    );
});
