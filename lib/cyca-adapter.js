'use strict';
/*
 * CYCA tracker source adapter: polls the selected race's live fleet status once
 * per 10 minute slot and emits normalised Reports
 * {boatId: 'cyca:<entryId>', src: 'cyca', t, lat, lon, cogRad, sogMs} (brief section 4).
 *
 * - A report's time is its slot (the feed has no fix time; YB fixes fall in the
 *   first minute after the boundary), so polls run `offsetMs` after each boundary.
 * - A position unchanged since the boat's previous slot is a missed report, not a
 *   new one. TODO(verify): how the live feed shows a missed report during a race.
 * - Only boats racing are reported; finished and retired boats keep their last row.
 * - One request chain at a time; failures are recorded and the next slot retried.
 *   Nothing here throws into the caller.
 * - The race detail is re-read every `detailMs`; once it says the race is
 *   completed, polling stops.
 * - A fix timed more than FUTURE_MS after now is dropped, whatever the source: a feed
 *   with a bad clock, or a recorded race (recorded-race.js) holding the rest of a race.
 */

const feed = require('./cyca-feed');

const DETAIL_MS = 30 * 60e3;
const PRE_START_MS = 10 * 60e3;
const FUTURE_MS = 2 * 60e3;

class CycaAdapter {
    /**
     * @param {object} o
     * @param {typeof fetch} o.fetch
     * @param {(report: object) => void} o.onReport
     * @param {(entries: {entryId, name, owner, club}[]) => void} [o.onEntries]
     * @param {() => number} [o.clock]
     * @param {{setTimeout, clearTimeout}} [o.timers]
     */
    constructor({
        fetch,
        onReport,
        onEntries = () => {},
        onChange = () => {},
        clock = Date.now,
        timers = {setTimeout, clearTimeout},
        base,
        offsetMs = 120e3,
        detailMs = DETAIL_MS
    }) {
        this.fetch = fetch;
        this.onReport = onReport;
        this.onEntries = onEntries;
        this.onChange = onChange;
        this.clock = clock;
        this.timers = timers;
        this.urls = feed.urls(base);
        this.offsetMs = offsetMs;
        this.detailMs = detailMs;
        this.race = null; // parsed race detail
        this.raceId = null;
        this.entries = new Map(); // entryId -> {entryId, name, owner, club}
        this.rows = new Map(); // entryId -> latest status row
        this.detailT = null;
        this.lastOkT = null;
        this.lastError = null;
        this.completed = false;
        this.timer = null;
        this.running = null; // the poll in flight
        this.generation = 0; // bumped on every race change: stale polls drop their results
        this.fills = Promise.resolve(); // track fetches run one at a time
    }

    /** Select a race by id, or null to stop. */
    setRace(raceId) {
        if (raceId === this.raceId) return;
        this.generation++;
        this._cancel();
        this.raceId = Number.isInteger(raceId) ? raceId : null;
        this.race = null;
        this.entries.clear();
        this.rows.clear();
        this.detailT = null;
        this.lastOkT = null;
        this.lastError = null;
        this.completed = false;
        if (this.raceId !== null) this._schedule(0);
        this.onChange();
    }

    stop() {
        this.generation++;
        this._cancel();
    }

    /** Poll state for the API. */
    toJSON() {
        return {
            raceId: this.raceId,
            race: this.race,
            lastOkT: this.lastOkT,
            lastError: this.lastError,
            completed: this.completed,
            entries: this.entries.size
        };
    }

    /** The latest status row per entry, with its name. */
    fleet() {
        return [...this.entries.values()].map((e) => ({...e, last: this.rows.get(e.entryId) || null}));
    }

    _cancel() {
        if (this.timer) this.timers.clearTimeout(this.timer);
        this.timer = null;
    }

    _schedule(delayMs) {
        this._cancel();
        this.timer = this.timers.setTimeout(
            () => {
                this.timer = null;
                this.pollNow();
            },
            Math.max(0, delayMs)
        );
    }

    /** Delay to the next poll: offsetMs after the next slot boundary, or near the start. */
    _nextDelay(now) {
        const start = this.race && this.race.startT;
        if (start && now < start - PRE_START_MS) return start - PRE_START_MS - now;
        const next = Math.floor((now - this.offsetMs) / feed.SLOT_MS + 1) * feed.SLOT_MS + this.offsetMs;
        return next - now;
    }

