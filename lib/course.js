'use strict';
/*
 * The course for Up = Course (brief section 3.3a), set on the webapp's Course tab and
 * kept by the plugin (course.json in the data dir), so every screen shares it.
 *
 * A mark is {name, waypointId?, lat?, lon?}:
 *  - a waypoint resource (waypointId): it follows the waypoint if it is moved (looked up
 *    by id, then by name if the id has gone), else its last known position;
 *  - a fixed point (lat, lon), e.g. a route point that is not a waypoint;
 *  - a name only (seeded from the old waypointNames config): looked up by name.
 * A mark may appear more than once (passed on the way out and back).
 *
 * Routes (verified against @signalk/server-api 2.30.0 resources-schemas.js): a GeoJSON
 * LineString of [lon, lat], with optional feature.properties.coordinatesMeta per point,
 * {name} or {href: '/resources/waypoints/<uuid>'}. Unnamed points are WP<n>, as the Course
 * API names them (signalk-server dist/api/course/index.js getRoutePointName).
 */

const {JsonStore} = require('./persist');

const FILE = 'course.json';
const VERSION = 1;
const MAX_MARKS = 50;
const WAYPOINT_HREF = /^\/resources\/waypoints\/([^/]+)$/;

function validLatLon(lat, lon) {
    return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

/** A mark cleaned to {name, waypointId?, lat?, lon?}, or null if unusable. */
function cleanMark(m) {
    if (!m || typeof m !== 'object') return null;
    const name = typeof m.name === 'string' ? m.name.trim() : '';
    const waypointId = typeof m.waypointId === 'string' && m.waypointId ? m.waypointId : null;
    const pos = validLatLon(m.lat, m.lon);
    if (!name && !waypointId && !pos) return null;
    const out = {name};
    if (waypointId) out.waypointId = waypointId;
    if (pos) {
        out.lat = m.lat;
        out.lon = m.lon;
    }
    return out;
}

/** Marks cleaned; throws a RangeError if the list itself is not acceptable. */
function cleanMarks(list) {
    if (!Array.isArray(list)) throw new RangeError('marks must be an array');
    if (list.length > MAX_MARKS) throw new RangeError(`at most ${MAX_MARKS} marks`);
    const out = list.map(cleanMark);
    if (out.some((m) => !m)) throw new RangeError('each mark needs a name, a waypointId or a lat and lon');
    return out;
}

/** A waypoint resource's position {lat, lon}, or null. */
function wptPos(w) {
    const c = w && w.feature && w.feature.geometry && w.feature.geometry.coordinates;
    return Array.isArray(c) && validLatLon(c[1], c[0]) ? {lat: c[1], lon: c[0]} : null;
}

/** All waypoint resources as [{id, name, lat, lon}] by name. Pure. */
function waypointList(all) {
    const out = [];
    for (const [id, w] of Object.entries(all || {})) {
        const p = wptPos(w);
        if (p) out.push({id, name: typeof w.name === 'string' && w.name.trim() ? w.name.trim() : id, ...p});
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Marks resolved against the waypoint resources: [{name, waypointId, lat, lon, found, src}],
 * src 'waypoint' (live), 'fixed', or 'last' (a waypoint gone, at its last known position).
 * Unfound marks have lat and lon null. Pure.
 */
function resolveCourse(marks, all) {
    const byName = new Map();
    for (const [id, w] of Object.entries(all || {})) {
        const n = w && typeof w.name === 'string' ? w.name.trim() : '';
        if (n && !byName.has(n) && wptPos(w)) byName.set(n, id);
    }
    return (marks || []).map((m) => {
        let id = m.waypointId && wptPos((all || {})[m.waypointId]) ? m.waypointId : null;
        if (!id && m.name && (m.waypointId || !validLatLon(m.lat, m.lon))) id = byName.get(m.name) || null;
        if (id) {
            const w = all[id];
            const name = m.name || (typeof w.name === 'string' ? w.name.trim() : id);
            return {name, waypointId: id, ...wptPos(w), found: true, src: 'waypoint'};
        }
        if (validLatLon(m.lat, m.lon))
            return {
                name: m.name,
                waypointId: m.waypointId || null,
                lat: m.lat,
                lon: m.lon,
                found: true,
                src: m.waypointId ? 'last' : 'fixed'
            };
        return {name: m.name, waypointId: m.waypointId || null, lat: null, lon: null, found: false, src: 'waypoint'};
    });
}

/** A route resource as course marks: waypoint points linked, the rest fixed. Pure. */
function routeToMarks(route, all) {
    const coords = route && route.feature && route.feature.geometry && route.feature.geometry.coordinates;
    if (!Array.isArray(coords)) throw new RangeError('route has no points');
    const meta = (route.feature.properties && route.feature.properties.coordinatesMeta) || [];
    const marks = [];
    coords.forEach((c, i) => {
        if (!Array.isArray(c) || !validLatLon(c[1], c[0])) return;
        const m = meta[i] || {};
        const href = typeof m.href === 'string' ? WAYPOINT_HREF.exec(m.href) : null;
        const w = href ? (all || {})[href[1]] : null;
        const wname = w && typeof w.name === 'string' && w.name.trim() ? w.name.trim() : null;
        const name = (typeof m.name === 'string' && m.name.trim()) || wname || `WP${i + 1}`;
        const mark = {name, lat: c[1], lon: c[0]};
        if (href) mark.waypointId = href[1];
        marks.push(mark);
    });
    if (!marks.length) throw new RangeError('route has no valid points');
    return cleanMarks(marks.slice(0, MAX_MARKS));
}

/** Route resources as [{id, name, points}] by name. Pure. */
function routeList(all) {
    const out = [];
    for (const [id, r] of Object.entries(all || {})) {
        const c = r && r.feature && r.feature.geometry && r.feature.geometry.coordinates;
        if (!Array.isArray(c) || !c.length) continue;
        out.push({id, name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : id, points: c.length});
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

class CourseStore {
    /**
     * @param {string} dataDir
     * @param {string[]} seedNames the old waypointNames config: the course until one is set
     */
    constructor(dataDir, seedNames = [], onError = () => {}) {
        this.store = new JsonStore(dataDir, FILE, onError);
        const d = this.store.load(null);
        let marks = null;
        if (d && Array.isArray(d.marks)) {
            try {
                marks = cleanMarks(d.marks);
            } catch (e) {
                marks = d.marks.map(cleanMark).filter(Boolean);
            }
        }
        this.seeded = !marks;
        this.marks =
            marks || (seedNames || []).filter((n) => typeof n === 'string' && n.trim()).map((n) => ({name: n.trim()}));
    }

    /** Replace the course. Throws a RangeError for bad input; resolves when saved. */
    set(marks) {
        this.marks = cleanMarks(marks);
        this.seeded = false;
        return this.store.save({version: VERSION, marks: this.marks});
    }

    toJSON() {
        return {version: VERSION, marks: this.marks, seeded: this.seeded};
    }
}

module.exports = {CourseStore, resolveCourse, routeToMarks, routeList, waypointList, cleanMarks, MAX_MARKS};
