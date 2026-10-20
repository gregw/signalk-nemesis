'use strict';
/*
 * Suggested AIS matches for unlinked CYCA boats. Pure.
 *
 * Each CYCA report is compared with each AIS boat's position at the same time (the
 * slot time), never with its latest position: moving boats would otherwise match
 * whoever happens to be where they were. The AIS position is dead-reckoned from its
 * report nearest that time, within maxDtMs. A fit is within
 *   baseM + slack x speed
 * (the slot time is up to a minute or two off the YB fix), and not heading more
 * than maxCogDiff away when both are moving.
 *
 * One slot is not enough: after a start the fleet is tens of metres apart, about
 * the slot time error (GC2026 at 30 min: 10 of 46 single-slot picks were wrong).
 * So an AIS boat must fit every CYCA slot of the last windowMs where it has data,
 * at least minChecks of them, and is scored by the mean. An AIS name equal to the
 * CYCA name is a candidate at any distance. A recommendation needs a clear winner
 * (runner-up `ambiguity` times worse), and by position alone also a small crowd.
 */

const {distance, destination, normPi} = require('./geo');
const {nameKey} = require('./cyca-feed');

const DEFAULTS = {
    maxDtMs: 5 * 60e3,
    baseM: 400,
    slackS: 150,
    maxCogDiff: Math.PI / 4,
    movingMs: 1, // about 2 kn
    cogDtMs: 2 * 60e3,
    ambiguity: 3, // the runner-up within this factor of the best: no recommendation
    maxCrowd: 3, // more position candidates than this: no recommendation by position
    maxAgeMs: 30 * 60e3, // a CYCA boat whose latest report is older is not matched
    windowMs: 60 * 60e3, // the CYCA reports compared: the last hour
    minChecks: 3 // slots with AIS data needed for a position match
};

/** An AIS boat's position at t, dead-reckoned from its nearest report within maxDtMs. */
function aisAt(track, t, maxDtMs) {
    const a = track.items;
    // Binary search for the first report after t (runs per CYCA slot x AIS boat).
    let lo = 0;
    let hi = a.length;
    while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (a[m].t <= t) lo = m + 1;
        else hi = m;
    }
    const before = lo > 0 ? a[lo - 1] : null;
    const after = lo < a.length ? a[lo] : null;
    let r = before;
    if (after && (!r || after.t - t < t - r.t)) r = after;
    if (!r || Math.abs(r.t - t) > maxDtMs) return null;
    const dt = (t - r.t) / 1000;
    if (!Number.isFinite(r.sogMs) || !Number.isFinite(r.cogRad) || dt === 0) return {...r, dtMs: r.t - t};
    const p = destination(r, r.cogRad, r.sogMs * dt);
    return {...r, lat: p.lat, lon: p.lon, dtMs: r.t - t};
}

/** One comparison: {d, ratio} if the AIS boat fits the CYCA report at its time, false if not, null if no data. */
function compare(r, aisTrack, o) {
    const p = aisAt(aisTrack, r.t, o.maxDtMs);
    if (!p) return null;
    const d = distance(r, p);
    const v = Math.max(r.sogMs || 0, p.sogMs || 0);
    // COG only when the AIS report is near the slot: a tacking boat turns 90 degrees in minutes.
    const moving = (r.sogMs || 0) >= o.movingMs && (p.sogMs || 0) >= o.movingMs && Math.abs(p.dtMs) <= o.cogDtMs;
    const cogOk =
        !moving ||
        !Number.isFinite(r.cogRad) ||
        !Number.isFinite(p.cogRad) ||
        Math.abs(normPi(r.cogRad - p.cogRad)) <= o.maxCogDiff;
    const tol = o.baseM + o.slackS * v;
    if (!cogOk || d > tol) return false;
    return {d, ratio: d / tol, dSogMs: Number.isFinite(r.sogMs) && Number.isFinite(p.sogMs) ? p.sogMs - r.sogMs : null};
}

/**
 * @param {object} o
 * @param {object[]} o.cyca unlinked CYCA boats {id, name, track}
 * @param {object[]} o.ais AIS boats {id, name, track} not already linked
 * @param {number} o.now
 * @returns {Map<string, {candidates: object[], recommended: string|null}>} by CYCA boat id
 */
function suggest({cyca, ais, now, ...opts}) {
    const o = {...DEFAULTS, ...opts};
    const out = new Map();
    for (const c of cyca) {
        const key = nameKey(c.name);
        const latest = c.track.latest();
        const recent = latest && now - latest.t <= o.maxAgeMs ? c.track.between(now - o.windowMs, now) : [];
        const candidates = [];
        for (const a of ais) {
            const sameName = !!key && nameKey(a.name) === key;
            // Every slot in the window where AIS has data must fit; one miss rules it out.
            const checks = [];
            let fits = true;
            for (const r of recent) {
                const x = compare(r, a.track, o);
                if (x === false) {
                    fits = false;
                    break;
                }
                if (x) checks.push(x);
            }
            fits = fits && checks.length >= o.minChecks;
            if (!fits && !sameName) continue;
            const last = fits ? checks[checks.length - 1] : null;
            const ratio = fits ? checks.reduce((sum, x) => sum + x.ratio, 0) / checks.length : 1;
            candidates.push({
                mmsi: a.id,
                name: a.name || null,
                distanceM: last ? Math.round(last.d) : null,
                dSogMs: last ? last.dSogMs : null,
                checks: checks.length,
                sameName,
                score: ratio * (sameName ? 0.5 : 1)
            });
        }
        candidates.sort((x, y) => x.score - y.score);
        const [best, next] = candidates;
        const byPosition = candidates.filter((x) => x.checks >= o.minChecks).length;
        const clear = !next || next.score > best.score * o.ambiguity;
        const recommended = best && clear && (best.sameName || byPosition <= o.maxCrowd) ? best.mmsi : null;
        out.set(c.id, {candidates, recommended});
    }
    return out;
}

module.exports = {suggest, aisAt, DEFAULTS};
