'use strict';
/*
 * Nemesis Delta: Signal K server plugin entry point.
 *
 * Layers (keep them distinct):
 *  - Data model paths consumed: other vessels' navigation.position,
 *    courseOverGroundTrue, speedOverGround, name; our own position, COG, SOG,
 *    headingTrue, environment.wind.directionTrue (smoothed, lib/wind.js);
 *    navigation.courseRhumbline|courseGreatCircle.nextPoint.* (raw NMEA
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
const {TwdSmoother, WindAdapter} = require('./lib/wind');
const {WaypointSource} = require('./lib/waypoint');
const {UserState, validTcf} = require('./lib/user-state');
const {buildSnapshot, buildTracks} = require('./lib/snapshot');
const {StartTime, RacerStartAdapter} = require('./lib/start-time');
const {Journal} = require('./lib/journal');
const {CycaState} = require('./lib/cyca-state');
const {CycaRaces} = require('./lib/cyca-races');
const {RecordedRaces} = require('./lib/recorded-race');
const {CycaAdapter} = require('./lib/cyca-adapter');
const {mergedView} = require('./lib/cyca-merge');
const {mappingRows} = require('./lib/cyca-mapping');
const {BackfillPlanner} = require('./lib/cyca-backfill');
const {nameKey} = require('./lib/cyca-feed');
const {CourseStore, resolveCourse, routeToMarks, routeList, waypointList} = require('./lib/course');

const PLUGIN_ID = 'signalk-nemesis';
const API_PREFIX = '/nemesis';
// PUT handler paths, under our own name within signalk-racer's navigation.racing group.
const PUT_PATHS = {
    setNemesis: 'navigation.racing.nemesis.setNemesis',
    setTcf: 'navigation.racing.nemesis.setTcf',
    setStartTime: 'navigation.racing.nemesis.setStartTime',
    setCycaRace: 'navigation.racing.nemesis.setCycaRace',
    setCycaLink: 'navigation.racing.nemesis.setCycaLink',
    setCycaNoAis: 'navigation.racing.nemesis.setCycaNoAis',
    setCourse: 'navigation.racing.nemesis.setCourse',
    clearHistory: 'navigation.racing.nemesis.clearHistory',
    unlinkAllCyca: 'navigation.racing.nemesis.unlinkAllCyca'
};
const MAX_PERIOD_MS = 24 * 3600e3;
// Backfill depth: the longest display period a webapp asked /tracks for lately.
const WANT_PERIOD_DEFAULT_MS = 60 * 60e3;
const WANT_PERIOD_HOLD_MS = 10 * 60e3;

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
        windSmoothSeconds: {
            type: 'number',
            title: 'True wind direction smoothed over (seconds)',
            description: 'For Up = Upwind and Downwind: a circular mean of our TWD over this long.',
            default: 120,
            minimum: 1
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
        waypointNames: {
            type: 'array',
            title: 'Fallback waypoints, looked up by name in the waypoint resources (e.g. made in Freeboard-SK)',
            description:
                'The first one found is the waypoint when neither the Course API nor NMEA has a next ' +
                'point; with none, the waypoint based values (Up = Waypoint, VMC, TCF Should) are not ' +
                'shown. Each one found can be picked as Up in the webapp. The course for Up = Course ' +
                "is set on the webapp's Course tab; until it is, this list is the course.",
            default: ['nemesis'],
            items: {type: 'string', title: 'Name'}
        }
    }
};

/**
 * @param {object} app Signal K server app
 * @param {object} [deps] test seams: {fetch} for the CYCA feed
 */
