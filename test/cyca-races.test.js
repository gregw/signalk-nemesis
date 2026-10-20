'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {CycaRaces, candidates} = require('../lib/cyca-races');
const {tmpdir} = require('./sim/tmpdir');

const NOW = Date.parse('2026-10-20T00:00:00Z');
const D = 24 * 3600e3;

/** A fetch serving the saved feed responses; anything else is a 404, or every call fails when down. */
function fakeFeed(routes, state = {down: false, calls: []}) {
    const f = async (url) => {
        state.calls.push(url);
        if (state.down) throw new TypeError('fetch failed');
        const p = url.replace('https://feeds.cycaracing.com/v2', '');
        if (!(p in routes)) return {ok: false, status: 404};
        return {ok: true, json: async () => routes[p]};
    };
    return Object.assign(f, {state});
}

const ROUTES = {
    '/years/2026/series': [14, 99],
    '/years/2027/series': [17],
    '/series/14/races': require('./data/cyca/series-14-races.json'),
    '/series/17/races': [
        {
            raceId: 177,
            year: 2027,
            status: 'Pre-race',
            startDateUtc: '2027-02-27T02:00:00',
            isCurrent: true,
            isRunning: false,
            timeZone: 'Australia/Sydney'
        }
    ],
    '/races/197/entries': require('./data/cyca/entries-197.json')
};

test('candidates: future, pre-race, running and recent races, soonest first, no repeats', () => {
    const r = (raceId, startT, status = 'Race completed', running = false) => ({raceId, startT, status, running});
    const list = candidates(
        [
            r(1, NOW - 10 * D),
            r(2, NOW - 2 * D),
            r(3, NOW + 5 * D, 'Pre-race'),
            r(4, NOW - 20 * D, 'Racing', true),
            r(3, NOW + 5 * D, 'Pre-race')
        ],
        NOW
    );
    assert.deepEqual(
        list.map((x) => x.raceId),
        [4, 2, 3]
    );
});

test('refresh lists upcoming races with fleet, slug name and our entry, and caches them', async () => {
    const dir = tmpdir();
    const fetch = fakeFeed(ROUTES);
    const races = new CycaRaces({fetch, dataDir: dir, clock: () => NOW, ourName: () => 'ambition'});
    const out = await races.refresh();
    assert.equal(out.error, null);
    assert.deepEqual(
        out.races.map((r) => r.raceId),
        [197, 177]
    );
    const bird = out.races[0];
    assert.equal(bird.name, 'Bird Island Race');
    assert.equal(bird.fleet, 4);
    assert.equal(bird.entered, true);
    assert.equal(bird.startT, Date.parse('2026-11-13T23:00:00Z'));
    assert.equal(out.races[1].fleet, null); // entries not available
    assert.equal(out.races[1].entered, false);
    // A restart offline still has the list.
    const again = new CycaRaces({fetch: fakeFeed(ROUTES, {down: true, calls: []}), dataDir: dir, clock: () => NOW});
    assert.equal(again.races.length, 2);
    assert.equal(again.byId(197).name, 'Bird Island Race');
});

test('a failed refresh keeps the previous list and reports the error', async () => {
    const dir = tmpdir();
    const state = {down: false, calls: []};
    const races = new CycaRaces({fetch: fakeFeed(ROUTES, state), dataDir: dir, clock: () => NOW});
    await races.refresh();
    state.down = true;
    const out = await races.refresh();
    assert.equal(out.error, 'CYCA feed unreachable');
    assert.equal(out.races.length, 2);
    assert.equal(out.fetchedT, NOW);
});

test('concurrent refreshes share one run', async () => {
    const state = {down: false, calls: []};
    const races = new CycaRaces({fetch: fakeFeed(ROUTES, state), dataDir: tmpdir(), clock: () => NOW});
    const [a, b] = await Promise.all([races.refresh(), races.refresh()]);
    assert.equal(a, b);
    assert.equal(state.calls.filter((u) => u.endsWith('/years/2026/series')).length, 1);
});

test('an unnamed race takes the name of a named race with the same start', async () => {
    const race = (raceId) => ({
        raceId,
        year: 2026,
        status: 'Pre-race',
        startDateUtc: '2026-12-26T02:00:00',
        isRunning: false,
        timeZone: 'Australia/Sydney'
    });
    const entry = (raceEntryId, cmsUrl) => ({raceEntryId, name: 'Kanreki', cmsUrl});
    const routes = {
        '/years/2026/series': [2, 15],
        '/series/2/races': [race(199)],
        '/series/15/races': [race(200)],
        '/races/199/entries': [entry(1, '/the-yachts/2026/kanreki/')],
        '/races/200/entries': [entry(2, '/the-yachts/rolex-sydney-hobart-yacht-race/2026/kanreki/')]
    };
    const races = new CycaRaces({fetch: fakeFeed(routes), dataDir: tmpdir(), clock: () => NOW});
    const out = await races.refresh();
    assert.deepEqual(
        out.races.map((r) => [r.raceId, r.name]),
        [
            [199, 'Rolex Sydney Hobart Yacht Race'],
            [200, 'Rolex Sydney Hobart Yacht Race']
        ]
    );
});
