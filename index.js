'use strict';
/*
 * Nemesis Delta: Signal K server plugin entry point.
 *
 * Layers (keep them distinct):
 *  - Data model paths consumed: other vessels' navigation.position,
 *    courseOverGroundTrue, speedOverGround, name; our own position, COG, SOG,
 *    headingTrue; navigation.courseRhumbline.nextPoint.position (waypoint seam);
 *    navigation.racing.startTime from signalk-racer (start time seam).
 *  - Data model paths published: none yet (brief section 8, Greg's call).
 *  - REST endpoints (read only): /plugins/<id>/* and /signalk/v1/api/nemesis/*.
 *  - PUT handlers (writes): navigation.racing.nemesis.setNemesis, .setTcf, .setStartTime.
 *  - Internal plugin state: TrackStore, OwnState, UserState.
 *
 * The webapp in public/ is served by the server at /<package name>/
 * (signalk-server src/interfaces/webapps.js).
 */

const {TrackStore} = require('./lib/track-store');
const {OwnState} = require('./lib/own-state');
const {AisSourceAdapter, OwnAdapter} = require('./lib/ais-adapter');
const {makeWaypointSource} = require('./lib/waypoint');
const {UserState, validTcf} = require('./lib/user-state');
const {buildSnapshot, buildTracks} = require('./lib/snapshot');
const {StartTime, RacerStartAdapter} = require('./lib/start-time');

const PLUGIN_ID = 'signalk-nemesis';
const API_PREFIX = '/nemesis';
// PUT handler paths, under our own name within signalk-racer's navigation.racing group.
const PUT_PATHS = {
    setNemesis: 'navigation.racing.nemesis.setNemesis',
    setTcf: 'navigation.racing.nemesis.setTcf',
    setStartTime: 'navigation.racing.nemesis.setStartTime'
};
const MAX_PERIOD_MS = 24 * 3600e3;

const schema = {
    title: 'Nemesis Delta',
    type: 'object',
    properties: {
        staleSeconds: {
            type: 'number',
            title: 'Stale after (seconds without a report)',
            default: 1800,
            minimum: 60
        },
        historySeconds: {
            type: 'number',
            title: 'Track history kept per boat (seconds)',
            default: 21600,
            minimum: 600
        },
        maxReportsPerBoat: {
            type: 'number',
            title: 'Maximum reports kept per boat',
            default: 2000,
            minimum: 10
        },
        maxBoats: {
            type: 'number',
            title: 'Maximum boats tracked',
            default: 500,
            minimum: 1
        },
        ownSampleSeconds: {
            type: 'number',
            title: 'Minimum interval between stored own-state samples (seconds)',
            default: 1,
            minimum: 0.1
        },
        maxRaceHours: {
            type: 'number',
            title: 'Ignore a start time older than this (hours)',
            description: "Stops a previous race's start time feeding the TCF numbers of the next race",
            default: 96,
            minimum: 1
        },
        waypoint: {
            type: 'object',
            title: 'Fallback waypoint, used when the course API has no next point',
            properties: {
                lat: {type: 'number', title: 'Latitude (decimal degrees)'},
                lon: {type: 'number', title: 'Longitude (decimal degrees)'}
            }
        }
    }
};

