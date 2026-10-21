'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../public/derive');
const geo = require('../lib/geo');

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

test('TCF Should: time owed at the trailing boat VMG (worked values)', () => {
    const E = 6 * 3600e3;
    // Boat owes us 10%: 36 min after 6 h; we trail, at our 6 kn: it must be 3.6 nm ahead.
    near(D.should(E, 1.0, 1.1, 6 * KN, 99) / NM, 3.6, 1e-9, 'owes us');
    // We owe it 10% of our time: 36 min; it trails, at its 8 kn: it may be 4.8 nm behind.
    near(D.should(E, 1.1, 1.0, 99, 8 * KN) / NM, -4.8, 1e-9, 'we owe it');
    // Symmetric in the ratio: either way round, 25% of the elapsed time.
    near(D.should(E, 1.0, 1.25, 6 * KN, null) / NM, 9, 1e-9, '25%');
    near(D.should(E, 1.25, 1.0, null, 6 * KN) / NM, -9, 1e-9, '25%, we owe it');
    assert.equal(D.should(E, 1.1, 1.1, null, null), 0, 'equal TCF: level, VMG not needed');
    assert.equal(D.should(0, 1, 1.1, null, null), 0, 'at the start');
    assert.equal(D.should(E, 1, 1.1, 0, 8 * KN), null, 'trailing VMG (ours) not positive');
    assert.equal(D.should(E, 1, 1.1, null, 8 * KN), null, 'our VMG unknown');
    assert.equal(D.should(E, 1.1, 1, 8 * KN, -1), null, 'trailing VMG (theirs) not positive');
    assert.equal(D.should(null, 1, 1.1, 6 * KN, 6 * KN), null);
});

test('vmcOver: smoothed over the window, shorter for a boat first heard recently', () => {
    // 6 kn due north toward WP, one report a minute for 30 min.
    const s = [];
    for (let k = 0; k <= 30; k++) s.push(at(k * 60e3, north((6 * k) / 60), 0));
    near(D.vmcOver(s, 30 * 60e3, WP, 600e3, 1800e3) / KN, 6, 0.01, '10 min window');
    // A tack in the last 2 minutes (heading away) barely moves the 10 min value.
    const t = s.slice(0, 29).concat([at(29 * 60e3, north(2.8), 0), at(30 * 60e3, north(2.7), 0)]);
    assert.ok(D.vmcOver(t, 30 * 60e3, WP, 600e3, 1800e3) / KN > 3, 'smoothed through the tack');
    assert.ok(D.vmc(t[29], t[30], WP, 1800e3) < 0, 'while the last interval is negative');
    near(D.vmcOver(s, 5 * 60e3, WP, 600e3, 1800e3) / KN, 6, 0.01, 'from the first report');
    near(D.vmcOver(s, 0, WP, 600e3, 1800e3) / KN, 6, 1e-6, 'one report: instant from SOG and COG');
    assert.equal(D.vmcOver(s, 30 * 60e3 + 1801e3, WP, 600e3, 1800e3), null, 'stale at t');
    assert.equal(D.vmcOver(s, 30 * 60e3, null, 600e3, 1800e3), null, 'no waypoint');
});

test('instant VMC: SOG x cos(COG - the boat own bearing to the mark), for a first report', () => {
    near(D.vmcInstant(at(0, 0, 0, 60, 8), WP) / KN, 4, 1e-6, 'mark due north, COG 060');
    // The boat's own bearing, not ours: a boat 1 deg east of the mark's meridian, heading at it.
    const off = {lat: 0, lon: 1};
    const brg = geo.bearing(off, WP) / DEG;
    near(D.vmcInstant(at(0, off.lat, off.lon, brg, 8), WP) / KN, 8, 1e-6, 'heading straight at it');
    near(D.vmcInstant(at(0, 0, 0, 180, 5), WP) / KN, -5, 1e-6, 'sailing away (e.g. rounded): negative');
    assert.equal(D.vmcInstant({t: 0, lat: 0, lon: 0, cogRad: null, sogMs: 3}, WP), null, 'no COG');
    assert.equal(D.vmcInstant(at(0, 0, 0), null), null, 'no waypoint');
    // Relative: theirs instant, so ours is instant at their time too (like with like).
    const us = [at(0, 0, 0.01, 0, 5)];
    near(D.vmgToward([at(0, 0, 0, 0, 7)], 0, ctxOf('waypoint', us), 'rel') / KN, 2, 1e-3, 'rel from instants');
    // Our own first sample.
    near(D.ownVmgAbs(us, 0, ctxOf('waypoint', us)) / KN, 5, 1e-3, 'own: instant without a minute of history');
});

