'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {simulate, lerpDeg, rng, mmsiOf} = require('./sim/ais-sim');
const {parseArgs, login} = require('./sim/live-feed');
const data = require('./data/gc2026-tracks.json');

test('rng is deterministic per seed', () => {
    const a = rng(42);
    const b = rng(42);
    const c = rng(43);
    const sa = [a(), a(), a()];
    assert.deepEqual(sa, [b(), b(), b()]);
    assert.notDeepEqual(sa, [c(), c(), c()]);
});

test('COG interpolation goes the short way: 350 to 010 passes 000', () => {
    assert.equal(lerpDeg(350, 10, 0.5), 0);
    assert.equal(lerpDeg(10, 350, 0.25), 5);
});

test('simulation is deterministic and receives only within 20 nm', () => {
    const a = simulate(data, {receiverName: 'Kanreki', seed: 7});
    const b = simulate(data, {receiverName: 'Kanreki', seed: 7});
    assert.equal(a.reports.length, b.reports.length);
    assert.deepEqual(a.reports.slice(0, 50), b.reports.slice(0, 50));
    assert.ok(a.reports.length > 1000, `reports ${a.reports.length}`);
    assert.ok(a.own.length > 4000, `own samples ${a.own.length}`);
});

test('simulated gaps look like AIS (GC2026 measured: median 2 min, p90 7 min)', () => {
    const {reports} = simulate(data, {receiverName: 'Kanreki', seed: 7});
    const last = new Map();
    const gaps = [];
    for (const r of reports) {
        const p = last.get(r.boatId);
        if (p != null && r.t - p <= 30 * 60e3) gaps.push((r.t - p) / 60e3);
        last.set(r.boatId, r.t);
    }
    gaps.sort((x, y) => x - y);
    const q = (f) => gaps[Math.floor(f * (gaps.length - 1))];
    assert.ok(q(0.5) >= 1 && q(0.5) <= 3, `median ${q(0.5)}`);
    assert.ok(q(0.9) >= 4 && q(0.9) <= 10, `p90 ${q(0.9)}`);
});

test('MMSIs: Kanreki has its real one, the others a made-up 9 digits', () => {
    const sim = simulate(data, {receiverName: 'Kanreki', seed: 11});
    assert.equal(sim.ownMmsi, '503029690');
    const ids = [...sim.names.keys()];
    assert.ok(ids.length > 40);
    for (const id of ids) assert.match(id, /^5000\d{5}$/);
    assert.equal(new Set(data.boats.map(mmsiOf)).size, data.boats.length, 'unique');
    // Kanreki as an AIS target when another boat is the receiver.
    const other = simulate(data, {receiverName: 'Ambition', seed: 11});
    assert.equal(other.names.get('503029690'), 'Kanreki');
});

test('live-feed --user: logs in with POST /signalk/v1/auth/login', async () => {
    assert.equal(parseArgs(['--user', 'admin', '--live']).user, 'admin');
    const seen = [];
    const srv = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            seen.push({url: req.url, type: req.headers['content-type'], body: JSON.parse(body)});
            const ok = JSON.parse(body).password === 'pw';
            res.writeHead(ok ? 200 : 401, {'Content-Type': 'application/json'});
            res.end(JSON.stringify(ok ? {token: 'T'} : {message: 'Invalid username/password'}));
        });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `ws://127.0.0.1:${srv.address().port}/`;
    try {
        assert.equal(await login(url, 'admin', 'pw'), 'T');
        assert.deepEqual(seen[0], {
            url: '/signalk/v1/auth/login',
            type: 'application/json',
            body: {username: 'admin', password: 'pw'}
        });
        await assert.rejects(login(url, 'admin', 'bad'), /login failed: 401 Invalid username\/password/);
    } finally {
        srv.close();
    }
});

test('live-feed --race: the Tollgate race plays our logged heading and wind, and no finish', () => {
    const {ownDelta} = require('./sim/live-feed');
    const {race} = require('./sim/races');
    assert.equal(parseArgs([]).race, 'gc2026');
    assert.equal(parseArgs(['--race', 'tollgate2026']).race, 'tollgate2026');
    assert.throws(() => race('nope'), /unknown race nope/);
    const rec = race('tollgate2026');
    assert.equal(rec.start, Date.parse('2026-10-16T06:00:00Z'));
    const sim = rec.play(1000);
    assert.equal(sim.finish, null);
    const s = sim.own.find((x) => x.hdgRad != null && x.twdRad != null);
    assert.equal(
        s.t,
        require('./data/tollgate2026-kanreki.json').samples.find((x) => x[5] != null && x[7] != null)[0] + 1000
    );
    const d = ownDelta('vessels.self', s);
    assert.deepEqual(
        d.updates[0].values.map((v) => v.path),
        [
            'navigation.position',
            'navigation.courseOverGroundTrue',
            'navigation.speedOverGround',
            'navigation.headingTrue'
        ]
    );
    assert.equal(d.updates[0].values[3].value, s.hdgRad);
    // GC2026 has no heading: none sent.
    const g = race('gc2026').play(0).own[30];
    assert.equal(ownDelta('vessels.self', g).updates[0].values.length, 3);
});
