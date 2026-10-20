'use strict';
/*
 * Which CYCA boats to backfill from their tracks (decided 2026-10-20): nemesis
 * boats only, over the display period, where the merged track (AIS and tracker)
 * has a gap longer than Stale after. Pure decisions plus a per-boat memo so a gap
 * the tracker cannot fill (no fixes there, or before the start) is not fetched
 * again every slot: after a fetch that added nothing, wait `idleRetryMs`.
 */

const RETRY_MS = 10 * 60e3;
const IDLE_RETRY_MS = 60 * 60e3;

/** True if items (oldest first) leave a gap longer than staleMs anywhere in [fromT, toT]. */
function hasGap(items, fromT, toT, staleMs) {
    if (!(toT > fromT)) return false;
    let prev = fromT;
    for (const r of items) {
        if (r.t < fromT) continue;
        if (r.t > toT) break;
        if (r.t - prev > staleMs) return true;
        prev = r.t;
    }
    return toT - prev > staleMs;
}

class BackfillPlanner {
    constructor({retryMs = RETRY_MS, idleRetryMs = IDLE_RETRY_MS} = {}) {
        this.retryMs = retryMs;
        this.idleRetryMs = idleRetryMs;
        this.memo = new Map(); // entryId -> {fromT, at, added}
    }

    reset() {
        this.memo.clear();
    }

    /**
     * @param {object} o
     * @param {object[]} o.boats merged view boats {id, cycaId, track}
     * @param {(id: string) => boolean} o.isNemesis
     * @param {number} o.now
     * @param {number} o.periodMs the display period to cover
     * @param {number} o.staleMs
     * @param {number|null} o.startT the race start: nothing to fill before it
     * @returns {{entryId: number, fromT: number, toT: number}[]}
     */
    plan({boats, isNemesis, now, periodMs, staleMs, startT}) {
        const out = [];
        const fromT = Math.max(now - periodMs, Number.isFinite(startT) ? startT : -Infinity);
        for (const b of boats) {
            const cid = b.cycaId || (typeof b.id === 'string' && b.id.startsWith('cyca:') ? b.id : null);
            if (!cid || !isNemesis(b.id)) continue;
            if (!hasGap(b.track.items, fromT, now, staleMs)) continue;
            const entryId = Number(cid.slice('cyca:'.length));
            const m = this.memo.get(entryId);
            // A longer period always fetches again; otherwise wait out the retry interval.
            if (m && fromT >= m.fromT && now - m.at < (m.added ? this.retryMs : this.idleRetryMs)) continue;
            out.push({entryId, fromT, toT: now});
        }
        return out;
    }

    /** Record a fetch for entryId covering fromT; added null means it failed (retry next time). */
    done(entryId, fromT, at, added) {
        if (added === null) this.memo.delete(entryId);
        else this.memo.set(entryId, {fromT, at, added});
    }
}

module.exports = {BackfillPlanner, hasGap};
