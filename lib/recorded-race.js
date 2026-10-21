'use strict';
/*
 * Recorded races: files named recorded-race-<key>.json in the plugin's data dir, each a
 * race's tracker fixes, offered on the CYCA tab beside the feed's races. Picking one
 * serves the same feed requests from the file, so polling and backfill run as against
 * the real feed. Only what has happened by now is served: the file can hold a whole race
 * ahead of the clock (a replay with its times shifted to now, test/sim/live-feed.js).
 *
 * File format (as test/sim/fleet-sim.js trackerSlots() and the GC2026 data):
 *   {race: {id, name, start: ISO time, timeZone?}, boats: [{id: entry id, name, owner?,
 *    club?, samples: [[ISO time on a 10 minute slot, lat, lon, sog_kn, cog_deg, ...]]}]}
 *
 * A recorded race gets a negative race id from its key, so it never clashes with a feed
 * race or the links kept for one. A file is read again when it changes (each request
 * checks its modification time; a replay rewrites it with new times each run), and one
 * not found is looked for again at most every RESCAN_MS; onChange(raceId) then says a
 * race's data changed, so its detail (the start) is read again. A file that can't be read or parsed is left out, with
 * its error kept for the race list. Nothing here throws into the caller.
 */
const fs = require('node:fs');
const path = require('node:path');
const {SLOT_MS} = require('./cyca-feed');

const FILE_RE = /^recorded-race-([A-Za-z0-9_.-]+)\.json$/;
const MAX_BYTES = 20e6; // a 3 day race of 100 boats is about 2 MB
const RESCAN_MS = 30e3;

/** A stable negative race id for a key. */
function recordedId(key) {
    let h = 0;
    for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return -(1 + (h % 999999));
}

