'use strict';
/*
 * Nemesis Delta: Signal K server plugin entry point.
 *
 * Layers (keep them distinct):
 *  - Data model paths consumed: other vessels' navigation.position,
 *    courseOverGroundTrue, speedOverGround, name; our own position, COG, SOG,
 *    headingTrue; navigation.courseRhumbline.nextPoint.position (waypoint seam).
 *  - Data model paths published: none yet (brief section 8, Greg's call).
 *  - REST endpoints: mounted by the server at /plugins/<id>
 *    (signalk-server packages/server-api/src/plugin.ts registerWithRouter).
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

const PLUGIN_ID = 'signalk-nemesis';
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

        state = {
            cfg,
            store,
            own,
            userState,
            waypoint: makeWaypointSource(app, cfg),
            ais,
            ownAdapter,
            // Live clock. The replay harness shifts recorded times to wall-clock time.
            clock: () => Date.now()
        };
        ais.start();
        ownAdapter.start();
        app.setPluginStatus('Started');
    };

    plugin.stop = function () {
        if (!state) return;
        try {
            state.ais.stop();
        } catch (e) {
            app.debug(e);
        }
        try {
            state.ownAdapter.stop();
        } catch (e) {
            app.debug(e);
        }
        state = null;
    };

    plugin.registerWithRouter = function (router) {
        // Handlers read `state` on each request: the router outlives start/stop cycles.
        const running = (res) => {
            if (state) return state;
            res.status(503).json({error: 'plugin not running'});
            return null;
        };

        router.get('/snapshot', (req, res) => {
            const s = running(res);
            if (!s) return;
            res.json(
                buildSnapshot({
                    store: s.store,
                    own: s.own,
                    userState: s.userState,
                    waypoint: s.waypoint(),
                    staleMs: s.cfg.staleSeconds * 1000,
                    now: s.clock()
                })
            );
        });

        router.get('/tracks', (req, res) => {
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

        router.get('/user', (req, res) => {
            const s = running(res);
            if (s) res.json(s.userState.toJSON());
        });

        // TODO(verify): which security permission the server enforces on PUT under /plugins/<id>.
        router.put('/nemesis/:id', async (req, res) => {
            const s = running(res);
            if (!s) return;
            const on = req.body && req.body.nemesis;
            if (typeof on !== 'boolean') return res.status(400).json({error: 'body must be {"nemesis": true|false}'});
            await s.userState.setNemesis(String(req.params.id), on);
            res.json({id: req.params.id, nemesis: on});
        });

        router.put('/tcf/:id', async (req, res) => {
            const s = running(res);
            if (!s) return;
            const v = req.body && req.body.tcf;
            if (!validTcf(v)) return res.status(400).json({error: 'body must be {"tcf": number in (0, 3]}'});
            await s.userState.setTcf(String(req.params.id), v);
            res.json({id: req.params.id, tcf: v});
        });
    };

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
        waypoint: o.waypoint || null
    };
}

module.exports.PLUGIN_ID = PLUGIN_ID;
module.exports.withDefaults = withDefaults;
