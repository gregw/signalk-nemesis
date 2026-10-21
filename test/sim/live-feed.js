'use strict';
/*
 * Feeds a recorded race (GC2026, or --race tollgate2026; see races.js) into a running
 * Signal K server over its WebSocket stream, as Signal K deltas: our own state and wind,
 * and the fleet as simulated AIS. The server accepts
 * client deltas when security is off, or from a user with readwrite or admin
 * permission (signalk-server 2.18 src/interfaces/ws.js processUpdates,
 * src/tokensecurity.js shouldAllowWrite). With --user the password is prompted
 * for (or read from piped stdin), a token is fetched from POST
 * /signalk/v1/auth/login and passed as ?token= on the stream (tokensecurity.js
 * authorizeWS). For a local test server only: it sends our own position and an
 * RMB, which would mix with real instruments on a boat.
 *
 * Recorded times are shifted so that `hoursIn` after the start is now. History
 * up to now is sent as fast as the socket allows; with --live it then keeps
 * sending in real time.
 *
 *   node test/sim/live-feed.js [--race gc2026|tollgate2026] [--url ws://127.0.0.1:3000]
 *       [--hours 6] [--live] [--user name] [--tracker-file path]
 *
 * GC2026's finish is sent as an RMB-style next point, as the nav PC would (Tollgate's
 * course is out and back: none is sent). Tollgate's own heading is Kanreki's logged HDG,
 * sent as navigation.headingTrue: the log's TWD is its HDG + TWA (median difference 0.1
 * deg over 16 Oct), so HDG is referenced to true north like TWD.
 *
 * --tracker-file writes the race's tracker data, shifted to the same clock, as a recorded
 * race file (lib/recorded-race.js) for the plugin to offer on the CYCA tab. Name it
 * recorded-race-<key>.json in the plugin's data dir, e.g.
 * /var/lib/signalk/plugin-config-data/signalk-nemesis/recorded-race-tollgate.json.
 * Written to a temp file and renamed, so the plugin never reads half of it.
 * Names are sent the way N2K PGN 129809 maps them: path '' with value {name}
 * (n2k-signalk pgns/129809.js).
 * Our boat is Kanreki (MMSI 503029690); its data goes to vessels.self, or --self.
 */

const {toDelta, rmbDelta, windDelta} = require('./ais-sim');
const fs = require('node:fs');
const {race, shiftTracker} = require('./races');

function parseArgs(argv) {
    const a = {race: 'gc2026', url: 'ws://127.0.0.1:3000', hours: 6, live: false, selfContext: null, user: null};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--race') a.race = argv[++i];
        else if (argv[i] === '--url') a.url = argv[++i];
        else if (argv[i] === '--hours') a.hours = Number(argv[++i]);
        else if (argv[i] === '--live') a.live = true;
        else if (argv[i] === '--self') a.selfContext = argv[++i];
        else if (argv[i] === '--user') a.user = argv[++i];
        else if (argv[i] === '--tracker-file') a.trackerFile = argv[++i];
        else throw new Error(`unknown argument ${argv[i]}`); // a mistyped option is not ignored
    }
    return a;
}

/** Reads a password: hidden typing on a terminal, else the first line of stdin. */
function readPassword(prompt) {
    if (!process.stdin.isTTY) {
        return new Promise((resolve, reject) => {
            let text = '';
            process.stdin.setEncoding('utf8');
            process.stdin.on('data', (c) => (text += c));
            process.stdin.on('end', () => {
                const line = text.split(/\r?\n/)[0];
                if (line) resolve(line);
                else reject(new Error('no password on stdin'));
            });
        });
    }
    process.stderr.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    return new Promise((resolve, reject) => {
        let pw = '';
        const done = (fn) => {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.removeListener('data', onData);
            process.stderr.write('\n');
            fn();
        };
        const onData = (chunk) => {
            for (const c of chunk) {
                if (c === '\r' || c === '\n') return done(() => resolve(pw));
                if (c === '\u0003') return done(() => reject(new Error('cancelled')));
                if (c === '\u007f' || c === '\b') pw = pw.slice(0, -1);
                else pw += c;
            }
        };
        stdin.on('data', onData);
    });
}

/** Logs in and returns a token (signalk-server tokensecurity.js POST /signalk/v1/auth/login). */
async function login(wsUrl, username, password) {
    const http = wsUrl.replace(/^ws/, 'http').replace(/\/$/, '');
    const res = await fetch(http + '/signalk/v1/auth/login', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({username, password})
    });
    const body = await res.json().catch(() => ({}));
    if (res.status !== 200 || !body.token) throw new Error(`login failed: ${res.status} ${body.message || ''}`.trim());
    return body.token;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const now = Date.now();
    const rec = race(args.race);
    // Whole seconds, rounded down: the feed's times (a recorded race's start) carry no
    // milliseconds, and no recorded time may land after now.
    const shiftMs = Math.floor((now - (rec.start + args.hours * 3600e3)) / 1000) * 1000;
    const sim = rec.play(shiftMs);
    if (args.trackerFile) {
        writeAtomic(args.trackerFile, JSON.stringify(shiftTracker(rec.tracker, shiftMs)));
        console.log(`wrote ${args.trackerFile}: pick it on the CYCA tab (refresh the race list)`);
    }

    // Own deltas go to the server's self context; 'vessels.self' is accepted by handleMessage.
    const selfContext = args.selfContext || 'vessels.self';
    const events = [
        ...sim.own.map((s) => ({t: s.t, d: ownDelta(selfContext, s)})),
        // Our true wind with each own sample (made up for GC2026: its recording has none).
        ...sim.own.filter((s) => s.twdRad != null).map((s) => ({t: s.t, d: windDelta(selfContext, s.t, s.twdRad)})),
        ...sim.reports.map((r) => ({t: r.t, d: toDelta('vessels.urn:mrn:imo:mmsi:' + r.boatId, r)}))
    ].sort((a, b) => a.t - b.t);

    let query = 'subscribe=none';
    if (args.user) {
        const token = await login(args.url, args.user, await readPassword(`password for ${args.user}: `));
        query += '&token=' + encodeURIComponent(token);
        console.log(`logged in as ${args.user}`);
    }
    const ws = new WebSocket(args.url.replace(/\/$/, '') + '/signalk/v1/stream?' + query);
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
    // The nav PC's next point (the finish) as RMB, the way Expedition would send it.
    const finish = sim.finish;
    if (finish) send(rmbDelta(selfContext, finish, now));
    let i = 0;
    for (; i < events.length && events[i].t <= now; i++) send(events[i].d);
    console.log(`sent ${i} history deltas up to now`);
    if (!args.user) console.log('nothing showing? with security on the server drops these: use --user');

    if (!args.live) {
        // Let the socket drain before closing.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        ws.close();
        return;
    }
    console.log('live: sending in real time, Ctrl-C to stop');
    if (finish) setInterval(() => send(rmbDelta(selfContext, finish, Date.now())), 2000);
    for (; i < events.length; i++) {
        const wait = events[i].t - Date.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        send(events[i].d);
    }
    ws.close();
}

function writeAtomic(file, text) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
}

/** Our own state: position, COG and SOG, and the heading where the recording has one. */
function ownDelta(context, s) {
    const d = toDelta(context, s);
    if (s.hdgRad != null) d.updates[0].values.push({path: 'navigation.headingTrue', value: s.hdgRad});
    return d;
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e.message);
        process.exit(1);
    });
}

module.exports = {parseArgs, login, ownDelta};
