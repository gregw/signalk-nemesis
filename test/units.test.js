'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const UNITS = require('../public/units')

test('UI edge conversions', () => {
  assert.equal(UNITS.kn(1852 / 3600), 1)
  assert.equal(UNITS.nm(1852), 1)
  assert.equal(UNITS.deg(-Math.PI / 2), 270)
  assert.equal(UNITS.fmt(null, 1), '–')
  assert.equal(UNITS.fmtAge(45e3), '45s')
  assert.equal(UNITS.fmtAge(5 * 60e3), '5m')
})
