# TODO

Phases follow `wiki/overview.md` section 7. `[x]` = in the skeleton with tests.

## Housekeeping

- [x] Deleted the duplicate `signalk-nemesis-delta/` folder.
- [x] Code style matches signalk-racer (4-space indent, semicolons, single quotes). `npm run format` applies `.prettierrc.json`.
- [x] First commit.
- [ ] Get a Node 22 runtime locally (only Node 24 here) and run the suite on it.
- [x] Playwright + headless Chromium (`npm run test:browser`; first time on a machine: `npx playwright install chromium`). Stand-in server: `node test/sim/dev-server.js [port] [hoursIn]`.
- [ ] Browser tests in CI or a pre-commit script, so they actually get run.
- [ ] Install the plugin into a dev signalk-server (via `npm link` from a scratch server dir, never inside `~/.signalk`) and confirm the plugin starts, the webapp mounts at `/signalk-nemesis/` and the API at `/plugins/signalk-nemesis/`.
- [ ] README with install, config and API summary. `getOpenApi()` for the REST endpoints.

## Verify against the server (TODO(verify) in code)

- [ ] Local signalk-server source is 2.18.0; HALPI2 runs 2.30.0. Re-check router mount, webapp mount and subscription delivery on 2.30.
- [ ] How AIS `name` arrives through the subscription manager: path `name` or path `''` with `{name}`. The adapter handles both; confirm which.
- [ ] Course next point: v1 `navigation.courseRhumbline.nextPoint.position` (used now) vs v2 `navigation.course.nextPoint`.
- [ ] Which security permission is enforced on `PUT /plugins/<id>/...` when security is enabled, and how the webapp should handle 401/403.
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
- [x] REST: `GET /snapshot`, `GET /tracks`, `GET /user`, `PUT /nemesis/:id`, `PUT /tcf/:id`.
- [x] Seeded AIS simulator over GC2026, end-to-end replay test through a fake app.
- [ ] Debounce `JsonStore.save` (currently writes on every edit; fine for taps, not for a slider).
- [ ] OwnState interpolation between bracketing samples (currently nearest earlier within 10 s).
- [ ] Coalescer: report with COG/SOG but no position is dropped. Decide whether to attach it to the previous report instead.
- [ ] Late or duplicate AIS reports from two receivers (N2K and 0183 both feeding): dedupe by timestamp is in place, but different `$source` timestamps for the same transmission are not.
- [ ] Clock: plugin uses wall time; the simulator shifts recorded data to wall time. Decide what happens when the server clock is wrong (no GPS time sync on HALPI2 after a brownout).
- [ ] Simulator CLI that injects deltas into a running server (for end-to-end checks against a real server, not just the fake app).

## Race inputs: start time and waypoint

Both are adapter seams with an explicit precedence, and the snapshot reports which source is in use so the UI can show it.

### Start time (for TCF elapsed time)

1. [ ] Manual override: plugin REST `PUT /start` (and clear), persisted atomically with user state. Wins when set.
2. [ ] signalk-racer: data model path `navigation.racing.startTime`, RFC 3339 UTC string, published on the timer `start` command (verified: `../signalk-racer/index.js:835`, metadata at `:267`).
   - [ ] TODO(verify): what racer publishes on `reset` and sync while the timer runs, so a reset does not leave a stale start time.
3. [ ] None: TCF tab shows "no start time" instead of numbers. Never guess.
- [ ] Webapp control to set/clear the override (e.g. "start was at hh:mm:ss", or "now").

### Next waypoint (Up = Waypoint, DTG, VMC, Should)

All three of your sources reach the server's Course API. Verified in signalk-server 2.18 `src/api/course/index.ts`:
- **Signal K route:** `activeRoute` with `pointIndex`; the Course API emits `nextPoint` as the route advances.
- **Named waypoint set in Freeboard-SK:** Freeboard sets the Course API destination (with an `href` to the waypoint resource), which emits `nextPoint`. TODO(verify) against the Freeboard-SK version on HALPI2.
- **NMEA from the nav PC (Expedition or H5000):** 0183 RMB and BWC, and N2K 129284, all publish `navigation.courseRhumbline|courseGreatCircle.nextPoint.position` (nmea0183-signalk `hooks/RMB.js:86`, `hooks/BWC.js:63`; n2k-signalk `pgns/129284.js:63`). The Course API subscribes to those and adopts them as the destination (`processV1DestinationDeltas`).