/** The time in a zone as the feed's race-local 'yyyy-MM-ddTHH:mm:ss'. */
function local(t, timeZone) {
    const p = {};
    const f = new Intl.DateTimeFormat('en-US', {
        timeZone,
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

const utcLocal = (t) => new Date(t).toISOString().slice(0, 19); // the feed's UTC form, no zone

/** Checks and normalises a file's JSON: {name, startT, timeZone, boats} or throws. */
function parseRecorded(json) {
    const r = json && json.race;
    const startT = r && Date.parse(r.start);
    if (!r || !Number.isFinite(startT)) throw new Error('no race start');
    if (!Array.isArray(json.boats)) throw new Error('no boats');
    const boats = [];
    for (const b of json.boats) {
        if (!b || !Number.isInteger(b.id) || typeof b.name !== 'string' || !Array.isArray(b.samples)) continue;
        const samples = b.samples
            .filter((s) => Array.isArray(s) && Number.isFinite(Date.parse(s[0])))
            .map(([t, lat, lon, sog, cog]) => ({t: Date.parse(t), lat, lon, sog, cog}))
            .sort((x, y) => x.t - y.t);
        boats.push({id: b.id, name: b.name, owner: b.owner || '', club: b.club || '', samples});
    }
    const lastT = Math.max(startT, ...boats.map((b) => (b.samples.length ? b.samples.at(-1).t : -Infinity)));
    const timeZone = typeof r.timeZone === 'string' && r.timeZone ? r.timeZone : 'Australia/Sydney';
    return {name: typeof r.name === 'string' && r.name ? r.name : 'race', startT, lastT, timeZone, boats};
}

const position = (b, s, racing = true) => ({
    raceEntryId: b.id,
    latitude: s ? s.lat : null,
    longitude: s ? s.lon : null,
    speedOverGround: s && s.sog != null ? String(s.sog) : '',
    courseOverGround: s && s.cog != null ? String(s.cog) : '',
    distanceToGo: null,
    distanceToLeader: null,
    raceStatus: 'Racing',
    isRetired: false,
    isFinished: false,
    isRacing: racing
});

/**
 * The feed's answers for one recorded race at `now` (feed paths after /v2), or null for a
 * path it does not serve. Only slots at or before now are given.
 */
function answer(rec, raceId, p, now) {
    const race = `/races/${raceId}`;
    const sinceSlot = (b) => b.samples.filter((s) => s.t <= now);
    if (p === race) {
        const ended = now > rec.lastT + SLOT_MS;
        return {
            raceId,
            seriesId: null,
            year: new Date(rec.startT).getUTCFullYear(),
            status: now < rec.startT ? 'Pre-race' : ended ? 'Race completed' : 'Racing',
            startDateUtc: utcLocal(rec.startT),
            endDateUtc: ended ? utcLocal(rec.lastT) : null,
            isCurrent: true,
            isRunning: now >= rec.startT && !ended,
            timeZone: rec.timeZone
        };
    }
    if (p === race + '/entries')
        return rec.boats.map((b) => ({raceEntryId: b.id, raceId, name: b.name, owner: b.owner, club: b.club}));
    if (p === race + '/at/live/status')
        return rec.boats.map((b) => {
            const s = sinceSlot(b).at(-1);
            return {
                raceEntryId: b.id,
                raceId,
                raceTime: s ? local(s.t, rec.timeZone) : '0001-01-01T00:00:00',
                position: s ? position(b, s) : null
            };
        });
    const m = new RegExp(`^${race}/entries/(\\d+)/track/at/live$`).exec(p);
    if (m) {
        const b = rec.boats.find((x) => x.id === Number(m[1]));
        if (!b) return undefined;
        // One point per slot from the start, as the feed's tracks are (point i is the slot
        // at start + i x 10 min); a slot with no fix is a point with no position, so later
        // points keep their slots. Slots count from the start, which a replay's shifted
        // times need not put on a clock boundary.
        const at = new Map(b.samples.map((s) => [Math.round((s.t - rec.startT) / SLOT_MS), s]));
        const out = [];
        for (let i = 0; rec.startT + i * SLOT_MS <= Math.min(now, rec.lastT); i++)
            out.push(position(b, at.get(i) || null));
        return out;
    }
    return undefined;
}

class RecordedRaces {
    /**
     * @param {object} o
     * @param {string} o.dataDir
     * @param {() => number} [o.clock]
     * @param {(raceId: number) => void} [o.onChange] a race's file changed and was read again
     */
    constructor({dataDir, clock = Date.now, onChange = () => {}}) {
        this.dataDir = dataDir;
        this.clock = clock;
        this.onChange = onChange;
        this.races = new Map(); // raceId -> {key, rec, file, mtimeMs}
        this.errors = [];
        this.scanning = null;
        this.scannedT = -Infinity;
    }

    /** Reads the recorded race files again; one scan at a time. Never rejects. */
    scan() {
        if (!this.scanning) this.scanning = this._scan().finally(() => (this.scanning = null));
        return this.scanning;
    }

    async _scan() {
        this.scannedT = this.clock();
        const before = this.races;
        const races = new Map();
        const errors = [];
        let names = [];
        try {
            names = await fs.promises.readdir(this.dataDir);
        } catch (e) {
            if (e.code !== 'ENOENT') errors.push(`data dir: ${e.message}`);
        }
        for (const f of names.sort()) {
            const m = FILE_RE.exec(f);
            if (!m) continue;
            try {
                const file = path.join(this.dataDir, f);
                const st = await fs.promises.stat(file);
                if (st.size > MAX_BYTES) throw new Error('too big');
                const id = recordedId(m[1]);
                const had = before.get(id);
                if (had && had.mtimeMs === st.mtimeMs) {
                    races.set(id, had);
                    continue;
                }
                const rec = parseRecorded(JSON.parse(await fs.promises.readFile(file, 'utf8')));
                races.set(id, {key: m[1], rec, file, mtimeMs: st.mtimeMs});
            } catch (e) {
                errors.push(`${f}: ${e.message}`);
            }
        }
        this.races = races;
        this.errors = errors;
        for (const [id, r] of races) {
            const had = before.get(id);
            if (had && had !== r) this.onChange(id);
        }
    }

    /** As _fresh, for a timer: never rejects. */
    check(raceId) {
        return this._fresh(raceId).catch(() => {});
    }

    /** Reads a race's file again if it changed, or looks for a race not found yet. */
    async _fresh(raceId) {
        const r = this.races.get(raceId);
        if (!r) {
            if (this.clock() - this.scannedT >= RESCAN_MS) await this.scan();
            return;
        }
        try {
            if ((await fs.promises.stat(r.file)).mtimeMs !== r.mtimeMs) await this.scan();
        } catch (e) {
            await this.scan(); // gone: the scan drops it
        }
    }

    /** Race picker rows, as CycaRaces lists feed races, marked recorded. */
    listings() {
        const now = this.clock();
        return [...this.races].map(([raceId, {key, rec}]) => {
            const d = answer(rec, raceId, `/races/${raceId}`, now);
            return {
                raceId,
                seriesId: null,
                name: `Recorded: ${rec.name}`,
                key,
                recorded: true,
                startT: rec.startT,
                status: d.status,
                running: d.isRunning,
                timeZone: rec.timeZone,
                fleet: rec.boats.length,
                entered: false
            };
        });
    }

    /**
     * A fetch for the feed that answers a recorded race's requests from its file and
     * passes every other request to `fallback`.
     * @param {typeof fetch} fallback
     */
    fetchWith(fallback) {
        return async (url, opts) => {
            const m = /\/v2(\/races\/(-\d+)(?:\/.*)?)$/.exec(String(url));
            if (m) await this._fresh(Number(m[2]));
            const r = m && this.races.get(Number(m[2]));
            if (!r) return fallback(url, opts);
            const json = answer(r.rec, Number(m[2]), m[1], this.clock());
            if (json === undefined) return {ok: false, status: 404, json: async () => null};
            return {ok: true, status: 200, json: async () => json};
        };
    }
}

module.exports = {RecordedRaces, parseRecorded, recordedId, answer, FILE_RE};
