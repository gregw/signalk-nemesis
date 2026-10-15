'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {RingBuffer, TrackStore, currentReport} = require('../lib/track-store');

const r = (boatId, t, extra = {}) => ({boatId, t, lat: 0, lon: 0, cogRad: 0, sogMs: 0, src: 'ais', ...extra});

test('ring buffer keeps time order, replaces duplicates and evicts oldest', () => {
    const b = new RingBuffer(3);
    b.insert({t: 10});
    b.insert({t: 30});
    b.insert({t: 20});
    assert.deepEqual(
        b.items.map((x) => x.t),
        [10, 20, 30]
    );
    b.insert({t: 20, v: 'new'});
    assert.equal(b.items[1].v, 'new');
    assert.equal(b.length, 3);
    const evicted = b.insert({t: 40});
    assert.equal(evicted.t, 10);
    assert.deepEqual(
        b.items.map((x) => x.t),
        [20, 30, 40]
    );
});

test('atOrBefore binary search', () => {
    const b = new RingBuffer(10);
    for (const t of [10, 20, 30]) b.insert({t});
    assert.equal(b.atOrBefore(5), null);
    assert.equal(b.atOrBefore(10).t, 10);
    assert.equal(b.atOrBefore(25).t, 20);
    assert.equal(b.atOrBefore(99).t, 30);
});

test('store trims each boat to its time span', () => {
    const s = new TrackStore({maxSpanMs: 100, maxReportsPerBoat: 100});
    for (const t of [0, 50, 100, 150, 200]) s.add(r('a', t));
    assert.deepEqual(
        s.get('a').track.items.map((x) => x.t),
        [100, 150, 200]
    );
});

test('store caps boat count, evicting the least recently heard, never the new one', () => {
    const s = new TrackStore({maxBoats: 2});
    s.add(r('a', 100));
    s.add(r('b', 200));
    s.add(r('c', 300));
    assert.deepEqual(
        s
            .all()
            .map((b) => b.id)
            .sort(),
        ['b', 'c']
    );
});

test('currentReport bridges gaps up to the stale threshold', () => {
    const b = new RingBuffer(10);
    b.insert({t: 0});
    const stale = 30 * 60e3;
    assert.equal(currentReport(b, stale, stale).t, 0);
    assert.equal(currentReport(b, stale + 1, stale), null);
});
