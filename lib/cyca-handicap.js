'use strict';
/*
 * Handicaps from the CYCA feed: a race's IRC TCFs, as its results page shows them
 * (bwps.cycaracing.com/race/<year>/results?category=<IRC id>). Read on request only,
 * never polled: a TCF does not change during a race.
 */
const feed = require('./cyca-feed');

/**
 * The TCFs of a race's category named `categoryName` (IRC by default).
 * Never throws: resolves {ok: true, category: {id, name}, rows: [{entryId, name, tcf}]}
 * or {ok: false, error}.
 * @param {object} o
 * @param {typeof fetch} o.fetch
 * @param {number} o.raceId a feed race id
 */
async function fetchTcfs({fetch, raceId, categoryName = 'IRC', base}) {
    const urls = feed.urls(base);
    const d = await feed.fetchJson(fetch, urls.race(raceId));
    if (!d.ok) return {ok: false, error: `race detail: ${d.error}`};
    const want = categoryName.toLowerCase();
    const category = feed.parseCategories(d.json).find((c) => c.name.toLowerCase() === want);
    if (!category) return {ok: false, error: `no ${categoryName} category in this race`};
    // Live while racing; a finished race's live results are its last standings.
    let r = await feed.fetchJson(fetch, urls.results(raceId, category.id, 'live'));
    if (!r.ok) r = await feed.fetchJson(fetch, urls.results(raceId, category.id, 'final'));
    if (!r.ok) return {ok: false, error: `${category.name} results: ${r.error}`};
    return {ok: true, category: {id: category.id, name: category.name}, rows: feed.parseResults(r.json)};
}

module.exports = {fetchTcfs};
