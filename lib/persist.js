'use strict';
/*
 * Atomic JSON persistence for user state (nemesis list, TCFs).
 *
 * Writes go to a temp file in the same directory, are fsynced, then renamed over
 * the target, so a brownout leaves either the old or the new file, never a torn
 * one. Writes are serialised and coalesced: if several saves are requested while
 * one is in flight, only the latest state is written next.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

async function writeJsonAtomic(file, data) {
    const tmp = `${file}.${process.pid}.tmp`;
    const fh = await fsp.open(tmp, 'w');
    try {
        await fh.writeFile(JSON.stringify(data, null, 2));
        await fh.sync();
    } finally {
        await fh.close();
    }
    await fsp.rename(tmp, file);
}

/** Read JSON, returning `fallback` if missing or corrupt. Synchronous: used once at start. */
function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return fallback;
    }
}

class JsonStore {
    constructor(dir, name, onError = () => {}) {
        this.file = path.join(dir, name);
        this.onError = onError;
        this.inFlight = null;
        this.next = undefined;
    }

    load(fallback) {
        return readJson(this.file, fallback);
    }

    /** Request a save of `data` (snapshotted now). Returns a promise for when it is on disk. */
    save(data) {
        this.next = JSON.parse(JSON.stringify(data));
        if (!this.inFlight) this.inFlight = this._drain();
        return this.inFlight;
    }

    async _drain() {
        try {
            while (this.next !== undefined) {
                const d = this.next;
                this.next = undefined;
                try {
                    await writeJsonAtomic(this.file, d);
                } catch (e) {
                    this.onError(e);
                }
            }
        } finally {
            this.inFlight = null;
        }
    }
}

module.exports = {writeJsonAtomic, readJson, JsonStore};
