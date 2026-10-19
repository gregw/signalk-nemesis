'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {StartTime, RacerStartAdapter, RACER_PATH} = require('../lib/start-time');
const {fakeApp} = require('./sim/fake-app');

const H = 3600e3;
const T0 = Date.parse('2026-07-25T03:00:00Z');
const {tmpdir} = require('./sim/tmpdir');

function make(dir, now = T0 + H) {
    const clock = {now};
    const st = new StartTime({dataDir: dir, maxRaceMs: 96 * H, clock: () => clock.now});
    return {st, clock};
}

test('no source: no start time', () => {
    assert.equal(make(tmpdir()).st.get(), null);
});

test('racer start time is used; reset (null) clears it', async () => {
    const {st} = make(tmpdir());
    await st.racerValue('2026-07-25T03:00:00.000Z');
    assert.deepEqual(st.get(), {t: T0, src: 'racer'});
    await st.racerValue(null);
    assert.equal(st.get(), null);
});

test('override wins over racer, and clearing it falls back to racer', async () => {
    const {st} = make(tmpdir());
    await st.racerValue('2026-07-25T03:00:00Z');
    await st.setOverride('2026-07-25T03:05:00Z');
    assert.deepEqual(st.get(), {t: T0 + 5 * 60e3, src: 'override'});
    await st.setOverride(null);
    assert.equal(st.get().src, 'racer');
});

test('invalid override is rejected', () => {
    const {st} = make(tmpdir());
    assert.throws(() => st.setOverride('not a time'), RangeError);
    assert.throws(() => st.setOverride(''), RangeError);
    assert.throws(() => st.setOverride({}), RangeError);
});

test('both values survive a restart (racer does not persist its own)', async () => {
    const dir = tmpdir();
    const a = make(dir).st;
    await a.racerValue('2026-07-25T03:00:00Z');
    await a.setOverride('2026-07-25T03:01:00Z');
    const b = make(dir).st;
    assert.equal(b.get().src, 'override');
    await b.setOverride(null);
    assert.deepEqual(b.get(), {t: T0, src: 'racer'});
});

test('a start older than the maximum race length is ignored', async () => {
    const {st, clock} = make(tmpdir());
    await st.racerValue('2026-07-25T03:00:00Z');
    clock.now = T0 + 96 * H;
    assert.ok(st.get());
    clock.now = T0 + 96 * H + 1;
    assert.equal(st.get(), null);
});

test('adapter reads an existing racer value, then follows its deltas', async () => {
    const app = fakeApp({dataDir: tmpdir(), selfPaths: {[RACER_PATH]: {value: '2026-07-25T03:00:00Z'}}});
    const {st} = make(tmpdir());
    const ad = new RacerStartAdapter(app, st);
    ad.start();
    assert.deepEqual(st.get(), {t: T0, src: 'racer'});
    const delta = (value) => ({
        context: app.selfContext,
        updates: [{timestamp: new Date(T0).toISOString(), values: [{path: RACER_PATH, value}]}]
    });
    app.deliver(delta('2026-07-25T03:02:00Z'));
    assert.equal(st.get().t, T0 + 2 * 60e3);
    app.deliver(delta(null));
    assert.equal(st.get(), null);
    ad.stop();
    assert.equal(app.subscriptionCount(), 0);
});
