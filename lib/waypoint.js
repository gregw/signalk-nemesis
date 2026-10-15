'use strict'
/*
 * The single waypoint() seam (brief section 3.1). Everything that needs the
 * active waypoint (Up = Waypoint frame, DTG, VMC, map marker) asks this.
 *
 * Source order:
 *  1. Course API next point, read from the v1 data model path
 *     navigation.courseRhumbline.nextPoint.position on our own vessel
 *     (signalk-server src/api/course/index.ts emitCourseInfo/buildV1DeltaMsg).
 *  2. A fixed waypoint from plugin configuration.
 *
 * TODO(verify): whether v2 `navigation.course.nextPoint` is the better source on
 * signalk-server 2.30 (local source checked is 2.18.0).
 */

function makeWaypointSource (app, config) {
  const fallback = Number.isFinite(config?.waypoint?.lat) && Number.isFinite(config?.waypoint?.lon)
    ? { lat: config.waypoint.lat, lon: config.waypoint.lon, src: 'config' }
    : null

  return function waypoint () {
    try {
      const v = app.getSelfPath('navigation.courseRhumbline.nextPoint.position')
      const p = v && (v.value || v)
      if (p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude)) {
        return { lat: p.latitude, lon: p.longitude, src: 'course' }
      }
    } catch (e) {
      // fall through to configured waypoint
    }
    return fallback
  }
}

module.exports = { makeWaypointSource }
