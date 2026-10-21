'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {simulateFleet, ownFromLog, stateAt, keepChance, leg, DEFAULTS} = require('./sim/fleet-sim');

const KN = 1852 / 3600;
const NM = 1852;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const T0 = Date.parse('2026-10-16T06:00:00Z');
const iso = (t) => new Date(t).toISOString();
// Degrees of latitude per nm.
const LAT_NM = 1 / 60;

test('state between fixes: straight line, SOG and COG of the leg, nothing across a long gap', () => {
    // 1 nm due north in 10 minutes: 6 kn, COG 000.
    const fixes = [
        {t: T0, lat: -34, lon: 151},
        {t: T0 + 600e3, lat: -34 + LAT_NM, lon: 151},
        {t: T0 + 600e3 + 3600e3, lat: -33, lon: 151}
    ];
    const s = stateAt(fixes, T0 + 300e3, 40 * 60e3);
    near(s.lat, -34 + LAT_NM / 2, 1e-12, 'half way');
    near(s.sogMs / KN, 6, 0.02, 'SOG');
    near(s.cogRad, 0, 1e-9, 'COG');
    assert.equal(stateAt(fixes, T0 + 900e3, 40 * 60e3), null, 'an hour gap');
    assert.equal(stateAt(fixes, T0 - 1, 40 * 60e3), null, 'before the first fix');
    assert.equal(stateAt(fixes, T0 + 600e3 + 3600e3, 40 * 60e3), null, 'the last fix, after a long gap');
    // East: COG 090.
    near(leg({lat: -34, lon: 151}, {lat: -34, lon: 151.1}).brg, Math.PI / 2, 1e-9, 'east');
});

test('reception chance: high near, a third at 8 nm, none from 20 nm', () => {
    const o = DEFAULTS;
    assert.equal(keepChance(1, o), 0.9);
    near(keepChance(5, o), 0.9 + ((1 / 3 - 0.9) * 3) / 6, 1e-12, 'between');
    near(keepChance(8, o), 1 / 3, 1e-12, 'mid');
    near(keepChance(14, o), 1 / 6, 1e-12, 'half way out');
    assert.equal(keepChance(20, o), 0);
    assert.equal(keepChance(30, o), 0);
});

test('fleet: a close fast boat every 30 s or so, a slow one every 3 min, a far one never; jiggle small', () => {
    // Us: stopped at -34, 151 for an hour, 1 s samples.
    const own = Array.from({length: 3601}, (_, i) => ({t: T0 + i * 1000, lat: -34, lon: 151}));
    const line = (lat0, lon, kn) =>
        Array.from({length: 7}, (_, k) => [iso(T0 + k * 600e3), lat0 + (k * kn * LAT_NM) / 6, lon]);
    const fleet = {
        boats: [
            {id: 1, name: 'Close', samples: line(-34 + 0.5 * LAT_NM, 151, 6)},
            {id: 2, name: 'Slow', samples: line(-34 - 0.5 * LAT_NM, 151, 1)},
            {id: 3, name: 'Far', samples: line(-34 - 25 * LAT_NM, 151, 6)},
            {id: 4, name: 'Us', mmsi: '503029690', samples: line(-34, 151, 0)}
        ]
    };
    // The close boat ends 6.5 nm away: all of it in the near band.
    const OPTS = {seed: 7, ownMmsi: '503029690', shiftMs: 5000, nearNm: 10, midNm: 12};
    const {reports, names} = simulateFleet(fleet, own, OPTS);
    assert.deepEqual([...names.values()], ['Close', 'Slow', 'Far'], 'our own boat left out');
    const of = (id) => reports.filter((r) => r.boatId === String(500000000 + id));
    const close = of(1);
    // 120 transmissions in the hour; 0.9 of them received.
    assert.ok(close.length > 95 && close.length <= 120, `close ${close.length}`);
    const gaps = close.slice(1).map((r, i) => r.t - close[i].t);
    assert.equal(Math.min(...gaps) % 30e3, 0, 'on its 30 s cadence');
    const slow = of(2);
    assert.ok(slow.length >= 15 && slow.length <= 20, `slow ${slow.length}`);
    assert.equal(of(3).length, 0, 'out of range');
    // Jiggle: within about 4 sigma of the true track and speed.
    for (const r of close) {
        const s = stateAt(
            fleet.boats[0].samples.map(([t, lat, lon]) => ({t: Date.parse(t), lat, lon})),
            r.t - 5000,
            DEFAULTS.maxGapMs
        );
        assert.ok(leg(s, r).m < 25, 'position within 25 m');
        near(r.sogMs / KN, 6, 1, 'SOG');
        assert.equal(r.src, 'ais');
    }
    assert.ok(close[0].t >= T0 + 5000, 'shifted');
    // Seeded: the same again.
    assert.deepEqual(simulateFleet(fleet, own, OPTS).reports, reports);
});

test('own log to SI, shifted', () => {
    const json = {
        sample_fields: [
            't',
            'lat',
            'lon',
            'cog_deg',
            'sog_kn',
            'hdg_deg',
            'bsp_kn',
            'twd_deg',
            'tws_kn',
            'twa_deg',
            'aws_kn',
            'awa_deg'
        ],
        samples: [[T0, -34, 151, 90, 6, null, 5, 180, 10, -90, 12, -60]]
    };
    const [s] = ownFromLog(json, 1000);
    assert.equal(s.t, T0 + 1000);
    near(s.cogRad, Math.PI / 2, 1e-12, 'COG');
    near(s.sogMs, 6 * KN, 1e-12, 'SOG');
    assert.equal(s.hdgRad, null);
    near(s.twaRad, -Math.PI / 2, 1e-12, 'TWA port is negative');
    near(s.twsMs * 3600, 10 * NM, 1e-6, 'TWS');
});
