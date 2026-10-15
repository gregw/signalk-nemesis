'use strict';
/*
 * Nemesis Delta: Signal K server plugin entry point.
 *
 * Layers (keep them distinct):
 *  - Data model paths consumed: other vessels' navigation.position,
 *    courseOverGroundTrue, speedOverGround, name; our own position, COG, SOG,
 *    headingTrue; navigation.courseRhumbline|courseGreatCircle.nextPoint.* (raw NMEA
 *    next point); Course API getCourse() and waypoint/route resources (waypoint seam);
 *    navigation.racing.startTime from signalk-racer (start time seam).
 *  - Data model paths published: none yet (brief section 8, Greg's call).
 *  - REST endpoints (read only): /plugins/<id>/* and /signalk/v1/api/nemesis/*.
 *  - PUT handlers (writes): navigation.racing.nemesis.setNemesis, .setTcf, .setStartTime.
 *  - Internal plugin state: TrackStore, OwnState, UserState, StartTime; track history
 *    journaled to <data dir>/journal so it survives a restart (lib/journal.js).
 *
 * The webapp in public/ is served by the server at /<package name>/
 * (signalk-server src/interfaces/webapps.js).
 */

const path = require('node:path');
const {TrackStore} = require('./lib/track-store');
const {OwnState} = require('./lib/own-state');
const {AisSourceAdapter, OwnAdapter} = require('./lib/ais-adapter');
const {WaypointSource} = require('./lib/waypoint');
const {UserState, validTcf} = require('./lib/user-state');
const {buildSnapshot, buildTracks} = require('./lib/snapshot');
const {StartTime, RacerStartAdapter} = require('./lib/start-time');
const {Journal} = require('./lib/journal');

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
        boats: {
            type: 'array',
            title: 'Nemesis boats, entered in advance',
            description:
                'Each is made a nemesis with its TCF when added, or when its TCF here changes; webapp edits ' +
                'are kept across restarts. The name replaces the AIS name in this plugin only.',
            default: [],
            items: {
                type: 'object',
                required: ['mmsi'],
                properties: {
                    mmsi: {type: 'string', title: 'MMSI', pattern: '^[0-9]{9}$'},
                    name: {type: 'string', title: 'Name'},
                    tcf: {type: 'number', title: 'TCF', exclusiveMinimum: 0, maximum: 3}
                }
            }
        },
        staleSeconds: {
            type: 'number',
            title: 'Stale after (seconds without a report)',
            default: 1800,
            minimum: 60
        },
        historyHours: {
            type: 'number',
            title: 'Track history kept, in memory and on disk (hours)',
            description: 'Default 5 days, for long offshore races. Survives a restart.',
            default: 120,
            minimum: 1
        },
        recentHours: {
            type: 'number',
            title: 'Full resolution window (hours)',
            description:
                'History newer than this keeps every report and our own state at full rate. ' +
                'Older history is thinned to one report per boat per thinning interval.',
            default: 6,
            minimum: 0.25
        },
        thinSeconds: {
            type: 'number',
            title: 'Thinning interval for older history (seconds)',
            default: 120,
            minimum: 10
        },
        maxReportsPerBoat: {
            type: 'number',
            title: 'Maximum reports kept per boat',
            description: 'A hard memory bound on top of the time limits',
            default: 5000,
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
        tcfVmgSeconds: {
            type: 'number',
            title: 'TCF: smooth VMG to the waypoint over this long (seconds)',
            description:
                "The handicap Should distance is the time owed at the trailing boat's VMG, " +
                'measured over this period to ride through tacks and gybes.',
            default: 600,
            minimum: 60
        },
        maxRaceHours: {
            type: 'number',
            title: 'Ignore a start time older than this (hours)',
            description: "Stops a previous race's start time feeding the TCF numbers of the next race",
            default: 96,
            minimum: 1
        },
        waypointOrder: {
            type: 'string',
            title: 'Next waypoint: which source wins when both are available',
            description:
                'The Course API covers Signal K routes and destinations set in Freeboard-SK. ' +
                'NMEA is the next point sent by the instruments or navigation software (RMB, BWC, PGN 129284).',
            enum: ['course,nmea', 'nmea,course'],
            enumNames: ['Course API, then NMEA', 'NMEA, then Course API'],
            default: 'course,nmea'
        },
        nmeaWaypointStaleSeconds: {
            type: 'number',
            title: 'Ignore an NMEA next point not updated for this long (seconds)',
            default: 30,
            minimum: 1
        },
        waypointName: {
            type: 'string',
            title: 'Fallback waypoint name, looked up in the waypoint resources (e.g. one made in Freeboard-SK)',
            description:
                'Used when neither the Course API nor NMEA has a next point. Empty: no fallback, and ' +
                'without a waypoint the waypoint based values (Up = Waypoint, VMC, TCF Should) are not shown.',
            default: 'nemesis'
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
            maxSpanMs: cfg.historyHours * 3600e3,
            maxBoats: cfg.maxBoats
        });
        const own = new OwnState({minIntervalMs: cfg.ownSampleSeconds * 1000, maxSpanMs: cfg.recentHours * 3600e3});
        const journal = new Journal({
            dir: path.join(app.getDataDirPath(), 'journal'),
            retainMs: cfg.historyHours * 3600e3,
            recentMs: cfg.recentHours * 3600e3,
            thinMs: cfg.thinSeconds * 1000,
            onError: (e) => app.error(`Track journal: ${e.message}`)
        });
        const userState = new UserState(app.getDataDirPath(), (e) => app.error(`Saving state failed: ${e.message}`));
        userState.applyConfig(cfg.boats);
        const ais = new AisSourceAdapter(
            app,
            (r) => {
                // Our state at their report time travels with the report, so it outlives
                // our own continuous history (kept only for the recent window).
                const us = own.at(r.t);
                const rep = {
                    ...r,
                    us: us ? {t: us.t, lat: us.lat, lon: us.lon, cogRad: us.cogRad, sogMs: us.sogMs} : null
                };
                store.add(rep);
                journal.append({k: 'r', ...rep});
            },
            (id, name) => {
                store.setName(id, name);
                journal.append({k: 'n', id, name});
            }
        );
        const ownAdapter = new OwnAdapter(app, (s) => {
            if (own.add(s)) journal.append({k: 'o', ...s});
        });
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
            waypoints: new WaypointSource(app, cfg, {ownAt: (t) => own.at(t)}),
            ais,
            ownAdapter,
            startTime,
            racerStart,
            journal,
            thinTimer: null,
            ready: null, // promise: journal loaded
            // Live clock. The replay harness shifts recorded times to wall-clock time.
            clock: () => Date.now()
        };
        ais.start();
        ownAdapter.start();
        racerStart.start();
        state.waypoints.start();
        registerPutHandlers();
        app.setPluginStatus('Loading track history');

        // Live ingest runs while history loads; the stores accept out-of-order data.
        const mine = state;
        mine.ready = journal
            .load(
                (rec) => applyRecord(mine, rec),
                () => state !== mine
            )
            .then((n) => {
                if (state !== mine) return;
                store.thin(mine.clock(), cfg.recentHours * 3600e3, cfg.thinSeconds * 1000);
                journal.start();
                mine.thinTimer = setInterval(
                    () => store.thin(mine.clock(), cfg.recentHours * 3600e3, cfg.thinSeconds * 1000),
                    60e3
                );
                mine.thinTimer.unref?.();
                app.setPluginStatus(`Started, ${n} history records loaded`);
            })
            .catch((e) => {
                if (state === mine) app.error(`Loading track history failed: ${e.message}`);
            });
    };

    // Replays one journal record into the in-memory stores (never re-journaled).
    function applyRecord(s, rec) {
        if (rec.k === 'r' && typeof rec.boatId === 'string' && Number.isFinite(rec.t)) {
            const {k, ...r} = rec;
            s.store.add(r);
        } else if (rec.k === 'o' && Number.isFinite(rec.t)) {
            const {k, ...o} = rec;
            s.own.add(o);
        } else if (rec.k === 'n' && typeof rec.id === 'string') {
            s.store.setName(rec.id, rec.name);
        }
    }

    /** Resolves once track history has been loaded from the journal (used by tests). */
    plugin.whenReady = () => (state ? state.ready : Promise.resolve());

    plugin.stop = function () {
        if (!state) return;
        try {
            state.ais.stop();
        } catch (e) {
            app.debug(e);
        }
        if (state.thinTimer) clearInterval(state.thinTimer);
        for (const a of [state.ownAdapter, state.racerStart, state.waypoints, state.journal]) {
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
            const waypoint = s.waypoints.get();
            res.json(
                buildSnapshot({
                    store: s.store,
                    own: s.own,
                    userState: s.userState,
                    waypoint,
                    start: s.startTime.get(),
                    names: s.cfg.names,
                    tcfVmgMs: s.cfg.tcfVmgSeconds * 1000,
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
            // toT: end of the window (epoch ms, default now), for looking back in history.
            // sinceT: only reports newer than this (incremental polling).
            const optT = (k) => (req.query[k] == null || req.query[k] === '' ? null : Number(req.query[k]));
            const toT = optT('toT');
            const sinceT = optT('sinceT');
            if ((toT != null && !Number.isFinite(toT)) || (sinceT != null && !Number.isFinite(sinceT)))
                return res.status(400).json({error: 'bad toT or sinceT'});
            const now = s.clock();
            res.json(
                buildTracks({
                    store: s.store,
                    own: s.own,
                    now,
                    periodMs: Math.min(periodS * 1000, MAX_PERIOD_MS),
                    toT: toT ?? now,
                    sinceT,
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
        historyHours: d('historyHours'),
        maxReportsPerBoat: d('maxReportsPerBoat'),
        maxBoats: d('maxBoats'),
        ownSampleSeconds: d('ownSampleSeconds'),
        recentHours: Math.min(d('recentHours'), d('historyHours')),
        thinSeconds: d('thinSeconds'),
        maxRaceHours: d('maxRaceHours'),
        tcfVmgSeconds: d('tcfVmgSeconds'),
        waypointOrder: o.waypointOrder === 'nmea,course' ? 'nmea,course' : 'course,nmea',
        nmeaWaypointStaleSeconds: d('nmeaWaypointStaleSeconds'),
        waypointName: typeof o.waypointName === 'string' ? o.waypointName : schema.properties.waypointName.default,
        ...configuredBoats(o.boats)
    };
}

/**
 * Configured boats, invalid entries dropped, later duplicates ignored.
 * @returns {{boats: {mmsi, name, tcf}[], names: Map<string, string>}} names: mmsi -> configured name
 */
function configuredBoats(list) {
    const boats = [];
    const names = new Map();
    const seen = new Set();
    for (const b of Array.isArray(list) ? list : []) {
        const mmsi = b && String(b.mmsi ?? '').trim();
        if (!/^[0-9]{9}$/.test(mmsi) || seen.has(mmsi)) continue;
        seen.add(mmsi);
        const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : null;
        const tcf = validTcf(b.tcf) ? b.tcf : null;
        boats.push({mmsi, name, tcf});
        if (name) names.set(mmsi, name);
    }
    return {boats, names};
}

module.exports.PLUGIN_ID = PLUGIN_ID;
module.exports.API_PREFIX = API_PREFIX;
module.exports.PUT_PATHS = PUT_PATHS;
module.exports.withDefaults = withDefaults;
