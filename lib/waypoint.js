'use strict';
/*
 * The single waypoint() seam (brief section 3.1). Everything that needs the active
 * waypoint (Up = Waypoint frame, DTG, VMC, map marker) asks get().
 *
 * Sources (verified against signalk-server 2.30.0):
 *  - course: the Course API, app.getCourse() (server-api course.d.ts). It covers a
 *    Signal K route (activeRoute advancing nextPoint), a destination set in
 *    Freeboard-SK (nextPoint with an href to a waypoint resource), and NMEA it has
 *    adopted. It adopts NMEA destinations only while no API destination is set
 *    (dist/api/course/index.js processV1DestinationDeltas), so when Freeboard has set
 *    one, the nav PC's RMB/BWC is ignored there.
 *  - nmea: raw next point from the instruments: navigation.courseRhumbline|courseGreatCircle
 *    .nextPoint.position (nmea0183-signalk RMB, BWC; n2k-signalk 129284), ignoring the
 *    Course API's own copies ($source 'courseApi'). Expires after nmeaStaleMs of quiet.
 *    When only bearingTrue and distance arrive, the point is projected from our own
 *    position at that time.
 *  - named: the first found of a list of waypoint resources looked up by name
 *    (resources API, default ['nemesis']), refreshed periodically. All of those found
 *    are also offered to the webapp (namedList) for picking Up by hand.
 * The waypoint resources read for that are kept (waypoints()) for the course (lib/course.js).
 * None of them: no waypoint (get() returns null) and the waypoint based values are not shown.
 *
 * The order of course/nmea is configurable; named always comes last.
 * get() is synchronous: async sources are polled into a cache.
 */

const {destination, distance} = require('./geo');

const COURSE_API_SOURCE = 'courseApi';
const NMEA_PATHS = ['navigation.courseRhumbline.nextPoint', 'navigation.courseGreatCircle.nextPoint'];
const ORDERS = {
    'course,nmea': ['course', 'nmea', 'named'],
    'nmea,course': ['nmea', 'course', 'named']
};
const COURSE_POLL_MS = 2000;
// A Course API point this close to a raw NMEA point is taken to be the adopted NMEA one.
const ADOPTED_MATCH_M = 10;
const NAMED_POLL_MS = 30000;

class WaypointSource {
    /**
     * @param {object} app
     * @param {object} cfg {waypointOrder, nmeaWaypointStaleSeconds, waypointNames}
     * @param {object} [deps]
     * @param {() => number} [deps.clock]
     * @param {(t: number) => object|null} [deps.ownAt] our state at time t, for projecting bearing/distance
     */
    constructor(app, cfg, {clock = Date.now, ownAt = () => null} = {}) {
        this.app = app;
        this.clock = clock;
        this.ownAt = ownAt;
        this.order = ORDERS[cfg.waypointOrder] || ORDERS['course,nmea'];
        this.nmeaStaleMs = (cfg.nmeaWaypointStaleSeconds ?? 30) * 1000;
        this.names = (cfg.waypointNames || []).map(trimmed).filter(Boolean);

        this.course = null; // {lat, lon, id, href, name, activeRoute} from the Course API
        this.nmea = {}; // per base path: {position: {v, at}, bearingTrue: {v, at}, distance: {v, at}, ID: {v, at}}
        this.namedFound = []; // [{lat, lon, id, name}] found, in configured order
        this.all = {}; // the waypoint resources last read, by id
        this.unsubscribes = [];
        this.timers = [];
    }

    start() {
        const subscribe = [];
        for (const base of NMEA_PATHS) {
            for (const leaf of ['position', 'bearingTrue', 'distance', 'ID']) {
                subscribe.push({path: `${base}.${leaf}`, policy: 'instant'});
            }
        }
        this.app.subscriptionmanager.subscribe(
            {context: 'vessels.self', subscribe},
            this.unsubscribes,
            (err) => this.app.error(`Waypoint subscription error: ${err}`),
            (delta) => {
                try {
                    this._nmeaDelta(delta);
                } catch (e) {
                    this.app.debug(`waypoint delta ignored: ${e && e.message}`);
                }
            }
        );
        this._pollCourse();
        this.timers.push(setInterval(() => this._pollCourse(), COURSE_POLL_MS).unref());
        // Always: the course's marks are waypoints too.
        this._pollNamed();
        this.timers.push(setInterval(() => this._pollNamed(), NAMED_POLL_MS).unref());
    }

    stop() {
        this.unsubscribes.forEach((f) => f());
        this.unsubscribes = [];
        this.timers.forEach((t) => clearInterval(t));
        this.timers = [];
    }

    /** The active waypoint {lat, lon, src, id, name?} or null. Never throws. */
    get() {
        for (const src of this.order) {
            const w = this._from(src);
            if (w) return w;
        }
        return null;
    }

    /** The waypoint resources last read, by id (empty until the first read). */
    waypoints() {
        return this.all;
    }

    /** Read the waypoint resources now (after the course changes). Never rejects. */
    refresh() {
        return this._pollNamed();
    }

    /** Every configured named waypoint found [{lat, lon, id, name}], in configured order. */
    namedList() {
        return this.namedFound.map((w) => ({...w}));
    }

    _from(src) {
        switch (src) {
            case 'course':
                return this.course && !this._courseIsStaleNmea() ? {...pick(this.course), src} : null;
            case 'nmea':
                return this._nmeaPoint();
            case 'named':
                return this.namedFound.length ? {...this.namedFound[0], src} : null;
        }
        return null;
    }

