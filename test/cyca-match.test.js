'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {TrackStore} = require('../lib/track-store');
const {suggest, aisAt} = require('../lib/cyca-match');
const {mergedView, mergeTracks} = require('../lib/cyca-merge');
const {simulate} = require('./sim/ais-sim');
const data = require('./data/gc2026-tracks.json');

const M = 60e3;
const KN = 1852 / 3600;
const T0 = Date.parse('2026-07-25T03:00:00Z');
const r = (boatId, t, lat, lon, extra = {}) => ({boatId, t, lat, lon, cogRad: 0, sogMs: 6 * KN, ...extra});

function store(reports, names = {}) {
    const s = new TrackStore({maxSpanMs: 96 * 3600e3, maxReportsPerBoat: 10000});
    for (const x of reports) s.add(x);
    for (const [id, n] of Object.entries(names)) s.setName(id, n);
    return s;
}

test('mergeTracks drops tracker reports within the window of an AIS report', () => {
    const ais = [{t: 0}, {t: 3 * M}, {t: 40 * M}];
    const cyca = [{t: 10 * M}, {t: 20 * M}, {t: 30 * M}, {t: 50 * M}, {t: 60 * M}];
    assert.deepEqual(
        mergeTracks(ais, cyca).map((x) => x.t / M),
        [0, 3, 20, 40, 60]
    );
    assert.equal(mergeTracks(ais, []), ais);
});

test('a linked CYCA boat shows as its AIS boat, even before AIS hears it; unlinked stays cyca:', () => {
    const s = store(
        [
            r('503000001', T0, -33.8, 151.3),
            r('cyca:1', T0 + 30 * M, -33.7, 151.4),
            r('cyca:2', T0 + 30 * M, -33.6, 151.5),
            r('cyca:3', T0 + 30 * M, -33.5, 151.6)
        ],
        {503000001: 'KANREKI', 'cyca:1': 'Kanreki', 'cyca:2': 'Calibre 12', 'cyca:3': 'Ambition'}
    );
    const links = {kanreki: '503000001', 'calibre 12': '503000002'};
    const v = mergedView(s, (name) => links[name.toLowerCase()] || null);
    const ids = v
        .all()
        .map((b) => b.id)
        .sort();
    assert.deepEqual(ids, ['503000001', '503000002', 'cyca:3']);
    const k = v.get('503000001');
    assert.equal(k.name, 'KANREKI');
    assert.equal(k.cycaId, 'cyca:1');
    assert.deepEqual(
        k.track.items.map((x) => x.t),
        [T0, T0 + 30 * M]
    );
    assert.equal(k.track.latest().boatId, 'cyca:1');
    const c = v.get('503000002');
    assert.equal(c.name, 'Calibre 12'); // not heard on AIS yet
    // The store itself is untouched.
    assert.ok(s.get('cyca:1'));
});

test('aisAt dead-reckons the nearest report within the limit', () => {
    const s = store([r('a', T0, -34, 151, {cogRad: 0, sogMs: 10}), r('a', T0 + 20 * M, -33.9, 151)]);
    const p = aisAt(s.get('a').track, T0 + 60e3, 5 * M);
    assert.ok(Math.abs(p.lat - (-34 + 600 / 111195)) < 1e-4);
    assert.equal(aisAt(s.get('a').track, T0 + 10 * M, 5 * M), null);
});

test('candidates are compared at the CYCA slot time, not at the latest AIS position', () => {
    const t = T0 + 60 * M;
    // AIS boat x was at the CYCA position at t, and has sailed on since; y is there now.
    const s = store([
        r('cyca:1', t, -33.5, 151.5),
        r('x', t + M, -33.5 + (6 * KN * 60) / 111195, 151.5),
        r('x', t + 25 * M, -33.45, 151.5),
        r('y', t + 25 * M, -33.5, 151.5)
    ]);
    const res = suggest({cyca: [s.get('cyca:1')], ais: [s.get('x'), s.get('y')], now: t + 26 * M, minChecks: 1}).get(
        'cyca:1'
    );
    assert.deepEqual(
        res.candidates.map((c) => c.mmsi),
        ['x']
    );
    assert.equal(res.recommended, 'x');
});

