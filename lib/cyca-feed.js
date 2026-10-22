'use strict';
/*
 * CYCA race tracker feed (feeds.cycaracing.com, API v2): URL builders, a fetch
 * that never throws, and pure parsers to SI units.
 *
 * Verified 2026-10-20 against the tracker page's own module
 * (goldcoast.cycaracing.com /_astro/feedsV2.*.js) and live responses:
 *  - Snapshot tokens are 'live', 'final' or race-local yyyyMMddHHmm on a 10 minute
 *    boundary. Race-local times carry no zone; the race detail names it
 *    (timeZone 'Australia/Sydney').
 *  - A position has no fix time of its own, only its snapshot slot (raceTime).
 *    YB fixes fall almost all in the first minute after the boundary (bwp2023).
 *  - speedOverGround and courseOverGround are strings (knots, degrees true);
 *    distanceToGo is nautical miles. The feed's "no data" time is year 1.
 *  - A track has one point per 10 minute slot from the race start while the boat
 *    is racing (checked against slot snapshots for races 194 and 191); the points
 *    after it finish are its finish position, not slot fixes.
 *  - Results (verified 2026-10-22 against bwps.cycaracing.com /_astro/feedsV2.7uXYYd2L.js
 *    and races 194 and 198): the race detail lists categories {id, name ('IRC', 'PHS',
 *    ...), type ('Handicap', 'Line Honours'), isDefault}; a category's results at a
 *    snapshot give each entry's raceEntryId, nameRace and tcf (a number).
 */

const FEED_BASE = 'https://feeds.cycaracing.com';
const SLOT_MS = 600e3;
const KN = 1852 / 3600;
const NM = 1852;
const DEG = Math.PI / 180;

function urls(base = FEED_BASE) {
    const race = (raceId) => `${base}/v2/races/${raceId}`;
    return {
        yearSeries: (year) => `${base}/v2/years/${year}/series`,
        seriesRaces: (seriesId) => `${base}/v2/series/${seriesId}/races`,
        race,
        entries: (raceId) => `${race(raceId)}/entries`,
        status: (raceId, snapshot) => `${race(raceId)}/at/${snapshot}/status`,
        track: (raceId, entryId, snapshot) => `${race(raceId)}/entries/${entryId}/track/at/${snapshot}`,
        // A category's standings (its handicaps among them), as the results page asks for them.
        results: (raceId, categoryId, snapshot) => `${race(raceId)}/categories/${categoryId}/results/at/${snapshot}`
    };
}

/**
 * GET a JSON document. Never throws: resolves {ok: true, json} or {ok: false, error}.
 * @param {typeof fetch} fetchImpl
 */
async function fetchJson(fetchImpl, url, timeoutMs = 15e3) {
    // A plain timer, not AbortSignal.timeout: that one is unref'd on Node 22, so a
    // stalled request would not hold the process open until it times out.
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        ac.abort();
    }, timeoutMs);
    try {
        const res = await fetchImpl(url, {signal: ac.signal, headers: {accept: 'application/json'}});
        if (!res.ok) return {ok: false, error: `HTTP ${res.status}`};
        return {ok: true, json: await res.json()};
    } catch (e) {
        return {ok: false, error: timedOut ? 'timeout' : String((e && e.message) || e)};
    } finally {
        clearTimeout(timer);
    }
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;
const zoneFormats = new Map();

function zoneFormat(timeZone) {
    let f = zoneFormats.get(timeZone);
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric'
        });
        zoneFormats.set(timeZone, f);
    }
    return f;
}

/** The zone's offset from UTC at instant t, in ms. */
function zoneOffsetMs(t, timeZone) {
    const p = {};
    for (const {type, value} of zoneFormat(timeZone).formatToParts(new Date(t))) p[type] = Number(value);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}

/** Race-local 'yyyy-MM-ddTHH:mm[:ss]' to UTC ms, or null (unparseable, or the year 1 sentinel). */
function localToUtc(local, timeZone) {
    const m = LOCAL.exec(local || '');
    if (!m || Number(m[1]) < 1900) return null;
    const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    try {
        // Two passes settle the offset either side of a daylight saving change.
        const first = wall - zoneOffsetMs(wall, timeZone);
        return wall - zoneOffsetMs(first, timeZone);
    } catch (e) {
        return null; // unknown time zone
    }
}

/** UTC ms to a race-local snapshot token yyyyMMddHHmm, floored to the 10 minute boundary. */
function snapshotToken(t, timeZone) {
    const w = new Date(t + zoneOffsetMs(t, timeZone));
    const pad = (n) => String(n).padStart(2, '0');
    const minute = Math.floor(w.getUTCMinutes() / 10) * 10;
    return `${w.getUTCFullYear()}${pad(w.getUTCMonth() + 1)}${pad(w.getUTCDate())}${pad(w.getUTCHours())}${pad(minute)}`;
}