So reading the Course API's next point covers all three, which is what `lib/waypoint.js` does now via the v1 path. Still to do:
- [ ] Bearing and distance only (no position, e.g. 0183 APB or BWR, or a talker that leaves out lat/lon): derive the waypoint by projecting from our position at that time. Bearing true vs magnetic must be handled.
- [ ] Freshness: an NMEA-sourced next point must expire if the nav PC stops sending, instead of being used forever.
- [ ] Precedence when the Course API and a raw NMEA next point disagree (e.g. Expedition on a different mark from Freeboard). Proposal: Course API first, raw NMEA second, config last. Greg's call.
- [ ] Configured fallback by waypoint **name**, looked up in the resources API (`resources.waypoints`), as well as by lat/lon. TODO(verify) the plugin-side resources API call.
- [ ] Waypoint changes mid-race (rounding a mark): VMC and lead must not compare DTGs to different marks. Store the waypoint id with each derived value and break series at a change.
- [ ] TCF Should uses D = DTG_start - DTG_now, which is only meaningful to a single finish. With legs, D needs route distance sailed (route length from the Course API, or race config). Ties into the open decision below.
- [ ] Replay: the simulator has no waypoint, so it should publish the GC2026 finish as an RMB-style next point so the end-to-end test exercises this path.

## Phase 2: derivations (pure, unit tested)

- [ ] Frame reference direction: Waypoint, Course, North; Wind disabled.
- [ ] DTG to waypoint for every report, and for us at their report time.
- [ ] VMC from the boat's own previous report, ignoring gaps over the stale threshold.
- [ ] VMG toward Up for Course and North; relative mode (theirs minus ours at the same time).
- [ ] Lead toward Up (Waypoint, Course, North).
- [ ] TCF: Should, Actual, Net. Unit test with the worked value (D = 144.6 nm, TCF 1.000 vs 1.100, Should = 13.14 nm).
- [ ] In-range recomputed continuously.
- [ ] Elapsed time from the start-time seam (see Race inputs above).
- [ ] Add derived values to the snapshot and track payloads.

## Phase 3: webapp port

- [x] Shell: top bar, Show filter, tabs (Boats, Vectors, TCF, Geo), polling with timeout and backoff, prefs in localStorage.
- [x] Boats tab: basic list, nemesis toggle, SOG/COG, range, age.
- [ ] Boats tab: sort by Waypoint and VMG; strip charts (newest left, age taper, shared window height per column, value over latest dot).
- [ ] Vectors tab (brief 3.7), auto-fit, selected boat's dashed true velocity shafts.
- [ ] TCF tab: entry box per boat (don't re-render under focus), Should/Actual/Net sorted by Net.
- [ ] Geo tab: Web Mercator rotated to Up, White/OSM/Sea basemaps, pan/pinch per the prototype lessons. Tiles need internet: decide on offline behaviour.
- [ ] Time popup: Period, Stale after. Decide whether live mode needs a race-time slider for scrubbing history.
- [ ] Selection popup clamped to viewport.
- [ ] WebSocket stream (or SK stream subscription) for updates, poll kept as resync.
- [ ] Optimistic nemesis toggle can flicker if a poll started before the PUT returns. Track a pending-edit set and ignore stale values for it.
- [x] Playwright tests: phone and tablet layout (no horizontal or page scroll), nemesis tap persists across reload, scroll survives polling re-renders, outage shows stale and recovers.
- [ ] Playwright tests still to add: pinch and pan (Geo, Vectors), popups clamped to the viewport, TCF input not re-rendered under focus.
- [ ] While stale, per-boat ages freeze at the last snapshot. Age them on the client from `snapshot.now` plus elapsed wall time.
- [ ] `renderBoats` restores `scrollTop`, but the browser test showed `innerHTML` replacement keeps it anyway. Keep the restore as a guard for when list height changes; the test checks behaviour, not that line.
- [ ] Performance budget: about 15 ms per render with 48 boats and a 4 h window.

## Phase 4: persistence and robustness

- [ ] Settings (Show, Up, Mode) server-side or per device? Currently per device in localStorage.
- [ ] Optional track history persistence for restart and post-race replay (bounded size, atomic).
- [ ] Restart and brownout tests: kill mid-write, corrupt state file, empty data dir.
- [ ] Soak test: memory stays bounded over a 72 h replay.

## Phase 5: extras

- [ ] Wind frame and VMG to wind (instrument TWD, or CYCA weather grid for replay).
- [ ] Tracker-feed adapter (CYCA), with a name-to-MMSI mapping table.
- [ ] Post-race replay from stored history.
- [ ] Instrument-display outputs in our own namespace.

## Open decisions (Greg's call)

- [x] Package name: `signalk-nemesis` (plugin id and URL path).
- [ ] Course distance source for TCF Should when live.
- [ ] Own state kept continuously (current choice) vs only at other boats' report times.
- [ ] Which derived values, if any, to publish to the data model.
- [ ] Mapping tracker-feed names to MMSIs.
- [ ] Division filter for Show: AIS has no division, so it needs a per-boat division entered like TCF.
