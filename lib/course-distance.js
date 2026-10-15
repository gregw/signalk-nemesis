'use strict';
/*
 * Course length for the TCF Should distance D (wiki section 8, decided 2026-10-15):
 *   D = our distance made good along the course
 *     = totalM - (our distance to the waypoint + afterM)
 * where, in order of preference:
 *  1. route: a Course API active route drives the waypoint. totalM is the route's
 *     length; afterM the legs after the next point. pointIndex counts in travel order,
 *     so a reversed route is walked from its last coordinate (signalk-server 2.18
 *     src/api/course/index.ts getRoutePoint).
 *  2. start: a waypoint resource named as the start. totalM is its distance to the
 *     waypoint; afterM 0.
 *  3. config: a configured course distance; afterM 0.
 * The client evaluates D at each report time from our position then, so this is
 * the only part that needs server-side knowledge (route resources, named waypoints).
 */

const {distance} = require('./geo');

// The route's next point must be this close to the waypoint in use, else the route is stale.
const ROUTE_MATCH_M = 100;

function legs(points) {
    let m = 0;
    for (let i = 1; i < points.length; i++) m += distance(points[i - 1], points[i]);
    return m;
}

/**
 * @param {object} p
 * @param {object|null} p.waypoint the waypoint in use (WaypointSource.get())
 * @param {object|null} p.course WaypointSource.courseInfo()
 * @param {object|null} p.startPoint named start waypoint {lat, lon, name}
 * @param {number|null} p.configuredM configured course distance in metres
 * @returns {{totalM: number, afterM: number, src: 'route'|'start'|'config', name?: string}|null}
 */
function courseDistance({waypoint, course, startPoint, configuredM}) {
    if (!waypoint) return null;
    const r = course && course.activeRoute;
    if (waypoint.src === 'course' && r && Array.isArray(r.points) && r.points.length >= 2) {
        const pts = r.reverse ? r.points.slice().reverse() : r.points;
        const i = r.pointIndex;
        if (Number.isInteger(i) && i >= 0 && i < pts.length && distance(pts[i], waypoint) <= ROUTE_MATCH_M) {
            return {totalM: legs(pts), afterM: legs(pts.slice(i)), src: 'route', name: r.name || undefined};
        }
    }
    if (startPoint) {
        return {totalM: distance(startPoint, waypoint), afterM: 0, src: 'start', name: startPoint.name};
    }
    if (Number.isFinite(configuredM) && configuredM > 0) return {totalM: configuredM, afterM: 0, src: 'config'};
    return null;
}

module.exports = {courseDistance, ROUTE_MATCH_M};
