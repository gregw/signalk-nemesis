'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {UserState} = require('../lib/user-state');

const {tmpdir} = require('./sim/tmpdir');
const tmp = () => tmpdir('nemesis-us-');

test('configured boats seed the nemesis list and TCFs once; webapp edits survive a restart', async () => {
    const dir = tmp();
    const cfg = [
        {mmsi: '503029690', tcf: 1.05},
        {mmsi: '503000001', tcf: null}
    ];
    let u = new UserState(dir);
    await u.applyConfig(cfg);
    assert.ok(u.isNemesis('503029690') && u.isNemesis('503000001'));
    assert.equal(u.tcfOf('503029690'), 1.05);
    assert.equal(u.tcfOf('503000001'), 1, 'no configured TCF: default');

    // Edited in the webapp, then a restart with the same configuration.
    await u.setNemesis('503000001', false);
    await u.setTcf('503029690', 1.1);
    u = new UserState(dir);
    assert.equal(u.applyConfig(cfg), null, 'nothing to apply');
    assert.equal(u.tcfOf('503029690'), 1.1, 'webapp TCF kept');
    assert.ok(!u.isNemesis('503000001'), 'webapp un-nemesis kept');

    // The configured TCF changed: applied again; a new boat: added.
    await u.applyConfig([
        {mmsi: '503029690', tcf: 1.2},
        {mmsi: '503000001', tcf: null},
        {mmsi: '503000002', tcf: 1}
    ]);
    assert.equal(u.tcfOf('503029690'), 1.2);
    assert.ok(!u.isNemesis('503000001'), 'unchanged entry left alone');
    assert.ok(u.isNemesis('503000002'));

    // A configured TCF removed: the boat keeps its TCF; removing the boat changes nothing.
    await u.applyConfig([{mmsi: '503029690', tcf: null}]);
    assert.equal(u.tcfOf('503029690'), 1.2);
    assert.equal(new UserState(dir).applyConfig([{mmsi: '503029690', tcf: null}]), null, 'persisted');
    assert.ok(new UserState(dir).isNemesis('503000002'), 'removed from config: still a nemesis');
});
