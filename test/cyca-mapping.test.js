'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {TrackStore} = require('../lib/track-store');
const {CycaState} = require('../lib/cyca-state');
const {mappingRows} = require('../lib/cyca-mapping');
const {tmpdir} = require('./sim/tmpdir');

const M = 60e3;
const T0 = Date.parse('2026-07-25T03:00:00Z');
const KN = 1852 / 3600;

/** Two CYCA boats sailing north for an hour; AIS hears only the first, as 503000001. */
function setup() {
    const s = new TrackStore({maxSpanMs: 96 * 3600e3});
    for (let i = 0; i <= 6; i++) {
        const t = T0 + i * 10 * M;
        const lat = -34 + (i * 6 * KN * 600) / 111195;
        s.add({boatId: 'cyca:1', t, lat, lon: 151, cogRad: 0, sogMs: 6 * KN});
        s.add({boatId: 'cyca:2', t, lat, lon: 152, cogRad: 0, sogMs: 6 * KN});
        s.add({boatId: '503000001', t: t + M, lat: lat + (6 * KN * 60) / 111195, lon: 151, cogRad: 0, sogMs: 6 * KN});
    }
    const entries = [
        {entryId: 1, name: 'Kanreki', owner: 'A', club: 'X'},
        {entryId: 2, name: 'Calibre 12', owner: 'B', club: 'Y'}
    ];
    return {store: s, entries, now: T0 + 61 * M};
}

test('an unlinked boat with a candidate needs action, and sorts first', () => {
    const {store, entries, now} = setup();
    const cycaState = new CycaState(tmpdir());
    const m = mappingRows({entries, store, cycaState, now});
    assert.equal(m.needsAction, true);
    assert.deepEqual(
        m.rows.map((r) => [r.name, r.needsAction, r.recommended]),
        [
            ['Kanreki', true, '503000001'],
            ['Calibre 12', false, null]
        ]
    );
    assert.equal(m.rows[0].candidates[0].checks, 6); // the slots in the last hour
    assert.ok(m.rows[0].candidates[0].distanceM < 50);
    assert.equal(m.rows[0].lastT, T0 + 60 * M);
    assert.equal('score' in m.rows[0].candidates[0], false);
});

test('linking or marking No AIS clears the need; the linked AIS boat is no candidate for others', async () => {
    const {store, entries, now} = setup();
    const cycaState = new CycaState(tmpdir());
    await cycaState.link('Kanreki', '503000001');
    let m = mappingRows({entries, store, cycaState, now});
    assert.equal(m.needsAction, false);
    const k = m.rows.find((r) => r.name === 'Kanreki');
    assert.equal(k.link, '503000001');
    assert.equal(k.candidates.length, 0);
    await cycaState.link('Kanreki', null);
    await cycaState.setNoAis(1, true);
    m = mappingRows({entries, store, cycaState, now});
    assert.equal(m.needsAction, false);
    assert.equal(m.rows.at(-1).name, 'Kanreki'); // No AIS sorts last
});

test('before the start (no tracker fixes) boats still match AIS boats by name', async () => {
    const s = new TrackStore({maxSpanMs: 96 * 3600e3});
    const now = T0;
    s.add({boatId: '503000001', t: now - 4 * 24 * 3600e3, lat: -33.8, lon: 151.3, cogRad: 0, sogMs: 0});
    s.setName('503000001', 'BLUE PLANET (DH)');
    s.add({boatId: '503000002', t: now - 60e3, lat: -33.8, lon: 151.3, cogRad: 0, sogMs: 0});
    s.setName('503000002', 'Someone Else');
    const entries = [
        {entryId: 1, name: 'Blue Planet (DH)', owner: '', club: ''},
        {entryId: 2, name: 'Akonga', owner: '', club: ''}
    ];
    const m = mappingRows({entries, store: s, cycaState: new CycaState(tmpdir()), now});
    const bp = m.rows.find((r) => r.name === 'Blue Planet (DH)');
    assert.equal(bp.lastT, null);
    assert.deepEqual(
        bp.candidates.map((c) => [c.mmsi, c.sameName, c.distanceM]),
        [['503000001', true, null]]
    );
    assert.equal(bp.recommended, '503000001');
    assert.equal(bp.needsAction, true);
    assert.equal(m.rows.find((r) => r.name === 'Akonga').candidates.length, 0);
    assert.equal(m.needsAction, true);
});
