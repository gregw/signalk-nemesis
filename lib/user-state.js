'use strict';
/*
 * Internal plugin state the user edits: the nemesis list and per-boat TCFs
 * (brief sections 3.5 and 3.6). Keyed by boatId (MMSI for AIS).
 * TODO: name fallback key for boats without an MMSI (tracker feeds).
 *
 * Persisted in the plugin data dir as nemesis-state.json, not in plugin options,
 * so edits from the webapp never touch the server's plugin configuration.
 */

const {JsonStore} = require('./persist');

const FILE = 'nemesis-state.json';
const VERSION = 1;

class UserState {
    constructor(dataDir, onError) {
        this.store = new JsonStore(dataDir, FILE, onError);
        const d = this.store.load(null);
        this.nemesis = new Set(Array.isArray(d?.nemesis) ? d.nemesis.map(String) : []);
        this.tcf = new Map();
        if (d && d.tcf && typeof d.tcf === 'object') {
            for (const [k, v] of Object.entries(d.tcf)) if (validTcf(v)) this.tcf.set(k, v);
        }
    }

    isNemesis(id) {
        return this.nemesis.has(id);
    }

    setNemesis(id, on) {
        on ? this.nemesis.add(id) : this.nemesis.delete(id);
        return this._save();
    }

    tcfOf(id) {
        return this.tcf.get(id) ?? 1;
    }

    setTcf(id, v) {
        if (!validTcf(v)) throw new RangeError('TCF must be a finite number in (0, 3]');
        v === 1 ? this.tcf.delete(id) : this.tcf.set(id, v);
        return this._save();
    }

    toJSON() {
        return {version: VERSION, nemesis: [...this.nemesis], tcf: Object.fromEntries(this.tcf)};
    }

    _save() {
        return this.store.save(this.toJSON());
    }
}

function validTcf(v) {
    return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 3;
}

module.exports = {UserState, validTcf};