test('opposite headings do not match; equal names match at any distance; close pairs are ambiguous', () => {
    const t = T0 + 60 * M;
    const s = store(
        [
            r('cyca:1', t, -33.5, 151.5, {cogRad: 0}),
            r('opp', t, -33.5005, 151.5, {cogRad: Math.PI}),
            r('far', t, -32, 152),
            r('cyca:2', t, -33.0, 151.0),
            r('p', t, -33.0005, 151.0),
            r('q', t, -33.0, 151.0005)
        ],
        {'cyca:1': 'Kanreki', far: 'KANREKI'}
    );
    const res = suggest({
        cyca: [s.get('cyca:1'), s.get('cyca:2')],
        ais: ['opp', 'far', 'p', 'q'].map((id) => s.get(id)),
        now: t,
        minChecks: 1
    });
    const one = res.get('cyca:1');
    assert.deepEqual(
        one.candidates.map((c) => [c.mmsi, c.sameName, c.distanceM]),
        [['far', true, null]]
    );
    assert.equal(one.recommended, 'far');
    const two = res.get('cyca:2');
    assert.deepEqual(two.candidates.map((c) => c.mmsi).sort(), ['p', 'q']);
    assert.equal(two.recommended, null);
});

/** GC2026 with unnamed AIS from the simulator and the recorded 10 min samples as the CYCA feed. */
function gc2026At(sim, now) {
    const s = new TrackStore({maxSpanMs: 96 * 3600e3, maxReportsPerBoat: 10000});
    for (const x of sim.reports) if (x.t <= now) s.add(x);
    const pairs = [];
    for (const b of data.boats) {
        if (b.name === 'Kanreki') continue;
        const id = 'cyca:' + b.id;
        for (const [ts, lat, lon, sog, cog] of b.samples) {
            const t = Date.parse(ts);
            if (t > now) break;
            s.add({boatId: id, t, lat, lon, sogMs: sog * KN, cogRad: (cog * Math.PI) / 180});
        }
        s.setName(id, b.name);
        pairs.push({cyca: id, mmsi: String(500000000 + b.id)});
    }
    const ais = s.all().filter((b) => !b.id.startsWith('cyca:'));
    const res = suggest({cyca: pairs.map((c) => s.get(c.cyca)), ais, now});
    const n = {right: 0, wrong: 0, heard: 0};
    for (const c of pairs) {
        const latest = s.get(c.mmsi)?.track.latest();
        if (latest && now - latest.t < 10 * M) n.heard++;
        const rec = res.get(c.cyca).recommended;
        if (rec === c.mmsi) n.right++;
        else if (rec) n.wrong++;
    }
    return n;
}

test('GC2026: by position alone, no picks in the packed start, then the right AIS boat', () => {
    for (const seed of [11, 3, 7]) {
        const sim = simulate(data, {receiverName: 'Kanreki', seed});
        const start = gc2026At(sim, T0 + 0.5 * 3600e3);
        assert.equal(start.right + start.wrong, 0, `seed ${seed}: no recommendation 30 min after the start`);
        // One hour in, a boat the AIS never heard can still have a neighbour alongside it all
        // hour (seed 11): a recommendation is a suggestion the navigator confirms.
        assert.ok(gc2026At(sim, T0 + 3600e3).wrong <= 1, `seed ${seed}: at most one wrong pick at 1 h`);
        for (const hoursIn of [2, 6, 24]) {
            const n = gc2026At(sim, T0 + hoursIn * 3600e3);
            assert.equal(n.wrong, 0, `seed ${seed} hour ${hoursIn}: ${n.wrong} wrong`);
            assert.ok(n.right >= n.heard * 0.85, `seed ${seed} hour ${hoursIn}: ${n.right} right of ${n.heard} heard`);
        }
    }
});
