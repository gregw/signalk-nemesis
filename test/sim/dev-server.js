'use strict';
/*
 * Minimal HTTP server standing in for signalk-server in browser tests:
 *  - serves public/ at /signalk-nemesis/ (as src/interfaces/webapps.js does)
 *  - dispatches /plugins/signalk-nemesis/* to the plugin's registered routes
 * `setDown(true)` makes every request fail with 503, to simulate a server restart.
 *
 * Run standalone for manual poking: node test/sim/dev-server.js [port] [hoursIn]
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {replayTo} = require('./replay');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const TYPES = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.png': 'image/png',
    '.svg': 'image/svg+xml'
};

function matchRoute(app, method, p) {
    for (const key of app.routeKeys()) {
        const [m, pattern] = key.split(' ');
        if (m !== method) continue;
        const names = [];
        const re = new RegExp(
            '^' +
                pattern.replace(/:(\w+)/g, (_, n) => {
                    names.push(n);
                    return '([^/]+)';
                }) +
                '$'
        );
        const hit = re.exec(p);
        if (hit) return {pattern, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(hit[i + 1])]))};
    }
    return null;
}

async function startDevServer({port = 0, hoursIn = 6, replay} = {}) {
    const r = replay || (await replayTo(hoursIn));
    let down = false;
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        if (down) {
            res.writeHead(503);
            return res.end();
        }
        if (url.pathname.startsWith('/plugins/signalk-nemesis/')) {
            const sub = url.pathname.slice('/plugins/signalk-nemesis'.length);
            const route = matchRoute(r.app, req.method, sub);
            if (!route) {
                res.writeHead(404);
                return res.end();
            }
            let raw = '';
            req.on('data', (c) => {
                raw += c;
            });
            req.on('end', async () => {
                let body;
                try {
                    body = raw ? JSON.parse(raw) : undefined;
                } catch (e) {
                    res.writeHead(400);
                    return res.end();
                }
                const out = await r.app.call(req.method, route.pattern, {
                    params: route.params,
                    query: Object.fromEntries(url.searchParams),
                    body
                });
                res.writeHead(out.status, {'Content-Type': 'application/json'});
                res.end(JSON.stringify(out.body));
            });
            return;
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
        setDown(v) {
            down = v;
        },
        async close() {
            r.plugin.stop();
            await new Promise((resolve) => server.close(resolve));
        }
    };
}

module.exports = {startDevServer};

if (require.main === module) {
    startDevServer({port: Number(process.argv[2] || 3300), hoursIn: Number(process.argv[3] || 6)}).then((s) =>
        console.log('webapp at', s.url)
    );
}
