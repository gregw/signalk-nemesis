'use strict';
/*
 * Minimal HTTP server standing in for signalk-server in browser tests:
 *  - serves public/ at /signalk-nemesis/ (as src/interfaces/webapps.js does)
 *  - dispatches GET /plugins/signalk-nemesis/* and /signalk/v1/api/* to the plugin's routes
 *  - dispatches PUT /signalk/v1/api/vessels/self/<path> to the plugin's PUT handlers
 * `setFail(503)` makes every request fail with that status (503: server restarting,
 * 401: security on and not logged in); `setFail(null)` restores service.
 *
 * Run standalone for manual poking: node test/sim/dev-server.js [port] [hoursIn] [race]
 * Standalone, it also serves the race's tracker data as a fake CYCA feed (cyca-sim.js):
 * pick the race on the CYCA tab.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {replayTo} = require('./replay');
const {rmbDelta} = require('./ais-sim');
const {cycaFeed} = require('./cyca-sim');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const TYPES = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.png': 'image/png',
    '.svg': 'image/svg+xml'
};

async function startDevServer({port = 0, hoursIn = 6, replay, config, resources, replayOpts = {}} = {}) {
    const r = replay || (await replayTo(hoursIn, {config, resources, wind: true, ...replayOpts}));
    let failWith = null; // HTTP status every request fails with, or null
    // Keep the nav PC's RMB next point coming, as the live feed does, or it goes stale.
    const finish = r.sim.finish;
    const rmbTimer = setInterval(() => finish && r.app.deliver(rmbDelta(r.app.selfContext, finish, Date.now())), 5000);
    rmbTimer.unref();
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        if (failWith) {
            res.writeHead(failWith);
            return res.end();
        }
        const PUT_PREFIX = '/signalk/v1/api/vessels/self/';
        if (req.method === 'PUT' && url.pathname.startsWith(PUT_PREFIX)) {
            return readBody(req, res, async (body) => {
                // As dist/put.js: body must carry {value}; reply status is reply.statusCode.
                if (!body || body.value === undefined) return send(res, 400, 'input is missing a value');
                const out = await r.app.put(url.pathname.slice(PUT_PREFIX.length).replace(/\//g, '.'), body.value);
                send(res, out.status, out.body);
            });
        }
        if (req.method === 'GET' && (url.pathname.startsWith('/plugins/') || url.pathname.startsWith('/signalk/'))) {
            return r.app
                .call('GET', url.pathname, {query: Object.fromEntries(url.searchParams)})
                .then((out) => send(res, out.status, out.body));
        }
        if (url.pathname.startsWith('/signalk-nemesis/')) {
            let rel = url.pathname.slice('/signalk-nemesis/'.length) || 'index.html';
            const file = path.join(PUBLIC, path.normalize(rel));
            if (!file.startsWith(PUBLIC)) {
                res.writeHead(403);
                return res.end();
            }
            return fs.readFile(file, (err, buf) => {
                if (err) {
                    res.writeHead(404);
                    return res.end();
                }
                res.writeHead(200, {'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream'});
                res.end(buf);
            });
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    return {
        ...r,
        url: `http://127.0.0.1:${server.address().port}/signalk-nemesis/`,
        setFail(status) {
            failWith = status;
        },
        async close() {
            clearInterval(rmbTimer);
            r.plugin.stop();
            await new Promise((resolve) => server.close(resolve));
        }
    };
}

function readBody(req, res, cb) {
    let raw = '';
    req.on('data', (c) => {
        raw += c;
    });
    req.on('end', () => {
        let body;
        try {
            body = raw ? JSON.parse(raw) : undefined;
        } catch (e) {
            return send(res, 400, 'bad JSON');
        }
        cb(body);
    });
}

function send(res, status, body) {
    const json = typeof body !== 'string';
    res.writeHead(status, {'Content-Type': json ? 'application/json' : 'text/plain'});
    res.end(json ? JSON.stringify(body) : body);
}

module.exports = {startDevServer};

if (require.main === module) {
    const [port = 3300, hoursIn = 6, race = 'gc2026'] = process.argv.slice(2);
    startDevServer({
        port: Number(port),
        hoursIn: Number(hoursIn),
        replayOpts: {
            race,
            selfName: 'Kanreki',
            fetchFor: (shiftMs, tracker) => cycaFeed({shiftMs, clock: Date.now, data: tracker})
        }
    }).then((s) => console.log('webapp at', s.url));
}
