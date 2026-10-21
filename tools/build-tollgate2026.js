#!/usr/bin/env node
'use strict';
/*
 * Builds the Tollgate Islands Race 2026 test data (CYCA race 198, YB race bwps2026_2,
 * start 17:00 AEDT 16 Oct 2026) from raw downloads:
 *
 *   curl -o bwps2026_2.kml https://yb.tl/bwps2026_2.kml
 *   curl -o entries-198.json https://feeds.cycaracing.com/v2/races/198/entries
 *   node tools/build-tollgate2026.js <bwps2026_2.kml> <entries-198.json> <Kanreki Expedition log>
 *
 * Writes test/data/tollgate2026-yb.json (the fleet's YB fixes) and
 * test/data/tollgate2026-kanreki.json (Kanreki's own instruments). Both cover the span of
 * Kanreki's 16 Oct log, 02:50 to 13:00Z (to midnight AEDT): the start and first 7 hours.
 */
const fs = require('node:fs');
const path = require('node:path');
const {parseYbKml} = require('../test/sim/yb-kml');
const {parseExpedition} = require('../test/sim/expedition-log');
const {buildYbTracks, buildOwnLog} = require('../test/sim/build-tracks');

const FROM = Date.parse('2026-10-16T02:50:00Z');
const TO = Date.parse('2026-10-16T13:00:00Z');
const RACE = {
    id: 198,
    yb: 'bwps2026_2',
    name: 'Tollgate Islands Race 2026',
    start: '2026-10-16T17:00:00+11:00',
    tz: '+11:00'
};
// YB spells Ataraxia "Artaraxia".
const ALIASES = {artaraxia: 'ataraxia'};
// Real MMSIs given by Greg (2026-10-22), Kanreki's from live-feed.js.
const MMSI = {
    kanreki: '503029690',
    supernova: '503073900',
    ragtime: '503098600',
    diskotrooper: '503097760'
};

function main([kml, entries, log]) {
    if (!log) throw new Error('usage: build-tollgate2026.js <kml> <entries.json> <expedition log>');
    const out = path.join(__dirname, '..', 'test', 'data');
    const {boats, unmatched} = buildYbTracks({
        units: parseYbKml(fs.readFileSync(kml, 'utf8')),
        entries: JSON.parse(fs.readFileSync(entries, 'utf8')),
        fromMs: FROM,
        toMs: TO,
        aliases: ALIASES,
        mmsi: MMSI
    });
    const yb = {
        race: RACE,
        source: `https://yb.tl/${RACE.yb}.kml, fetched 2026-10-22; names and ids from the CYCA race entries`,
        from: new Date(FROM).toISOString(),
        to: new Date(TO).toISOString(),
        sample_fields: ['t', 'lat', 'lon'],
        boats
    };
    // One boat per line: diffable, and not much bigger than fully compact.
    const ybText =
        JSON.stringify({...yb, boats: []}).replace(/"boats":\[\]}$/, '"boats":[\n') +
        boats.map((b) => JSON.stringify(b)).join(',\n') +
        '\n]}\n';
    fs.writeFileSync(path.join(out, 'tollgate2026-yb.json'), ybText);
    const own = buildOwnLog({rows: parseExpedition(fs.readFileSync(log, 'utf8')).rows, fromMs: FROM, toMs: TO});
    const ownJson = {
        race: RACE,
        boat: 'Kanreki',
        mmsi: MMSI.kanreki,
        source: "Kanreki's Expedition log, 16 Oct 2026; t is the GPS fix time, epoch ms",
        ...own
    };
    const ownText =
        JSON.stringify({...ownJson, samples: []}).replace(/"samples":\[\]}$/, '"samples":[\n') +
        own.samples.map((s) => JSON.stringify(s)).join(',\n') +
        '\n]}\n';
    fs.writeFileSync(path.join(out, 'tollgate2026-kanreki.json'), ownText);
    console.log(
        `${boats.length} boats, ${boats.reduce((n, b) => n + b.samples.length, 0)} YB fixes; skipped ${unmatched.join(', ')}`
    );
    console.log(`${own.samples.length} own samples`);
}

main(process.argv.slice(2));
