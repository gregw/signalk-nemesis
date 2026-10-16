'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {Coalescer} = require('../lib/coalescer');

// Manual timers so tests control flushing.
function harness() {
    const out = [];
    const timers = new Set();
    const c = new Coalescer((ctx, r) => out.push({ctx, ...r}), {
        setTimer: (fn) => {
            const h = {fn};
            timers.add(h);
            return h;
        },
        clearTimer: (h) => timers.delete(h)
    });
    const fire = () => {
        for (const h of [...timers]) {
            timers.delete(h);
            h.fn();
        }
    };
    return {c, out, fire};
}

const CTX = 'vessels.urn:mrn:imo:mmsi:503000001';
const T1 = '2026-07-25T03:00:00.000Z';
const T2 = '2026-07-25T03:03:00.000Z';
const one = (path, value, ts = T1, context = CTX) => ({context, updates: [{timestamp: ts, values: [{path, value}]}]});

test('merges per-path values sharing a timestamp into one report', () => {
    const {c, out, fire} = harness();
    c.accept(one('navigation.position', {latitude: -33.8, longitude: 151.3}));
    c.accept(one('navigation.courseOverGroundTrue', 0.5));
    c.accept(one('navigation.speedOverGround', 4));
    assert.equal(out.length, 0);
    fire();
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], {
        ctx: CTX,
        t: Date.parse(T1),
        lat: -33.8,
        lon: 151.3,
        cogRad: 0.5,
        sogMs: 4,
        headingRad: null
    });
});

test('a new timestamp flushes the previous report immediately', () => {
    const {c, out} = harness();
    c.accept(one('navigation.position', {latitude: 1, longitude: 2}));
    c.accept(one('navigation.position', {latitude: 3, longitude: 4}, T2));
    assert.equal(out.length, 1);
    assert.equal(out[0].lat, 1);
    assert.equal(out[0].cogRad, null);
});

test('reports without a position are dropped', () => {
    const {c, out, fire} = harness();
    c.accept(one('navigation.speedOverGround', 4));
    fire();
    assert.equal(out.length, 0);
});

test('contexts are independent', () => {
    const {c, out, fire} = harness();
    c.accept(one('navigation.position', {latitude: 1, longitude: 2}));
    c.accept(one('navigation.position', {latitude: 5, longitude: 6}, T1, 'vessels.urn:mrn:imo:mmsi:503000002'));
    fire();
    assert.equal(out.length, 2);
});

test('malformed input never throws', () => {
    const {c, out, fire} = harness();
    for (const bad of [
        null,
        {},
        {context: CTX},
        {context: CTX, updates: [null]},
        {context: CTX, updates: [{timestamp: 'nope', values: []}]},
        {context: CTX, updates: [{timestamp: T1, values: [null, {path: 'navigation.position', value: null}]}]},
        one('navigation.position', {latitude: 'x', longitude: 2})
    ]) {
        c.accept(bad);
    }
    fire();
    assert.equal(out.length, 0);
});

test('AIS adapter looks names up in the data model, throttled', () => {
    const {AisSourceAdapter} = require('../lib/ais-adapter');
    let t = 0;
    let lookups = 0;
    const model = {};
    const app = {
        getPath: (p) => {
            if (p.endsWith('.name')) lookups++;
            return model[p];
        },
        debug: () => {}
    };
    const names = [];
    const a = new AisSourceAdapter(
        app,
        () => {},
        (id, n) => names.push([id, n]),
        () => t
    );
    const ctx = 'vessels.urn:mrn:imo:mmsi:503000001';
    a._lookupName(ctx, '503000001');
    assert.deepEqual(names, []);
    model[ctx + '.name'] = 'Calibre 12';
    t = 10e3;
    a._lookupName(ctx, '503000001'); // within retry interval: no lookup
    assert.equal(lookups, 1);
    t = 31e3;
    a._lookupName(ctx, '503000001');
    assert.deepEqual(names, [['503000001', 'Calibre 12']]);
    model[ctx + '.design.aisShipType'] = {value: {id: 36, name: 'Sailing'}};
    t = 62e3; // named but no ship type yet: still the retry interval
    a._lookupName(ctx, '503000001');
    assert.equal(lookups, 3);
    t = 100e3;
    a._lookupName(ctx, '503000001'); // named and typed: refresh interval is longer
    assert.equal(lookups, 3);
});

test('AIS adapter reads the ship type from the data model, as a leaf or a bare value', () => {
    const {AisSourceAdapter} = require('../lib/ais-adapter');
    let t = 0;
    const model = {};
    const app = {getPath: (p) => model[p], debug: () => {}};
    const types = [];
    const a = new AisSourceAdapter(
        app,
        () => {},
        () => {},
        () => t,
        (id, st) => types.push([id, st])
    );
    const ctx = 'vessels.urn:mrn:imo:mmsi:503000001';
    model[ctx + '.name'] = 'Calibre 12';
    a._lookupName(ctx, '503000001');
    assert.deepEqual(types, [], 'no type yet');
    model[ctx + '.design.aisShipType'] = {value: {id: 36, name: 'Sailing'}, $source: 'x'};
    t = 31e3; // no type yet: retried at the short interval although named
    a._lookupName(ctx, '503000001');
    assert.deepEqual(types, [['503000001', 36]]);
    model[ctx + '.design.aisShipType'] = {id: 70, name: 'Cargo'};
    t = 100e3; // complete: not looked up again before the refresh interval
    a._lookupName(ctx, '503000001');
    assert.deepEqual(types, [['503000001', 36]]);
    t = 700e3;
    a._lookupName(ctx, '503000001');
    assert.deepEqual(types, [
        ['503000001', 36],
        ['503000001', 70]
    ]);
    delete model[ctx + '.design.aisShipType'];
    t = 1400e3; // gone from the model (server restart): the known type is kept
    a._lookupName(ctx, '503000001');
    assert.equal(types.length, 2);
});
