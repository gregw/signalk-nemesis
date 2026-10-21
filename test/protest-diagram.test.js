'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../tools/protest-diagram');

const D2R = Math.PI / 180;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const nearPt = (p, q, msg) => {
    near(p[0], q[0], 1e-9, msg + ' x');
    near(p[1], q[1], 1e-9, msg + ' y');
};

test('hull centre from the GPS antenna: 1 m from the stern and 1 m to starboard of a 12 m boat', () => {
    // fwd = 1 - 12 / 2 = -5: the antenna is 5 m aft of the centre and 1 m to starboard.
    const g = D.boatGeom({lengthM: 12, antenna: {fromSternM: 1, stbdM: 1}});
    assert.equal(g.fwd, -5);
    assert.equal(g.stbd, 1);
    // Heading north: starboard is east, so the centre is 5 m north and 1 m west.
    nearPt(D.hullCentre([0, 0], 0, g.fwd, g.stbd), [-1, 5], 'north');
    // Heading east: starboard is south, so the centre is 5 m east and 1 m north.
    nearPt(D.hullCentre([0, 0], 90 * D2R, g.fwd, g.stbd), [5, 1], 'east');
    // Unknown antenna: at the centre.
    const s = D.boatGeom({lengthM: 10, antenna: null});
    nearPt(D.hullCentre([3, 4], 1.234, s.fwd, s.stbd), [3, 4], 'unknown');
    assert.equal(s.B, 3.2, 'beam assumed about a third of the length');
});

test('hull outline: bow at half the length ahead, transom across the stern, turned to the heading', () => {
    const n = D.hullOutline([0, 0], 0, 12, 4);
    nearPt(n[0], [0, 6], 'bow, heading north');
    const ys = n.map((p) => p[1]);
    near(Math.min(...ys), -6, 1e-9, 'stern');
    near(Math.max(...n.map((p) => Math.abs(p[0]))), 2, 1e-9, 'half beam');
    const e = D.hullOutline([10, 0], 90 * D2R, 12, 4);
    nearPt(e[0], [16, 0], 'bow, heading east');
});

test('distance between polygons: gap, touching and overlapping', () => {
    const sq = (x, y) => [
        [x, y],
        [x + 1, y],
        [x + 1, y + 1],
        [x, y + 1]
    ];
    assert.equal(D.polyDistance(sq(0, 0), sq(3, 0)), 2);
    near(D.polyDistance(sq(0, 0), sq(4, 4)), Math.hypot(3, 3), 1e-12, 'corner to corner');
    assert.equal(D.polyDistance(sq(0, 0), sq(1, 0)), 0, 'touching');
    assert.equal(D.polyDistance(sq(0, 0), sq(0.5, 0.5)), 0, 'overlapping');
    const big = [
        [-5, -5],
        [5, -5],
        [5, 5],
        [-5, 5]
    ];
    assert.equal(D.polyDistance(big, sq(0, 0)), 0, 'inside');
});

test('wind up: the bearing turned to the top of the page', () => {
    const up = 79 * D2R;
    nearPt(D.turn([Math.sin(up), Math.cos(up)], up), [0, 1], 'TWD to up');
    // North ends up 79 degrees anticlockwise of up.
    nearPt(D.turn([0, 1], up), [-Math.sin(up), Math.cos(up)], 'north');
});

test('state at a time: position interpolated between fixes, heading within 2 s, nothing across a gap', () => {
    const rows = [
        {gpsT: 0, lat: -33.86, lon: 151.24, hdgRad: 0.5, cogRad: 0.4, sogMs: 2},
        {gpsT: 1000, lat: -33.861, lon: 151.242, hdgRad: null, cogRad: 0.6, sogMs: 3},
        {gpsT: 2000, lat: -33.862, lon: 151.244, hdgRad: null, cogRad: 0.7, sogMs: 3},
        {gpsT: 3000, lat: -33.863, lon: 151.246, hdgRad: null, cogRad: 0.8, sogMs: 3},
        {gpsT: 9000, lat: -33.87, lon: 151.25, hdgRad: 1, cogRad: 1, sogMs: 1}
    ];
    const s = D.stateAt(rows, 500);
    near(s.lat, -33.8605, 1e-12, 'lat');
    near(s.lon, 151.241, 1e-12, 'lon');
    assert.equal(s.hdgRad, 0.5);
    assert.equal(D.stateAt(rows, 1600).cogRad, 0.7, 'COG from the nearest row');
    assert.equal(D.stateAt(rows, 1600).hdgRad, 0.5, 'heading 1.6 s old');
    assert.equal(D.stateAt(rows, 2500).hdgRad, null, 'no heading within 2 s');
    assert.equal(D.stateAt(rows, 5000), null, 'fixes 6 s apart');
    assert.equal(D.stateAt(rows, 9500), null, 'after the log');
});

test('wind: median of each boat, then averaged, so the boat that logged more does not win', () => {
    near(D.circMedian([350, 355, 5, 10, 20].map((d) => d * D2R)) / D2R, 5, 1e-9, 'median across north');
    const boat = (n, deg, kn) => ({
        rows: Array.from({length: n}, (_, i) => ({gpsT: i * 100, twdRad: deg * D2R, twsMs: kn}))
    });
    const w = D.boatsWind([boat(9, 70, 12), boat(5, 88, 14)], 0, 10000);
    near(w.twdRad / D2R, 79, 1e-9, 'TWD');
    near(w.twsMs, 13, 1e-12, 'TWS');
    assert.deepEqual(D.boatsWind([boat(0, 0, 0)], 0, 1), {twdRad: null, twsMs: null});
});

test('lateral gap: sideways across a heading, ignoring how far ahead, never more than the gap', () => {
    // Heading north (port is west). b is 7 m to port and 20 m ahead of a.
    const a = D.hullOutline([0, 0], 0, 12, 4);
    const b = D.hullOutline([-7, 20], 0, 10, 3);
    const l = D.lateralGap(a, 0, b);
    assert.equal(l.sgn, 1, 'b to port');
    near(l.d, 7 - 2 - 1.5, 1e-9, 'centres 7 m apart less the half beams');
    assert.ok(l.d < D.polyDistance(a, b), 'less than the shortest gap');
    // To starboard, and overlapping sideways.
    const c = D.hullOutline([1, -15], 0, 10, 3);
    assert.equal(D.lateralGap(a, 0, c).sgn, -1);
    near(D.lateralGap(a, 0, c).d, -(2 + 1.5 - 1), 1e-9, 'overlap is negative');
});
