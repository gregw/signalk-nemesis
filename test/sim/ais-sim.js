'use strict';
/*
 * Deterministic AIS simulator over a recorded tracker file (brief section 6).
 *
 *  1. Interpolate each boat to 1-minute samples (linear position, SOG, DTG;
 *     COG the short way round).
 *  2. Keep each competitor sample with probability 1/3.
 *  3. Drop by range from the receiver: kept within 8 nm, drop chance rising
 *     linearly to 1 at 20 nm.
 *  4. Keep the receiver's own state at every minute.
 *
 * Output is in SI and Signal K shaped, ready to be turned into deltas.
 * Times may be shifted by `shiftMs` so recorded data can be replayed as "now".
 */

const NM = 1852;
const KN = NM / 3600;
const MIN = 60e3;
const toRad = (d) => (d * Math.PI) / 180;

/** mulberry32 seeded PRNG, returns floats in [0,1). */
function rng(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Nulls must not be coerced to 0: take the nearer endpoint instead.
const lin = (a, b, f) => (a == null || b == null ? (f < 0.5 ? a : b) : a + (b - a) * f);

function lerpDeg(a, b, f) {
    if (a == null || b == null) return f < 0.5 ? a : b;
    const d = ((((b - a) % 360) + 540) % 360) - 180;
    return (((a + d * f) % 360) + 360) % 360;
}

/** Per-minute interpolation of one boat's samples: Map(tMs -> {lat, lon, sogKn, cogDeg, dtgNm}). */
function perMinute(samples) {
    const out = new Map();
    for (let k = 0; k < samples.length; k++) {
        const a = samples[k];
        const t0 = Date.parse(a[0]);
        out.set(t0, {lat: a[1], lon: a[2], sogKn: a[3], cogDeg: a[4], dtgNm: a[5]});
        if (k === samples.length - 1) break;
        const c = samples[k + 1];
        const n = Math.round((Date.parse(c[0]) - t0) / MIN);
        for (let m = 1; m < n; m++) {
            const f = m / n;
            out.set(t0 + m * MIN, {
                lat: lin(a[1], c[1], f),
                lon: lin(a[2], c[2], f),
                sogKn: lin(a[3], c[3], f),
                cogDeg: lerpDeg(a[4], c[4], f),
                dtgNm: lin(a[5], c[5], f)
            });
        }
    }
    return out;
}

function havNm(a, b) {
    const R = 3440.065;
    const p = Math.PI / 180;
    const dla = (b.lat - a.lat) * p;
    const dlo = (b.lon - a.lon) * p;
    const x = Math.sin(dla / 2) ** 2 + Math.cos(a.lat * p) * Math.cos(b.lat * p) * Math.sin(dlo / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}

const si = (t, s) => ({
    t,
    lat: s.lat,
    lon: s.lon,
    cogRad: s.cogDeg == null ? null : toRad(s.cogDeg),
    sogMs: s.sogKn == null ? null : s.sogKn * KN
});

/**
 * @param {object} json tracks file (test/data schema)
 * @param {object} opts {receiverName, seed, keep=1/3, nearNm=8, farNm=20, shiftMs=0, fakeMmsi}
 * @returns {{own: object[], reports: object[], names: Map<string,string>, ownMmsi: string}} reports sorted by t
 */
function simulate(json, opts) {
    const {receiverName, seed = 1, keep = 1 / 3, nearNm = 8, farNm = 20, shiftMs = 0} = opts;
    const fakeMmsi = opts.fakeMmsi || mmsiOf;
    const rand = rng(seed);
    const rx = json.boats.find((b) => b.name === receiverName);
    if (!rx) throw new Error(`receiver ${receiverName} not in data`);
    const us = perMinute(rx.samples);
    const own = [...us.entries()].map(([t, s]) => si(t + shiftMs, s));
    const reports = [];
    const names = new Map();
    for (const b of json.boats) {
        if (b === rx) continue;
        const id = fakeMmsi(b);
        names.set(id, b.name);
        for (const [t, s] of perMinute(b.samples)) {
            if (rand() >= keep) continue;
            const u = us.get(t);
            if (!u) continue;
            const d = havNm(s, u);
            if (d >= farNm || (d > nearNm && rand() < (d - nearNm) / (farNm - nearNm))) continue;
            reports.push({boatId: id, src: 'ais', ...si(t + shiftMs, s)});
        }
    }
    reports.sort((a, b) => a.t - b.t);
    return {own, reports, names, ownMmsi: fakeMmsi(rx)};
}

/**
 * A boat's MMSI: the real one where the data has it (Kanreki: 503029690), else a
 * made-up 9 digit number from the tracker id (500000000 + id; never a real 503 one).
 */
function mmsiOf(b) {
    return b.mmsi ? String(b.mmsi) : String(500000000 + b.id);
}

/** The finish: the position of the smallest DTG anywhere in the data (as the prototype does). */
function finishOf(json) {
    let best = Infinity;
    let finish = null;
    for (const b of json.boats) {
        for (const x of b.samples) {
            if (x[5] != null && x[5] < best) {
                best = x[5];
                finish = {lat: x[1], lon: x[2]};
            }
        }
    }
    return finish;
}

/** Our next point as nmea0183-signalk maps an RMB sentence from the nav PC. */
function rmbDelta(context, wp, t) {
    return {
        context,
        updates: [
            {
                $source: 'sim.EC',
                source: {label: 'sim', type: 'NMEA0183', talker: 'EC', sentence: 'RMB'},
                timestamp: new Date(t).toISOString(),
                values: [
                    {
                        path: 'navigation.courseRhumbline.nextPoint.position',
                        value: {latitude: wp.lat, longitude: wp.lon}
                    },
                    {path: 'navigation.courseRhumbline.nextPoint.ID', value: 'FINISH'}
                ]
            }
        ]
    };
}

/** Signal K delta for a report, in the shape the AIS parsers emit (one update, one timestamp). */
function toDelta(context, r) {
    const values = [{path: 'navigation.position', value: {latitude: r.lat, longitude: r.lon}}];
    if (r.cogRad != null) values.push({path: 'navigation.courseOverGroundTrue', value: r.cogRad});
    if (r.sogMs != null) values.push({path: 'navigation.speedOverGround', value: r.sogMs});
    return {context, updates: [{timestamp: new Date(r.t).toISOString(), values}]};
}

module.exports = {rng, lerpDeg, perMinute, simulate, mmsiOf, toDelta, finishOf, rmbDelta, KN, NM};
