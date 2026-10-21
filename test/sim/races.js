'use strict';
/*
 * The recorded races the replay and the live feed can play, each as our own samples, the
 * fleet's AIS reports and the tracker feed's data, on a clock shifted so that `hoursIn`
 * after the start is `now`.
 *
 *  - gc2026: Noakes Sydney Gold Coast 2026 from the CYCA feed's 10 minute slots. Our own
 *    state is Kanreki's slots interpolated per minute; the wind is made up (simTwdRad).
 *  - tollgate2026: Tollgate Islands Race 2026, 02:50 to 13:00Z 16 Oct (start 06:00Z). Our
 *    own state and wind are Kanreki's Expedition log, at its rate; the fleet's AIS is
 *    simulated from its YB fixes (fleet-sim.js); the tracker feed is those fixes on the
 *    CYCA slot grid, played as a recorded race file (lib/recorded-race.js). No finish
 *    point is sent: the course is out and back.
 */
const {simulate, finishOf, simTwdRad} = require('./ais-sim');
const {simulateFleet, ownFromLog, trackerSlots} = require('./fleet-sim');

const RACES = {
    gc2026: () => {
        const data = require('../data/gc2026-tracks.json');
        return {
            start: Date.parse(data.race.start),
            play(shiftMs) {
                const sim = simulate(data, {receiverName: 'Kanreki', seed: 11, shiftMs});
                return {
                    ...sim,
                    own: sim.own.map((s) => ({...s, twdRad: simTwdRad(s.t - shiftMs)})),
                    finish: finishOf(data)
                };
            },
            tracker: data
        };
    },
    tollgate2026: () => {
        const fleet = require('../data/tollgate2026-yb.json');
        const log = require('../data/tollgate2026-kanreki.json');
        return {
            start: Date.parse(fleet.race.start),
            play(shiftMs) {
                const {reports, names} = simulateFleet(fleet, ownFromLog(log), {
                    seed: 11,
                    ownMmsi: log.mmsi,
                    shiftMs
                });
                return {own: ownFromLog(log, shiftMs), reports, names, ownMmsi: log.mmsi, finish: null};
            },
            tracker: trackerSlots(fleet)
        };
    }
};

/**
 * A race's tracker data with every time shifted, as a recorded race file's JSON
 * (lib/recorded-race.js), so the plugin plays it on the same clock as the replay.
 */
function shiftTracker(tracker, shiftMs) {
    const sh = (iso) => new Date(Date.parse(iso) + shiftMs).toISOString();
    return {
        ...tracker,
        race: {...tracker.race, start: sh(tracker.race.start), timeZone: tracker.race.timeZone || 'Australia/Sydney'},
        boats: tracker.boats.map((b) => ({...b, samples: b.samples.map(([t, ...rest]) => [sh(t), ...rest])}))
    };
}

/** @param {string} name a key of RACES */
function race(name = 'gc2026') {
    const make = RACES[name];
    if (!make) throw new Error(`unknown race ${name}: ${Object.keys(RACES).join(', ')}`);
    return make();
}

module.exports = {race, shiftTracker, RACES};
