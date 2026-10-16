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

const NAME_RETRY_MS = 30e3;
const NAME_REFRESH_MS = 600e3;

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
     * @param {() => number} clock
     * @param {(boatId: string, shipType: number) => void} onShipType
     */
    constructor(app, onReport, onName, clock = Date.now, onShipType = () => {}) {
        this.app = app;
        this.onReport = onReport;
        this.onName = onName;
        this.onShipType = onShipType;
        this.clock = clock;
        this.names = new Map(); // boatId -> {name, shipType, checkedAt}
        this.unsubscribes = [];
        this.coalescer = new Coalescer((context, r) => {
            const boatId = mmsiOf(context);
            if (!boatId) return;
            this.onReport({boatId, src: 'ais', ...r});
            this._lookupName(context, boatId);
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
                    {path: 'navigation.speedOverGround', policy: 'instant'}
                ]
            },
            this.unsubscribes,
            (err) => this.app.error(`AIS subscription error: ${err}`),
            (delta) => {
                try {
                    if (!delta || delta.context === self) return;
                    this.coalescer.accept(delta);
                } catch (e) {
                    // Never let one bad delta break ingest.
                    this.app.debug(`AIS delta ignored: ${e && e.message}`);
                }
            }
        );
    }

    /*
     * Names are read from the full data model rather than subscribed to. Verified on
     * signalk-server 2.30.0: N2K PGN 129809 maps the name as path '' with value {name}
     * (n2k-signalk pgns/129809.js) and a subscription to path 'name' never delivers it,
     * although the data model holds it at vessels.<id>.name. app.getPath works however
     * the name arrived (it is _.get on the full model: src/interfaces/plugins.ts).
     *
     * The AIS ship type is read the same way, from data model path design.aisShipType,
     * value {id, name} (nmea0183-signalk hooks/VDM.js, n2k-signalk pgns/129794.js and
     * 129810.js; ids in signalk-schema schemas/groups/design.json, 36 Sailing, 37 Pleasure).
     *
     * Boats missing either are looked up at most every NAME_RETRY_MS, others every
     * NAME_REFRESH_MS.
     */
    _lookupName(context, boatId) {
        const now = this.clock();
        const known = this.names.get(boatId);
        const complete = known && known.name && known.shipType != null;
        if (known && now - known.checkedAt < (complete ? NAME_REFRESH_MS : NAME_RETRY_MS)) return;
        let name = null;
        let shipType = null;
        try {
            const v = this.app.getPath(context + '.name');
            name = typeof v === 'string' ? v : v && typeof v.value === 'string' ? v.value : null;
            const t = this.app.getPath(context + '.design.aisShipType');
            const tv = t && t.value !== undefined ? t.value : t;
            const id = tv && typeof tv === 'object' ? Number(tv.id) : NaN;
            shipType = Number.isInteger(id) && id > 0 ? id : null;
        } catch (e) {
            this.app.debug(`AIS name lookup failed: ${e && e.message}`);
        }
        name = name && name.trim() ? name.trim() : (known?.name ?? null);
        shipType = shipType ?? known?.shipType ?? null;
        this.names.set(boatId, {name, shipType, checkedAt: now});
        if (name && name !== known?.name) this.onName(boatId, name);
        if (shipType != null && shipType !== known?.shipType) this.onShipType(boatId, shipType);
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
