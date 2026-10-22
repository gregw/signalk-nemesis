'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const feed = require('../lib/cyca-feed');
const {fetchTcfs} = require('../lib/cyca-handicap');
const {handicapRoute} = require('./sim/cyca-sim');

const BASE = 'https://feeds.cycaracing.com/v2';

/** The fixture as a feed; `down` paths answer 503. */
function fake(down = []) {
    const f = async (url) => {
        f.calls.push(url);
        const p = url.replace(BASE, '');
        if (down.some((d) => p.endsWith(d))) return {ok: false, status: 503};
        const json = handicapRoute(p);
        return json ? {ok: true, json: async () => json} : {ok: false, status: 404};
    };
    f.calls = [];
    return f;
}

test('categories and results parse: IRC found, TCFs kept, bad rows dropped', () => {
    const cats = feed.parseCategories(handicapRoute('/races/198'));
    assert.deepEqual(
        cats.find((c) => c.name === 'IRC'),
        {id: 1148, name: 'IRC', type: 'Handicap', isDefault: true}
    );
    assert.equal(cats.length, 7);
    const rows = feed.parseResults([
        ...handicapRoute('/races/198/categories/1148/results/at/live'),
        {raceEntryId: 1, nameRace: 'no tcf', tcf: null},
        {raceEntryId: 2, nameRace: 'zero', tcf: 0},
        {raceEntryId: 'x', tcf: 1.1},
        null
    ]);
    assert.equal(rows.length, 23);
    assert.deepEqual(
        rows.find((r) => r.entryId === 19073),
        {entryId: 19073, name: 'Kanreki', tcf: 1.107}
    );
    assert.deepEqual(feed.parseCategories(null), []);
});

test('fetchTcfs: the IRC category, live results, final when live fails; never throws', async () => {
    const f = fake();
    const r = await fetchTcfs({fetch: f, raceId: 198});
    assert.deepEqual([r.ok, r.category, r.rows.length], [true, {id: 1148, name: 'IRC'}, 23]);
    assert.deepEqual(f.calls, [`${BASE}/races/198`, `${BASE}/races/198/categories/1148/results/at/live`]);

    const g = fake(['/at/live']);
    const r2 = await fetchTcfs({fetch: g, raceId: 194});
    assert.deepEqual([r2.ok, r2.category.id, r2.rows.length], [true, 1120, 39]);
    assert.ok(g.calls.at(-1).endsWith('/categories/1120/results/at/final'));

    assert.deepEqual(await fetchTcfs({fetch: fake(['/at/live', '/at/final']), raceId: 198}), {
        ok: false,
        error: 'IRC results: HTTP 503'
    });
    assert.deepEqual(await fetchTcfs({fetch: fake(), raceId: 5}), {ok: false, error: 'race detail: HTTP 404'});
    const r3 = await fetchTcfs({fetch: fake(), raceId: 198, categoryName: 'ORCi'});
    assert.deepEqual(r3, {ok: false, error: 'no ORCi category in this race'});
    const boom = async () => {
        throw new TypeError('fetch failed');
    };
    assert.deepEqual(await fetchTcfs({fetch: boom, raceId: 198}), {ok: false, error: 'race detail: fetch failed'});
});
