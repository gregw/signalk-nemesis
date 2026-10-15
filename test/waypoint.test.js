'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {WaypointSource} = require('../lib/waypoint');
const {fakeApp} = require('./sim/fake-app');
const geo = require('../lib/geo');

const FINISH = {latitude: -27.96, longitude: 153.44};
const MARK = {latitude: -33.5, longitude: 151.6};

function setup(cfg = {}, ownAt = () => null) {
    const app = fakeApp({dataDir: '/nonexistent'});
    const clock = {now: 1_000_000};
    const w = new WaypointSource(app, cfg, {clock: () => clock.now, ownAt});
    return {app, w, clock};
}

// A raw instrument next point, as nmea0183-signalk RMB would deliver it.
function rmb(app, values, $source = 'nmea0183.EC') {
    app.deliver({
        context: app.selfContext,
        updates: [
            {
                $source,
                source: {type: 'NMEA0183', sentence: 'RMB'},
                timestamp: new Date().toISOString(),
                values
            }
        ]
    });
}
const pos = (p) => ({path: 'navigation.courseRhumbline.nextPoint.position', value: p});

test('no source: null (a configured lat/lon is no longer a source)', () => {
    assert.equal(setup().w.get(), null);
    assert.equal(setup({waypoint: {lat: -27.96, lon: 153.44}}).w.get(), null);
});

test('Course API next point, with href as id', async () => {
    const {app, w} = setup();
    app.course = {nextPoint: {position: FINISH, href: '/resources/waypoints/abc', name: 'Finish'}, activeRoute: null};
    await w._pollCourse();
    assert.deepEqual(w.get(), {
        lat: -27.96,
        lon: 153.44,
        id: '/resources/waypoints/abc',
        name: 'Finish',
        src: 'course'
    });
});

test('Course API error keeps the last known point; cleared course drops it', async () => {
    const {app, w} = setup();
    app.course = {nextPoint: {position: FINISH}};
    await w._pollCourse();
    app.course = new Error('boom');
    await w._pollCourse();
    assert.equal(w.get().src, 'course');
    app.course = {nextPoint: null};
    await w._pollCourse();
    assert.equal(w.get(), null);
});

test('raw NMEA next point, ignoring the Course API copy, expiring when stale', () => {
    const {app, w, clock} = setup({nmeaWaypointStaleSeconds: 30});
    w.start();
    rmb(app, [pos(MARK)], 'courseApi');
    assert.equal(w.get(), null, 'courseApi $source is not raw NMEA');
    rmb(app, [pos(MARK)]);
    assert.equal(w.get().src, 'nmea');
    assert.equal(w.get().lat, MARK.latitude);
    clock.now += 30e3;
    assert.ok(w.get());
    clock.now += 1;
    assert.equal(w.get(), null, 'stale');
    w.stop();
});

test('precedence is configurable between Course API and NMEA', async () => {
    for (const [order, want] of [
        ['course,nmea', 'course'],
        ['nmea,course', 'nmea']
    ]) {
        const {app, w} = setup({waypointOrder: order});
        app.course = {nextPoint: {position: FINISH}};
        await w._pollCourse();
        w.start();
        rmb(app, [pos(MARK)]);
        assert.equal(w.get().src, want, order);
        w.stop();
    }
});

test('bearing and distance only: projected from our position at that time', () => {
    const us = {lat: -33.8, lon: 151.3};
    const {app, w} = setup({}, () => us);
    w.start();
    const d = 10 * 1852;
    rmb(app, [
        {path: 'navigation.courseRhumbline.nextPoint.bearingTrue', value: Math.PI / 4},
        {path: 'navigation.courseRhumbline.nextPoint.distance', value: d}
    ]);
    const p = w.get();
    assert.equal(p.src, 'nmea');
    assert.ok(p.projected);
    assert.ok(Math.abs(geo.distance(us, p) - d) < 1, 'distance');
    assert.ok(Math.abs(geo.bearing(us, p) - Math.PI / 4) < 1e-6, 'bearing');
    w.stop();
});

test('named waypoint from the resources API, below Course API', async () => {
    const {app, w} = setup({waypointName: 'GC Finish'});
    app.resources.waypoints = {
        x1: {name: 'Other', feature: {geometry: {type: 'Point', coordinates: [150, -30]}}},
        x2: {name: 'GC Finish', feature: {geometry: {type: 'Point', coordinates: [153.44, -27.96]}}}
    };
    await w._pollNamed();
    assert.deepEqual(w.get(), {lat: -27.96, lon: 153.44, id: 'named:x2', name: 'GC Finish', src: 'named'});
    app.course = {nextPoint: {position: MARK}};
    await w._pollCourse();
    assert.equal(w.get().src, 'course');
});

test('Course API point adopted from NMEA expires with the NMEA source', async () => {
    const {app, w, clock} = setup({nmeaWaypointStaleSeconds: 30});
    // The Course API adopted it: no href, same position, generic name.
    app.course = {nextPoint: {position: FINISH, name: 'DP', type: 'Location'}};
    await w._pollCourse();
    w.start();
    rmb(app, [pos(FINISH)]);
    assert.equal(w.get().src, 'course');
    assert.equal(w.get().name, null, 'generic name dropped');
    clock.now += 31e3;
    assert.equal(w.get(), null, 'adopted point expired with the NMEA');
    // A real destination (href) at the same place does not expire.
    app.course = {nextPoint: {position: FINISH, href: '/resources/waypoints/f', name: 'Finish'}};
    await new Promise((resolve) => setImmediate(resolve)); // let start()'s first poll finish
    await w._pollCourse();
    assert.equal(w.get().src, 'course');
    // Nor does a route point (no href) that happens to coincide with the old NMEA point.
    app.course = {
        nextPoint: {position: FINISH, type: 'RoutePoint'},
        activeRoute: {href: '/resources/routes/x', pointIndex: 2, pointTotal: 3}
    };
    await w._pollCourse();
    assert.equal(w.get().src, 'course');
    w.stop();
});
