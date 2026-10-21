'use strict';
/*
 * Shared replay setup: a recorded race (GC2026 unless opts.race names another, see
 * races.js) -> seeded AIS simulator -> Signal K deltas (split per path by the fake app)
 * -> a running plugin instance.
 * Recorded times are shifted so that `hoursIn` after the start is wall-clock now.
 */
const {setTimeout: sleep} = require('node:timers/promises');
const {toDelta, rmbDelta, windDelta} = require('./ais-sim');
const fs = require('node:fs');
const path = require('node:path');
const {race, shiftTracker} = require('./races');
const {fakeApp} = require('./fake-app');
const {tmpdir} = require('./tmpdir');
const createPlugin = require('../../index');
// Tests never reach the real CYCA feed unless they pass a fetch of their own.
const noFetch = async () => {
    throw new TypeError('no network in tests');
};

async function replayTo(hoursIn, opts = {}) {
    const now = Date.now();
    const rec = race(opts.race);
    const RACE_START = rec.start;
    // Whole seconds: the feed's times (a recorded race's start) carry no milliseconds.
    const shiftMs = Math.round((now - (RACE_START + hoursIn * 3600e3)) / 1000) * 1000;
    const sim = rec.play(shiftMs);
    const dataDir = opts.dataDir || tmpdir();
    // opts.recorded: a key; the race's tracker data is written as recorded-race-<key>.json,
    // shifted like the rest, for the plugin to offer on the CYCA tab.
    if (opts.recorded)
        fs.writeFileSync(
            path.join(dataDir, `recorded-race-${opts.recorded}.json`),
            JSON.stringify(shiftTracker(rec.tracker, shiftMs))
        );
    const app = fakeApp({dataDir, selfPaths: opts.selfName ? {name: opts.selfName} : {}});
    if (opts.resources) Object.assign(app.resources, opts.resources); // e.g. named waypoints
    // opts.fetchFor(shiftMs, tracker): a fake feed of the race's tracker data on the same
    // shifted clock (test/sim/cyca-sim.js).
    const fetch = opts.fetchFor ? opts.fetchFor(shiftMs, rec.tracker) : opts.fetch || noFetch;
    const plugin = createPlugin(app, {fetch});
    plugin.registerWithRouter(app.pluginRouter);
    plugin.signalKApiRoutes(app.apiRouter);
    plugin.start(opts.config || {});

    // Static data first, the name in the N2K PGN 129809 form (path '' with value {name}),
    // and the ship type as PGN 129810 maps it (design.aisShipType {id, name}): all sailing.
    for (const [id, name] of sim.names) {
        app.deliver({
            context: 'vessels.urn:mrn:imo:mmsi:' + id,
            updates: [
                {
                    timestamp: new Date(now).toISOString(),
                    values: [
                        {path: '', value: {name}},
                        {path: 'design.aisShipType', value: {id: 36, name: 'Sailing'}}
                    ]
                }
            ]
        });
    }

    // Interleave own samples and competitor reports in time order, up to "now".
    // opts.wind: our instruments' true wind with each own sample (made up for GC2026).
    const events = [
        ...sim.own.filter((s) => s.t <= now).map((s) => ({t: s.t, d: toDelta(app.selfContext, s)})),
        ...(opts.wind
            ? sim.own
                  .filter((s) => s.t <= now && s.twdRad != null)
                  .map((s) => ({t: s.t, d: windDelta(app.selfContext, s.t, s.twdRad)}))
            : []),
        ...sim.reports
            .filter((r) => r.t <= now)
            .map((r) => ({t: r.t, d: toDelta('vessels.urn:mrn:imo:mmsi:' + r.boatId, r)}))
    ].sort((a, b) => a.t - b.t);
    for (const e of events) app.deliver(e.d);
    // The nav PC's next point (the finish), as an RMB sentence, unless a test opts out.
    if (opts.rmb !== false && sim.finish) app.deliver(rmbDelta(app.selfContext, sim.finish, now));
    // signalk-racer's start time, unless a test opts out.
    if (opts.racerStart !== false) {
        app.deliver({
            context: app.selfContext,
            updates: [
                {
                    timestamp: new Date(now).toISOString(),
                    values: [{path: 'navigation.racing.startTime', value: new Date(RACE_START + shiftMs).toISOString()}]
                }
            ]
        });
    }
    await sleep(300); // let the coalescer flush the last report per context
    return {app, plugin, sim, now, dataDir, shiftMs, fetch, tracker: rec.tracker};
}

module.exports = {replayTo};
