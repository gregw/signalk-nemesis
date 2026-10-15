'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const geo = require('../lib/geo')

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`)

test('distance: 1 degree of longitude on the equator is 2 pi R / 360', () => {
  const d = geo.distance({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })
  near(d, (2 * Math.PI * geo.EARTH_RADIUS_M) / 360, 1e-6, 'metres')
  near(d, 111195.08, 0.01, 'worked value')
})

test('distance: zero for identical points', () => {
  assert.equal(geo.distance({ lat: -33.85, lon: 151.28 }, { lat: -33.85, lon: 151.28 }), 0)
})

test('bearing: cardinal directions', () => {
  near(geo.bearing({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }), 0, 1e-12, 'north')
  near(geo.bearing({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }), Math.PI / 2, 1e-12, 'east')
  near(geo.bearing({ lat: 0, lon: 0 }, { lat: -1, lon: 0 }), Math.PI, 1e-12, 'south')
  near(geo.bearing({ lat: 0, lon: 0 }, { lat: 0, lon: -1 }), 1.5 * Math.PI, 1e-12, 'west')
})

test('displacement agrees with distance at short range', () => {
  const a = { lat: -33.85, lon: 151.28 }
  const b = { lat: -33.80, lon: 151.35 }
  const { e, n } = geo.displacement(a, b)
  near(Math.hypot(e, n), geo.distance(a, b), 5, 'metres over ~8 km')
  assert.ok(e > 0 && n > 0)
})

test('displacement takes the short way across the antimeridian', () => {
  const { e } = geo.displacement({ lat: 0, lon: 179.9 }, { lat: 0, lon: -179.9 })
  assert.ok(e > 0 && e < 30000, `east ${e}`)
})

test('lerpAngle: 350 to 010 degrees passes through 000', () => {
  const d = Math.PI / 180
  near(geo.lerpAngle(350 * d, 10 * d, 0.5), 0, 1e-12, 'midpoint')
  near(geo.lerpAngle(350 * d, 10 * d, 0.25), 355 * d, 1e-12, 'quarter')
})

test('normPi range', () => {
  near(geo.normPi(3 * Math.PI / 2), -Math.PI / 2, 1e-12, '270 -> -90')
  near(geo.normPi(-Math.PI / 2), -Math.PI / 2, 1e-12, '-90 stays')
})

test('velocity components', () => {
  const v = geo.velocity(Math.PI / 2, 5)
  near(v.e, 5, 1e-12, 'east')
  near(v.n, 0, 1e-12, 'north')
})
