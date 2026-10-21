'use strict';
/*
 * Builds recorded test data files from raw downloads (see tools/build-tollgate2026.js):
 *  - the fleet's YB tracker fixes, named and numbered as the race's CYCA entries;
 *  - our own boat's instrument log, at the logged rate.
 * Pure: takes parsed input, returns the JSON to write.
 */

/** A name as a match key: lower case, letters and digits only, "(DH)" (two handed) dropped. */
function nameKey(s) {
    return String(s)
        .toLowerCase()
        .replace(/\(dh\)/g, '')
        .replace(/[^a-z0-9]/g, '');
}

/**
 * The fleet's YB fixes in [fromMs, toMs], one boat per CYCA entry.
 * @param {object} o
 * @param {{name: string, samples: number[][]}[]} o.units parseYbKml output
 * @param {{raceEntryId: number, name: string, owner?: string, club?: string}[]} o.entries CYCA race entries
 * @param {Object<string, string>} [o.aliases] YB name key -> CYCA name key, for misspellings
 * @param {Object<string, string>} [o.mmsi] CYCA name key -> real MMSI
 * @returns {{boats: object[], unmatched: string[]}} unmatched: YB units with no entry (spares, second units)
 */
function buildYbTracks({units, entries, fromMs, toMs, aliases = {}, mmsi = {}}) {
    const byKey = new Map(entries.map((e) => [nameKey(e.name), e]));
    const boats = [];
    const unmatched = [];
    for (const u of units) {
        const k = nameKey(u.name);
        const e = byKey.get(aliases[k] || k);
        if (!e) {
            unmatched.push(u.name);
            continue;
        }
        const ek = nameKey(e.name);
        const samples = u.samples
            .filter(([t]) => t >= fromMs && t <= toMs)
            .map(([t, lat, lon]) => [new Date(t).toISOString().replace('.000Z', 'Z'), lat, lon]);
        boats.push({
            id: e.raceEntryId,
            name: e.name,
            ybName: u.name,
            ...(mmsi[ek] ? {mmsi: mmsi[ek]} : {}),
            owner: e.owner || '',
            club: e.club || '',
            samples
        });
    }
    boats.sort((a, b) => a.name.localeCompare(b.name));
    return {boats, unmatched};
}

const KN = 1852 / 3600;
const R2D = 180 / Math.PI;
const round = (v, dp) => (v == null ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const deg = (r) => (r == null ? null : round((((r * R2D) % 360) + 360) % 360, 1));
const kn = (ms) => (ms == null ? null : round(ms / KN, 2));
const sdeg = (r) => (r == null ? null : round(r * R2D, 1)); // signed, as logged (TWA, AWA)

const OWN_FIELDS = [
    't',
    'lat',
    'lon',
    'cog_deg',
    'sog_kn',
    'hdg_deg',
    'bsp_kn',
    'twd_deg',
    'tws_kn',
    'twa_deg',
    'aws_kn',
    'awa_deg'
];

/**
 * Our own log rows (parseExpedition) in [fromMs, toMs] as compact samples: t epoch ms
 * (the GPS fix time, else the logged time), lat/lon 6 dp, angles 0.1 deg, speeds 0.01 kn.
 * Rows without a position are dropped.
 */
function buildOwnLog({rows, fromMs, toMs}) {
    const samples = [];
    for (const r of rows) {
        const t = Math.round(r.gpsT ?? r.t);
        if (t < fromMs || t > toMs || r.lat == null || r.lon == null) continue;
        samples.push([
            t,
            round(r.lat, 6),
            round(r.lon, 6),
            deg(r.cogRad),
            kn(r.sogMs),
            deg(r.hdgRad),
            kn(r.bspMs),
            deg(r.twdRad),
            kn(r.twsMs),
            sdeg(r.twaRad),
            kn(r.awsMs),
            sdeg(r.awaRad)
        ]);
    }
    samples.sort((a, b) => a[0] - b[0]);
    // A stale fix is logged again with a later row: keep the first of each fix time.
    const out = samples.filter((s, i) => i === 0 || s[0] !== samples[i - 1][0]);
    return {sample_fields: OWN_FIELDS, samples: out};
}

module.exports = {nameKey, buildYbTracks, buildOwnLog, OWN_FIELDS};