test('course: each report picks its closest mark with positive VMC; DTF along the later marks', () => {
    // North to A, east to B, south to the finish C.
    const A = {lat: 0.5, lon: 0, name: 'A'};
    const B = {lat: 0.5, lon: 0.5, name: 'B'};
    const C = {lat: 0, lon: 0.5, name: 'C'};
    const c = D.makeCourse([A, B, C]);
    const AB = geo.distance(A, B);
    const BC = geo.distance(B, C);
    near(c.after[0], AB + BC, 1e-6, 'after A');
    assert.equal(c.after[2], 0, 'after the finish');

    const beat = at(0, 0.2, 0, 0, 6); // heading north to A; B is ahead too but further
    assert.equal(c.mark(beat), 0);
    near(D.dtg(beat, c), geo.distance(beat, A) + AB + BC, 1e-6, 'DTF from before A');
    const reach = at(0, 0.5, 0.1, 90, 6); // rounded A, heading east: A is behind
    assert.equal(c.mark(reach), 1);
    near(D.dtg(reach, c), geo.distance(reach, B) + BC, 1e-6, 'DTF from after A');
    assert.equal(c.mark({t: 0, lat: 0.45, lon: 0, cogRad: null, sogMs: null}), 0, 'no COG: the closest mark');
    assert.equal(D.makeCourse([]), null);

    // VMC across a mark switch uses the newer report's mark for both positions.
    const before = at(0, 0.49, 0, 0, 6);
    const after = at(600e3, 0.5, 0.02, 90, 6);
    const v = D.vmc(before, after, c, 1800e3);
    near(v, (geo.distance(before, B) - geo.distance(after, B)) / 600, 1e-9, 'toward B for both');
    assert.ok(v > 0 && v < 10 * KN, 'no leg-sized jump');

    // Lead: each boat's own DTF. A boat round A is well ahead of us on the beat.
    const ctx = ctxOf('course', [], {wp: c});
    assert.ok(D.lead(reach, beat, 'course', c) > 15 * NM, 'rounded boat ahead');
    near(D.vmgAbs([reach], 0, ctx) / KN, 6 * Math.cos(geo.bearing(reach, B) - Math.PI / 2), 1e-6, 'instant toward B');
    near(D.upDir('course', beat, c), 0, 1e-9, 'Up: our next mark (A, due north)');
    near(D.upDir('course', reach, c), geo.bearing(reach, B), 1e-12, 'Up after our rounding: B');
});

test('course: an out-and-back past a mark both ways picks by leg heading (Tollgate Islands)', () => {
    // Sydney south past Jervis Bay to the Tollgate Islands, back past Jervis to North Head.
    const J = {lat: -35.074, lon: 150.8508, name: 'Jervis'};
    const T = {lat: -35.7451, lon: 150.2626, name: 'Tollgate'};
    const N = {lat: -33.8288, lon: 151.304, name: 'NorthHead'};
    const JT = geo.distance(J, T);
    const JN = geo.distance(J, N);
    const p = (lat, lon, cogDeg) => at(0, lat, lon, cogDeg, 7);
    const south = p(-34.95, 150.95, 205); // southbound, just north of Jervis
    const pastJ = p(-35.3, 150.65, 215); // southbound, past Jervis
    const back = p(-35.6, 150.4, 40); // northbound from Tollgate
    const beating = p(-35.5, 150.5, 330); // northbound, beating on port: 66 degrees off the leg
    const home = p(-34.9, 151.0, 30); // northbound, past Jervis

    // Jervis listed twice: the true distance to finish all the way round.
    const c = D.makeCourse([J, T, J, N]);
    assert.equal(c.legBrg[0], null, 'the first leg has no heading');
    assert.equal(c.mark(south), 0, 'the outbound Jervis');
    near(D.dtg(south, c), geo.distance(south, J) + 2 * JT + JN, 1e-6, 'DTF includes the out-and-back');
    assert.equal(c.mark(pastJ), 1);
    assert.equal(c.mark(back), 2, 'the return Jervis: same mark, the leg from Tollgate');
    assert.equal(c.mark(beating), 2);
    near(D.dtg(back, c), geo.distance(back, J) + JN, 1e-6, 'DTF on the way back');
    assert.equal(c.mark(home), 3);

    // Jervis listed only on the way back: southbound boats are not on the leg from
    // Tollgate, so they keep Tollgate (positive VMC toward Jervis alone picked it).
    const once = D.makeCourse([T, J, N]);
    assert.equal(once.mark(south), 0);
    near(D.dtg(south, once), geo.distance(south, T) + JT + JN, 1e-6, 'no skipped out-and-back');
    assert.equal(once.mark(back), 1);
    assert.equal(once.mark(home), 2);
});

