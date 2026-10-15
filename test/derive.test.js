'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../public/derive');
const geo = require('../lib/geo');
const {courseDistance} = require('../lib/course-distance');

const NM = 1852;
const KN = NM / 3600;
const DEG = Math.PI / 180;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

// Waypoint due north of the origin, far enough that bearings to it barely change locally.
const WP = {lat: 1, lon: 0};
const at = (t, lat, lon, cogDeg = 0, sogKn = 6) => ({t, lat, lon, cogRad: cogDeg * DEG, sogMs: sogKn * KN});
// A position x nm north of the equator at lon 0 (nm of latitude = 1 minute, near enough for tests via distance()).
const north = (nm) => (nm * NM) / (geo.EARTH_RADIUS_M * DEG);
const ctxOf = (frame, us, extra = {}) => ({frame, wp: WP, us, staleMs: 1800e3, usGapMs: 10e3, ...extra});

test('TCF Should: worked value from the brief (D = 144.6 nm, TCF 1.000 vs 1.100)', () => {
    near(D.should(144.6 * NM, 1.0, 1.1) / NM, 13.145, 0.001, 'Should nm');
    assert.equal(D.should(144.6 * NM, 1.1, 1.1), 0, 'equal TCF: level');
    assert.ok(D.should(144.6 * NM, 1.1, 1.0) < 0, 'slower rated boat may be behind');
    assert.equal(D.should(-5, 1, 1.1), 0, 'no distance made good yet');
    assert.equal(D.should(null, 1, 1.1), null);
});

test('upDir per frame', () => {
    const us = at(0, 0, 0, 45);
    assert.equal(D.upDir('north', us, WP), 0);
    near(D.upDir('course', us, WP), 45 * DEG, 1e-12, 'course is our COG');
    near(D.upDir('waypoint', us, WP), 0, 1e-12, 'waypoint due north');
    near(D.upDir('waypoint', us, {lat: 0, lon: 1}), Math.PI / 2, 1e-12, 'waypoint due east');
    assert.equal(D.upDir('wind', us, WP), null);
    assert.equal(D.upDir('course', null, WP), null);
});

test('VMC from the boat own previous report, ignoring long gaps', () => {
    const r = [at(0, 0, 0), at(1800e3, north(3), 0)];
    near(D.vmgAbs(r, 1, ctxOf('waypoint', [])) / KN, 6, 0.01, '3 nm closer in 30 min');
    assert.equal(D.vmgAbs(r, 0, ctxOf('waypoint', [])), null, 'no previous report');
    assert.equal(D.vmgAbs(r, 1, ctxOf('waypoint', [], {staleMs: 1800e3 - 1})), null, 'gap over stale');
    near(D.vmc(r[1], at(3600e3, 0, 0), WP, 1e9) / KN, -6, 0.01, 'opening is negative');
});

test('VMG for North and Course frames', () => {
    const s = [at(1000, 0, 0, 60, 10)];
    near(D.vmgAbs(s, 0, ctxOf('north', [])) / KN, 5, 1e-9, 'SOG cos COG');
    const us = [at(1000, 0, 0.01, 90, 8)];
    near(D.vmgAbs(s, 0, ctxOf('course', us)) / KN, 10 * Math.cos(30 * DEG), 1e-9, 'projected on our COG');
    assert.equal(D.vmgAbs(s, 0, ctxOf('course', [])), null, 'no own state at their time');
    assert.equal(D.vmgAbs(s, 0, ctxOf('course', [at(1000 - 11e3, 0, 0)])), null, 'own state too old');
});

test('relative VMG is theirs minus ours over the same interval', () => {
    // They close 3 nm in 30 min, we close 2 nm over the same interval.
    const r = [at(0, 0, 0), at(1800e3, north(3), 0)];
    const us = [at(0, 0, 0), at(900e3, north(0.5), 0), at(1800e3, north(2), 0)];
    near(D.vmgToward(r, 1, ctxOf('waypoint', us), 'rel') / KN, 2, 0.02, '+ = they gain');
    near(D.vmgToward(r, 1, ctxOf('waypoint', us), 'abs') / KN, 6, 0.02, 'absolute');
    // Course frame: ours is our SOG.
    const s = [at(5000, 0, 0, 0, 7)];
    near(D.vmgToward(s, 0, ctxOf('course', [at(5000, 0, 0, 0, 9)]), 'rel') / KN, -2, 1e-9, 'slower than us');
});

test('own VMC spans at least a minute of our samples', () => {
    const us = [at(0, 0, 0), at(30e3, north(0.05), 0), at(60e3, north(0.1), 0), at(61e3, north(0.1), 0)];
    near(D.ownVmgAbs(us, 3, ctxOf('waypoint', us)) / KN, 6 * (60 / 61), 0.05, 'from the sample 61 s back');
    assert.equal(D.ownVmgAbs(us, 1, ctxOf('waypoint', us)), null, 'less than a minute of history');
    near(D.ownVmgAbs(us, 0, ctxOf('course', us)) / KN, 6, 1e-9, 'course: our SOG');
});

test('lead toward Up: + = they are ahead, in every frame', () => {
    const u = at(0, 0, 0, 90); // we sail east
    const ahead = at(0, north(1), 0.01); // a mile closer to the waypoint, a little east
    near(D.lead(ahead, u, 'waypoint', WP) / NM, 1, 0.01, 'waypoint: DTG ours minus theirs');
    near(D.lead(ahead, u, 'north', WP) / NM, 1, 0.01, 'north: northward displacement');
    const eastNm = geo.displacement(u, ahead).e / NM;
    near(D.lead(ahead, u, 'course', WP) / NM, eastNm, 1e-9, 'course: along our COG');
    near(D.lead(u, ahead, 'waypoint', WP) / NM, -1, 0.01, 'behind is negative');
});

