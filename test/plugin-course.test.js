'use strict';
/*
 * The course in the plugin: seeded from the old waypointNames config, then set over
 * PUT (marks, or a route imported), resolved against the waypoint resources, in the
 * snapshot, and kept across a restart.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {setTimeout: sleep} = require('node:timers/promises');
const {replayTo} = require('./sim/replay');
const {PUT_PATHS} = require('../index');
const createPlugin = require('../index');
const {fakeApp} = require('./sim/fake-app');
const {tmpdir} = require('./sim/tmpdir');

const API = '/signalk/v1/api/nemesis';
const point = (name, lat, lon) => ({
    name,
    feature: {type: 'Feature', geometry: {type: 'Point', coordinates: [lon, lat]}}
});
const RESOURCES = {
    waypoints: {
        'u-j': point('Jervis', -35.074, 150.8508),
        'u-t': point('Tollgate', -35.7451, 150.2626),
        'u-n': point('NorthHead', -33.8288, 151.304)
    },
    routes: {
        'r-1': {
            name: 'Tollgate Islands',
            feature: {
                type: 'Feature',
                geometry: {
                    type: 'LineString',
                    coordinates: [
                        [150.8508, -35.074],
                        [150.2626, -35.7451],
                        [150.8508, -35.074],
                        [151.31, -33.83]
                    ]
                },
                properties: {
                    coordinatesMeta: [
                        {href: '/resources/waypoints/u-j'},
                        {href: '/resources/waypoints/u-t'},
                        {href: '/resources/waypoints/u-j'},
                        {name: 'Finish'}
                    ]
                }
            }
        }
    }
};

test('course: seeded from config, set by PUT, a route imported, in the snapshot, kept across a restart', async (t) => {
    const dataDir = tmpdir();
    const {app, plugin} = await replayTo(1, {
        dataDir,
        resources: JSON.parse(JSON.stringify(RESOURCES)),
        config: {waypointNames: ['Tollgate', 'Missing', 'NorthHead']}
    });
    t.after(() => plugin.stop());
    await sleep(50); // the first waypoint resources read

    let c = (await app.call('GET', API + '/course')).body;
    assert.equal(c.seeded, true);
    assert.deepEqual(
        c.marks.map((m) => [m.name, m.found]),
        [
            ['Tollgate', true],
            ['Missing', false],
            ['NorthHead', true]
        ]
    );
    const wps = (await app.call('GET', API + '/course/waypoints')).body;
    assert.deepEqual(
        wps.map((w) => w.name),
        ['Jervis', 'NorthHead', 'Tollgate']
    );
    assert.deepEqual((await app.call('GET', API + '/course/routes')).body, [
        {id: 'r-1', name: 'Tollgate Islands', points: 4}
    ]);

    // Set: Jervis twice, by waypoint id.
    const j = wps.find((w) => w.name === 'Jervis');
    const marks = [j, wps.find((w) => w.name === 'Tollgate'), j].map((w) => ({
        name: w.name,
        waypointId: w.id,
        lat: w.lat,
        lon: w.lon
    }));
    assert.equal((await app.put(PUT_PATHS.setCourse, {marks: 'no'})).status, 400);
    assert.equal((await app.put(PUT_PATHS.setCourse, {marks: [{}]})).status, 400);
    assert.equal((await app.put(PUT_PATHS.setCourse, {marks})).status, 200);
    c = (await app.call('GET', API + '/course')).body;
    assert.equal(c.seeded, false);
    assert.deepEqual(
        c.marks.map((m) => m.name),
        ['Jervis', 'Tollgate', 'Jervis']
    );

    // A waypoint moved in the chart app: the mark follows it.
    app.resources.waypoints['u-t'] = point('Tollgate', -35.75, 150.27);
    await sleep(20);
    assert.equal((await app.put(PUT_PATHS.setCourse, {marks})).status, 200); // re-reads the resources
    await sleep(20);
    assert.equal((await app.call('GET', API + '/course')).body.marks[1].lat, -35.75);

    // Import the route: replaces the course; its waypoint points linked, the rest fixed.
    assert.equal((await app.put(PUT_PATHS.setCourse, {routeId: 'nope'})).status, 404);
    assert.equal((await app.put(PUT_PATHS.setCourse, {routeId: 'r-1'})).status, 200);
    c = (await app.call('GET', API + '/course')).body;
    assert.deepEqual(
        c.marks.map((m) => [m.name, m.src, m.waypointId]),
        [
            ['Jervis', 'waypoint', 'u-j'],
            ['Tollgate', 'waypoint', 'u-t'],
            ['Jervis', 'waypoint', 'u-j'],
            ['Finish', 'fixed', null]
        ]
    );
    const snap = (await app.call('GET', API + '/snapshot')).body;
    assert.deepEqual(
        snap.course.map((m) => m.name),
        ['Jervis', 'Tollgate', 'Jervis', 'Finish']
    );
    assert.ok(fs.existsSync(path.join(dataDir, 'course.json')));
    plugin.stop();

    // A restart keeps the imported course, not the config seed.
    const app2 = fakeApp({dataDir});
    Object.assign(app2.resources, JSON.parse(JSON.stringify(RESOURCES)));
    const p2 = createPlugin(app2, {fetch: async () => ({ok: false, status: 404})});
    p2.registerWithRouter(app2.pluginRouter);
    p2.signalKApiRoutes(app2.apiRouter);
    p2.start({waypointNames: ['Tollgate']});
    t.after(() => p2.stop());
    await sleep(50);
    const again = (await app2.call('GET', API + '/course')).body;
    assert.equal(again.seeded, false);
    assert.deepEqual(
        again.marks.map((m) => m.name),
        ['Jervis', 'Tollgate', 'Jervis', 'Finish']
    );
});