test('upDir per frame', () => {
    const us = at(0, 0, 0, 45);
    assert.equal(D.upDir('north', us, WP), 0);
    near(D.upDir('cog', us, WP), 45 * DEG, 1e-12, 'cog is our COG');
    near(D.upDir('waypoint', us, WP), 0, 1e-12, 'waypoint due north');
    near(D.upDir('waypoint', us, {lat: 0, lon: 1}), Math.PI / 2, 1e-12, 'waypoint due east');
    assert.equal(D.upDir('wind', us, WP), null);
    assert.equal(D.upDir('cog', null, WP), null);
});

test('VMC from the boat own previous report, ignoring long gaps', () => {
    const r = [at(0, 0, 0), at(1800e3, north(3), 0)];
    near(D.vmgAbs(r, 1, ctxOf('waypoint', [])) / KN, 6, 0.01, '3 nm closer in 30 min');
    near(D.vmgAbs(r, 0, ctxOf('waypoint', [])) / KN, 6, 1e-6, 'no previous report: instant');
    const slow = [at(0, 0, 0), at(1800e3, north(3), 0, 60, 4)];
    near(D.vmgAbs(slow, 1, ctxOf('waypoint', [], {staleMs: 1800e3 - 1})) / KN, 2, 1e-3, 'gap over stale: instant');
    near(D.vmc(r[1], at(3600e3, 0, 0), WP, 1e9) / KN, -6, 0.01, 'opening is negative');
});

test('VMG for North and COG frames', () => {
    const s = [at(1000, 0, 0, 60, 10)];
    near(D.vmgAbs(s, 0, ctxOf('north', [])) / KN, 5, 1e-9, 'SOG cos COG');
    const us = [at(1000, 0, 0.01, 90, 8)];
    near(D.vmgAbs(s, 0, ctxOf('cog', us)) / KN, 10 * Math.cos(30 * DEG), 1e-9, 'projected on our COG');
    assert.equal(D.vmgAbs(s, 0, ctxOf('cog', [])), null, 'no own state at their time');
    assert.equal(D.vmgAbs(s, 0, ctxOf('cog', [at(1000 - 11e3, 0, 0)])), null, 'own state too old');
});

test('relative VMG is theirs minus ours over the same interval', () => {
    // They close 3 nm in 30 min, we close 2 nm over the same interval.
    const r = [at(0, 0, 0), at(1800e3, north(3), 0)];
    const us = [at(0, 0, 0), at(900e3, north(0.5), 0), at(1800e3, north(2), 0)];
    near(D.vmgToward(r, 1, ctxOf('waypoint', us), 'rel') / KN, 2, 0.02, '+ = they gain');
    near(D.vmgToward(r, 1, ctxOf('waypoint', us), 'abs') / KN, 6, 0.02, 'absolute');
    // Course frame: ours is our SOG.
    const s = [at(5000, 0, 0, 0, 7)];
    near(D.vmgToward(s, 0, ctxOf('cog', [at(5000, 0, 0, 0, 9)]), 'rel') / KN, -2, 1e-9, 'slower than us');
});

test('own VMC spans at least a minute of our samples', () => {
    const us = [at(0, 0, 0), at(30e3, north(0.05), 0), at(60e3, north(0.1), 0), at(61e3, north(0.1), 0)];
    near(D.ownVmgAbs(us, 3, ctxOf('waypoint', us)) / KN, 6 * (60 / 61), 0.05, 'from the sample 61 s back');
    near(D.ownVmgAbs(us, 1, ctxOf('waypoint', us)) / KN, 6, 0.01, 'less than a minute of history: instant');
    near(D.ownVmgAbs(us, 0, ctxOf('cog', us)) / KN, 6, 1e-9, 'cog: our SOG');
});

