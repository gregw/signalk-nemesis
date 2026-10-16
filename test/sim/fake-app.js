'use strict';
/*
 * Minimal stand-in for the signalk-server app object, enough to run the plugin.
 * Deltas are split into one value per delivery, as the real subscription manager
 * does (signalk-server src/subscriptionmanager.ts, per-path buses).
 */

function fakeApp({dataDir, selfId = 'urn:mrn:imo:mmsi:503999999', selfPaths = {}}) {
    const subs = [];
    const routes = []; // {method, path, handler}
    const putHandlers = new Map();
    const mount = (prefix) => ({
        get: (p, h) => routes.push({method: 'GET', path: prefix + p, handler: h}),
        put: (p, h) => routes.push({method: 'PUT', path: prefix + p, handler: h})
    });
    const names = new Map(); // context -> name, as the full data model would hold it
    const shipTypes = new Map(); // context -> {id, name}
    const app = {
        selfId,
        selfContext: 'vessels.' + selfId,
        statusMessages: [],
        errors: [],
        getDataDirPath: () => dataDir,
        getSelfPath: (p) => selfPaths[p],
        // Only vessel names and AIS ship types are modelled: enough for the AIS adapter's lookup.
        getPath: (p) => {
            const m = /^vessels\.(.+)\.name$/.exec(p);
            if (m) return names.get('vessels.' + m[1]);
            const t = /^(vessels\..+)\.design\.aisShipType$/.exec(p);
            // A leaf as the full model holds it: {value, $source, timestamp}.
            return t && shipTypes.has(t[1]) ? {value: shipTypes.get(t[1])} : undefined;
        },
        // Course API and resources API stand-ins; tests assign course/resources directly.
        course: null,
        resources: {waypoints: {}, routes: {}},
        getCourse: async () => {
            if (app.course instanceof Error) throw app.course;
            return app.course;
        },
        resourcesApi: {
            listResources: async (type) => app.resources[type] || {},
            getResource: async (type, id) => {
                const r = (app.resources[type] || {})[id];
                if (!r) throw new Error('not found');
                return r;
            }
        },
        setPluginStatus: (m) => app.statusMessages.push(m),
        error: (m) => app.errors.push(m),
        debug: () => {},
        subscriptionmanager: {
            subscribe(cmd, unsubscribes, errCb, cb) {
                const pattern = new RegExp('^' + cmd.context.replace('.', '\\.').replace('*', '.*') + '$');
                const paths = new Set(cmd.subscribe.map((s) => s.path));
                const sub = {cmd, pattern, paths, cb};
                subs.push(sub);
                unsubscribes.push(() => subs.splice(subs.indexOf(sub), 1));
            }
        },
        /** Deliver a delta as the server would: per value, to matching subscriptions. */
        deliver(delta) {
            const ctx = delta.context;
            for (const u of delta.updates) {
                for (const v of u.values) {
                    if (v.path === 'name' && typeof v.value === 'string') names.set(ctx, v.value);
                    if (v.path === '' && v.value && typeof v.value.name === 'string') names.set(ctx, v.value.name);
                    if (v.path === 'design.aisShipType' && v.value) shipTypes.set(ctx, v.value);
                    const one = {context: ctx, updates: [{...u, values: [v]}]};
                    for (const s of subs) {
                        const ctxOk =
                            s.pattern.test(ctx) || (s.cmd.context === 'vessels.self' && ctx === app.selfContext);
                        if (ctxOk && s.paths.has(v.path)) s.cb(one);
                    }
                }
            }
        },
        // The two mounts the real server gives a plugin (dist/interfaces/plugins.js).
        pluginRouter: mount('/plugins/signalk-nemesis'),
        apiRouter: mount('/signalk/v1/api'),
        registerPutHandler(context, path, handler) {
            putHandlers.set(context + '/' + path, handler);
        },
        /**
         * A PUT as the server's REST route makes it: PUT /signalk/v1/api/vessels/self/<path>
         * with body {value} (dist/put.js). Resolves with {status, body: reply}.
         */
        async put(path, value) {
            const h = putHandlers.get('vessels.self/' + path);
            if (!h) return {status: 405, body: {state: 'COMPLETED', statusCode: 405}};
            const reply = await h('vessels.self', path, value, () => {});
            return {status: reply.statusCode, body: reply};
        },
        /** Invoke a GET route by full path; resolves with {status, body}. */
        async call(method, fullPath, {query = {}, body} = {}) {
            const r = matchRoute(routes, method, fullPath);
            if (!r) return {status: 404, body: {error: 'no route ' + method + ' ' + fullPath}};
            return new Promise((resolve) => {
                const res = {
                    statusCode: 200,
                    status(c) {
                        this.statusCode = c;
                        return this;
                    },
                    json(b) {
                        resolve({status: this.statusCode, body: b});
                    }
                };
                Promise.resolve(r.handler({params: r.params, query, body}, res)).catch((e) =>
                    resolve({status: 500, body: {error: e.message}})
                );
            });
        },
        subscriptionCount: () => subs.length
    };
    return app;
}

function matchRoute(routes, method, fullPath) {
    for (const r of routes) {
        if (r.method !== method) continue;
        const names = [];
        const re = new RegExp(
            '^' +
                r.path.replace(/:(\w+)/g, (_, n) => {
                    names.push(n);
                    return '([^/]+)';
                }) +
                '$'
        );
        const hit = re.exec(fullPath);
        if (hit) {
            const params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(hit[i + 1])]));
            return {handler: r.handler, params};
        }
    }
    return null;
}

module.exports = {fakeApp};
