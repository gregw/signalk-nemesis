'use strict'
/*
 * Builds the REST snapshot and track history payloads from internal state.
 * Pure functions of (store, own, userState, waypoint, config, now): no I/O.
 * All values SI; timestamps are epoch milliseconds.
 */

const { currentReport } = require('./track-store')
const { distance } = require('./geo')

function pickReport (r) {
  return r && { t: r.t, lat: r.lat, lon: r.lon, cogRad: r.cogRad, sogMs: r.sogMs, src: r.src }
}

/**
 * @returns {{now, staleMs, waypoint, own, boats: object[]}}
 */
function buildSnapshot ({ store, own, userState, waypoint, staleMs, now }) {
  const ownNow = own.at(now, staleMs)
  const boats = []
  for (const b of store.all()) {
    const latest = b.track.latest()
    if (!latest) continue
    const cur = currentReport(b.track, now, staleMs)
    // Range compares their report with OUR state at their report time (brief 2.2).
    const ourThen = own.at(latest.t)
    boats.push({
      id: b.id,
      name: b.name,
      nemesis: userState.isNemesis(b.id),
      tcf: userState.tcfOf(b.id),
      current: !!cur,
      ageMs: now - latest.t,
      rangeM: ourThen ? distance(ourThen, latest) : null,
      latest: pickReport(latest)
    })
  }
  return {
    now,
    staleMs,
    waypoint,
    own: ownNow && { t: ownNow.t, lat: ownNow.lat, lon: ownNow.lon, cogRad: ownNow.cogRad, sogMs: ownNow.sogMs, headingRad: ownNow.headingRad },
    boats
  }
}

/** Reports within [now - periodMs, now] per boat, plus our own samples at those report times. */
function buildTracks ({ store, own, now, periodMs, ids }) {
  const from = now - periodMs
  const boats = {}
  const ownAt = new Map()
  for (const b of store.all()) {
    if (ids && !ids.has(b.id)) continue
    const rs = b.track.between(from, now)
    if (!rs.length) continue
    boats[b.id] = rs.map(pickReport)
    for (const r of rs) {
      if (ownAt.has(r.t)) continue
      const o = own.at(r.t)
      if (o) ownAt.set(r.t, { t: r.t, lat: o.lat, lon: o.lon, cogRad: o.cogRad, sogMs: o.sogMs })
    }
  }
  return { now, periodMs, boats, ownAtReports: [...ownAt.values()].sort((a, b) => a.t - b.t) }
}

module.exports = { buildSnapshot, buildTracks }