module.exports = function (app, deps = {}) {
    const fetchImpl = deps.fetch || globalThis.fetch;
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
        // Every source's reports go in the same way: AIS and the CYCA tracker.
        const ingest = (r) => {
            // Our state at their report time travels with the report, so it outlives
            // our own continuous history (kept only for the recent window).
            const us = own.at(r.t);
            const rep = {
                ...r,
                us: us
                    ? {t: us.t, lat: us.lat, lon: us.lon, cogRad: us.cogRad, sogMs: us.sogMs, twdRad: us.twdRad ?? null}
                    : null
            };
            store.add(rep);
            journal.append({k: 'r', ...rep});
        };
        const setName = (id, name) => {
            store.setName(id, name);
            journal.append({k: 'n', id, name});
        };
        const ais = new AisSourceAdapter(app, ingest, setName, Date.now, (id, shipType) => {
            store.setShipType(id, shipType);
            journal.append({k: 'n', id, shipType});
        });
        // Our smoothed true wind direction travels with each own sample (Up = Upwind, Downwind).
        const twd = new TwdSmoother({windowMs: cfg.windSmoothSeconds * 1000});
        const wind = new WindAdapter(app, twd);
        const ownAdapter = new OwnAdapter(app, (s) => {
            const o = {...s, twdRad: twd.at(s.t)};
            if (own.add(o)) journal.append({k: 'o', ...o});
        });
        const startTime = new StartTime({
            dataDir: app.getDataDirPath(),
            maxRaceMs: cfg.maxRaceHours * 3600e3,
            onError: (e) => app.error(`Saving start time failed: ${e.message}`)
        });
        const racerStart = new RacerStartAdapter(app, startTime);
        // The course is set on the webapp's Course tab; until then, the old waypointNames.
        const course = new CourseStore(app.getDataDirPath(), cfg.waypointNames, (e) =>
            app.error(`Saving the course failed: ${e.message}`)
        );
        const onCycaError = (e) => app.error(`Saving CYCA state failed: ${e.message}`);
        const cycaState = new CycaState(app.getDataDirPath(), onCycaError);
        const cycaRaces = new CycaRaces({
            fetch: fetchImpl,
            dataDir: app.getDataDirPath(),
            ourName: () => selfName(app),
            onError: onCycaError
        });
        // Recorded races (recorded-race-<key>.json in the data dir) are offered beside the
        // feed's; picking one serves the feed's requests from its file.
        const recorded = new RecordedRaces({dataDir: app.getDataDirPath()});
        const cyca = new CycaAdapter({
            fetch: recorded.fetchWith(fetchImpl),
            onChange: () => {
                if (state && state.cyca === cyca) backfill(state);
            },
            onReport: (r) => {
                const e = cyca.entries.get(Number(r.boatId.slice('cyca:'.length)));
                // We are in the fleet too: our own entry is not a competitor.
                if (e && nameKey(e.name) === nameKey(selfName(app) || '')) return;
                ingest(r);
                // Entries arrive before reports, and the store names only boats it holds.
                const b = store.get(r.boatId);
                if (e && b && b.name !== e.name) setName(r.boatId, e.name);
            }
        });

        state = {
            cfg,
            store,
            own,
            userState,
            waypoints: new WaypointSource(app, cfg, {ownAt: (t) => own.at(t)}),
            ais,
            ownAdapter,
            wind,
            startTime,
            racerStart,
            journal,
            cycaState,
            cycaRaces,
            recorded,
            cyca,
            course,
            backfillPlanner: new BackfillPlanner(),
            backfilling: false,
            filled: 0, // bumped when a backfill adds reports: the webapp then refetches tracks
            wantPeriod: {ms: WANT_PERIOD_DEFAULT_MS, at: 0},
            thinTimer: null,
            ready: null, // promise: journal loaded
            // Live clock. The replay harness shifts recorded times to wall-clock time.
            clock: () => Date.now()
        };
        ais.start();
        ownAdapter.start();
        wind.start();
        racerStart.start();
        state.waypoints.start();
        // A recorded race is only served once its file is read.
        recorded.scan().then(() => {
            if (state && state.cyca === cyca) cyca.setRace(cycaState.raceId);
        });
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
            if (rec.name !== undefined) s.store.setName(rec.id, rec.name);
            if (rec.shipType !== undefined) s.store.setShipType(rec.id, rec.shipType);
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
        for (const a of [state.ownAdapter, state.wind, state.racerStart, state.waypoints, state.cyca, state.journal]) {
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
                const s = state;
                return s.userState.setNemesis(value.id, value.nemesis).then(() => {
                    backfill(s); // a new nemesis may have gaps the tracker can fill
                    return complete(200, 'OK');
                });
            })
        );
        app.registerPutHandler('vessels.self', PUT_PATHS.setTcf, (ctx, path, value) =>
            command(() => {
                if (!value || typeof value.id !== 'string' || !validTcf(value.tcf))
                    return complete(400, 'value must be {id: string, tcf: number in (0, 3]}');
                return state.userState.setTcf(value.id, value.tcf).then(() => complete(200, 'OK'));
            })
        );
        // value {raceId: integer} selects the CYCA race to poll; {raceId: null} turns it off.
        app.registerPutHandler('vessels.self', PUT_PATHS.setCycaRace, (ctx, path, value) =>
            command(() => {
                if (!value || !(value.raceId === null || Number.isInteger(value.raceId)))
                    return complete(400, 'value must be {raceId: integer|null}');
                state.cyca.setRace(value.raceId);
                state.backfillPlanner.reset();
                return state.cycaState.setRace(value.raceId).then(() => complete(200, 'OK'));
            })
        );
        // value {name: CYCA boat name, mmsi: string} links it (kept across races); mmsi null unlinks.
        app.registerPutHandler('vessels.self', PUT_PATHS.setCycaLink, (ctx, path, value) =>
            command(() => {
                if (
                    !value ||
                    typeof value.name !== 'string' ||
                    !(value.mmsi === null || typeof value.mmsi === 'string')
                )
                    return complete(400, 'value must be {name: string, mmsi: string|null}');
                try {
                    return state.cycaState.link(value.name, value.mmsi).then(() => complete(200, 'OK'));
                } catch (e) {
                    return complete(400, e.message);
                }
            })
        );
        // value {entryId: integer, noAis: boolean}: the boat has no AIS this race (silences the badge).
        app.registerPutHandler('vessels.self', PUT_PATHS.setCycaNoAis, (ctx, path, value) =>
            command(() => {
                if (!value || !Number.isInteger(value.entryId) || typeof value.noAis !== 'boolean')
                    return complete(400, 'value must be {entryId: integer, noAis: boolean}');
                return state.cycaState.setNoAis(value.entryId, value.noAis).then(() => complete(200, 'OK'));
            })
        );
        // value true: forget every boat's track and our own, in memory and in the journal.
        // Names, nemeses, TCFs, links and the course are kept; boats reappear as they report.
        app.registerPutHandler('vessels.self', PUT_PATHS.clearHistory, (ctx, path, value) =>
            command(async () => {
                if (value !== true) return complete(400, 'value must be true');
                const s = state;
                // After the journal has loaded, or its records would come back.
                await s.ready.catch(() => {});
                if (state !== s) return complete(503, 'plugin restarted');
                s.store.clear();
                s.own.clear();
                s.ais.forgetNames(); // the store's names went with its boats
                s.backfillPlanner.reset();
                await s.journal.clear();
                s.filled++; // the webapp refetches its tracks
                return complete(200, 'OK');
            })
        );
        // value true: remove every CYCA link (they are kept across races, by CYCA name).
        app.registerPutHandler('vessels.self', PUT_PATHS.unlinkAllCyca, (ctx, path, value) =>
            command(() => {
                if (value !== true) return complete(400, 'value must be true');
                return state.cycaState.unlinkAll().then(() => complete(200, 'OK'));
            })
        );
        // value {marks: [{name, waypointId?, lat?, lon?}]} replaces the course;
        // {routeId} replaces it with that route resource's points.
        app.registerPutHandler('vessels.self', PUT_PATHS.setCourse, (ctx, path, value) =>
            command(async () => {
                if (!value || !(Array.isArray(value.marks) || typeof value.routeId === 'string'))
                    return complete(400, 'value must be {marks: [...]} or {routeId: string}');
                const s = state;
                let marks = value.marks;
                if (typeof value.routeId === 'string') {
                    let route;
                    try {
                        route = await app.resourcesApi.getResource('routes', value.routeId);
                    } catch (e) {
                        return complete(404, `route ${value.routeId} not found`);
                    }
                    try {
                        marks = routeToMarks(route, s.waypoints.waypoints());
                    } catch (e) {
                        return complete(400, e.message);
                    }
                }
                try {
                    await s.course.set(marks);
                } catch (e) {
                    if (e instanceof RangeError) return complete(400, e.message);
                    throw e;
                }
                s.waypoints.refresh();
                return complete(200, 'OK');
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
            const now = s.clock();
            const snap = buildSnapshot({
                store: viewOf(s),
                own: s.own,
                userState: s.userState,
                waypoint,
                start: s.startTime.get(),
                names: s.cfg.names,
                configured: s.cfg.configuredIds,
                namedWaypoints: s.waypoints.namedList(),
                waypointNames: s.cfg.waypointNames,
                tcfVmgMs: s.cfg.tcfVmgSeconds * 1000,
                staleMs: s.cfg.staleSeconds * 1000,
                now
            });
            snap.cyca = cycaSummary(s, now);
            snap.course = resolveCourse(s.course.marks, s.waypoints.waypoints());
            res.json(snap);
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
            const periodMs = Math.min(periodS * 1000, MAX_PERIOD_MS);
            if (toT == null && sinceT == null) wantPeriod(s, periodMs, now);
            res.json(
                buildTracks({
                    store: viewOf(s),
                    own: s.own,
                    now,
                    periodMs,
                    toT: toT ?? now,
                    sinceT,
                    ids
                })
            );
        });

        router.get(prefix + '/course', (req, res) => {
            const s = running(res);
            if (!s) return;
            res.json({seeded: s.course.seeded, marks: resolveCourse(s.course.marks, s.waypoints.waypoints())});
        });

        // Everything the Course tab can add: the waypoint resources, and the routes to import.
        router.get(prefix + '/course/waypoints', (req, res) => {
            const s = running(res);
            if (s) res.json(waypointList(s.waypoints.waypoints()));
        });

        router.get(prefix + '/course/routes', (req, res) => {
            const s = running(res);
            if (!s) return;
            const list = app.resourcesApi?.listResources;
            if (!list) return res.json([]);
            Promise.resolve()
                .then(() => list.call(app.resourcesApi, 'routes', {}))
                .then(
                    (all) => res.json(routeList(all)),
                    (e) => res.status(502).json({error: `routes: ${e && e.message}`})
                );
        });

        router.get(prefix + '/cyca', (req, res) => {
            const s = running(res);
            if (s) res.json(cycaSummary(s, s.clock()));
        });

        // The race picker's list; ?refresh=1 reads the feed first (the cached list if that fails).
        router.get(prefix + '/cyca/races', (req, res) => {
            const s = running(res);
            if (!s) return;
            const send = () =>
                res.json({
                    ...s.cycaRaces.toJSON(),
                    races: [...s.recorded.listings(), ...s.cycaRaces.races],
                    recordedErrors: s.recorded.errors,
                    selected: s.cycaState.raceId
                });
            if (req.query.refresh) Promise.all([s.cycaRaces.refresh(), s.recorded.scan()]).then(send, send);
            else send();
        });

        router.get(prefix + '/cyca/mapping', (req, res) => {
            const s = running(res);
            if (!s) return;
            res.json({...cycaSummary(s, s.clock()), ...cycaMapping(s, s.clock())});
        });

        router.get(prefix + '/user', (req, res) => {
            const s = running(res);
            if (s) res.json(s.userState.toJSON());
        });
    }

    /** Note the period a webapp shows; a longer one than before backfills at once. */
    function wantPeriod(s, periodMs, now) {
        const w = s.wantPeriod;
        const longer = periodMs > w.ms;
        if (longer || now - w.at > WANT_PERIOD_HOLD_MS) s.wantPeriod = {ms: periodMs, at: now};
        else if (periodMs === w.ms) w.at = now;
        if (longer) backfill(s);
    }

    /**
     * Fill gaps in nemesis boats' tracks over the display period from the CYCA tracks
     * (one run at a time; the adapter queues the fetches). Never throws.
     */
    function backfill(s) {
        if (s.backfilling || s.cycaState.raceId === null || !s.cyca.race) return;
        const now = s.clock();
        const jobs = s.backfillPlanner.plan({
            boats: viewOf(s).all(),
            isNemesis: (id) => s.userState.isNemesis(id),
            now,
            periodMs: s.wantPeriod.ms,
            staleMs: s.cfg.staleSeconds * 1000,
            startT: s.cyca.race.startT
        });
        if (!jobs.length) return;
        s.backfilling = true;
        (async () => {
            for (const j of jobs) {
                if (state !== s) return;
                const own = s.store.get('cyca:' + j.entryId);
                const known = (t) => !!own && own.track.atOrBefore(t)?.t === t;
                const added = await s.cyca.fillTrack(j.entryId, j.fromT, j.toT, known);
                if (added > 0) s.filled++;
                s.backfillPlanner.done(j.entryId, j.fromT, now, added);
            }
        })()
            .catch((e) => app.error(`CYCA backfill: ${e.message}`))
            .finally(() => (s.backfilling = false));
    }

    // Tracks with CYCA links applied: a linked CYCA boat shows as its AIS boat.
    function viewOf(s) {
        return mergedView(s.store, (name) => s.cycaState.linkOf(name));
    }

    function cycaEntries(s) {
        const ours = nameKey(selfName(app) || '');
        let fleet = s.cyca.fleet();
        // Entries not read yet (offline since a restart): the CYCA boats already in the store.
        if (!fleet.length && s.cyca.raceId !== null)
            fleet = s.store
                .all()
                .filter((b) => b.id.startsWith('cyca:') && b.name)
                .map((b) => ({entryId: Number(b.id.slice(5)), name: b.name, owner: '', club: ''}));
        return ours ? fleet.filter((e) => nameKey(e.name) !== ours) : fleet; // we are not a competitor
    }

    function cycaMapping(s, now) {
        if (s.cycaState.raceId === null) return {rows: [], needsAction: false};
        return mappingRows({entries: cycaEntries(s), store: s.store, cycaState: s.cycaState, now});
    }

    function cycaSummary(s, now) {
        // race: the adapter's race detail; listing: the picker's row (name, fleet, entered).
        return {
            ...s.cyca.toJSON(),
            raceId: s.cycaState.raceId,
            filled: s.filled,
            links: s.cycaState.links.size,
            listing:
                s.cycaRaces.byId(s.cycaState.raceId) ||
                s.recorded.listings().find((r) => r.raceId === s.cycaState.raceId) ||
                null,
            needsAction: cycaMapping(s, now).needsAction
        };
    }

    return plugin;
};