    _nmeaDelta(delta) {
        const at = this.clock();
        for (const u of delta.updates || []) {
            if (!u || u.$source === COURSE_API_SOURCE) continue;
            for (const pv of u.values || []) {
                if (!pv || typeof pv.path !== 'string') continue;
                const base = NMEA_PATHS.find((b) => pv.path.startsWith(b + '.'));
                if (!base) continue;
                const leaf = pv.path.slice(base.length + 1);
                (this.nmea[base] = this.nmea[base] || {})[leaf] = {v: pv.value, at};
            }
        }
    }

    /*
     * The Course API adopts an NMEA destination and keeps it after the instruments stop
     * sending (seen on 2.30.0), so a dead nav PC would pin its last mark for good. A
     * Course API point with no href and no active route that sits on the last raw NMEA
     * point is treated as
     * that NMEA point and expires with it.
     */
    _courseIsStaleNmea() {
        const c = this.course;
        // Route points have no href either, but are never adopted NMEA.
        if (!c || c.href || c.activeRoute) return false;
        const now = this.clock();
        for (const base of NMEA_PATHS) {
            const n = this.nmea[base]?.position;
            if (!n || !n.v || now - n.at <= this.nmeaStaleMs) continue;
            if (distance(c, {lat: n.v.latitude, lon: n.v.longitude}) < ADOPTED_MATCH_M) return true;
        }
        return false;
    }

    _nmeaPoint() {
        const now = this.clock();
        const fresh = (x) => x && now - x.at <= this.nmeaStaleMs;
        // Prefer an explicit position from either base; else project bearing and distance.
        for (const base of NMEA_PATHS) {
            const n = this.nmea[base];
            const p = n && fresh(n.position) && n.position.v;
            if (p && validLatLon({lat: p.latitude, lon: p.longitude})) {
                const id =
                    fresh(n.ID) && n.ID.v != null
                        ? `nmea:${n.ID.v}`
                        : `nmea:${round(p.latitude)},${round(p.longitude)}`;
                return {lat: p.latitude, lon: p.longitude, id, src: 'nmea'};
            }
        }
        for (const base of NMEA_PATHS) {
            const n = this.nmea[base];
            if (!n || !fresh(n.bearingTrue) || !fresh(n.distance)) continue;
            const b = n.bearingTrue.v;
            const d = n.distance.v;
            if (!Number.isFinite(b) || !Number.isFinite(d) || d < 0) continue;
            const at = Math.min(n.bearingTrue.at, n.distance.at);
            const us = this.ownAt(at);
            if (!us) continue;
            const p = destination(us, b, d);
            // Projected points jitter with our own position, so the id is not position based.
            const id = fresh(n.ID) && n.ID.v != null ? `nmea:${n.ID.v}` : 'nmea:projected';
            return {lat: p.lat, lon: p.lon, id, src: 'nmea', projected: true};
        }
        return null;
    }

    async _pollCourse() {
        if (typeof this.app.getCourse !== 'function' || this.coursePolling) return;
        this.coursePolling = true;
        try {
            const c = await this.app.getCourse();
            const p = c && c.nextPoint && c.nextPoint.position;
            if (!p || !validLatLon({lat: p.latitude, lon: p.longitude})) {
                this.course = null;
                return;
            }
            this.course = {
                lat: p.latitude,
                lon: p.longitude,
                id: c.nextPoint.href || `course:${round(p.latitude)},${round(p.longitude)}`,
                // Only a destination with an href names a real waypoint; adopted NMEA points
                // come back with a generic name ('DP' on 2.30.0).
                href: c.nextPoint.href || null,
                name: c.nextPoint.href ? c.nextPoint.name || null : null,
                activeRoute: c.activeRoute ? {href: c.activeRoute.href, name: c.activeRoute.name || null} : null
            };
        } catch (e) {
            // Keep the last known course: a transient API error must not drop the waypoint.
            this.app.debug(`getCourse failed: ${e && e.message}`);
        } finally {
            this.coursePolling = false;
        }
    }

    async _pollNamed() {
        if (!this.app.resourcesApi?.listResources) return;
        try {
            const all = await this.app.resourcesApi.listResources('waypoints', {});
            this.all = all && typeof all === 'object' ? all : {};
            this.namedFound = this.names.map((n) => findNamed(all, n)).filter(Boolean);
        } catch (e) {
            // Keep the last lookups: a transient resources error must not drop the waypoint.
            this.app.debug(`named waypoint lookup failed: ${e && e.message}`);
        }
    }
}

/** First waypoint resource with this name (trimmed, exact), as {lat, lon, id, name}. */
function findNamed(all, name) {
    if (!name) return null;
    for (const [id, w] of Object.entries(all || {})) {
        if (!w || typeof w.name !== 'string' || w.name.trim() !== name) continue;
        const c = w.feature?.geometry?.coordinates;
        if (Array.isArray(c) && validLatLon({lat: c[1], lon: c[0]}))
            return {lat: c[1], lon: c[0], id: `named:${id}`, name};
    }
    return null;
}

function trimmed(v) {
    return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function pick(c) {
    return {lat: c.lat, lon: c.lon, id: c.id, name: c.name};
}

function validLatLon(p) {
    return (
        !!p &&
        Number.isFinite(p.lat) &&
        Number.isFinite(p.lon) &&
        p.lat >= -90 &&
        p.lat <= 90 &&
        p.lon >= -180 &&
        p.lon <= 180
    );
}

function round(v) {
    return Math.round(v * 1e5) / 1e5;
}

module.exports = {WaypointSource, ORDERS, NMEA_PATHS, COURSE_API_SOURCE};