module.exports = function (app) {
    const plugin = {
        id: PLUGIN_ID,
        name: 'Nemesis Delta',
        description: 'Track how your nemesis boats are sailing relative to you',
        schema
    };

    let state = null; // everything created in start(), dropped in stop()

    plugin.start = function (options) {
        const cfg = withDefaults(options);
        const store = new TrackStore({
            maxReportsPerBoat: cfg.maxReportsPerBoat,
            maxSpanMs: cfg.historySeconds * 1000,
            maxBoats: cfg.maxBoats
        });
        const own = new OwnState({minIntervalMs: cfg.ownSampleSeconds * 1000, maxSpanMs: cfg.historySeconds * 1000});
        const userState = new UserState(app.getDataDirPath(), (e) => app.error(`Saving state failed: ${e.message}`));
        const ais = new AisSourceAdapter(
            app,
            (r) => store.add(r),
            (id, name) => store.setName(id, name)
        );
        const ownAdapter = new OwnAdapter(app, (s) => own.add(s));
        const startTime = new StartTime({
            dataDir: app.getDataDirPath(),
            maxRaceMs: cfg.maxRaceHours * 3600e3,
            onError: (e) => app.error(`Saving start time failed: ${e.message}`)
        });
        const racerStart = new RacerStartAdapter(app, startTime);

        state = {
            cfg,
            store,
            own,
            userState,
            waypoint: makeWaypointSource(app, cfg),
            ais,
            ownAdapter,
            startTime,
            racerStart,
            // Live clock. The replay harness shifts recorded times to wall-clock time.
            clock: () => Date.now()
        };
        ais.start();
        ownAdapter.start();
        racerStart.start();
        registerPutHandlers();
        app.setPluginStatus('Started');
    };

    plugin.stop = function () {
        if (!state) return;
        try {
            state.ais.stop();
        } catch (e) {
            app.debug(e);
        }
        for (const a of [state.ownAdapter, state.racerStart]) {
            try {
                a.stop();
            } catch (e) {
                app.debug(e);
            }
        }
        state = null;
    };

    /*
     * Writes are Signal K PUT handlers, as in signalk-racer: reachable over the
     * WebSocket or as REST PUT /signalk/v1/api/vessels/self/<path> with body {value}.
     * The server checks write permission (signalk-server 2.30.0 dist/put.js
     * shouldAllowPut). A plugin router PUT under /signalk/v1/api cannot work: the
     * server's own data model PUT route is registered first and answers 400.
     */
    function registerPutHandlers() {
        app.registerPutHandler('vessels.self', PUT_PATHS.setNemesis, (ctx, path, value) =>
            command(() => {
                if (!value || typeof value.id !== 'string' || typeof value.nemesis !== 'boolean')
                    return complete(400, 'value must be {id: string, nemesis: boolean}');
                return state.userState.setNemesis(value.id, value.nemesis).then(() => complete(200, 'OK'));
            })
        );
        app.registerPutHandler('vessels.self', PUT_PATHS.setTcf, (ctx, path, value) =>
            command(() => {
                if (!value || typeof value.id !== 'string' || !validTcf(value.tcf))
                    return complete(400, 'value must be {id: string, tcf: number in (0, 3]}');
                return state.userState.setTcf(value.id, value.tcf).then(() => complete(200, 'OK'));
            })
        );
        // value {startTime: RFC 3339 string} sets the override; {startTime: null} clears it.
        app.registerPutHandler('vessels.self', PUT_PATHS.setStartTime, (ctx, path, value) =>
            command(() => {
                if (!value || !('startTime' in value)) return complete(400, 'value must be {startTime: string|null}');
                try {
                    return state.startTime.setOverride(value.startTime).then(() => complete(200, 'OK'));
                } catch (e) {
                    return complete(400, e.message);
                }
            })
        );
    }

    // Runs a PUT command; never throws into the server, and refuses when stopped.
    function command(fn) {
        if (!state) return complete(503, 'plugin not running');
        try {
            return Promise.resolve(fn()).catch((e) => complete(500, e.message));
        } catch (e) {
            return complete(500, e.message);
        }
    }

    function complete(statusCode, message) {
        return {state: 'COMPLETED', statusCode, message};
    }

    /*
     * Read-only REST handlers are mounted twice:
     *  - /plugins/signalk-nemesis/* via registerWithRouter. With security on, the server
     *    puts all of /plugins behind admin-only middleware (signalk-server 2.30.0
     *    dist/tokensecurity.js, app.use('/plugins', adminAuthenticationMiddleware)).
     *  - /signalk/v1/api/nemesis/* via signalKApiRoutes (dist/interfaces/plugins.js).
     *    There GET needs read access and PUT needs readwrite (tokensecurity.js
     *    app.put('/signalk/v1/*', writeAuthenticationMiddleware)), so crew devices
     *    with ordinary accounts can use the webapp.
     */
    plugin.registerWithRouter = function (router) {
        addRoutes(router, '');
    };

    plugin.signalKApiRoutes = function (router) {
        addRoutes(router, API_PREFIX);
        return router;
    };

    function addRoutes(router, prefix) {
        // Handlers read `state` on each request: the router outlives start/stop cycles.
        const running = (res) => {
            if (state) return state;
            res.status(503).json({error: 'plugin not running'});
            return null;
        };

        router.get(prefix + '/snapshot', (req, res) => {
            const s = running(res);
            if (!s) return;
            res.json(
                buildSnapshot({
                    store: s.store,
                    own: s.own,
                    userState: s.userState,
                    waypoint: s.waypoint(),
                    start: s.startTime.get(),
                    staleMs: s.cfg.staleSeconds * 1000,
                    now: s.clock()
                })
            );
        });

        router.get(prefix + '/tracks', (req, res) => {
            const s = running(res);
            if (!s) return;
            const periodS = Number(req.query.periodS ?? 3600);
            if (!Number.isFinite(periodS) || periodS < 0) return res.status(400).json({error: 'bad periodS'});
            const ids = typeof req.query.ids === 'string' && req.query.ids ? new Set(req.query.ids.split(',')) : null;
            res.json(
                buildTracks({
                    store: s.store,
                    own: s.own,
                    now: s.clock(),
                    periodMs: Math.min(periodS * 1000, MAX_PERIOD_MS),
                    ids
                })
            );
        });

        router.get(prefix + '/user', (req, res) => {
            const s = running(res);
            if (s) res.json(s.userState.toJSON());
        });
    }

    return plugin;
};

function withDefaults(options) {
    const o = options || {};
    const d = (k) => (Number.isFinite(o[k]) ? o[k] : schema.properties[k].default);
    return {
        staleSeconds: d('staleSeconds'),
        historySeconds: d('historySeconds'),
        maxReportsPerBoat: d('maxReportsPerBoat'),
        maxBoats: d('maxBoats'),
        ownSampleSeconds: d('ownSampleSeconds'),
        maxRaceHours: d('maxRaceHours'),
        waypoint: o.waypoint || null
    };
}

module.exports.PLUGIN_ID = PLUGIN_ID;
module.exports.API_PREFIX = API_PREFIX;
module.exports.PUT_PATHS = PUT_PATHS;
module.exports.withDefaults = withDefaults;
