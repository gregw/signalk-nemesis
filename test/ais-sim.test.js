'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {simulate, lerpDeg, rng} = require('./sim/ais-sim');
const data = require('./data/gc2026-tracks.json');

test('rng is deterministic per seed', () => {
    const a = rng(42);
    const b = rng(42);
    const c = rng(43);
    const sa = [a(), a(), a()];
    assert.deepEqual(sa, [b(), b(), b()]);
    assert.notDeepEqual(sa, [c(), c(), c()]);
});

test('COG interpolation goes the short way: 350 to 010 passes 000', () => {
    assert.equal(lerpDeg(350, 10, 0.5), 0);
    assert.equal(lerpDeg(10, 350, 0.25), 5);
});

test('simulation is deterministic and receives only within 20 nm', () => {
    const a = simulate(data, {receiverName: 'Kanreki', seed: 7});
    const b = simulate(data, {receiverName: 'Kanreki', seed: 7});
    assert.equal(a.reports.length, b.reports.length);
    assert.deepEqual(a.reports.slice(0, 50), b.reports.slice(0, 50));
    assert.ok(a.reports.length > 1000, `reports ${a.reports.length}`);
    assert.ok(a.own.length > 4000, `own samples ${a.own.length}`);
});

test('simulated gaps look like AIS (GC2026 measured: median 2 min, p90 7 min)', () => {
    const {reports} = simulate(data, {receiverName: 'Kanreki', seed: 7});
    const last = new Map();
    const gaps = [];
    for (const r of reports) {
        const p = last.get(r.boatId);
        if (p != null && r.t - p <= 30 * 60e3) gaps.push((r.t - p) / 60e3);
        last.set(r.boatId, r.t);
    }
    gaps.sort((x, y) => x - y);
    const q = (f) => gaps[Math.floor(f * (gaps.length - 1))];
    assert.ok(q(0.5) >= 1 && q(0.5) <= 3, `median ${q(0.5)}`);
    assert.ok(q(0.9) >= 4 && q(0.9) <= 10, `p90 ${q(0.9)}`);
});
