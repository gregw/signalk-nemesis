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

    // The nav PC's RMB next point is the waypoint (no Course API destination in the fake app).
    assert.equal(body.waypoint.src, 'nmea');
    assert.equal(body.waypoint.id, 'nmea:FINISH');
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

test('start time: PUT override shows in the snapshot and survives restart', async () => {
    const {app, plugin} = await replayTo(3, {racerStart: false});
    assert.equal((await app.call('GET', API + '/snapshot')).body.start, null);
    assert.equal((await app.put(PUT_PATHS.setStartTime, {})).status, 400);
    assert.equal((await app.put(PUT_PATHS.setStartTime, {startTime: 'soon'})).status, 400);
    const iso = new Date(Date.now() - 3 * 3600e3).toISOString();
    assert.equal((await app.put(PUT_PATHS.setStartTime, {startTime: iso})).status, 200);
    assert.deepEqual((await app.call('GET', API + '/snapshot')).body.start, {t: Date.parse(iso), src: 'override'});
    plugin.stop();
    plugin.start({});
    assert.equal((await app.call('GET', API + '/snapshot')).body.start.src, 'override');
    assert.equal((await app.put(PUT_PATHS.setStartTime, {startTime: null})).status, 200);
    assert.equal((await app.call('GET', API + '/snapshot')).body.start, null);
    plugin.stop();
});

test('track history survives a plugin restart (journal)', async () => {
    const {app, plugin, dataDir} = await replayTo(12);
    await plugin.whenReady();
    const before = (await app.call('GET', API + '/snapshot')).body;
    const tracksBefore = (await app.call('GET', API + '/tracks', {query: {periodS: '86400'}})).body;
    plugin.stop();

    // A fresh server process: new app, nothing delivered, same data dir.
    const {fakeApp} = require('./sim/fake-app');
    const app2 = fakeApp({dataDir});
    const plugin2 = require('../index')(app2);
    plugin2.signalKApiRoutes(app2.apiRouter);
    plugin2.start({});
    await plugin2.whenReady();
    const after = (await app2.call('GET', API + '/snapshot')).body;
    assert.equal(after.boats.length, before.boats.length);
    for (const b of before.boats) {
        const a = after.boats.find((x) => x.id === b.id);
        assert.ok(a, b.name);
        assert.equal(a.name, b.name);
        assert.deepEqual(a.latest, b.latest);
        assert.equal(a.rangeM, b.rangeM, `${b.name} range`);
    }
    // Instant replay processes each boat's last report only after everything is
    // delivered, so a boat last heard more than the 6 h own-state window ago has no
    // stored own state. Live, reports are processed within 250 ms. Most have a range.
    assert.ok(after.boats.filter((b) => b.rangeM != null).length >= after.boats.length * 0.8);
    const tracksAfter = (await app2.call('GET', API + '/tracks', {query: {periodS: '86400'}})).body;
    for (const [id, rs] of Object.entries(tracksBefore.boats)) {
        assert.equal(tracksAfter.boats[id].length, rs.length, `track length ${id}`);
    }
    plugin2.stop();
});

test('snapshot carries the TCF VMG period, racer start and oldest history time', async () => {
    const {app, plugin, now} = await replayTo(6);
    const s = (await app.call('GET', API + '/snapshot')).body;
    assert.equal(s.tcfVmgMs, 600e3, 'default 10 min');
    assert.equal(s.start.src, 'racer');
    assert.ok(Math.abs(s.start.t - (now - 6 * 3600e3)) < 1000, 'start 6 h ago');
    assert.ok(s.oldestT <= now - 5 * 3600e3, 'history goes back toward the start');
    assert.equal(s.tcfUs, 1);
    assert.equal((await app.put(PUT_PATHS.setTcf, {id: 'self', tcf: 1.05})).status, 200);
    assert.equal((await app.call('GET', API + '/snapshot')).body.tcfUs, 1.05);
    plugin.stop();
});

test('tracks: window ending at toT, incremental sinceT, own track thinned', async () => {
    const {app, plugin, now} = await replayTo(6);
    const get = async (query) => (await app.call('GET', API + '/tracks', {query})).body;
    const all = await get({periodS: '3600'});
    const reports = Object.values(all.boats).flat();
    assert.ok(reports.length > 50, `reports ${reports.length}`);
    assert.ok(reports.every((r) => r.t >= all.fromT && r.t <= all.toT));
    assert.ok(
        all.own.length >= 55 && all.own.length <= 121,
        `own samples ${all.own.length} (sim: 1 per min; at most 1 per 30 s)`
    );
    assert.ok(all.ownAtReports.length > 0);

    const maxT = Math.max(...reports.map((r) => r.t));
    const inc = await get({periodS: '3600', sinceT: String(maxT - 600e3)});
    const incReports = Object.values(inc.boats).flat();
    assert.ok(incReports.length > 0 && incReports.every((r) => r.t > maxT - 600e3), 'only newer');
    assert.ok(incReports.length < reports.length);

    const back = await get({periodS: '3600', toT: String(now - 3 * 3600e3)});
    const backReports = Object.values(back.boats).flat();
    assert.ok(backReports.length > 0 && backReports.every((r) => r.t <= now - 3 * 3600e3), 'history window');
    assert.equal((await app.call('GET', API + '/tracks', {query: {toT: 'x'}})).status, 400);
    plugin.stop();
});
