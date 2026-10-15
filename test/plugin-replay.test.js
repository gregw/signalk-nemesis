'use strict';
/*
 * End to end: GC2026 recorded race -> seeded AIS simulator -> Signal K deltas
 * (split per path) -> plugin ingest -> REST snapshot.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {NM} = require('./sim/ais-sim');
const {replayTo} = require('./sim/replay');
const {PUT_PATHS} = require('../index');

const API = '/signalk/v1/api/nemesis';

test('snapshot after 6 h of simulated AIS', async () => {
    const {app, plugin} = await replayTo(6);
    const {status, body} = await app.call('GET', API + '/snapshot');
    assert.equal(status, 200);
    assert.ok(body.own, 'own state present');
    assert.ok(body.boats.length > 3, `boats ${body.boats.length}`);
    assert.ok(!body.boats.some((b) => b.id === app.selfId), 'self not listed as competitor');

    const calibre = body.boats.find((b) => b.name === 'Calibre 12');
    assert.ok(calibre, 'Calibre 12 heard and named');
    assert.ok(
        body.boats.every((b) => b.name),
        'every boat named'
    );

    for (const b of body.boats) {
        assert.equal(b.current, b.ageMs <= body.staleMs, `${b.name} current flag`);
        // Range uses our state at their report time, and the simulator drops >= 20 nm.
        assert.ok(b.rangeM != null && b.rangeM < 20 * NM, `${b.name} range ${b.rangeM}`);
        assert.equal(typeof b.latest.cogRad, 'number');
    }
    plugin.stop();
    assert.equal(app.subscriptionCount(), 0, 'unsubscribed on stop');
});

test('track history is bounded and in time order', async () => {
    const {app, plugin} = await replayTo(12, {config: {historySeconds: 3600, maxReportsPerBoat: 15}});
    const {body} = await app.call('GET', API + '/tracks', {query: {periodS: '86400'}});
    for (const [id, rs] of Object.entries(body.boats)) {
        assert.ok(rs.length <= 15, `${id} has ${rs.length}`);
        for (let i = 1; i < rs.length; i++) assert.ok(rs[i].t > rs[i - 1].t);
        assert.ok(rs[rs.length - 1].t - rs[0].t <= 3600e3);
    }
    assert.ok(body.ownAtReports.length > 0);
    plugin.stop();
});

test('reads are served on both the plugin mount and the Signal K API mount', async () => {
    const {app, plugin} = await replayTo(2);
    const a = await app.call('GET', '/plugins/signalk-nemesis/user');
    const b = await app.call('GET', API + '/user');
    assert.equal(a.status, 200);
    assert.deepEqual(a.body, b.body);
    plugin.stop();
});

test('nemesis and TCF PUT handlers validate and persist', async () => {
    const {app, plugin} = await replayTo(1);
    assert.equal((await app.put(PUT_PATHS.setNemesis, {id: '1', nemesis: 'yes'})).status, 400);
    assert.equal((await app.put(PUT_PATHS.setNemesis, {nemesis: true})).status, 400);
    assert.equal((await app.put(PUT_PATHS.setTcf, {id: '1', tcf: -1})).status, 400);
    assert.equal((await app.put(PUT_PATHS.setNemesis, {id: '1', nemesis: true})).status, 200);
    assert.equal((await app.put(PUT_PATHS.setTcf, {id: '1', tcf: 1.1})).status, 200);
    const user = (await app.call('GET', API + '/user')).body;
    assert.deepEqual(user.nemesis, ['1']);
    assert.equal(user.tcf['1'], 1.1);

    // stopped: reads and writes refuse cleanly
    plugin.stop();
    assert.equal((await app.call('GET', API + '/snapshot')).status, 503);
    assert.equal((await app.put(PUT_PATHS.setNemesis, {id: '2', nemesis: true})).status, 503);

    // restart: state comes back from disk
    plugin.start({});
    assert.deepEqual((await app.call('GET', API + '/user')).body.nemesis, ['1']);
    plugin.stop();
});