function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function fix(p) {
    const lat = num(p.latitude);
    const lon = num(p.longitude);
    if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0))
        return null;
    const sog = num(p.speedOverGround);
    const cog = num(p.courseOverGround);
    const dtg = num(p.distanceToGo);
    return {
        lat,
        lon,
        sogMs: sog === null ? null : sog * KN,
        cogRad: cog === null ? null : (((cog % 360) + 360) % 360) * DEG,
        dtgM: dtg === null ? null : dtg * NM,
        status: typeof p.raceStatus === 'string' ? p.raceStatus : '',
        racing: p.isRacing === true
    };
}

/** Race detail to {raceId, seriesId, startT, endT, status, running, current, timeZone}, or null. */
function parseRace(r) {
    if (!r || !Number.isInteger(r.raceId)) return null;
    const utc = (s) =>
        typeof s === 'string' && LOCAL.test(s) && Number(s.slice(0, 4)) >= 1900
            ? Date.parse(s.slice(0, 19) + 'Z')
            : null;
    return {
        raceId: r.raceId,
        seriesId: Number.isInteger(r.seriesId) ? r.seriesId : null,
        startT: utc(r.startDateUtc),
        endT: utc(r.endDateUtc),
        status: typeof r.status === 'string' ? r.status : '',
        running: r.isRunning === true,
        current: r.isCurrent === true,
        timeZone: typeof r.timeZone === 'string' && r.timeZone ? r.timeZone : 'Australia/Sydney'
    };
}

/** A series' races (series/<id>/races), unparseable rows dropped. */
function parseRaces(json) {
    return (Array.isArray(json) ? json : []).map(parseRace).filter((r) => r && r.startT !== null);
}

/** The race name from an entry's cmsUrl ('/the-yachts/bird-island-race/2026/akonga/'), or null. */
function slugName(cmsUrl) {
    const m = /^\/the-yachts\/([a-z0-9-]+)\/\d{4}\//.exec(cmsUrl || '');
    if (!m) return null;
    return m[1].replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Entries to [{entryId, name, owner, club}] plus the race name found in their cmsUrl. */
function parseEntries(json) {
    const entries = [];
    let raceName = null;
    for (const e of Array.isArray(json) ? json : []) {
        if (!e || !Number.isInteger(e.raceEntryId) || typeof e.name !== 'string') continue;
        entries.push({entryId: e.raceEntryId, name: e.name.trim(), owner: e.owner || '', club: e.club || ''});
        raceName = raceName || slugName(e.cmsUrl);
    }
    return {entries, raceName};
}

/**
 * A fleet status snapshot to one row per entry with a position:
 * {entryId, t (slot, UTC ms), lat, lon, sogMs, cogRad, dtgM, status, racing}.
 */
function parseStatus(json, timeZone) {
    const out = [];
    for (const s of Array.isArray(json) ? json : []) {
        if (!s || !Number.isInteger(s.raceEntryId) || !s.position) continue;
        const t = localToUtc(s.raceTime, timeZone);
        const f = fix(s.position);
        if (t === null || !f) continue;
        out.push({entryId: s.raceEntryId, t, ...f});
    }
    return out;
}

/**
 * A boat's track to its slot fixes [{t, lat, lon, sogMs, cogRad, dtgM, status, racing}].
 * Point i is the slot at startT + i x 10 min while racing; the track stops being
 * slot-aligned once the boat is no longer racing, so the rest is dropped.
 */
function parseTrack(json, startT) {
    const out = [];
    if (!Array.isArray(json) || !Number.isFinite(startT)) return out;
    for (let i = 0; i < json.length; i++) {
        const p = json[i];
        if (!p || p.isRacing !== true) break;
        const f = fix(p);
        // The first point is the start area with no speed (seen in race 194), not a fix.
        if (f && f.sogMs !== null) out.push({t: startT + i * SLOT_MS, ...f});
    }
    return out;
}

/** A race detail's categories to [{id, name, type, isDefault}], unparseable ones dropped. */
function parseCategories(r) {
    return (r && Array.isArray(r.categories) ? r.categories : [])
        .filter((c) => c && Number.isInteger(c.id) && typeof c.name === 'string')
        .map((c) => ({
            id: c.id,
            name: c.name,
            type: typeof c.type === 'string' ? c.type : '',
            isDefault: c.isDefault === true
        }));
}

/** A category's results to [{entryId, name, tcf}], the entries with a usable TCF (in (0, 3]). */
function parseResults(json) {
    const out = [];
    for (const r of Array.isArray(json) ? json : []) {
        if (!r || !Number.isInteger(r.raceEntryId)) continue;
        const tcf = num(r.tcf);
        if (tcf === null || !(tcf > 0 && tcf <= 3)) continue;
        out.push({entryId: r.raceEntryId, name: typeof r.nameRace === 'string' ? r.nameRace.trim() : '', tcf});
    }
    return out;
}

/** The key a CYCA boat is linked by across races (entry ids change every race). */
function nameKey(name) {
    return typeof name === 'string' ? name.trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

module.exports = {
    FEED_BASE,
    SLOT_MS,
    urls,
    fetchJson,
    localToUtc,
    snapshotToken,
    zoneOffsetMs,
    parseRace,
    parseRaces,
    parseEntries,
    parseStatus,
    parseTrack,
    parseCategories,
    parseResults,
    slugName,
    nameKey
};