    /** Run one poll now (also used by the timer). Resolves when done; never rejects. */
    pollNow() {
        if (this.raceId === null) return Promise.resolve();
        if (!this.running) {
            this._cancel(); // a manual poll replaces the scheduled one
            const gen = this.generation;
            this.running = this._poll(gen)
                .catch((e) => {
                    if (gen === this.generation) this.lastError = String((e && e.message) || e);
                })
                .finally(() => {
                    this.running = null;
                    if (gen !== this.generation) return;
                    if (!this.completed) this._schedule(this._nextDelay(this.clock()));
                    this.onChange();
                });
        }
        return this.running;
    }

    async _poll(gen) {
        const raceId = this.raceId;
        const now = this.clock();
        if (!this.race || this.detailT === null || now - this.detailT >= this.detailMs) {
            const d = await feed.fetchJson(this.fetch, this.urls.race(raceId));
            if (gen !== this.generation) return;
            const race = d.ok ? feed.parseRace(d.json) : null;
            if (!race) {
                this.lastError = d.ok ? 'unexpected race detail' : d.error;
                return;
            }
            this.race = race;
            this.detailT = now;
            if (race.status === 'Race completed') this.completed = true;
        }
        if (this.entries.size === 0) {
            const e = await feed.fetchJson(this.fetch, this.urls.entries(raceId));
            if (gen !== this.generation) return;
            if (e.ok) {
                for (const x of feed.parseEntries(e.json).entries) this.entries.set(x.entryId, x);
                if (this.entries.size) this.onEntries([...this.entries.values()]);
            }
        }
        if (this.race.startT && now < this.race.startT) {
            this.lastError = null;
            return; // pre-race: nothing to poll yet
        }
        const s = await feed.fetchJson(this.fetch, this.urls.status(raceId, 'live'));
        if (gen !== this.generation) return;
        if (!s.ok) {
            this.lastError = s.error;
            return;
        }
        this.lastOkT = now;
        this.lastError = null;
        for (const row of feed.parseStatus(s.json, this.race.timeZone)) this._row(row);
    }

    /**
     * Backfill one boat from its track: the slots in [fromT, toT] that `known(t)` says
     * are missing are reported. Queued behind other fills. Resolves the number
     * reported, or null if the track could not be read; never rejects.
     */
    fillTrack(entryId, fromT, toT, known = () => false) {
        const gen = this.generation;
        const run = async () => {
            if (gen !== this.generation || !this.race || !Number.isFinite(this.race.startT)) return null;
            const r = await feed.fetchJson(this.fetch, this.urls.track(this.raceId, entryId, 'live'));
            if (gen !== this.generation) return null;
            if (!r.ok) {
                this.lastError = r.error;
                return null;
            }
            let n = 0;
            const latest = this.clock() + FUTURE_MS;
            for (const p of feed.parseTrack(r.json, this.race.startT)) {
                if (p.t < fromT || p.t > toT || p.t > latest || known(p.t)) continue;
                n++;
                this.onReport({
                    boatId: 'cyca:' + entryId,
                    src: 'cyca',
                    t: p.t,
                    lat: p.lat,
                    lon: p.lon,
                    cogRad: p.cogRad,
                    sogMs: p.sogMs
                });
            }
            return n;
        };
        const p = this.fills.then(run).catch(() => null);
        this.fills = p;
        return p;
    }

    _row(row) {
        if (row.t > this.clock() + FUTURE_MS) return; // not happened yet
        const prev = this.rows.get(row.entryId);
        if (prev && row.t <= prev.t) return; // the same slot again, or older
        this.rows.set(row.entryId, row);
        if (!row.racing) return;
        if (prev && prev.lat === row.lat && prev.lon === row.lon) return; // missed report
        this.onReport({
            boatId: 'cyca:' + row.entryId,
            src: 'cyca',
            t: row.t,
            lat: row.lat,
            lon: row.lon,
            cogRad: row.cogRad,
            sogMs: row.sogMs
        });
    }
}

module.exports = {FUTURE_MS, CycaAdapter};
