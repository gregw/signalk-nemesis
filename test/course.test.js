'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    CourseStore,
    resolveCourse,
    routeToMarks,
    routeList,
    waypointList,
    cleanMarks,
    MAX_MARKS
} = require('../lib/course');
const {tmpdir} = require('./sim/tmpdir');

const wpt = (name, lat, lon) => ({
    name,
    feature: {type: 'Feature', geometry: {type: 'Point', coordinates: [lon, lat]}}
});
const WPTS = {
    'u-jervis': wpt('Jervis', -35.074, 150.8508),
    'u-tollgate': wpt('Tollgate', -35.7451, 150.2626),
    'u-nh': wpt(' NorthHead ', -33.8288, 151.304),
    'u-bad': {name: 'Broken', feature: {geometry: {coordinates: [500, 0]}}}
};

test('waypoint marks follow the resource: by id, then by name, then their last position', () => {
    const marks = [
        {name: 'Jervis', waypointId: 'u-jervis', lat: -35, lon: 150},
        {name: 'Tollgate', waypointId: 'u-gone', lat: -35.7, lon: 150.2}, // id gone, name still there
        {name: 'Old Mark', waypointId: 'u-gone2', lat: -34, lon: 151}, // gone altogether
        {name: 'NorthHead'}, // seeded from the old config: by name
        {name: 'Nowhere'},
        {name: 'Fixed', lat: -34.5, lon: 151.1}
    ];
    const r = resolveCourse(marks, WPTS);
    assert.deepEqual(
        r.map((m) => [m.name, m.waypointId, m.lat, m.lon, m.found, m.src]),
        [
            ['Jervis', 'u-jervis', -35.074, 150.8508, true, 'waypoint'],
            ['Tollgate', 'u-tollgate', -35.7451, 150.2626, true, 'waypoint'],
            ['Old Mark', 'u-gone2', -34, 151, true, 'last'],
            ['NorthHead', 'u-nh', -33.8288, 151.304, true, 'waypoint'],
            ['Nowhere', null, null, null, false, 'waypoint'],
            ['Fixed', null, -34.5, 151.1, true, 'fixed']
        ]
    );
});

test('a route imports with its waypoint links, its point names, and WP<n> for the rest', () => {
    const route = {
        name: 'Tollgate Islands',
        feature: {
            type: 'Feature',
            geometry: {
                type: 'LineString',
                coordinates: [
                    [151.304, -33.8288],
                    [150.8508, -35.074],
                    [150.2626, -35.7451],
                    [999, 0], // invalid: skipped
                    [150.8508, -35.074],
                    [151.304, -33.8288]
                ]
            },
            properties: {
                coordinatesMeta: [
                    {name: 'Start'},
                    {href: '/resources/waypoints/u-jervis'},
                    {href: '/resources/waypoints/u-tollgate'},
                    {},
                    {}
                ]
            }
        }
    };
    assert.deepEqual(routeToMarks(route, WPTS), [
        {name: 'Start', lat: -33.8288, lon: 151.304},
        {name: 'Jervis', waypointId: 'u-jervis', lat: -35.074, lon: 150.8508},
        {name: 'Tollgate', waypointId: 'u-tollgate', lat: -35.7451, lon: 150.2626},
        {name: 'WP5', lat: -35.074, lon: 150.8508},
        {name: 'WP6', lat: -33.8288, lon: 151.304}
    ]);
    assert.throws(() => routeToMarks({feature: {geometry: {coordinates: [[999, 0]]}}}, WPTS), RangeError);
    assert.throws(() => routeToMarks({}, WPTS), RangeError);
    assert.deepEqual(routeList({r1: route, r2: {name: 'Empty', feature: {geometry: {coordinates: []}}}}), [
        {id: 'r1', name: 'Tollgate Islands', points: 6}
    ]);
});

test('the waypoint list is by name, with positions; broken ones are left out', () => {
    assert.deepEqual(
        waypointList(WPTS).map((w) => w.name),
        ['Jervis', 'NorthHead', 'Tollgate']
    );
});

test('the course is seeded from the old config until set, then kept across restarts', async () => {
    const dir = tmpdir();
    const seed = new CourseStore(dir, ['nemesis', ' Jervis ', '']);
    assert.equal(seed.seeded, true);
    assert.deepEqual(seed.marks, [{name: 'nemesis'}, {name: 'Jervis'}]);
    await seed.set([{name: 'Jervis', waypointId: 'u-jervis', lat: -35.074, lon: 150.8508}, {name: 'Jervis'}]);
    const again = new CourseStore(dir, ['nemesis']);
    assert.equal(again.seeded, false);
    assert.equal(again.marks.length, 2, 'a mark can be listed twice');
    // An emptied course stays empty: the seed does not come back.
    await again.set([]);
    assert.deepEqual(new CourseStore(dir, ['nemesis']).marks, []);
    // A corrupt file: the seed, rather than a crash.
    fs.writeFileSync(path.join(dir, 'course.json'), '{oops');
    assert.equal(new CourseStore(dir, ['A']).marks[0].name, 'A');
});

test('bad marks are rejected', () => {
    assert.throws(() => cleanMarks('x'), RangeError);
    assert.throws(() => cleanMarks([{}]), RangeError);
    assert.throws(() => cleanMarks([{name: 'A', lat: 91, lon: 0}].concat([{}])), RangeError);
    assert.throws(() => cleanMarks(new Array(MAX_MARKS + 1).fill({name: 'A'})), RangeError);
    assert.deepEqual(cleanMarks([{name: ' A ', lat: 91, lon: 0, extra: 1}]), [{name: 'A'}]);
});
