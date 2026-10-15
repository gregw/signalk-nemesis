# TODO

Phases follow `wiki/overview.md` section 7. `[x]` = in the skeleton with tests.

## Housekeeping

- [x] Deleted the duplicate `signalk-nemesis-delta/` folder.
- [x] Code style matches signalk-racer (4-space indent, semicolons, single quotes). `npm run format` applies `.prettierrc.json`.
- [x] First commit.
- [x] Node 22.22.2 test run: `npm run test:node22` (fetches Node 22.22.2 via npx). Unit and browser suites pass.
- [x] Playwright + headless Chromium (`npm run test:browser`; first time on a machine: `npx playwright install chromium`). Stand-in server: `node test/sim/dev-server.js [port] [hoursIn]`.
- [ ] Browser tests in CI or a pre-commit script, so they actually get run.
- [x] Ran in signalk-server 2.30.0 on Node 22.22.2 (scratch config dir, plugin symlinked into its `node_modules`). Plugin starts, webapp at `/signalk-nemesis/`, API at `/plugins/signalk-nemesis/`, 47 boats ingested from the simulated race, webapp checked in Chromium against it.
- [x] README: deploying to a local server as a dev test (scratch server or existing config dir, by symlink), feeding the simulated race, config and interfaces. Recipe checked on 2.30.0 from an empty config dir.
- [ ] `getOpenApi()` / openapi.json for the REST endpoints; release notes; install from npm once published.

## Verify against the server (TODO(verify) in code)

