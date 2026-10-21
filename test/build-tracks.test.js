'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {nameKey, buildYbTracks, buildOwnLog} = require('./sim/build-tracks');

const D2R = Math.PI / 180;
const KN = 1852 / 3600;
const T = (iso) => Date.parse(iso);

test('name keys: case, punctuation and the two handed mark ignored', () => {
    assert.equal(nameKey("Wot's Next"), nameKey('Wots Next'));
    assert.equal(nameKey('Back 2 Black'), nameKey('BACK 2 BLACK'));
    assert.equal(nameKey('Verite'), nameKey('Verite (DH)'));
    assert.notEqual(nameKey('Moneypenny 2'), nameKey('Moneypenny'));
});

test('YB tracks: matched to CYCA entries by name or alias, cut to the window, real MMSIs kept', () => {
    const units = [
        {
            name: 'Kanreki',
            samples: [
                [T('2026-10-16T05:50:00Z'), -33.8, 151.3],
                [T('2026-10-16T06:00:30Z'), -33.81, 151.31],
                [T('2026-10-16T13:10:00Z'), -34.8, 151]
            ]
        },
        {name: 'Artaraxia', samples: [[T('2026-10-16T06:00:00Z'), -33.82, 151.32]]},
        {name: 'Spare 19', samples: [[T('2026-10-16T06:00:00Z'), -33.9, 151.4]]}
    ];
    const entries = [
        {raceEntryId: 19073, name: 'Kanreki', owner: 'O', club: 'C'},
        {raceEntryId: 19246, name: 'Ataraxia (DH)'}
    ];
    const {boats, unmatched} = buildYbTracks({
        units,
        entries,
        fromMs: T('2026-10-16T06:00:00Z'),
        toMs: T('2026-10-16T13:00:00Z'),
        aliases: {artaraxia: 'ataraxia'},
        mmsi: {kanreki: '503029690'}
    });
    assert.deepEqual(unmatched, ['Spare 19']);
    assert.deepEqual(
        boats.map((b) => [b.id, b.name, b.ybName, b.mmsi]),
        [
            [19246, 'Ataraxia (DH)', 'Artaraxia', undefined],
            [19073, 'Kanreki', 'Kanreki', '503029690']
        ]
    );
    assert.deepEqual(boats[1].samples, [['2026-10-16T06:00:30Z', -33.81, 151.31]]);
});

test('own log: window, GPS fix time, units as the gc2026 file (kn, deg), a repeated fix dropped', () => {
    const row = (gpsT, over = {}) => ({
        t: gpsT + 600,
        gpsT,
        lat: -33.123456789,
        lon: 151.987654321,
        cogRad: 350 * D2R,
        sogMs: 6.5 * KN,
        hdgRad: null,
        bspMs: 6 * KN,
        twdRad: -10 * D2R,
        twsMs: 12.345 * KN,
        twaRad: -40 * D2R,
        awsMs: 15 * KN,
        awaRad: -30 * D2R,
        ...over
    });
    const t0 = T('2026-10-16T06:00:00Z');
    const {sample_fields, samples} = buildOwnLog({
        rows: [
            row(t0 - 1000),
            row(t0),
            row(t0, {sogMs: 1}),
            row(t0 + 1000.4, {lat: null}),
            row(t0 + 2000, {gpsT: null})
        ],
        fromMs: t0,
        toMs: t0 + 5000
    });
    assert.equal(sample_fields.length, samples[0].length);
    assert.deepEqual(samples[0], [t0, -33.123457, 151.987654, 350, 6.5, null, 6, 350, 12.35, -40, 15, -30]);
    assert.equal(samples.length, 2, 'repeat and no-position rows dropped');
    assert.equal(samples[1][0], t0 + 2600, 'no GPS time: the logged time');
});