/** Our vessel name: a plain string at self.name (getSelfPath is lodash.get on self, signalk-server 2.30.0). */
function selfName(app) {
    const v = app.getSelfPath('name');
    if (typeof v === 'string') return v;
    return v && typeof v.value === 'string' ? v.value : null;
}

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
        windSmoothSeconds: d('windSmoothSeconds'),
        waypointOrder: o.waypointOrder === 'nmea,course' ? 'nmea,course' : 'course,nmea',
        nmeaWaypointStaleSeconds: d('nmeaWaypointStaleSeconds'),
        waypointNames: waypointNames(o),
        ...configuredBoats(o.boats)
    };
}

/**
 * Named waypoints, trimmed, empties dropped. Repeats are kept: the list is also the course,
 * where a mark can be passed twice (out and back). An old single waypointName still works.
 */
function waypointNames(o) {
    let list = schema.properties.waypointNames.default;
    if (Array.isArray(o.waypointNames)) list = o.waypointNames;
    else if (typeof o.waypointName === 'string') list = [o.waypointName];
    const out = [];
    for (const n of list) {
        const t = typeof n === 'string' ? n.trim() : '';
        if (t) out.push(t);
    }
    return out;
}

/**
 * Configured boats, invalid entries dropped, later duplicates ignored.
 * @returns {{boats: {mmsi, name, tcf}[], names: Map<string, string>, configuredIds: Set<string>}} names: mmsi -> configured name
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
    return {boats, names, configuredIds: seen};
}

module.exports.PLUGIN_ID = PLUGIN_ID;
module.exports.API_PREFIX = API_PREFIX;
module.exports.PUT_PATHS = PUT_PATHS;
module.exports.withDefaults = withDefaults;
