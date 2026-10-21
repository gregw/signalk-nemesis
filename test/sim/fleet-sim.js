'use strict';
/*
 * Simulated AIS from tracker fixes at real times (the YB test data), received by our own
 * boat's logged track:
 *
 *  1. Between two fixes of a boat, its position is interpolated in a straight line, and
 *     its SOG and COG are those of that leg. No position across a gap of more than
 *     maxGapMs, or outside its first and last fix.
 *  2. Each boat transmits on its own Class B CS cadence: every 30 s above 2 kn, every
 *     3 minutes at or below, from a seeded random phase. TODO(verify) against ITU-R
 *     M.1371 Annex 7: not confirmed from the text, only from secondary sources.
 *  3. Each transmission is received with a chance that falls with range from us: keepNear
 *     out to nearNm, down to keepMid at midNm, down to 0 at farNm. Most are lost even
 *     close by: GC2026's real AIS gaps had a median of 2 min and a 90th percentile of
 *     7 min (brief section 6), which 30 s transmissions give at a chance of 0.16 each
 *     (gaps geometric: 0.84^4 = 0.5, 0.84^13 = 0.1). At 8 nm, 0.08 gives a median gap
 *     of about 4 min; from 12 nm on a boat is heard every 6 to 30 min, so far boats
 *     are mostly seen by their tracker.
 *  4. A received report is jiggled a little (seeded): position, COG and SOG noise, so
 *     nearby boats do not move along perfectly straight lines.
 *
 * All output is SI, times shifted by shiftMs.
 */
const {rng, mmsiOf, KN, NM} = require('./ais-sim');

const D2R = Math.PI / 180;
const R_EARTH = 6371008.8;

/** Gaussian from a uniform source (Box-Muller). */
function gauss(rand) {
    const u = 1 - rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Distance (m) and initial bearing (rad) from a to b, equirectangular: fine over a 10 minute leg. */
function leg(a, b) {
    const k = Math.cos(((a.lat + b.lat) / 2) * D2R);
    const dx = (b.lon - a.lon) * D2R * k * R_EARTH;
    const dy = (b.lat - a.lat) * D2R * R_EARTH;
    return {m: Math.hypot(dx, dy), brg: (Math.atan2(dx, dy) + 2 * Math.PI) % (2 * Math.PI)};
}

/** Index of the last element with key(x) <= t, or -1. */
function atOrBefore(arr, t, key) {
    let lo = 0;
    let hi = arr.length - 1;
    let ans = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (key(arr[mid]) <= t) {
            ans = mid;
            lo = mid + 1;
        } else hi = mid - 1;
    }
    return ans;
}

/**
 * A boat's state at t from fixes [{t, lat, lon}] (by time): {lat, lon, sogMs, cogRad} or null.
 * At a fix the leg after it gives SOG and COG (the leg before it for the last fix).
 */
function stateAt(fixes, t, maxGapMs) {
    const i = atOrBefore(fixes, t, (f) => f.t);
    if (i < 0) return null;
    const a = fixes[i];
    const c = fixes[i + 1];
    if (!c) {
        if (t !== a.t || i === 0) return null;
        const p = fixes[i - 1];
        if (a.t - p.t > maxGapMs) return null;
        const l = leg(p, a);
        return {lat: a.lat, lon: a.lon, sogMs: l.m / ((a.t - p.t) / 1e3), cogRad: l.brg};
    }
    if (c.t - a.t > maxGapMs || c.t === a.t) return null;
    const f = (t - a.t) / (c.t - a.t);
    const l = leg(a, c);
    return {
        lat: a.lat + (c.lat - a.lat) * f,
        lon: a.lon + (c.lon - a.lon) * f,
        sogMs: l.m / ((c.t - a.t) / 1e3),
        cogRad: l.brg
    };
}

/** Chance a transmission at dNm from us is received. */
function keepChance(dNm, o) {
    if (dNm <= o.nearNm) return o.keepNear;
    if (dNm <= o.midNm) return o.keepNear + ((o.keepMid - o.keepNear) * (dNm - o.nearNm)) / (o.midNm - o.nearNm);
    if (dNm < o.farNm) return (o.keepMid * (o.farNm - dNm)) / (o.farNm - o.midNm);
    return 0;
}

const DEFAULTS = {
    seed: 1,
    shiftMs: 0,
    maxGapMs: 40 * 60e3,
    fastMs: 30e3, // Class B CS above 2 kn
    slowMs: 180e3, // at or below 2 kn
    slowKn: 2,
    nearNm: 4,
    keepNear: 0.16,
    midNm: 8,
    keepMid: 0.08,
    farNm: 20,
    jigglePosM: 5,
    jiggleCogDeg: 4,
    jiggleSogKn: 0.2
};

