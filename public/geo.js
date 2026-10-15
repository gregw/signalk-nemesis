/*
 * Geometry primitives, shared by the plugin (require('./lib/geo')) and the webapp
 * (global GEO). SI throughout: positions as {lat, lon} in decimal degrees (converted from the
 * Signal K navigation.position object), angles in radians, distances in metres,
 * speeds in m/s. Conversions to knots, degrees and nm happen only in the webapp.
 */

(function (root) {
    'use strict';
    const EARTH_RADIUS_M = 6371008.8; // IUGG mean radius
    const TWO_PI = 2 * Math.PI;

    const toRad = (deg) => (deg * Math.PI) / 180;

    /** Normalise an angle to [0, 2pi). */
    function norm2pi(a) {
        a %= TWO_PI;
        return a < 0 ? a + TWO_PI : a;
    }

    /** Normalise an angle to (-pi, pi]. */
    function normPi(a) {
        a = norm2pi(a);
        return a > Math.PI ? a - TWO_PI : a;
    }

    /** Great-circle (haversine) distance in metres between two {lat, lon}. */
    function distance(a, b) {
        const p1 = toRad(a.lat);
        const p2 = toRad(b.lat);
        const dp = p2 - p1;
        const dl = toRad(b.lon - a.lon);
        const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
        return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
    }

    /** Initial great-circle bearing from a to b, radians true in [0, 2pi). */
    function bearing(a, b) {
        const p1 = toRad(a.lat);
        const p2 = toRad(b.lat);
        const dl = toRad(b.lon - a.lon);
        const y = Math.sin(dl) * Math.cos(p2);
        const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
        return norm2pi(Math.atan2(y, x));
    }

    /**
     * Local east/north displacement in metres from a to b (equirectangular, as in the
     * prototype). Accurate for the short ranges AIS covers; use distance() for DTG.
     */
    function displacement(a, b) {
        const midLat = toRad((a.lat + b.lat) / 2);
        const n = toRad(b.lat - a.lat) * EARTH_RADIUS_M;
        const e = normPi(toRad(b.lon - a.lon)) * EARTH_RADIUS_M * Math.cos(midLat);
        return {e, n};
    }

    /** Point reached from `start` along great-circle initial bearing (rad) for distance (m). */
    function destination(start, bearingRad, distanceM) {
        const d = distanceM / EARTH_RADIUS_M;
        const p1 = toRad(start.lat);
        const l1 = toRad(start.lon);
        const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(bearingRad));
        const l2 =
            l1 +
            Math.atan2(Math.sin(bearingRad) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
        return {lat: (p2 * 180) / Math.PI, lon: (normPi(l2) * 180) / Math.PI};
    }

    /** Velocity east/north components (m/s) from COG (rad) and SOG (m/s). */
    function velocity(cogRad, sogMs) {
        return {e: sogMs * Math.sin(cogRad), n: sogMs * Math.cos(cogRad)};
    }

    /** Shortest-way interpolation between two angles (rad), f in [0,1]. */
    function lerpAngle(a, b, f) {
        return norm2pi(a + normPi(b - a) * f);
    }

    const GEO = {
        EARTH_RADIUS_M,
        norm2pi,
        normPi,
        distance,
        bearing,
        displacement,
        destination,
        velocity,
        lerpAngle
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = GEO;
    else root.GEO = GEO;
})(this);
