'use strict';
/*
 * AIS source adapter: subscribes to other vessels' contexts and emits normalised
 * Reports {boatId, t, lat, lon, cogRad, sogMs, src: 'ais'} (brief section 4).
 *
 * Contexts are `vessels.urn:mrn:imo:mmsi:<MMSI>` (verified: n2k-signalk
 * mmsi-context.js, nmea0183-signalk hooks/VDM.js). boatId is the MMSI string.
 * Our own context (app.selfContext) is excluded; own state comes from OwnAdapter.
 *
 * policy 'instant' is required: 'fixed'/period resampling would replace report
 * times with buffer times (signalk-server src/subscriptionmanager.ts).
 */

const {Coalescer} = require('./coalescer');

const MMSI_CONTEXT = /^vessels\.urn:mrn:imo:mmsi:(\d{1,9})$/;

function mmsiOf(context) {
    const m = MMSI_CONTEXT.exec(context);
    return m ? m[1] : null;
}

class AisSourceAdapter {
    /**
     * @param {object} app Signal K server app
     * @param {(report: object) => void} onReport
     * @param {(boatId: string, name: string) => void} onName
     */
    constructor(app, onReport, onName) {
        this.app = app;
        this.onReport = onReport;
        this.onName = onName;
        this.unsubscribes = [];
        this.coalescer = new Coalescer((context, r) => {
            const boatId = mmsiOf(context);
            if (boatId) this.onReport({boatId, src: 'ais', ...r});
        });
    }

    start() {
        const self = this.app.selfContext;
        this.app.subscriptionmanager.subscribe(
            {
                context: 'vessels.*',
                subscribe: [
                    {path: 'navigation.position', policy: 'instant'},
                    {path: 'navigation.courseOverGroundTrue', policy: 'instant'},
                    {path: 'navigation.speedOverGround', policy: 'instant'},
                    {path: 'name', policy: 'instant'}
                ]
            },
            this.unsubscribes,
            (err) => this.app.error(`AIS subscription error: ${err}`),
            (delta) => {
                try {
                    if (!delta || delta.context === self) return;
                    this._names(delta);
                    this.coalescer.accept(delta);
                } catch (e) {
                    // Never let one bad delta break ingest.
                    this.app.debug(`AIS delta ignored: ${e && e.message}`);
                }
            }
        );
    }

    // TODO(verify): whether `name` arrives as path 'name' or as path '' with value {name}
    // through the subscription manager. Both are handled.
    _names(delta) {
        const boatId = mmsiOf(delta.context);
        if (!boatId) return;
        for (const u of delta.updates || []) {
            for (const pv of (u && u.values) || []) {
                if (!pv) continue;
                if (pv.path === 'name' && typeof pv.value === 'string') this.onName(boatId, pv.value);
                else if (pv.path === '' && pv.value && typeof pv.value.name === 'string')
                    this.onName(boatId, pv.value.name);
            }
        }
    }

    stop() {
        this.coalescer.flushAll();
        this.unsubscribes.forEach((f) => f());
        this.unsubscribes = [];
    }
}

/** Own vessel adapter: same coalescing, self context only. */
class OwnAdapter {
    constructor(app, onSample) {
        this.app = app;
        this.unsubscribes = [];
        this.coalescer = new Coalescer((context, r) => onSample(r));
    }

    start() {
        this.app.subscriptionmanager.subscribe(
            {
                context: 'vessels.self',
                subscribe: [
                    {path: 'navigation.position', policy: 'instant'},
                    {path: 'navigation.courseOverGroundTrue', policy: 'instant'},
                    {path: 'navigation.speedOverGround', policy: 'instant'},
                    {path: 'navigation.headingTrue', policy: 'instant'}
                ]
            },
            this.unsubscribes,
            (err) => this.app.error(`Own subscription error: ${err}`),
            (delta) => {
                try {
                    this.coalescer.accept(delta);
                } catch (e) {
                    this.app.debug(`Own delta ignored: ${e && e.message}`);
                }
            }
        );
    }

    stop() {
        this.coalescer.flushAll();
        this.unsubscribes.forEach((f) => f());
        this.unsubscribes = [];
    }
}

module.exports = {AisSourceAdapter, OwnAdapter, mmsiOf};
