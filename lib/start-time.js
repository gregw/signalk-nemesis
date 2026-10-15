'use strict';
/*
 * Race start time seam, used for elapsed time in the TCF calculations.
 *
 * Sources, highest precedence first:
 *  1. Manual override, set through the PUT handler (navigation.racing.nemesis.setStartTime).
 *  2. signalk-racer: data model path navigation.racing.startTime on our own vessel, an
 *     RFC 3339 UTC string set by the racer timer's start/sync/set commands and set to
 *     null by reset (../signalk-racer index.js startTimeCommand).
 *
 * Both values are persisted. signalk-racer does not persist its start time: after a
 * restart it reads navigation.racing.startTime back from the (now empty) data model
 * (index.js plugin.start), so after a brownout mid-race only our copy survives.
 *
 * A start older than maxRaceMs is ignored, so a previous race's start time cannot
 * silently feed the TCF numbers of the next one.
 */

const {JsonStore} = require('./persist');

const FILE = 'start-time.json';
const RACER_PATH = 'navigation.racing.startTime';

class StartTime {
    /**
     * @param {object} opts
     * @param {string} opts.dataDir
     * @param {number} opts.maxRaceMs
     * @param {() => number} [opts.clock]
     * @param {(e: Error) => void} [opts.onError]
     */
    constructor({dataDir, maxRaceMs, clock = Date.now, onError}) {
        this.maxRaceMs = maxRaceMs;
        this.clock = clock;
        this.store = new JsonStore(dataDir, FILE, onError);
        const d = this.store.load(null);
        this.override = parseTime(d?.override);
        this.racer = parseTime(d?.racer);
    }

    /** The effective start {t, src} or null. */
    get() {
        const now = this.clock();
        for (const [t, src] of [
            [this.override, 'override'],
            [this.racer, 'racer']
        ]) {
            if (t != null && now - t <= this.maxRaceMs) return {t, src};
        }
        return null;
    }

    /** Set (ISO string or epoch ms) or clear (null) the manual override. */
    setOverride(v) {
        if (v === null) this.override = null;
        else {
            const t = parseTime(v);
            if (t == null) throw new RangeError('start time must be an RFC 3339 time or null');
            this.override = t;
        }
        return this._save();
    }

    /** A value of navigation.racing.startTime from signalk-racer: string, or null on reset. */
    racerValue(v) {
        if (v === null) {
            if (this.racer === null) return Promise.resolve();
            this.racer = null;
            return this._save();
        }
        const t = parseTime(v);
        if (t == null || t === this.racer) return Promise.resolve();
        this.racer = t;
        return this._save();
    }

    toJSON() {
        return {
            override: this.override == null ? null : new Date(this.override).toISOString(),
            racer: this.racer == null ? null : new Date(this.racer).toISOString()
        };
    }

    _save() {
        return this.store.save(this.toJSON());
    }
}

/** Epoch ms from an RFC 3339 string or finite number, else null. */
function parseTime(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v !== 'string' || !v) return null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
}

/** Subscribes to signalk-racer's start time and feeds it into a StartTime. */
class RacerStartAdapter {
    constructor(app, startTime) {
        this.app = app;
        this.startTime = startTime;
        this.unsubscribes = [];
    }

    start() {
        // A value already in the data model (racer running, we restarted).
        try {
            const v = this.app.getSelfPath(RACER_PATH);
            if (v && v.value !== undefined) this.startTime.racerValue(v.value);
        } catch (e) {
            this.app.debug(`racer start time read failed: ${e && e.message}`);
        }
        this.app.subscriptionmanager.subscribe(
            {context: 'vessels.self', subscribe: [{path: RACER_PATH, policy: 'instant'}]},
            this.unsubscribes,
            (err) => this.app.error(`Start time subscription error: ${err}`),
            (delta) => {
                try {
                    for (const u of delta.updates || []) {
                        for (const pv of (u && u.values) || []) {
                            if (pv && pv.path === RACER_PATH) this.startTime.racerValue(pv.value);
                        }
                    }
                } catch (e) {
                    this.app.debug(`racer start time ignored: ${e && e.message}`);
                }
            }
        );
    }

    stop() {
        this.unsubscribes.forEach((f) => f());
        this.unsubscribes = [];
    }
}

module.exports = {StartTime, RacerStartAdapter, parseTime, RACER_PATH};
