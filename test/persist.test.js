'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { writeJsonAtomic, readJson, JsonStore } = require('../lib/persist')
const { UserState } = require('../lib/user-state')

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-'))

test('atomic write leaves no temp file and round-trips', async () => {
  const d = tmpdir()
  const f = path.join(d, 'x.json')
  await writeJsonAtomic(f, { a: 1 })
  assert.deepEqual(readJson(f), { a: 1 })
  assert.deepEqual(fs.readdirSync(d), ['x.json'])
})

test('corrupt or missing file falls back', () => {
  const d = tmpdir()
  const f = path.join(d, 'bad.json')
  fs.writeFileSync(f, '{"trunc')
  assert.equal(readJson(f, 'fb'), 'fb')
  assert.equal(readJson(path.join(d, 'none.json'), 'fb'), 'fb')
})

test('concurrent saves serialise and the last state wins', async () => {
  const d = tmpdir()
  const s = new JsonStore(d, 's.json')
  const ps = []
  for (let i = 0; i < 20; i++) ps.push(s.save({ i }))
  await Promise.all(ps)
  assert.deepEqual(s.load(), { i: 19 })
})

test('user state survives a restart', async () => {
  const d = tmpdir()
  const u = new UserState(d)
  await u.setNemesis('503000001', true)
  await u.setTcf('503000001', 1.1)
  await u.setTcf('503000002', 1)
  const u2 = new UserState(d)
  assert.ok(u2.isNemesis('503000001'))
  assert.equal(u2.tcfOf('503000001'), 1.1)
  assert.equal(u2.tcfOf('503000002'), 1)
  assert.throws(() => u2.setTcf('x', 0), RangeError)
  assert.throws(() => u2.setTcf('x', NaN), RangeError)
})
