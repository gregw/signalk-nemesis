'use strict';
/*
 * Feeds the seeded AIS simulation of the GC2026 race into a running Signal K
 * server over its WebSocket stream, as Signal K deltas. The server accepts
 * client deltas when security is off (signalk-server dist/interfaces/ws.js
 * processUpdates).
 *
 * Recorded times are shifted so that `hoursIn` after the start is now. History
 * up to now is sent as fast as the socket allows; with --live it then keeps
 * sending in real time.
 *
 *   node test/sim/live-feed.js [--url ws://127.0.0.1:3000] [--hours 6] [--live]
 *
 * Names are sent the way N2K PGN 129809 maps them: path '' with value {name}
 * (n2k-signalk pgns/129809.js).
 */

const {simulate, toDelta} = require('./ais-sim');
const data = require('../data/gc2026-tracks.json');

function parseArgs(argv) {
    const a = {url: 'ws://127.0.0.1:3000', hours: 6, live: false, selfContext: null};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--url') a.url = argv[++i];
        else if (argv[i] === '--hours') a.hours = Number(argv[++i]);
        else if (argv[i] === '--live') a.live = true;
        else if (argv[i] === '--self') a.selfContext = argv[++i];
    }
    return a;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const now = Date.now();
    const shiftMs = now - (Date.parse(data.race.start) + args.hours * 3600e3);
    const sim = simulate(data, {receiverName: 'Kanreki', seed: 11, shiftMs});

    // Own deltas go to the server's self context; 'vessels.self' is accepted by handleMessage.
    const selfContext = args.selfContext || 'vessels.self';
    const events = [
        ...sim.own.map((s) => ({t: s.t, d: toDelta(selfContext, s)})),
        ...sim.reports.map((r) => ({t: r.t, d: toDelta('vessels.urn:mrn:imo:mmsi:' + r.boatId, r)}))
    ].sort((a, b) => a.t - b.t);

    const ws = new WebSocket(args.url.replace(/\/$/, '') + '/signalk/v1/stream?subscribe=none');
    await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = (e) => reject(new Error('WebSocket error ' + (e.message || '')));
    });
    const send = (d) => ws.send(JSON.stringify(d));

    for (const [id, name] of sim.names) {
        send({
            context: 'vessels.urn:mrn:imo:mmsi:' + id,
            updates: [{timestamp: new Date(now).toISOString(), values: [{path: '', value: {name}}]}]
        });
    }
    let i = 0;
    for (; i < events.length && events[i].t <= now; i++) send(events[i].d);
    console.log(`sent ${i} history deltas up to now`);

    if (!args.live) {
        // Let the socket drain before closing.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        ws.close();
        return;
    }
    console.log('live: sending in real time, Ctrl-C to stop');
    for (; i < events.length; i++) {
        const wait = events[i].t - Date.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        send(events[i].d);
    }
    ws.close();
}

main().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
