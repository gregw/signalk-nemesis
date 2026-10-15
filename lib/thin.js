'use strict';
/*
 * Thinning of old reports: per boat, keep a report only if it is at least thinMs after
 * the last one kept. Applied to history older than the recent window, in memory
 * (TrackStore.thin) and on disk (journal compaction), so 5 days of history stays bounded.
 */

/** Thin an array of reports {boatId, t, ...} (any order); returns the kept ones in time order. */
function thinReports(reports, thinMs) {
    const sorted = reports.slice().sort((a, b) => a.t - b.t);
    const last = new Map();
    const out = [];
    for (const r of sorted) {
        const prev = last.get(r.boatId);
        if (prev !== undefined && r.t - prev < thinMs) continue;
        last.set(r.boatId, r.t);
        out.push(r);
    }
    return out;
}

module.exports = {thinReports};
