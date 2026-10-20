'use strict';
/*
 * The CYCA tab's mapping table, and whether it needs the navigator: a CYCA boat
 * that is not linked, not marked "No AIS", and has a candidate AIS boat. Pure.
 */

const {suggest} = require('./cyca-match');
const {isCyca, CYCA_PREFIX} = require('./cyca-merge');
const {RingBuffer} = require('./track-store');

/**
 * @param {object} o
 * @param {{entryId, name, owner, club}[]} o.entries the selected race's entries
 * @param {object} o.store TrackStore (unmerged)
 * @param {object} o.cycaState CycaState
 * @param {number} o.now
 */
function mappingRows({entries, store, cycaState, now}) {
    const linkedMmsi = new Set(cycaState.links.values());
    const ais = store.all().filter((b) => !isCyca(b.id) && !linkedMmsi.has(b.id));
    const unlinked = [];
    for (const e of entries) {
        if (cycaState.linkOf(e.name) || cycaState.isNoAis(e.entryId)) continue;
        // A boat with no tracker fix yet (before the start) still matches by name.
        const b = store.get(CYCA_PREFIX + e.entryId) || {id: CYCA_PREFIX + e.entryId, track: new RingBuffer(1)};
        unlinked.push({...b, name: e.name});
    }
    const sug = suggest({cyca: unlinked, ais, now});
    const rows = entries.map((e) => {
        const id = CYCA_PREFIX + e.entryId;
        const last = store.get(id)?.track.latest() || null;
        const link = cycaState.linkOf(e.name);
        const s = sug.get(id);
        const candidates = s ? s.candidates.map(({score, ...c}) => c) : [];
        return {
            entryId: e.entryId,
            id,
            name: e.name,
            owner: e.owner,
            club: e.club,
            lastT: last ? last.t : null,
            link,
            linkName: link ? store.get(link)?.name || null : null,
            noAis: cycaState.isNoAis(e.entryId),
            candidates,
            recommended: s ? s.recommended : null,
            needsAction: !link && !cycaState.isNoAis(e.entryId) && candidates.length > 0
        };
    });
    const rank = (r) => (r.needsAction ? 0 : !r.link && !r.noAis ? 1 : r.link ? 2 : 3);
    rows.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    return {rows, needsAction: rows.some((r) => r.needsAction)};
}

module.exports = {mappingRows};