/**
 * @param {object} fleet tracks file with samples [[iso, lat, lon], ...] (tollgate2026-yb.json)
 * @param {{t: number, lat: number, lon: number}[]} own our recorded track by time (not shifted)
 * @param {object} [opts] see DEFAULTS; ownMmsi: our MMSI, left out of the fleet
 * @returns {{reports: object[], names: Map<string, string>}} reports sorted by t
 */
function simulateFleet(fleet, own, opts = {}) {
    const o = {...DEFAULTS, ...opts};
    const rand = rng(o.seed);
    const reports = [];
    const names = new Map();
    const ownAt = (t) => {
        const i = atOrBefore(own, t, (s) => s.t);
        return i < 0 ? null : own[i];
    };
    for (const b of fleet.boats) {
        const id = mmsiOf(b);
        if (id === String(o.ownMmsi)) continue;
        names.set(id, b.name);
        const fixes = b.samples.map(([t, lat, lon]) => ({t: Date.parse(t), lat, lon}));
        if (fixes.length < 2) continue;
        const end = fixes.at(-1).t;
        let t = fixes[0].t + Math.floor(rand() * o.fastMs);
        while (t <= end) {
            const s = stateAt(fixes, t, o.maxGapMs);
            const slow = !s || s.sogMs <= o.slowKn * KN;
            const us = s && ownAt(t);
            if (s && us && t - us.t <= 60e3) {
                const l = leg(us, s);
                if (rand() < keepChance(l.m / NM, o)) {
                    const n = (k) => gauss(rand) * k;
                    const dN = n(o.jigglePosM);
                    const dE = n(o.jigglePosM);
                    reports.push({
                        boatId: id,
                        src: 'ais',
                        t: t + o.shiftMs,
                        lat: s.lat + dN / R_EARTH / D2R,
                        lon: s.lon + dE / (R_EARTH * Math.cos(s.lat * D2R)) / D2R,
                        cogRad: (((s.cogRad + n(o.jiggleCogDeg) * D2R) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI),
                        sogMs: Math.max(0, s.sogMs + n(o.jiggleSogKn) * KN)
                    });
                }
            }
            t += slow ? o.slowMs : o.fastMs;
        }
    }
    reports.sort((a, b) => a.t - b.t);
    return {reports, names};
}

/** Our own log file (tollgate2026-kanreki.json) as SI samples by time, shifted by shiftMs. */
function ownFromLog(json, shiftMs = 0) {
    const f = Object.fromEntries(json.sample_fields.map((k, i) => [k, i]));
    const rad = (v) => (v == null ? null : v * D2R);
    const ms = (v) => (v == null ? null : v * KN);
    return json.samples.map((s) => ({
        t: s[f.t] + shiftMs,
        lat: s[f.lat],
        lon: s[f.lon],
        cogRad: rad(s[f.cog_deg]),
        sogMs: ms(s[f.sog_kn]),
        hdgRad: rad(s[f.hdg_deg]),
        stwMs: ms(s[f.bsp_kn]),
        twdRad: rad(s[f.twd_deg]),
        twsMs: ms(s[f.tws_kn]),
        twaRad: rad(s[f.twa_deg]),
        awsMs: ms(s[f.aws_kn]),
        awaRad: rad(s[f.awa_deg])
    }));
}

/**
 * Tracker fixes at real times as the CYCA feed shows them: one sample per 10 minute slot,
 * the boat's first fix within lateMs after the slot boundary (YB fixes fall almost all in
 * that first minute), with SOG and COG of the leg from its previous fix. No DTG.
 * @returns {object} the same file with samples [slot iso, lat, lon, sog_kn, cog_deg, null, null]
 */
function trackerSlots(fleet, {slotMs = 600e3, lateMs = 120e3} = {}) {
    const R2D = 180 / Math.PI;
    const boats = fleet.boats.map((b) => {
        const fixes = b.samples.map(([t, lat, lon]) => ({t: Date.parse(t), lat, lon}));
        const samples = [];
        for (let i = 0; i < fixes.length; i++) {
            const f = fixes[i];
            const slot = Math.floor(f.t / slotMs) * slotMs;
            if (f.t - slot > lateMs || (samples.length && Date.parse(samples.at(-1)[0]) === slot)) continue;
            const p = fixes[i - 1];
            const l = p && f.t > p.t ? leg(p, f) : null;
            const sog = l ? Math.round((l.m / ((f.t - p.t) / 1e3) / KN) * 10) / 10 : null;
            const cog = l ? Math.round(l.brg * R2D) % 360 : null;
            samples.push([new Date(slot).toISOString().replace('.000Z', 'Z'), f.lat, f.lon, sog, cog, null, null]);
        }
        return {...b, samples};
    });
    return {
        ...fleet,
        step_s: slotMs / 1e3,
        sample_fields: ['t', 'lat', 'lon', 'sog_kn', 'cog_deg', 'dtg_nm', 'dtl_nm'],
        boats
    };
}

module.exports = {simulateFleet, ownFromLog, trackerSlots, stateAt, keepChance, leg, DEFAULTS};
