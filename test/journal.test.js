'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Journal} = require('../lib/journal');
const {TrackStore} = require('../lib/track-store');
const {thinReports} = require('../lib/thin');

const MIN = 60e3;
const H = 3600e3;
const T0 = Date.parse('2026-07-25T03:00:00Z'); // a segment boundary for 10 min segments

function make(clock, extra = {}) {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-j-')), 'journal');
    const errors = [];
    const j = new Journal({
        dir,
        retainMs: 120 * H,
        recentMs: 6 * H,
        thinMs: 2 * MIN,
        clock: () => clock.now,
        onError: (e) => errors.push(e),
        ...extra
    });
    return {j, dir, errors};
}
const rep = (boatId, t) => ({k: 'r', boatId, t, lat: -33, lon: 151, cogRad: 0, sogMs: 3, src: 'ais', us: null});

async function loadAll(j) {
    const out = [];
    await j.load((r) => out.push(r));
    return out;
}

test('append, flush and load round trip', async () => {
    const clock = {now: T0};
    const {j, dir} = make(clock);
    await j.load(() => {});
    j.append(rep('a', T0));
    j.append({k: 'n', id: 'a', name: 'Alpha'});
    await j.flush();
    const {j: j2} = make(clock);
    j2.dir = dir;
    const recs = await loadAll(j2);
    assert.deepEqual(
        recs.map((r) => r.k),
        ['r', 'n']
    );
});

test('a torn last line is skipped', async () => {
    const clock = {now: T0};
    const {j, dir} = make(clock);
    await j.load(() => {});
    j.append(rep('a', T0));
    await j.flush();
    fs.appendFileSync(path.join(dir, `seg-${T0}.jsonl`), '{"k":"r","boatId":"a","t":');
    const recs = await loadAll(j);
    assert.equal(recs.length, 1);
});

test('segments roll over with the clock and load oldest first', async () => {
    const clock = {now: T0 + MIN};
    const {j, dir} = make(clock);
    await j.load(() => {});
    j.append(rep('a', 1));
    await j.flush();
    clock.now = T0 + 11 * MIN;
    j.append(rep('a', 2));
    await j.flush();
    assert.deepEqual(fs.readdirSync(dir).sort(), [`seg-${T0}.jsonl`, `seg-${T0 + 10 * MIN}.jsonl`]);
    assert.deepEqual(
        (await loadAll(j)).map((r) => r.t),
        [1, 2]
    );
});

test('old segments are compacted: reports thinned per boat, own state dropped, names kept', async () => {
    const clock = {now: T0};
    const {j, dir} = make(clock);
    await j.load(() => {});
    for (let m = 0; m < 10; m++) {
        j.append(rep('a', T0 + m * MIN));
        j.append(rep('b', T0 + m * MIN + 30e3));
        j.append({k: 'o', t: T0 + m * MIN, lat: -33, lon: 151});
    }
    j.append({k: 'n', id: 'a', name: 'Alpha'});
    await j.flush();
    clock.now = T0 + 7 * H;
    await j.maintain();
    assert.deepEqual(fs.readdirSync(dir), [`seg-${T0}.thin.jsonl`]);
    const recs = await loadAll(j);
    assert.equal(recs.filter((r) => r.k === 'o').length, 0);
    assert.equal(recs.filter((r) => r.k === 'n').length, 1);
    const a = recs.filter((r) => r.boatId === 'a').map((r) => (r.t - T0) / MIN);
    assert.deepEqual(a, [0, 2, 4, 6, 8]);
    assert.equal(recs.filter((r) => r.boatId === 'b').length, 5);
});

test('segments older than the retention are deleted', async () => {
    const clock = {now: T0};
    const {j, dir} = make(clock);
    await j.load(() => {});
    j.append(rep('a', T0));
    await j.flush();
    clock.now = T0 + 120 * H + 10 * MIN;
    await j.maintain();
    assert.deepEqual(fs.readdirSync(dir), []);
});

test('clock jumping back into a compacted segment: compaction merges, nothing lost', async () => {
    const clock = {now: T0};
    const {j, dir} = make(clock);
    await j.load(() => {});
    j.append(rep('a', 100));
    await j.flush();
    clock.now = T0 + 7 * H;
    await j.maintain(); // seg-T0 compacted
    clock.now = T0 + 5 * MIN; // clock jumps back
    j.append(rep('b', 200));
    await j.flush();
    assert.equal((await loadAll(j)).length, 2, 'thin and raw files both read');
    clock.now = T0 + 7 * H;
    await j.maintain();
    assert.deepEqual(fs.readdirSync(dir), [`seg-${T0}.thin.jsonl`]);
    assert.deepEqual((await loadAll(j)).map((r) => r.boatId).sort(), ['a', 'b']);
});

test('stop writes the buffer synchronously; load can be cancelled', async () => {
    const clock = {now: T0};
    const {j} = make(clock);
    await j.load(() => {});
    for (let i = 0; i < 5000; i++) j.append(rep('a', i));
    j.stop();
    assert.equal((await loadAll(j)).length, 5000);
    let n = 0;
    await j.load(
        () => n++,
        () => n >= 10
    );
    assert.equal(n, 10);
});

test('thinReports keeps one report per boat per interval', () => {
    const rs = [rep('a', 0), rep('a', 60e3), rep('a', 120e3), rep('b', 10e3), rep('a', 250e3)];
    assert.deepEqual(
        thinReports(rs, 120e3).map((r) => r.boatId + r.t),
        ['a0', 'b10000', 'a120000', 'a250000']
    );
});

test('TrackStore.thin thins only history older than the recent window, incrementally', () => {
    const s = new TrackStore({maxSpanMs: 1e12, maxReportsPerBoat: 1e6});
    for (let m = 0; m < 600; m++) s.add({boatId: 'a', t: m * MIN});
    const now = 600 * MIN;
    s.thin(now, 6 * H, 2 * MIN);
    const ts = s.get('a').track.items.map((r) => r.t / MIN);
    assert.ok(
        ts.filter((t) => t < 240).every((t) => t % 2 === 0),
        'old: every 2 min'
    );
    assert.equal(ts.filter((t) => t >= 240).length, 360, 'recent 6 h untouched');
    const before = ts.length;
    s.thin(now, 6 * H, 2 * MIN);
    assert.equal(s.get('a').track.items.length, before, 'idempotent');
    s.thin(now + 10 * MIN, 6 * H, 2 * MIN);
    assert.equal(s.get('a').track.items.length, before - 5, 'next 10 min thinned to 5');
});
