'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {TwdSmoother, WindAdapter} = require('../lib/wind');
const {fakeApp} = require('./sim/fake-app');
const {tmpdir} = require('./sim/tmpdir');

const DEG = Math.PI / 180;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
// Angular difference, wrapped to -pi..pi.
const angNear = (a, b, tol, msg) => near(Math.atan2(Math.sin(a - b), Math.cos(a - b)), 0, tol, msg);

test('TWD smoothing: a circular mean, across north without averaging to south', () => {
    const w = new TwdSmoother({windowMs: 120e3});
    w.add(0, 350 * DEG);
    w.add(1000, 10 * DEG);
    angNear(w.at(1000), 0, 1e-9, 'mean of 350 and 10 is north');
    w.add(2000, 20 * DEG);
    // Mean of 350, 10, 20: atan2 of the summed unit vectors.
    const want = Math.atan2(
        Math.sin(350 * DEG) + Math.sin(10 * DEG) + Math.sin(20 * DEG),
        Math.cos(350 * DEG) + Math.cos(10 * DEG) + Math.cos(20 * DEG)
    );
    angNear(w.at(2000), want, 1e-12, 'three readings');
    assert.ok(w.at(2000) >= 0 && w.at(2000) < 2 * Math.PI, 'in 0..2 pi');
});

test('TWD smoothing: only the window ending at t counts; none in it is null', () => {
    const w = new TwdSmoother({windowMs: 120e3});
    for (let t = 0; t < 120e3; t += 1000) w.add(t, 200 * DEG);
    for (let t = 120e3; t <= 240e3; t += 1000) w.add(t, 220 * DEG);
    near(w.at(240e3) / DEG, 220, 1e-9, 'the old wind has left the window');
    assert.equal(w.at(240e3 + 121e3), null, 'no reading for a whole window: wind lost');
    assert.equal(new TwdSmoother().at(0), null, 'never had wind');
});

test('TWD smoothing: bad values ignored, fast input thinned so memory is bounded', () => {
    const w = new TwdSmoother({windowMs: 120e3});
    w.add(0, NaN);
    w.add(NaN, 1);
    w.add(0, null);
    assert.equal(w.at(0), null);
    for (let t = 0; t <= 120e3; t += 10) w.add(t, 90 * DEG); // 100 Hz
    assert.ok(w.buf.items.length <= 481, `bounded: ${w.buf.items.length}`);
    near(w.at(120e3) / DEG, 90, 1e-9, 'value');
});

test('Wind adapter: our environment.wind.directionTrue feeds the smoother; other vessels ignored', () => {
    const app = fakeApp({dataDir: tmpdir()});
    const w = new TwdSmoother({windowMs: 60e3});
    const a = new WindAdapter(app, w);
    a.start();
    const t = Date.parse('2026-07-25T03:00:00Z');
    const wind = (context, rad) => ({
        context,
        updates: [
            {timestamp: new Date(t).toISOString(), values: [{path: 'environment.wind.directionTrue', value: rad}]}
        ]
    });
    app.deliver(wind('vessels.urn:mrn:imo:mmsi:500000001', 90 * DEG));
    assert.equal(w.at(t), null, 'not ours');
    app.deliver(wind(app.selfContext, 135 * DEG));
    near(w.at(t) / DEG, 135, 1e-9, 'ours');
    a.stop();
    app.deliver(wind(app.selfContext, 0));
    near(w.at(t) / DEG, 135, 1e-9, 'unsubscribed on stop');
});
