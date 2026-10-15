'use strict';
/*
 * Minimal stand-in for the signalk-server app object, enough to run the plugin.
 * Deltas are split into one value per delivery, as the real subscription manager
 * does (signalk-server src/subscriptionmanager.ts, per-path buses).
 */

function fakeApp({dataDir, selfId = 'urn:mrn:imo:mmsi:503999999', selfPaths = {}}) {
    const subs = [];
    const routes = {};
    const names = new Map(); // context -> name, as the full data model would hold it
    const app = {
        selfId,
        selfContext: 'vessels.' + selfId,
        statusMessages: [],
        errors: [],
        getDataDirPath: () => dataDir,
        getSelfPath: (p) => selfPaths[p],
        // Only vessel names are modelled: enough for the AIS adapter's name lookup.
        getPath: (p) => {
            const m = /^vessels\.(.+)\.name$/.exec(p);
            return m ? names.get('vessels.' + m[1]) : undefined;
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
                    const one = {context: ctx, updates: [{...u, values: [v]}]};
                    for (const s of subs) {
                        const ctxOk =
                            s.pattern.test(ctx) || (s.cmd.context === 'vessels.self' && ctx === app.selfContext);
                        if (ctxOk && s.paths.has(v.path)) s.cb(one);
                    }
                }
            }
        },
        router: {
            get: (p, h) => {
                routes['GET ' + p] = h;
            },
            put: (p, h) => {
                routes['PUT ' + p] = h;
            }
        },
        /** Invoke a registered route; resolves with {status, body}. */
        async call(method, p, {params = {}, query = {}, body} = {}) {
            const h = routes[method + ' ' + p];
            if (!h) throw new Error('no route ' + method + ' ' + p);
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
                Promise.resolve(h({params, query, body}, res)).catch((e) =>
                    resolve({status: 500, body: {error: e.message}})
                );
            });
        },
        subscriptionCount: () => subs.length,
        routeKeys: () => Object.keys(routes)
    };
    return app;
}

module.exports = {fakeApp};
