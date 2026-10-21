'use strict';
/*
 * Internal plugin state the user edits: the nemesis list and per-boat TCFs
 * (brief sections 3.5 and 3.6). Keyed by boatId (MMSI for AIS).
 * TODO: name fallback key for boats without an MMSI (tracker feeds).
 *
 * Persisted in the plugin data dir as nemesis-state.json, not in plugin options,
 * so edits from the webapp never touch the server's plugin configuration.
 *
 * Boats entered in advance in the plugin configuration seed this state (applyConfig):
 * a newly configured boat becomes a nemesis with its TCF; a changed configured TCF
 * is applied again. What was applied is remembered, so a restart with the same
 * configuration never undoes edits made in the webapp since (race-critical: a
 * brownout must not reset TCFs).
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
        // mmsi -> the configured TCF last applied (null: none configured)
        this.applied = new Map();
        if (d && d.applied && typeof d.applied === 'object') {
            for (const [k, v] of Object.entries(d.applied)) this.applied.set(k, validTcf(v) ? v : null);
        }
    }

    /**
     * Seeds from configured boats [{mmsi, tcf}] (tcf null when not configured).
     * @returns {Promise<void>|null} the save, or null if nothing changed
     */
    applyConfig(boats) {
        let changed = false;
        const put = (id, v) => (v === 1 ? this.tcf.delete(id) : this.tcf.set(id, v));
        for (const b of boats || []) {
            const tcf = validTcf(b.tcf) ? b.tcf : null;
            const prev = this.applied.get(b.mmsi);
            if (prev === undefined) {
                this.nemesis.add(b.mmsi);
                if (tcf != null) put(b.mmsi, tcf);
            } else if (tcf === prev) {
                continue;
            } else if (tcf != null) {
                put(b.mmsi, tcf);
            } // a configured TCF removed: the boat keeps the TCF it has
            this.applied.set(b.mmsi, tcf);
            changed = true;
        }
        return changed ? this._save() : null;
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

    /** Every TCF back to 1 (ours too). Configured TCFs come back only if the config changes. */
    clearTcfs() {
        this.tcf.clear();
        return this._save();
    }

    toJSON() {
        return {
            version: VERSION,
            nemesis: [...this.nemesis],
            tcf: Object.fromEntries(this.tcf),
            applied: Object.fromEntries(this.applied)
        };
    }

    _save() {
        return this.store.save(this.toJSON());
    }
}

function validTcf(v) {
    return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 3;
}

module.exports = {UserState, validTcf};
