'use strict';
/*
 * The CYCA races a navigator can pick: those not yet started, running, or started
 * in the last few days, each with its fleet size, a name if the feed has one, and
 * whether our boat is entered. The feed has no race or series names; the entry
 * cmsUrl slug gives one for multi-race series ('bird-island-race').
 *
 * Refreshed on demand and cached in the data dir, so the picker still has a list
 * offline. A failed refresh keeps the previous list.
 */

const {JsonStore} = require('./persist');
const feed = require('./cyca-feed');

const FILE = 'cyca-races.json';
const RECENT_MS = 3 * 24 * 3600e3;
const MAX_RACES = 12; // bounds the entries requests per refresh

/** Races worth offering at `now`, soonest first. Pure. */
function candidates(races, now, recentMs = RECENT_MS) {
    const seen = new Set();
    return races
        .filter((r) => {
            if (seen.has(r.raceId)) return false;
            seen.add(r.raceId);
            return r.running || r.status === 'Pre-race' || r.startT > now || now - r.startT <= recentMs;
        })
        .sort((a, b) => a.startT - b.startT || a.raceId - b.raceId)
        .slice(0, MAX_RACES);
}

class CycaRaces {
    /**
     * @param {object} o
     * @param {typeof fetch} o.fetch
     * @param {string} o.dataDir
     * @param {() => number} [o.clock]
     * @param {() => string|null} [o.ourName] our vessel name, read at refresh time
     */
    constructor({fetch, dataDir, clock = Date.now, ourName = () => null, base, onError = () => {}}) {
        this.fetch = fetch;
        this.clock = clock;
        this.ourName = ourName;
        this.urls = feed.urls(base);
        this.store = new JsonStore(dataDir, FILE, onError);
        const d = this.store.load(null);
        this.races = Array.isArray(d?.races) ? d.races : [];
        this.fetchedT = Number.isFinite(d?.fetchedT) ? d.fetchedT : null;
        this.error = null;
        this.inFlight = null;
    }

    /** The cached list and its age. */
    toJSON() {
        return {fetchedT: this.fetchedT, error: this.error, races: this.races};
    }

    byId(raceId) {
        return this.races.find((r) => r.raceId === raceId) || null;
    }

    /** Refresh from the feed; one at a time. Resolves the list, never rejects. */
    refresh() {
        if (!this.inFlight) this.inFlight = this._refresh().finally(() => (this.inFlight = null));
        return this.inFlight;
    }

    async _refresh() {
        const now = this.clock();
        const year = new Date(now).getUTCFullYear();
        const seriesIds = new Set();
        let reached = false;
        // A December race runs into January; next year's series already list early races.
        for (const y of [year - 1, year, year + 1]) {
            const r = await feed.fetchJson(this.fetch, this.urls.yearSeries(y));
            if (!r.ok) continue;
            reached = true;
            for (const id of Array.isArray(r.json) ? r.json : []) if (Number.isInteger(id)) seriesIds.add(id);
        }
        if (!reached) {
            this.error = 'CYCA feed unreachable';
            return this.toJSON();
        }
        const all = [];
        for (const id of seriesIds) {
            const r = await feed.fetchJson(this.fetch, this.urls.seriesRaces(id));
            if (r.ok) for (const race of feed.parseRaces(r.json)) all.push({...race, seriesId: race.seriesId ?? id});
        }
        const ours = feed.nameKey(this.ourName() || '');
        const out = [];
        for (const race of candidates(all, now)) {
            const r = await feed.fetchJson(this.fetch, this.urls.entries(race.raceId));
            const {entries, raceName} = r.ok ? feed.parseEntries(r.json) : {entries: null, raceName: null};
            out.push({
                raceId: race.raceId,
                seriesId: race.seriesId,
                name: raceName,
                startT: race.startT,
                status: race.status,
                running: race.running,
                timeZone: race.timeZone,
                fleet: entries ? entries.length : null,
                entered: entries && ours ? entries.some((e) => feed.nameKey(e.name) === ours) : false
            });
        }
        // Parallel series on one race (Hobart: series 2 and 15) share a start; one may have the slug.
        for (const r of out) {
            if (r.name) continue;
            const twin = out.find((o) => o.name && o.startT === r.startT);
            if (twin) r.name = twin.name;
        }
        this.races = out;
        this.fetchedT = now;
        this.error = null;
        await this.store.save({fetchedT: this.fetchedT, races: this.races});
        return this.toJSON();
    }
}

module.exports = {CycaRaces, candidates};
