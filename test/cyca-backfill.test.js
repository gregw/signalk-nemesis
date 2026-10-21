'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {BackfillPlanner, hasGap} = require('../lib/cyca-backfill');
const {CycaAdapter} = require('../lib/cyca-adapter');

const M = 60e3;
const T0 = Date.parse('2026-07-25T03:00:00Z');
const items = (...mins) => mins.map((m) => ({t: T0 + m * M}));
const boat = (id, cycaId, ...mins) => ({id, cycaId, track: {items: items(...mins)}});

test('hasGap finds gaps longer than stale at either end and between reports', () => {
    const S = 30 * M;
    assert.equal(hasGap(items(5, 30, 55), T0, T0 + 60 * M, S), false);
    assert.equal(hasGap(items(5, 40), T0, T0 + 60 * M, S), true); // 5 to 40
    assert.equal(hasGap(items(35, 50), T0, T0 + 60 * M, S), true); // start to 35
    assert.equal(hasGap(items(5, 25), T0, T0 + 60 * M, S), true); // 25 to now
    assert.equal(hasGap([], T0, T0 + 20 * M, S), false);
});

test('only nemesis boats with a CYCA entry and a gap are planned, from the start at the earliest', () => {
    const p = new BackfillPlanner();
    const now = T0 + 120 * M;
    const boats = [
        boat('503000001', 'cyca:1', 110), // linked nemesis, gap
        boat('cyca:2', null, 110), // unlinked nemesis, gap
        boat('cyca:3', null, 110), // not a nemesis
        boat('503000004', null, 110), // AIS only: nothing to fetch
        boat('503000005', 'cyca:5', ...[60, 70, 80, 90, 100, 110, 119]) // no gap
    ];
    const nemesis = new Set(['503000001', 'cyca:2', '503000004', '503000005']);
    const plan = p.plan({
        boats,
        isNemesis: (id) => nemesis.has(id),
        now,
        periodMs: 240 * M,
        staleMs: 30 * M,
        startT: T0 + 60 * M
    });
    assert.deepEqual(plan, [
        {entryId: 1, fromT: T0 + 60 * M, toT: now},
        {entryId: 2, fromT: T0 + 60 * M, toT: now}
    ]);
});

test('a filled boat waits 10 min, an unfillable one an hour, a longer period goes again at once', () => {
    const p = new BackfillPlanner();
    const b = [boat('cyca:1', null, 110)];
    const args = (now, periodMs = 60 * M) => ({
        boats: b,
        isNemesis: () => true,
        now,
        periodMs,
        staleMs: 30 * M,
        startT: null
    });
    const now = T0 + 120 * M;
    assert.equal(p.plan(args(now)).length, 1);
    p.done(1, now - 60 * M, now, 5);
    assert.equal(p.plan(args(now + 5 * M)).length, 0);
    assert.equal(p.plan(args(now + 11 * M)).length, 1);
    p.done(1, now - 60 * M, now + 11 * M, 0);
    assert.equal(p.plan(args(now + 30 * M)).length, 0);
    assert.equal(p.plan(args(now + 30 * M, 240 * M)).length, 1); // the period was extended
    p.done(1, now - 60 * M, now, null); // failed: try again next time
    assert.equal(p.plan(args(now + 1 * M)).length, 1);
});

test('fillTrack reports the missing slots in the window, one fetch at a time', async () => {
    const track = require('./data/cyca/track-194-18921-202607261200.json');
    const detail = {...require('./data/cyca/race-194.json'), status: 'Racing', isRunning: true};
    let inFlight = 0;
    let maxInFlight = 0;
    const fetch = async (url) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setImmediate(r));
        inFlight--;
        const p = url.replace('https://feeds.cycaracing.com/v2', '');
        if (p === '/races/194') return {ok: true, json: async () => detail};
        if (p === '/races/194/entries') return {ok: true, json: async () => []};
        if (p.startsWith('/races/194/entries/18921/track/at/live')) return {ok: true, json: async () => track};
        return {ok: false, status: 404};
    };
    const reports = [];
    const timers = {setTimeout: () => null, clearTimeout: () => {}};
    // Now is when the track was fetched (12:00 local), so its slots are not in the future.
    const now = Date.parse('2026-07-26T02:00:00Z');
    const a = new CycaAdapter({fetch, timers, clock: () => now, onReport: (r) => reports.push(r)});
    a.setRace(194);
    await a.pollNow(); // reads the race detail (start time)
    const from = Date.parse('2026-07-26T00:00:00Z');
    const to = Date.parse('2026-07-26T02:00:00Z');
    const have = new Set([Date.parse('2026-07-26T01:00:00Z')]);
    const [n1, n2] = await Promise.all([
        a.fillTrack(18921, from, to, (t) => have.has(t)),
        a.fillTrack(18921, from, to)
    ]);
    assert.equal(n1, 12); // 13 slots 00:00 to 02:00, less the one we have
    assert.equal(n2, 13);
    assert.equal(maxInFlight, 1);
    assert.ok(reports.every((r) => r.boatId === 'cyca:18921' && r.src === 'cyca' && r.t >= from && r.t <= to));
    assert.equal(await a.fillTrack(99999, from, to), null); // 404
});
