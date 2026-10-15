'use strict';
/*
 * Shared replay setup: GC2026 recorded race -> seeded AIS simulator -> Signal K
 * deltas (split per path by the fake app) -> a running plugin instance.
 * Recorded times are shifted so that `hoursIn` after the start is wall-clock now.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {setTimeout: sleep} = require('node:timers/promises');
const {simulate, toDelta, finishOf, rmbDelta} = require('./ais-sim');
const {fakeApp} = require('./fake-app');
const createPlugin = require('../../index');
const data = require('../data/gc2026-tracks.json');

const RACE_START = Date.parse(data.race.start);

async function replayTo(hoursIn, opts = {}) {
    const now = Date.now();
    const shiftMs = now - (RACE_START + hoursIn * 3600e3);
    const sim = simulate(data, {receiverName: 'Kanreki', seed: 11, shiftMs});
    const dataDir = opts.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-'));
    const app = fakeApp({dataDir});
    const plugin = createPlugin(app);
    plugin.registerWithRouter(app.pluginRouter);
    plugin.signalKApiRoutes(app.apiRouter);
    plugin.start(opts.config || {});

    // Static data first, in the N2K PGN 129809 form (path '' with value {name}).
    for (const [id, name] of sim.names) {
        app.deliver({
            context: 'vessels.urn:mrn:imo:mmsi:' + id,
            updates: [{timestamp: new Date(now).toISOString(), values: [{path: '', value: {name}}]}]
        });
    }

    // Interleave own samples and competitor reports in time order, up to "now".
    const events = [
        ...sim.own.filter((s) => s.t <= now).map((s) => ({t: s.t, d: toDelta(app.selfContext, s)})),
        ...sim.reports
            .filter((r) => r.t <= now)
            .map((r) => ({t: r.t, d: toDelta('vessels.urn:mrn:imo:mmsi:' + r.boatId, r)}))
    ].sort((a, b) => a.t - b.t);
    for (const e of events) app.deliver(e.d);
    // The nav PC's next point (the finish), as an RMB sentence, unless a test opts out.
    if (opts.rmb !== false) app.deliver(rmbDelta(app.selfContext, finishOf(data), now));
    await sleep(300); // let the coalescer flush the last report per context
    return {app, plugin, sim, now, dataDir};
}

module.exports = {replayTo};
