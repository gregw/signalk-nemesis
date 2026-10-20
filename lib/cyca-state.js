'use strict';
/*
 * Persisted CYCA choices, kept apart from the nemesis list and TCFs:
 *  - the selected race (null: off);
 *  - links from CYCA boats to AIS boats, kept across races (decided 2026-10-20).
 *    Entry ids change every race, so a link is keyed by the normalised CYCA name.
 *    One AIS boat links to at most one CYCA name;
 *  - "No AIS" marks, for the selected race only (a boat may have AIS next race).
 */

const {JsonStore} = require('./persist');
const {nameKey} = require('./cyca-feed');

const FILE = 'cyca-state.json';
const VERSION = 1;
const MMSI = /^\d{1,9}$/;

class CycaState {
    constructor(dataDir, onError) {
        this.store = new JsonStore(dataDir, FILE, onError);
        const d = this.store.load(null);
        this.raceId = Number.isInteger(d?.raceId) ? d.raceId : null;
        this.links = new Map(); // nameKey -> mmsi
        if (d && d.links && typeof d.links === 'object') {
            for (const [k, v] of Object.entries(d.links)) if (k && MMSI.test(v)) this.links.set(k, v);
        }
        this.noAis = new Set(
            Array.isArray(d?.noAis) && d.noAisRaceId === this.raceId ? d.noAis.filter(Number.isInteger) : []
        );
    }

    /** Select a race (null: off). "No AIS" marks belong to the previous race and are dropped. */
    setRace(raceId) {
        const id = Number.isInteger(raceId) ? raceId : null;
        if (id === this.raceId) return Promise.resolve();
        this.raceId = id;
        this.noAis.clear();
        return this._save();
    }

    linkOf(name) {
        return this.links.get(nameKey(name)) ?? null;
    }

    /** The CYCA name key linked to an AIS boat, or null. */
    nameOf(mmsi) {
        for (const [k, v] of this.links) if (v === mmsi) return k;
        return null;
    }

    /** Link a CYCA name to an AIS boat (mmsi), or unlink it (null). */
    link(name, mmsi) {
        const k = nameKey(name);
        if (!k) throw new RangeError('name must be a non-empty string');
        if (mmsi === null) {
            this.links.delete(k);
        } else {
            if (!MMSI.test(mmsi)) throw new RangeError('mmsi must be a string of up to 9 digits');
            const other = this.nameOf(mmsi);
            if (other !== null) this.links.delete(other);
            this.links.set(k, mmsi);
        }
        return this._save();
    }

    isNoAis(entryId) {
        return this.noAis.has(entryId);
    }

    setNoAis(entryId, on) {
        if (!Number.isInteger(entryId)) throw new RangeError('entryId must be an integer');
        on ? this.noAis.add(entryId) : this.noAis.delete(entryId);
        return this._save();
    }

    toJSON() {
        return {
            version: VERSION,
            raceId: this.raceId,
            links: Object.fromEntries(this.links),
            noAisRaceId: this.raceId,
            noAis: [...this.noAis]
        };
    }

    _save() {
        return this.store.save(this.toJSON());
    }
}

module.exports = {CycaState};
