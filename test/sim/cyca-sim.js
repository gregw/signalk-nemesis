'use strict';
/*
 * A fake CYCA feed (v2) serving a recorded race (GC2026 by default), shifted like the
 * AIS simulator so that `now` is the same moment of the race. Entry ids are the
 * recorded tracker ids. Serves the race detail, entries, the live fleet status
 * (each boat's latest sample at or before now) and each boat's live track. The data's
 * samples are [t, lat, lon, sog_kn, cog_deg, dtg_nm, dtl_nm] on the 10 minute slot grid
 * (gc2026-tracks.json, or trackerSlots() of the YB fixes).
 */

const gc2026 = require('../data/gc2026-tracks.json');

const KN_STR = (v) => (v == null ? '' : String(v));
const SLOT_MS = 600e3;

/** UTC ms to Sydney wall-clock 'yyyy-MM-ddTHH:mm:ss' (the feed's race-local times). */
function sydney(t) {
    const p = {};
    const f = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Australia/Sydney',
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
    for (const {type, value} of f.formatToParts(new Date(t))) p[type] = value;
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

function position(b, s) {
    const [, lat, lon, sog, cog, dtg, dtl] = s;
    return {
        raceEntryId: b.id,
        dataTypeCode: 'GPS       ',
        latitude: lat,
        longitude: lon,
        speedOverGround: KN_STR(sog),
        courseOverGround: KN_STR(cog),
        distanceToGo: dtg,
        distanceToLeader: dtl,
        raceStatus: 'Racing',
        isRetired: false,
        isFinished: false,
        isRacing: true
    };
}

/**
 * @param {object} o
 * @param {number} o.shiftMs as given to the AIS simulator
 * @param {() => number} o.clock
 * @param {object} [o.data] the recorded race
 * @param {number} [o.raceId]
 * @returns {typeof fetch & {calls: string[], down: boolean}}
 */
function cycaFeed({shiftMs, clock, data = gc2026, raceId = data.race.id}) {
    const startT = Date.parse(data.race.start) + shiftMs;
    const samplesTo = (b, now) => b.samples.filter((s) => Date.parse(s[0]) + shiftMs <= now);
    const routes = {
        [`/races/${raceId}`]: () => ({
            raceId,
            seriesId: 3,
            year: 2026,
            status: 'Racing',
            startDateUtc: new Date(startT).toISOString().slice(0, 19),
            endDateUtc: null,
            isCurrent: true,
            isRunning: true,
            timeZone: 'Australia/Sydney'
        }),
        [`/races/${raceId}/entries`]: () =>
            data.boats.map((b) => ({
                raceEntryId: b.id,
                raceId,
                name: b.name,
                owner: b.owner,
                club: b.club,
                cmsUrl: ''
            })),
        [`/races/${raceId}/at/live/status`]: () => {
            const now = clock();
            return data.boats.map((b) => {
                const s = samplesTo(b, now).at(-1);
                return {
                    raceEntryId: b.id,
                    raceId,
                    raceTime: s ? sydney(Date.parse(s[0]) + shiftMs) : '0001-01-01T00:00:00',
                    raceStartTime: sydney(startT),
                    position: s ? position(b, s) : null,
                    showOnMap: true
                };
            });
        }
    };
    const f = async (url) => {
        f.calls.push(url);
        if (f.down) throw new TypeError('fetch failed');
        const p = url.replace('https://feeds.cycaracing.com/v2', '');
        // The race list: every year has series 3, whose one race is this one.
        if (/^\/years\/\d{4}\/series$/.test(p)) return {ok: true, json: async () => [3]};
        if (p === '/series/3/races') return {ok: true, json: async () => [routes[`/races/${raceId}`]()]};
        const m = new RegExp(`^/races/${raceId}/entries/(\\d+)/track/at/live$`).exec(p);
        let json;
        if (m) {
            const b = data.boats.find((x) => x.id === Number(m[1]));
            if (!b) return {ok: false, status: 404};
            // One point per slot from the start (the recorded data is on that grid).
            json = samplesTo(b, clock()).map((s) => position(b, s));
        } else if (routes[p]) {
            json = routes[p]();
        } else {
            return {ok: false, status: 404};
        }
        return {ok: true, json: async () => json};
    };
    f.calls = [];
    f.down = false;
    return f;
}

module.exports = {cycaFeed, SLOT_MS};