test('lead toward Up: + = they are ahead, in every frame', () => {
    const u = at(0, 0, 0, 90); // we sail east
    const ahead = at(0, north(1), 0.01); // a mile closer to the waypoint, a little east
    near(D.lead(ahead, u, 'waypoint', WP) / NM, 1, 0.01, 'waypoint: DTG ours minus theirs');
    near(D.lead(ahead, u, 'north', WP) / NM, 1, 0.01, 'north: northward displacement');
    const eastNm = geo.displacement(u, ahead).e / NM;
    near(D.lead(ahead, u, 'cog', WP) / NM, eastNm, 1e-9, 'cog: along our COG');
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

test('TCF row: Should from elapsed time and the smoothed VMG at their report time', () => {
    const startT = 0;
    const T = 6 * 3600e3;
    // Both sail north at 6 kn toward WP; one sample a minute over the last 20 min.
    const track = (aheadNm) => {
        const r = [];
        for (let k = 20; k >= 0; k--) r.push(at(T - k * 60e3, north(10 + aheadNm - (6 * k) / 60), 0));
        return r;
    };
    const us = track(0);
    const series = track(2); // 2 nm ahead
    const s = series[series.length - 1];
    const u = us[us.length - 1];
    const row = (o) =>
        D.tcfRow({
            s,
            u,
            series,
            usSeries: us,
            frame: 'waypoint',
            wp: WP,
            startT,
            tcfUs: 1,
            tcfBoat: 1.1,
            vmgMs: 600e3,
            maxGapMs: 1800e3,
            ...o
        });
    const r = row({});
    near(r.should / NM, 3.6, 0.01, 'Should: 36 min at our 6 kn');
    near(r.actual / NM, 2, 0.01, 'Actual');
    near(r.net / NM, 2 - 3.6, 0.02, 'Net: - it is losing to us on handicap');
    near(row({tcfUs: 1.1, tcfBoat: 1}).should / NM, -3.6, 0.01, 'we owe it: at its 6 kn');
    assert.equal(row({startT: null}).reason, 'no start time');
    assert.equal(row({startT: T + 1}).reason, 'before start');
    assert.equal(row({wp: null}).reason, 'no waypoint');
    near(row({usSeries: [u]}).should / NM, 3.6, 0.01, 'one sample of ours: instant VMG');
    assert.equal(row({usSeries: []}).reason, 'no VMG (ours)');
    assert.equal(row({tcfUs: 1.1, tcfBoat: 1, series: [{...s, cogRad: null}]}).reason, 'no VMG (theirs)');
    assert.equal(row({tcfBoat: 1, usSeries: []}).should, 0, 'equal TCF needs no VMG');
    assert.equal(row({s: null}).net, null);
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
    assert.equal(D.niceStep(1.4, 10), 0.1, 'about 10: 0.14 rounds to 0.1');
    assert.equal(D.niceStep(3, 10), 0.2, 'about 10: 0.3 rounds to 0.2');
    assert.equal(D.niceStep(30), 10);
});

test('Upwind and Downwind: along our smoothed TWD at their report time (worked values)', () => {
    // Wind from the north (TWD 0). We sail NE at 6 kn; they beat on port at 45 deg, then run.
    const w = (u, twdDeg) => ({...u, twdRad: twdDeg == null ? null : twdDeg * DEG});
    const us = [w(at(0, 0, 0, 45, 6), 0), w(at(60e3, north(0.1), 0, 45, 6), 0)];
    const beat = at(60e3, 0, 0, 315, 8);
    const run = at(60e3, 0, 0, 180, 8);
    const ctx = (frame) => ctxOf(frame, us);
    near(D.vmgAbs([beat], 0, ctx('upwind')) / KN, 8 * Math.cos(45 * DEG), 1e-9, 'beat: 8 kn x cos 45 upwind');
    near(D.vmgAbs([run], 0, ctx('upwind')) / KN, -8, 1e-9, 'run: going away from the wind');
    near(D.vmgAbs([run], 0, ctx('downwind')) / KN, 8, 1e-9, 'run: + downwind');
    near(D.ourVmgFor([beat], 0, ctx('upwind')) / KN, 6 * Math.cos(45 * DEG), 1e-9, 'ours at their time');
    near(D.ownVmgAbs(us, 1, ctx('downwind')) / KN, -6 * Math.cos(45 * DEG), 1e-9, 'our own, downwind');
    near(D.upDir('upwind', us[1], WP), 0, 1e-12, 'Up = into the wind');
    near(D.upDir('downwind', us[1], WP), Math.PI, 1e-12, 'Up = away from it');

    // Lead: a boat 1 nm north (upwind) and a little east of us.
    const u = us[1];
    const ahead = at(60e3, north(1.1), 0.01);
    const d = geo.displacement(u, ahead);
    near(D.lead(ahead, u, 'upwind', WP), d.n, 1e-6, 'upwind: displacement into the wind');
    near(D.lead(ahead, u, 'downwind', WP), -d.n, 1e-6, 'downwind: the same boat is behind');

    // The wind at their report time, not now: a 90 deg shift since then does not count.
    const shifted = [...us, w(at(120e3, north(0.2), 0, 45, 6), 90)];
    near(D.vmgAbs([beat], 0, ctxOf('upwind', shifted)) / KN, 8 * Math.cos(45 * DEG), 1e-9, 'TWD at 60 s');
});

test('Upwind and Downwind without wind: nothing, never a guess', () => {
    const us = [{...at(0, 0, 0, 45, 6), twdRad: null}];
    const b = at(0, north(1), 0, 0, 6);
    assert.equal(D.upDir('upwind', us[0], WP), null);
    assert.equal(D.vmgAbs([b], 0, ctxOf('downwind', us)), null);
    assert.equal(D.ourVmgFor([b], 0, ctxOf('upwind', us)), null);
    assert.equal(D.ownVmgAbs(us, 0, ctxOf('upwind', us)), null);
    assert.equal(D.lead(b, us[0], 'upwind', WP), null);
    assert.equal(D.frameDir('upwind', null), null);
});
