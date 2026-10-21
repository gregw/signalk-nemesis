'use strict';
/*
 * End to end: our true wind (made up for the GC2026 replay) -> smoothed TWD on our own
 * samples, on each report's copy of our state, in the snapshot and tracks, and kept
 * across a restart from the journal.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {simTwdRad} = require('./sim/ais-sim');
const {replayTo} = require('./sim/replay');
const {fakeApp} = require('./sim/fake-app');
const createPlugin = require('../index');

const API = '/signalk/v1/api/nemesis';
const DEG = Math.PI / 180;
const angDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

test('smoothed TWD reaches the snapshot, the tracks and the reports', async () => {
    const r = await replayTo(6, {wind: true});
    const snap = (await r.app.call('GET', API + '/snapshot')).body;
    const twd = snap.own.twdRad;
    assert.equal(typeof twd, 'number', 'own TWD in the snapshot');
    // Own samples (and so wind readings) come every 60 s: the 120 s window holds three.
    const T = snap.own.t - r.shiftMs;
    const rs = [T - 120e3, T - 60e3, T].map(simTwdRad);
    const want = Math.atan2(
        rs.reduce((a, x) => a + Math.sin(x), 0),
        rs.reduce((a, x) => a + Math.cos(x), 0)
    );
    assert.ok(angDiff(twd, want) < 1e-9, `smoothed ${twd / DEG} vs the mean of the window ${want / DEG}`);

    const tr = (await r.app.call('GET', API + '/tracks', {query: {periodS: '3600'}})).body;
    assert.ok(tr.own.length > 10 && tr.own.every((o) => typeof o.twdRad === 'number'), 'own track has TWD');
    assert.ok(
        tr.ownAtReports.every((o) => typeof o.twdRad === 'number'),
        'our state at each report has TWD'
    );

    // A fresh server process (new app, same data dir): our TWD comes back from the journal.
    await r.plugin.whenReady();
    r.plugin.stop();
    const app2 = fakeApp({dataDir: r.dataDir});
    const again = createPlugin(app2);
    again.signalKApiRoutes(app2.apiRouter);
    again.start({});
    await again.whenReady();
    const tr2 = (await app2.call('GET', API + '/tracks', {query: {periodS: '3600', toT: String(snap.now)}})).body;
    assert.ok(tr2.ownAtReports.length > 10, 'reports reloaded');
    assert.ok(
        tr2.ownAtReports.every((o) => typeof o.twdRad === 'number'),
        'TWD survives a restart'
    );
    again.stop();
});

test('no wind instruments: TWD is null, nothing breaks', async () => {
    const r = await replayTo(1);
    const snap = (await r.app.call('GET', API + '/snapshot')).body;
    assert.equal(snap.own.twdRad, null);
    r.plugin.stop();
});