- [x] Router mount, webapp mount and per-path subscription delivery confirmed on 2.30.0.
- [x] AIS names: N2K sends path `''` with `{name}` and a subscription to `name` never delivers it (checked on 2.30.0). Names are now read with `app.getPath(<context>.name)`, throttled.
- [ ] Course next point: v1 `navigation.courseRhumbline.nextPoint.position` (used now) vs v2 `navigation.course.nextPoint`.
- [x] Security (checked on 2.30.0 with security on): all of `/plugins/*` is admin only, so reads are also mounted at `/signalk/v1/api/nemesis/*` (read access is enough) and writes are Signal K PUT handlers `navigation.racing.nemesis.setNemesis|setTcf` (need readwrite). Webapp shows "login needed" on 401/403.
- [x] Webapp: "login needed" is a link to the server login (`/admin/#/login`; the session cookie is then used by the webapp's fetches). TODO(verify) on a secured 2.30.0 server that the cookie is accepted by the API mount after logging in there.
- [ ] Whether the subscription manager delivers our own `vessels.self` values when `selfContext` changes (MMSI configured after start).

## Phase 1: skeleton

- [x] Plugin scaffold, config schema, start/stop with clean unsubscribe.
- [x] Coalescer: rebuilds whole reports from per-path deliveries (same context + same timestamp).
- [x] AIS adapter (`vessels.*` minus self, MMSI as boatId), own-vessel adapter.
- [x] TrackStore: per-boat ring buffer capped by count and span, boat count cap, out-of-order insert.
- [x] OwnState: bounded continuous history, lookup at a report time.
- [x] Staleness (`currentReport`), configurable stale threshold.
- [x] Waypoint seam: course API, then config fallback.
- [x] Atomic persistence; nemesis list and TCFs in the data dir.
- [x] REST (read): `GET snapshot`, `tracks`, `user` at `/signalk/v1/api/nemesis/` and `/plugins/signalk-nemesis/`. PUT handlers (write): `navigation.racing.nemesis.setNemesis` `{id, nemesis}`, `.setTcf` `{id, tcf}`.
- [x] Seeded AIS simulator over GC2026, end-to-end replay test through a fake app.
- [ ] Debounce `JsonStore.save` (currently writes on every edit; fine for taps, not for a slider).
- [ ] OwnState interpolation between bracketing samples (currently nearest earlier within 10 s).
- [ ] Coalescer: report with COG/SOG but no position is dropped. Decide whether to attach it to the previous report instead.
- [ ] Late or duplicate AIS reports from two receivers (N2K and 0183 both feeding): dedupe by timestamp is in place, but different `$source` timestamps for the same transmission are not.
- [ ] Clock: plugin uses wall time; the simulator shifts recorded data to wall time. Decide what happens when the server clock is wrong (no GPS time sync on HALPI2 after a brownout).
- [x] `node test/sim/live-feed.js --url ws://host:port --hours 6 [--live]` feeds the simulated race into a running server over its WebSocket (security off).

## Race inputs: start time and waypoint

Both are adapter seams with an explicit precedence, and the snapshot reports which source is in use so the UI can show it.

### Start time (for TCF elapsed time)

1. [x] Manual override: PUT handler `navigation.racing.nemesis.setStartTime` `{startTime: RFC 3339 | null}`, persisted atomically. Wins when set.
2. [x] signalk-racer `navigation.racing.startTime` (RFC 3339 UTC; `reset` publishes null, verified with racer running in a 2.30.0 server). Our copy is persisted, because racer loses its start time on a server restart (checked: the path is 404 after restart).
3. [x] None, or older than `maxRaceHours` (default 96): snapshot `start` is null. TCF must then show "no start time".
- [ ] signalk-racer itself should persist its start time across restarts (a racer change, not this plugin).
- [x] Webapp control to set/clear the override (TCF tab: date-time box with Set, Now, Clear).

### Next waypoint (Up = Waypoint, DTG, VMC, Should)

All three of your sources reach the server's Course API. Verified in signalk-server 2.18 `src/api/course/index.ts`:
- **Signal K route:** `activeRoute` with `pointIndex`; the Course API emits `nextPoint` as the route advances.
- **Named waypoint set in Freeboard-SK:** Freeboard sets the Course API destination (with an `href` to the waypoint resource), which emits `nextPoint`. TODO(verify) against the Freeboard-SK version on HALPI2.
- **NMEA from the nav PC (Expedition or H5000):** 0183 RMB and BWC, and N2K 129284, all publish `navigation.courseRhumbline|courseGreatCircle.nextPoint.position` (nmea0183-signalk `hooks/RMB.js:86`, `hooks/BWC.js:63`; n2k-signalk `pgns/129284.js:63`). The Course API subscribes to those and adopts them as the destination (`processV1DestinationDeltas`).

Implemented in `lib/waypoint.js` and checked on a real 2.30.0 server (NMEA RMB, Course API position destination, named waypoint, destination by href, active route and advancing it, both orders):
- [x] Course API via `app.getCourse()` (polled every 2 s), with the active route's points loaded from the route resource.
- [x] Raw NMEA next point (RMB/BWC/129284 paths), ignoring the Course API's own `courseApi` copies, expiring after `nmeaWaypointStaleSeconds` (default 30).
- [x] Bearing and distance only: projected from our position at that time (true bearing only).
- [x] Precedence configurable: `waypointOrder` `course,nmea` (default) or `nmea,course`. Then `waypointName` (resources API, polled every 30 s, default `nemesis`). No fixed lat/lon fallback (removed 2026-10-16): with no waypoint the waypoint based values are not shown.
- [x] The Course API keeps an adopted NMEA destination after the instruments stop (seen on 2.30.0). A Course API point with no href and no active route that sits on the last NMEA point now expires with the NMEA.
- [x] Replay and live feed publish the GC2026 finish as an RMB next point.
- [ ] Magnetic-only bearing (`bearingMagnetic` plus variation) is not handled.
- [x] Waypoint changes mid-race (rounding a mark): nothing derived is stored; the webapp derives every value from positions and the waypoint in use now, so VMC and lead always compare distances to the same mark. Only the absolute DTG of old reports refers to a mark they were not yet sailing to.
- [x] TCF Should (decided 2026-10-15, replacing the course distance D): time owed over the elapsed time, at the trailing boat's VMG to the waypoint smoothed over `tcfVmgSeconds` (default 600). Snapshot `tcfVmgMs`. Course distance code, `startWaypointName` and `courseDistanceNm` removed.

## Phase 2: derivations (pure, unit tested)

All in `public/derive.js`, pure and loaded by both the webapp and `test/derive.test.js`.
- [x] Frame reference direction: Waypoint, Course, North; Wind disabled.
- [x] DTG to waypoint for every report, and for us at their report time.
- [x] VMC from the boat's own previous report, ignoring gaps over the stale threshold. Ours over at least 60 s of our own samples; in Relative mode ours is taken over the same interval as theirs.
- [x] VMG toward Up for Course and North; relative mode (theirs minus ours at the same time).
- [x] Lead toward Up (Waypoint, Course, North), + = they are ahead.
- [x] TCF: Should, Actual, Net. Unit tests with worked values (6 h, TCF 1.000 vs 1.100 at 6 kn: Should = 3.6 nm).
- [x] In-range recomputed on every render (client side, from the stale threshold in the Time popup).
- [x] Elapsed time from the start-time seam (time button; TCF needs a report after the start).
- [x] Where derived values live: in the webapp, because Up and Mode are per viewer. The server provides reports, our state at each report time, our own track, waypoint, start and the TCF VMG period. Tracks API: `toT` (look back), `sinceT` (incremental).

## Phase 3: webapp port

- [x] Shell: top bar, Show filter, tabs (Boats, TCF, Vectors, Geo), polling with timeout and backoff, prefs in localStorage.
- [x] Boats tab: basic list, nemesis toggle, SOG/COG, range, age.
- [x] Boats tab: sort by Near, Waypoint, VMG, A-Z (us included); strip charts (newest left, x by time, age taper, shared window height per column, value over latest dot). Sign: + = they are doing better than us in every frame (wiki §8).
- [x] Vectors tab (brief 3.7), auto-fit, selected boat's dashed true velocity shafts, taps hit-tested in code.
- [x] TCF tab: entry box per boat and for us (PUT setTcf, id `self` for us; not re-rendered under focus), Should and Actual at the latest report, Net (TCF corrected lead) as a strip chart over the period like the Boats tab so a slightly old report still shows its trend, sorted by latest Net, reason shown when Should can't be computed, method and elapsed time shown.
- [x] Geo tab: Web Mercator rotated to Up, White/OSM/Sea basemaps, pan/pinch per the prototype lessons, follows us until a gesture, Fit. Offline: White is the default; tiles load only when OSM or Sea is chosen, and only when the view changes (not on every poll).
- [x] Time popup: look back through the server's history (slider, 10 min back/forward, Live), Period 10 to 240 min, Stale after.
- [x] Selection popup clamped to viewport; selection highlighted on every tab.
- [ ] Not ported from the prototype: Play (animate history), expanding one boat's full trail by tapping its name, the Div filter (AIS has no division).
- [ ] Info popups open on tap; check they read well on a phone.
- [ ] WebSocket stream (or SK stream subscription) for updates, poll kept as resync.
- [x] Optimistic nemesis toggle: pending edits are re-applied over snapshots until the PUT completes, so a poll can't flicker it back.
- [x] Playwright tests: phone and tablet layout (no horizontal or page scroll), nemesis tap persists across reload, scroll survives polling re-renders, outage shows stale and recovers.
- [x] Playwright tests (`test/browser/tabs.browser.test.js`): every tab on phone and tablet, sign convention (Boats lead = TCF Actual), TCF entry not re-rendered under focus, start override, vector tap selection and popup clamp, Geo pinch about the fingers (CDP touch events), pan, Relative to Absolute on gesture, history window, Relative mode. Focus guard and pinch anchor tests were checked to fail when the code is broken.
- [x] Client-side aging: "now" is `snapshot.now` plus wall time elapsed since it arrived, and the view re-renders while polls fail.
- [ ] `renderBoats` restores `scrollTop`, but the browser test showed `innerHTML` replacement keeps it anyway. Keep the restore as a guard for when list height changes; the test checks behaviour, not that line.
- [x] Performance budget: measured in Chromium with 48 boats and a 4 h window (2,458 reports): Boats 11 ms, Vectors 11 ms, Geo 11 ms, TCF 3 ms per render. Needed age-tapered segments and old hulls grouped into one path per taper step (from 31 ms).

## Phase 4: persistence and robustness

- [ ] Settings (Show, Up, Mode) server-side or per device? Currently per device in localStorage.
- [x] Track history persistence (decided: append-only log, 5 day default): `lib/journal.js` journals reports, own state and names to `<data dir>/journal/` in 10 min segments, fdatasync every second; older than `recentHours` (6) compacted to one report per boat per `thinSeconds` (2 min) and own state dropped (each report carries our state at its time); older than `historyHours` (120, 5 d) deleted; loaded in chunks on start. Worst case measured on Node 22 (100 boats, 30 s cadence, 5 d): 80 MB on disk, 0.7 s load, max 8 ms event-loop stall, 136 MB heap. Verified across a real 2.30.0 restart.
- [ ] Memory: 136 MB worst case is mostly per-report objects (with the embedded own state). If the HALPI2 feels it, store old history as compact typed arrays.
- [ ] Post-race replay from the journal (phase 5).
- [x] Restart test (journal), torn last line, clock jump into a compacted segment.
- [ ] Brownout test: kill -9 the server mid-write on a real server and reload.
- [ ] Soak test: memory stays bounded over a 72 h replay.

## Phase 5: extras

- [ ] Wind frame and VMG to wind (instrument TWD, or CYCA weather grid for replay).
- [ ] Tracker-feed adapter (CYCA), with a name-to-MMSI mapping table.
- [ ] Instrument-display outputs in our own namespace.

## Open decisions (Greg's call)

- [x] Package name: `signalk-nemesis` (plugin id and URL path).
- [x] TCF Should method: time owed at the trailing boat's smoothed VMG (see above).
- [ ] Own state kept continuously (current choice) vs only at other boats' report times.
- [ ] Which derived values, if any, to publish to the data model.
- [ ] Mapping tracker-feed names to MMSIs.
- [ ] Division filter for Show: AIS has no division, so it needs a per-boat division entered like TCF.
