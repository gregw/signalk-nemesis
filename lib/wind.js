'use strict';
/*
 * True wind direction (TWD) for the Upwind and Downwind frames: our own instruments'
 * environment.wind.directionTrue (rad, relative to true north; @signalk/signalk-schema
 * 1.0.3 keyswithmetadata.json, the version signalk-server 2.30.0 depends on), smoothed
 * as a circular mean over a time window. Wind is where it blows from (meteorological),
 * as instruments report it. TODO(verify) on the boat that directionTrue is the "from"
 * direction for the H5000 via the NGT-1.
 *
 * A seam for the wind source: a later source (derived from heading and TWA, or the CYCA
 * weather grid for replay) feeds the same smoother through add().
 */
const {RingBuffer} = require('./track-store');

const TWO_PI = 2 * Math.PI;
const MIN_SPACING_MS = 250; // faster input is thinned, which bounds the buffer

class TwdSmoother {
    /** @param {{windowMs?: number}} [o] */
    constructor({windowMs = 120e3} = {}) {
        this.windowMs = windowMs;
        this.buf = new RingBuffer(Math.ceil(windowMs / MIN_SPACING_MS) + 1);
    }

    /** One instrument reading at time t (epoch ms). Non-finite values are ignored. */
    add(t, rad) {
        if (!Number.isFinite(t) || !Number.isFinite(rad)) return;
        const last = this.buf.latest();
        if (last && t > last.t && t - last.t < MIN_SPACING_MS) return;
        this.buf.insert({t, s: Math.sin(rad), c: Math.cos(rad)});
        this.buf.trimBefore(this.buf.latest().t - this.windowMs);
    }

    /**
     * The smoothed TWD (rad, 0 to 2 pi) at time t: the circular mean of the readings in
     * the window ending at t. Null with no reading in that window (wind lost or not fitted).
     * Only the latest window is kept, so t is meant to be about now (an own sample's time).
     */
    at(t) {
        let s = 0;
        let c = 0;
        let n = 0;
        for (const r of this.buf.between(t - this.windowMs, t)) {
            s += r.s;
            c += r.c;
            n++;
        }
        if (!n || (s === 0 && c === 0)) return null;
        const a = Math.atan2(s, c);
        return a < 0 ? a + TWO_PI : a;
    }
}

/** Subscribes to our own true wind direction and feeds the smoother. */
class WindAdapter {
    constructor(app, smoother) {
        this.app = app;
        this.smoother = smoother;
        this.unsubscribes = [];
    }

    start() {
        this.app.subscriptionmanager.subscribe(
            {context: 'vessels.self', subscribe: [{path: 'environment.wind.directionTrue', policy: 'instant'}]},
            this.unsubscribes,
            (err) => this.app.error(`Wind subscription error: ${err}`),
            (delta) => {
                try {
                    for (const u of delta.updates || []) {
                        const t = Date.parse(u && u.timestamp);
                        for (const pv of (u && u.values) || []) {
                            if (pv && pv.path === 'environment.wind.directionTrue') this.smoother.add(t, pv.value);
                        }
                    }
                } catch (e) {
                    this.app.debug(`Wind delta ignored: ${e && e.message}`);
                }
            }
        );
    }

    stop() {
        this.unsubscribes.forEach((f) => f());
        this.unsubscribes = [];
    }
}

module.exports = {TwdSmoother, WindAdapter};
