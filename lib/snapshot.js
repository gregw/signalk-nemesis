'use strict';
/*
 * Builds the REST snapshot and track history payloads from internal state.
 * Pure functions of (store, own, userState, waypoint, config, now): no I/O.
 * All values SI; timestamps are epoch milliseconds.
 */

const {currentReport} = require('./track-store');
const {distance} = require('./geo');

// UserState key for our own boat (TCF).
const OWN_ID = 'self';

function pickReport(r) {
    return r && {t: r.t, lat: r.lat, lon: r.lon, cogRad: r.cogRad, sogMs: r.sogMs, src: r.src};
}

/**
 * @returns {{now, staleMs, waypoint, own, boats: object[]}}
 */
function buildSnapshot({
    store,
    own,
    userState,
    waypoint,
    start = null,
    tcfVmgMs = null,
    names = null,
    configured = null,
    namedWaypoints = [],
    waypointNames = [],
    staleMs,
    now
}) {
    const ownNow = own.at(now, staleMs);
    const boats = [];
    let oldestT = null;
    for (const b of store.all()) {
        const latest = b.track.latest();
        if (!latest) continue;
        const first = b.track.oldest();
        if (oldestT == null || first.t < oldestT) oldestT = first.t;
        const cur = currentReport(b.track, now, staleMs);
        // Range compares their report with OUR state at their report time (brief 2.2).
        // Our continuous history covers only the recent window; the report carries our
        // state at its time for as long as it is kept.
        const ourThen = own.at(latest.t) || latest.us;
        boats.push({
            id: b.id,
            // A configured name wins inside this plugin; aisName is what the boat sends.
            name: (names && names.get(b.id)) || b.name,
            aisName: b.name,
            // The CYCA tracker boat behind it: itself if unlinked, else the one linked to this AIS boat.
            cycaId: b.cycaId || (b.id.startsWith('cyca:') ? b.id : null),
            // AIS ship type id (36 Sailing, 37 Pleasure), null until the boat sends one.
            shipType: b.shipType ?? null,
            configured: !!(configured && configured.has(b.id)),
            nemesis: userState.isNemesis(b.id),
            tcf: userState.tcfOf(b.id),
            current: !!cur,
            ageMs: now - latest.t,
            rangeM: ourThen ? distance(ourThen, latest) : null,
            latest: pickReport(latest)
        });
    }
    return {
        now,
        staleMs,
        oldestT,
        waypoint,
        // Every configured named waypoint found, in configured order (manual Up choices).
        namedWaypoints,
        // The configured names (the course, in order), to show any not found.
        waypointNames,
        start,
        tcfVmgMs,
        // Our own TCF, keyed like a boat (UserState ids are strings).
        tcfUs: userState.tcfOf(OWN_ID),
        own: ownNow && {
            t: ownNow.t,
            lat: ownNow.lat,
            lon: ownNow.lon,
            cogRad: ownNow.cogRad,
            sogMs: ownNow.sogMs,
            headingRad: ownNow.headingRad
        },
        boats
    };
}

/**
 * Track history for the window [toT - periodMs, toT], or only what is newer than sinceT
 * (incremental polling), per boat. Also our state at each of those report times, and
 * our own track thinned to one sample per ownStepMs bucket (stable across requests).
 */
function buildTracks({store, own, now, periodMs, toT = now, sinceT = null, ids = null, ownStepMs = 30e3}) {
    const to = Math.min(toT, now);
    const from = to - periodMs;
    const lo = sinceT != null && sinceT >= from ? sinceT + 1 : from;
    const boats = {};
    const ownAt = new Map();
    for (const b of store.all()) {
        if (ids && !ids.has(b.id)) continue;
        const rs = b.track.between(lo, to);
        if (!rs.length) continue;
        boats[b.id] = rs.map(pickReport);
        for (const r of rs) {
            if (ownAt.has(r.t)) continue;
            const o = own.at(r.t) || r.us;
            if (o) ownAt.set(r.t, pickOwn(o, r.t));
        }
    }
    const ownTrack = [];
    let bucket = null;
    for (const o of own.between(lo, to)) {
        const k = Math.floor(o.t / ownStepMs);
        if (k === bucket) continue;
        bucket = k;
        ownTrack.push(pickOwn(o, o.t));
    }
    return {
        now,
        fromT: lo,
        toT: to,
        periodMs,
        boats,
        ownAtReports: [...ownAt.values()].sort((a, b) => a.t - b.t),
        own: ownTrack
    };
}

function pickOwn(o, t) {
    return {t, lat: o.lat, lon: o.lon, cogRad: o.cogRad, sogMs: o.sogMs};
}

module.exports = {buildSnapshot, buildTracks, OWN_ID};