test('vector points rotate Up to +y; relative subtracts ours', () => {
    const s = at(0, 0, 0, 90, 10); // east at 10 kn
    let p = D.vectorPoint(s, null, 'abs', 0);
    near(p.x / KN, 10, 1e-9, 'north up: east is +x');
    near(p.y, 0, 1e-9, 'y');
    p = D.vectorPoint(s, null, 'abs', 90 * DEG);
    near(p.x, 0, 1e-9, 'east up: x');
    near(p.y / KN, 10, 1e-9, 'east up: east is +y');
    p = D.vectorPoint(s, at(0, 0, 0, 90, 8), 'rel', 90 * DEG);
    near(p.y / KN, 2, 1e-9, 'relative: 2 kn faster');
    assert.equal(D.vectorPoint(s, null, 'rel', 0), null, 'relative needs our state');
});

test('TCF row: Should from course distance and our DTG at their report time', () => {
    const startT = 0;
    // Course 200 nm long, single leg; we are 55.4 nm from the waypoint, so D = 144.6 nm.
    const course = {totalM: 200 * NM, afterM: 0};
    const u = at(3600e3, 1 - north(55.4), 0, 0);
    const s = at(3600e3, 1 - north(55.4 - 20), 0); // 20 nm ahead toward the waypoint
    const row = D.tcfRow({s, u, frame: 'waypoint', wp: WP, course, startT, tcfUs: 1, tcfBoat: 1.1});
    near(row.should / NM, 13.145, 0.01, 'Should');
    near(row.actual / NM, 20, 0.01, 'Actual');
    near(row.net / NM, 20 - 13.145, 0.02, 'Net: + beats us');
    assert.equal(
        D.tcfRow({s, u, frame: 'waypoint', wp: WP, course, startT: null, tcfUs: 1, tcfBoat: 1}).reason,
        'no start time'
    );
    assert.equal(
        D.tcfRow({s, u, frame: 'waypoint', wp: WP, course: null, startT, tcfUs: 1, tcfBoat: 1}).reason,
        'no course distance'
    );
    assert.equal(
        D.tcfRow({s, u, frame: 'waypoint', wp: WP, course, startT: 4e6, tcfUs: 1, tcfBoat: 1}).reason,
        'before start'
    );
    assert.equal(D.tcfRow({s: null, u, frame: 'waypoint', wp: WP, course, startT, tcfUs: 1, tcfBoat: 1}).net, null);
});

test('madeGood: route legs after the next point count as still to go', () => {
    near(D.madeGood({totalM: 100, afterM: 30}, 20), 50, 1e-9, 'D');
    assert.equal(D.madeGood(null, 20), null);
});

test('stateAt and indexAtOrBefore', () => {
    const s = [{t: 10}, {t: 20}, {t: 30}];
    assert.equal(D.indexAtOrBefore(s, 5), -1);
    assert.equal(D.indexAtOrBefore(s, 20), 1);
    assert.equal(D.indexAtOrBefore(s, 29), 1);
    assert.equal(D.stateAt(s, 29, 9).t, 20);
    assert.equal(D.stateAt(s, 29, 8), null);
});

test('ageFrac and niceStep', () => {
    assert.equal(D.ageFrac(100, 100, 50), 1);
    assert.equal(D.ageFrac(50, 100, 50), 0);
    assert.equal(D.ageFrac(75, 100, 50), 0.5);
    assert.equal(D.niceStep(9), 2);
    assert.equal(D.niceStep(0.9), 0.2);
    assert.equal(D.niceStep(30), 10);
});

test('course distance: route, then named start, then configured', () => {
    const pts = [
        {lat: 0, lon: 0},
        {lat: 0.5, lon: 0},
        {lat: 1, lon: 0}
    ];
    const leg = geo.distance(pts[0], pts[1]);
    const route = {activeRoute: {points: pts, pointIndex: 1, reverse: false, name: 'R'}};
    const wp = {...pts[1], src: 'course'};
    let c = courseDistance({waypoint: wp, course: route, startPoint: null, configuredM: null});
    assert.equal(c.src, 'route');
    near(c.totalM, 2 * leg, 1e-6, 'route length');
    near(c.afterM, leg, 1e-6, 'legs after the next point');
    // Reversed: pointIndex counts in travel order, from the last coordinate.
    c = courseDistance({
        waypoint: {...pts[1], src: 'course'},
        course: {activeRoute: {points: pts, pointIndex: 2, reverse: true}},
        startPoint: null,
        configuredM: null
    });
    assert.equal(c, null, 'reversed index 2 is the first coordinate, not the waypoint: route ignored');
    c = courseDistance({
        waypoint: {...pts[0], src: 'course'},
        course: {activeRoute: {points: pts, pointIndex: 2, reverse: true}},
        startPoint: null,
        configuredM: null
    });
    near(c.afterM, 0, 1e-9, 'reversed: last point, nothing after');
    // NMEA waypoint in use: the route does not describe it.
    const start = {lat: -1, lon: 0, name: 'Start'};
    c = courseDistance({waypoint: {...pts[1], src: 'nmea'}, course: route, startPoint: start, configuredM: 5});
    assert.equal(c.src, 'start');
    near(c.totalM, geo.distance(start, pts[1]), 1e-6, 'start to waypoint');
    c = courseDistance({waypoint: wp, course: null, startPoint: null, configuredM: 384 * NM});
    assert.deepEqual(c, {totalM: 384 * NM, afterM: 0, src: 'config'});
    assert.equal(courseDistance({waypoint: null, course: route, startPoint: start, configuredM: 5}), null);
    assert.equal(courseDistance({waypoint: wp, course: null, startPoint: null, configuredM: 0}), null);
});
