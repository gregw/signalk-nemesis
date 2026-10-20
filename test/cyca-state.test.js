'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {CycaState} = require('../lib/cyca-state');
const {tmpdir} = require('./sim/tmpdir');

test('race, links and No AIS marks survive a restart', async () => {
    const dir = tmpdir();
    const s = new CycaState(dir);
    await s.setRace(197);
    await s.link('Calibre 12', '503111111');
    await s.setNoAis(19231, true);
    const r = new CycaState(dir);
    assert.equal(r.raceId, 197);
    assert.equal(r.linkOf('  calibre  12 '), '503111111');
    assert.equal(r.isNoAis(19231), true);
});

test('links persist across races; No AIS marks do not', async () => {
    const dir = tmpdir();
    const s = new CycaState(dir);
    await s.setRace(194);
    await s.link('Kanreki', '503222222');
    await s.setNoAis(18921, true);
    await s.setRace(197);
    assert.equal(s.linkOf('Kanreki'), '503222222');
    assert.equal(s.isNoAis(18921), false);
    assert.equal(new CycaState(dir).isNoAis(18921), false);
});

test('one AIS boat links to one CYCA name; unlink removes it', async () => {
    const s = new CycaState(tmpdir());
    await s.link('Wrong Boat', '503333333');
    await s.link('Right Boat', '503333333');
    assert.equal(s.linkOf('Wrong Boat'), null);
    assert.equal(s.nameOf('503333333'), 'right boat');
    await s.link('Right Boat', null);
    assert.equal(s.linkOf('Right Boat'), null);
});

test('invalid input is rejected and a corrupt file starts empty', () => {
    const dir = tmpdir();
    const s = new CycaState(dir);
    assert.throws(() => s.link('', '503333333'), RangeError);
    assert.throws(() => s.link('Boat', 'abc'), RangeError);
    assert.throws(() => s.setNoAis('1', true), RangeError);
    fs.writeFileSync(path.join(dir, 'cyca-state.json'), '{not json');
    const r = new CycaState(dir);
    assert.equal(r.raceId, null);
    assert.equal(r.links.size, 0);
});
