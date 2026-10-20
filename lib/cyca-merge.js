'use strict';
/*
 * A read-only view of the TrackStore with CYCA links applied (decided 2026-10-20):
 *  - a CYCA boat linked to an AIS boat shows as that AIS boat (its MMSI), even
 *    before the AIS boat is heard, so the nemesis list and TCFs stay keyed by MMSI;
 *  - its tracker reports fill the gaps only: one within mergeWindowMs of an AIS
 *    report is dropped (AIS has exact times and a better cadence);
 *  - unlinked CYCA boats stay as cyca:<entryId>.
 * The store is never rewritten, so linking and unlinking apply at once and undo cleanly.
 */

const {RingBuffer} = require('./track-store');

const CYCA_PREFIX = 'cyca:';
const MERGE_WINDOW_MS = 10 * 60e3;

const isCyca = (id) => typeof id === 'string' && id.startsWith(CYCA_PREFIX);

/** AIS reports plus the tracker reports with no AIS report within windowMs. Both oldest first. */
function mergeTracks(ais, cyca, windowMs = MERGE_WINDOW_MS) {
    const out = [];
    let j = 0;
    for (const c of cyca) {
        while (j < ais.length && ais[j].t < c.t - windowMs) j++;
        if (j < ais.length && ais[j].t <= c.t + windowMs) continue;
        out.push(c);
    }
    if (!out.length) return ais;
    return ais.concat(out).sort((a, b) => a.t - b.t);
}

function trackOf(items) {
    const rb = new RingBuffer(Math.max(1, items.length));
    rb.items = items;
    return rb;
}

/**
 * @param {object} store TrackStore
 * @param {(cycaName: string) => string|null} linkOf the MMSI a CYCA name is linked to
 * @returns {{all: () => object[], get: (id: string) => object|null}} boats shaped as the store's
 */
function mergedView(store, linkOf, windowMs = MERGE_WINDOW_MS) {
    const linked = new Map(); // mmsi -> CYCA boat
    for (const b of store.all()) {
        if (!isCyca(b.id) || !b.name) continue;
        const mmsi = linkOf(b.name);
        if (mmsi) linked.set(mmsi, b);
    }
    const merge = (ais, cyca) => ({
        ...(ais || {}),
        id: ais ? ais.id : linkOf(cyca.name),
        name: ais && ais.name ? ais.name : cyca.name,
        shipType: ais ? ais.shipType : undefined,
        lastHeard: Math.max(ais ? ais.lastHeard || 0 : 0, cyca.lastHeard || 0),
        cycaId: cyca.id,
        track: trackOf(mergeTracks(ais ? ais.track.items : [], cyca.track.items, windowMs))
    });
    let cache = null;
    const all = () => {
        if (cache) return cache;
        cache = [];
        const seen = new Set();
        for (const b of store.all()) {
            if (isCyca(b.id) && b.name && linkOf(b.name)) continue; // shown as its AIS boat
            const c = linked.get(b.id);
            cache.push(c ? merge(b, c) : b);
            seen.add(b.id);
        }
        for (const [mmsi, c] of linked) if (!seen.has(mmsi)) cache.push(merge(null, c));
        return cache;
    };
    return {all, get: (id) => all().find((b) => b.id === id) || null};
}

module.exports = {mergedView, mergeTracks, isCyca, CYCA_PREFIX, MERGE_WINDOW_MS};
