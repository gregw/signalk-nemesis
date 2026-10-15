'use strict';
/*
 * Per-boat bounded track history.
 *
 * Each boat has a ring buffer capped by count and by time span. Reports are kept
 * in timestamp order; an out-of-order report (late delivery) is inserted in place,
 * and an exact duplicate timestamp replaces the earlier report.
 */

class RingBuffer {
    constructor(capacity) {
        if (!(capacity > 0)) throw new Error('RingBuffer capacity must be > 0');
        this.capacity = capacity;
        this.items = [];
    }

    get length() {
        return this.items.length;
    }

    /** Insert keeping ascending t. Returns the evicted oldest item, if any. */
    insert(item) {
        const a = this.items;
        let i = a.length;
        while (i > 0 && a[i - 1].t > item.t) i--;
        if (i > 0 && a[i - 1].t === item.t) {
            a[i - 1] = item;
            return null;
        }
        a.splice(i, 0, item);
        return a.length > this.capacity ? a.shift() : null;
    }

    /** Drop items with t < minT. */
    trimBefore(minT) {
        let k = 0;
        while (k < this.items.length && this.items[k].t < minT) k++;
        if (k) this.items.splice(0, k);
    }

    /** Latest item with item.t <= t, or null. Binary search. */
    atOrBefore(t) {
        const a = this.items;
        let lo = 0;
        let hi = a.length - 1;
        let k = -1;
        while (lo <= hi) {
            const m = (lo + hi) >> 1;
            if (a[m].t <= t) {
                k = m;
                lo = m + 1;
            } else hi = m - 1;
        }
        return k < 0 ? null : a[k];
    }

    /** Item immediately before `item` in time, or null. */
    previous(item) {
        const a = this.items;
        const i = a.indexOf(item);
        return i > 0 ? a[i - 1] : null;
    }

    /** Items with fromT <= t <= toT, oldest first. */
    between(fromT, toT) {
        return this.items.filter((x) => x.t >= fromT && x.t <= toT);
    }

    latest() {
        return this.items.length ? this.items[this.items.length - 1] : null;
    }
}

class TrackStore {
    /**
     * @param {object} opts
     * @param {number} opts.maxReportsPerBoat
     * @param {number} opts.maxSpanMs history kept per boat, relative to that boat's latest report
     * @param {number} opts.maxBoats hard cap on tracked boats; least recently heard is evicted
     */
    constructor({maxReportsPerBoat = 2000, maxSpanMs = 6 * 3600e3, maxBoats = 500} = {}) {
        this.maxReportsPerBoat = maxReportsPerBoat;
        this.maxSpanMs = maxSpanMs;
        this.maxBoats = maxBoats;
        this.boats = new Map(); // boatId -> {id, name, track: RingBuffer, lastHeard}
    }

    /** Add a normalised Report {boatId, t, lat, lon, cogRad, sogMs, src}. */
    add(report) {
        let b = this.boats.get(report.boatId);
        if (!b) {
            b = {id: report.boatId, name: null, track: new RingBuffer(this.maxReportsPerBoat), lastHeard: -Infinity};
            this.boats.set(report.boatId, b);
        }
        b.track.insert(report);
        b.lastHeard = Math.max(b.lastHeard, report.t);
        b.track.trimBefore(b.lastHeard - this.maxSpanMs);
        // Evict only after lastHeard is set, otherwise a new boat would evict itself.
        this._evictIfFull();
    }

    setName(boatId, name) {
        const b = this.boats.get(boatId);
        if (b && typeof name === 'string') b.name = name;
    }

    get(boatId) {
        return this.boats.get(boatId) || null;
    }

    all() {
        return [...this.boats.values()];
    }

    _evictIfFull() {
        if (this.boats.size <= this.maxBoats) return;
        let oldest = null;
        for (const b of this.boats.values()) if (!oldest || b.lastHeard < oldest.lastHeard) oldest = b;
        if (oldest) this.boats.delete(oldest.id);
    }
}

/**
 * Latest report of a boat at or before t, if no older than staleMs, else null.
 * This is the "current" report used everywhere (brief section 3.4).
 */
function currentReport(track, t, staleMs) {
    const r = track.atOrBefore(t);
    return r && t - r.t <= staleMs ? r : null;
}

module.exports = {RingBuffer, TrackStore, currentReport};
