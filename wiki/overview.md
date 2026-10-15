# Nemesis Delta: project brief

A Signal K server plugin and webapp that tracks how nearby competitors are sailing relative to us during a race, using AIS (and optionally race tracker feeds). It answers three questions in real time: who is going faster toward where we are heading, who is gaining or losing on us, and who is beating us on handicap.

The behaviour and UI were worked out in a standalone HTML prototype (`prototype/nemesis-delta.html`). This repo turns that into a production plugin. The prototype is the UI specification; this document is the behavioural specification.

## 1. Context

- **Boats:** Kanreki (Cookson 12, sail 7709, Vesper Cortex M1 AIS transponder, B&G H5000, Expedition on a Windows PC with an Actisense NGT-1) and Esprit (Archambault Grand Surprise, MYC-32, HALPI2 boat computer).
- **Primary runtime:** signalk-server 2.x (2.30.0 on HALPI2), Node 22.22.2 pinned on HALPI2 because of a canboatjs WASI regression on newer Node. Kanreki will run Signal K on the nav PC via the NGT-1.
- **Operating environment:** intermittent power and brownouts, unreliable WiFi, tablets and phones as displays. Race-critical: it must keep working and never mislead when data is missing.
- **Related plugin:** `signalk-racer` (start line, timer, next leg). Nemesis Delta is a separate plugin and must not depend on racer internals. It may consume racer's or the course API's published paths.

## 2. Data sources

### 2.1 AIS (primary)

Other vessels arrive as separate Signal K contexts. `TODO(verify)` the exact context and path names against the server: expected `vessels.urn:mrn:imo:mmsi:<MMSI>` with `navigation.position`, `navigation.courseOverGroundTrue` (rad), `navigation.speedOverGround` (m/s) and `name`.

Characteristics:

- Reports arrive irregularly, typically every 3 to 5 minutes for a Class B sailing boat (shorter for Class A when moving fast). Reports go missing.
- Range is limited. From our VHF antenna, assume reliable to about 8 nm and patchy out to about 20 nm.
- **AIS carries no DTG.** Distance to the waypoint must be computed by us, from their position to our active waypoint. VMC is derived from that.

### 2.2 Own vessel

Our own position, COG, SOG and (where available) heading, STW and true wind come from our own instruments continuously. **Whenever another boat reports, we always have our own exact state at that moment.** Every relative calculation compares their report with our state at their report time, never with our state "now".

### 2.3 Race tracker feeds (secondary, optional)

The prototype used the CYCA race-tracker backend (reverse-engineered):

- `GET https://feeds.cycaracing.com/Yachts/<raceId>?raceTime=YYYYMMDDHHMMSS`. `raceTime` is local time (AEST, UTC+10) and returns the whole fleet "as at" that time.
- Each boat has `Position { Latitude, Longitude, SpeedOverGround, CourseOverGround, DistanceToGo, DistanceToLeader, RaceStatus }` (SOG and COG arrive as strings).
- `/Weather?raceTime=...` returns a U/V wind grid. It is unused so far, and its timeline appears to be UTC while positions are local.
- `pull-gc2026.mjs` walks the 10-minute grid and writes `gc2026-tracks.json`.

A tracker feed is a second implementation of the same source adapter as AIS (see section 4). It is useful offshore beyond AIS range, but needs internet.

### 2.4 Recorded test data

`test/data/gc2026-tracks.json` holds the Noakes Sydney Gold Coast 2026 race (race id 194): 48 boats, start 13:00 25 Jul 2026 AEST, 439 samples per boat on an exact 10-minute grid to 14:00 28 Jul. Every sample is a fresh fix while racing; repeated positions only occur after a boat finishes. The 10-minute regularity comes from how the data was pulled, not from the trackers.

Schema:

```json
{ "race": { "id": 194, "name": "...", "start": "2026-07-25T13:00:00+10:00", "tz": "+10:00" },
  "step_s": 600,
  "sample_fields": ["t","lat","lon","sog_kn","cog_deg","dtg_nm","dtl_nm"],
  "boats": [ { "id": 18921, "name": "...", "club": "...", "owner": "...",
               "categories": [ { "name": "IRC", "division": "1" } ],
               "samples": [ ["2026-07-25T13:00:00+10:00", -33.85, 151.28, 8.1, 35, 380.2, 0.0] ] } ] }
```

Kanreki and Calibre 12 are both Cookson 12s in this fleet, which makes them a natural head-to-head test pair.

## 3. Core concepts and definitions

All formulas below are as implemented and validated in the prototype. Implement them in SI internally.

### 3.1 Up reference (frame)

The user picks what "up" means; it drives the vector plot rotation, the map rotation, VMG, and the lead/distance metrics.

| Frame | Up direction | Status |
|---|---|---|
| Waypoint | bearing from our position to the active waypoint | in prototype the waypoint is the finish (min-DTG fix); live: course API next point, `TODO(verify)` path |
| Course | our COG | done |
| North | true north | done |
| Wind | true wind direction | needs wind data; disabled in prototype |

The waypoint must come from a single `waypoint()` seam. The prototype has `waypoint(){ return FINISH; }`; the plugin reads the active course next point (Course API or NMEA), then a waypoint resource named in the configuration (default `nemesis`). With none, there is no waypoint and the waypoint based values are not shown (decided 2026-10-16: no fixed lat/lon fallback).

### 3.2 VMG toward Up

- Waypoint: VMC, the rate of change of the boat's distance to the waypoint between its own consecutive reports, positive when closing. Use the boat's own previous report, not a timeline step, and ignore gaps longer than the stale threshold.
- Course: `SOG x cos(COG_boat - COG_us)`, with our COG taken at their report time.
- North: `SOG x cos(COG)`.
- Wind: `SOG x cos(COG - TWD)` (to do).
- Relative mode shows the boat's VMG minus ours at the same time.

### 3.3 Lead toward Up (+ = they are ahead)

- Waypoint: `DTG_us - DTG_boat`, with both measured to the same waypoint at their report time.
- Course: the displacement from us to them projected on our COG.
- North: the northward displacement.

### 3.4 Staleness and reception

- `STALE_MIN` is configurable, default 30 minutes.
- A boat is **current** if its latest report is no older than `STALE_MIN`. Its current position is that latest report.
- Gaps shorter than `STALE_MIN` are bridged: no greying out, lines drawn straight across. Gaps longer than that break lines and grey the boat out.
- **In range** means received within `STALE_MIN`. It is time-dependent, so recompute it continuously.

### 3.5 Nemesis list

- There is a single list: the boats we care about. It is the only per-boat selection.
- What is displayed is a separate filter, **Show**: Nemesi (default), All, In range, Div (our division), or None (just us). Our own boat is always shown.
- Persist the list server-side in plugin config or the data dir, keyed by MMSI with the name as fallback, so it survives restarts and new races.

### 3.6 Handicap (TCF, time-on-time)

- Each boat has a TCF (default 1.000), entered by the user and persisted server-side, keyed by MMSI or name.
- Elapsed time `E` is measured from race start (prototype: the first sample). Corrected time `C = E x TCF`.
- **Should** (nm the boat must be ahead to be level on corrected time, if the race ended at its report; decided 2026-10-15, replacing a distance-from-start form that was too hard on complex courses and mixed many speeds): the time owed over the elapsed time, as a distance at the VMG of the boat that would be trailing at the finish.
  - It owes us (`TCF_boat > TCF_us`): `dt = E x (TCF_boat / TCF_us - 1)`, `Should = + VMG_us x dt` (it must be ahead).
  - We owe it (`TCF_boat < TCF_us`): `dt = E x (TCF_us / TCF_boat - 1)`, `Should = - VMG_boat x dt` (it may be behind).
  - VMG is VMC to the waypoint in use, smoothed over `tcfVmgSeconds` (default 600) at the boat's report time. Unknown or not positive: Should is not shown.
- **Actual** is the lead toward Up (3.3). **Net = Actual - Should**; positive means they are beating us on handicap. Sort the TCF list by Net.
- Worked values for tests: E = 6 h, TCF_us = 1.000, TCF_boat = 1.100, our VMG 6 kn: Should = +3.6 nm. TCF_us = 1.100, TCF_boat = 1.000, its VMG 8 kn: Should = -4.8 nm.
- Caveat: Should is toward the waypoint. It is only strictly comparable with Actual when Up = Waypoint.

### 3.7 Vector plot

- Each boat's velocity vector is drawn in the chosen frame: in Absolute mode the origin is zero velocity; in Relative mode the origin is us (their velocity minus ours, so current and leeway cancel).
- Comet tails join successive reports over the period window. Their width and opacity taper with the **age of each segment's endpoints** (by timestamp, not by index), so irregular AIS cadence renders correctly.
- When a boat is selected, its true velocity vectors (origin to each hull icon) are drawn as dashed shafts, which shows that the tail is not the velocity.
- Auto-fit: the origin plus all shown boats and tails, with a 10% margin.

## 4. Architecture

```
            +-------------------+     +--------------------+
 AIS ctx -->| AisSourceAdapter  |     | TrackerFeedAdapter |--> (CYCA, Yellow Brick ...)
            +---------+---------+     +---------+----------+
                      |   normalised Report {id, t, pos, cog, sog, src}
                      v                         v
                 +--------------------------------------+
                 | TrackStore (per boat ring buffers)   |<-- OwnState history (1 Hz)
                 +------------------+-------------------+
                                    v
                 +--------------------------------------+
                 | Derivation: frame, VMG, lead, TCF,   |<-- waypoint(), wind(), config
                 | staleness, in-range                  |
                 +------------------+-------------------+
                                    v
             REST snapshot + history  /  WebSocket stream  -->  Webapp
```

- **Source adapters** normalise to `Report {boatId, t, lat, lon, cogRad, sogMs, src}`. Boat identity is MMSI for AIS, with a name-to-MMSI mapping table for tracker feeds.
- **OwnState** keeps a bounded 1 Hz history (or sample-on-arrival) so we can look up our exact state at any report time.
- **TrackStore** is a ring buffer per boat with explicit caps on time span and count. It needs a lookup for "latest report at or before t".
- **Derivation** functions are pure and unit-tested. They take reports plus own state plus config and return values.
- **Persistence** covers the nemesis list, TCFs and settings, written atomically to the plugin data dir. Track history is optional (it is useful for post-race replay, but bound its size).
- **API:** REST snapshot and history endpoints for the webapp, plus a WebSocket stream of updates. `TODO(verify)` the current plugin router and webapp registration conventions in signalk-server 2.x before designing endpoints. Keep REST, PUT and model paths clearly separated.
- **Publishing to the data model:** optional and narrow, for example a "nearest nemesis lead" for instrument displays. Use our own namespace only; never write into other vessels' contexts.

## 5. Webapp (port of the prototype)

Plain JS with no framework, built for phones and tablets first.

- **Common bars:** Us selector; Mode (Absolute or Relative) and Up as dropdowns; a Time button that opens a popup with race time (slider on its own line, with ‹ Play ›), Period (0 to 240 min) and Stale after; and a Show filter with the fleet count.
- **Tabs, in this order:** Boats, TCF, Vectors, Geo (TCF moved second, decided 2026-10-15). The app opens on Boats.
- **Boats tab:**
  - Sort by Near, Waypoint (DTG), VMG (fastest toward Up first) or A-Z.
  - Each row has a boat icon (tap to toggle nemesis, highlighted when a nemesis), the name over SOG/COG, and two strip charts: VMG toward Up, and lead toward Up.
  - Strip charts put the newest point on the left, taper with age, and draw a dot plus the value above the latest point.
  - Each chart is centred on its own data, but every chart in a column shares one window height, shown in the column header.
- **Vectors tab:** see 3.7. Boat-hull icons point along velocity; ours is the special dark hull.
- **TCF tab:** a TCF entry box per boat, then Should, Actual and Net (Net coloured), sorted by Net.
- **Geo tab:**
  - Web Mercator, rotated to Up, with the waypoint marker. Basemaps are White, OSM, and Sea (Esri Ocean base plus the OpenSeaMap seamark overlay).
  - Pan with one finger or the mouse; zoom with pinch or the wheel. A gesture in Relative mode switches to Absolute.
  - Tapping a boat selects it; tapping water clears the selection.
- **Selection:** tapping a boat shows a compact popup with a close button that keeps the highlight. Any other tap clears the highlight.

### Lessons from the prototype (do not relearn these)

- Never let re-rendered SVG children be the target of an in-progress gesture. Set `pointer-events: none` on rendered content, keep a persistent root as the gesture target, and hit-test boats in code.
- Pinch must be computed from the state at the moment the second finger landed, not applied step by step (that drifts into a pan). Keep the point under the fingers fixed.
- Pointer capture mishandles a second finger on some browsers. Native touch events were reliable for pinch.
- Preserve list scroll position across re-renders, and don't re-render under a focused input.
- Clamp popups to the viewport. Lock horizontal page overflow on mobile.

## 6. Testing strategy

- **Unit:** frames, VMG, lead, VMC from own previous report, staleness bridging, TCF formula (worked value in 3.6), and circular COG interpolation (350 to 010 passes through 000).
- **Replay harness:** feed `gc2026-tracks.json` through an **AIS simulator** into the real pipeline:
  1. Interpolate each boat to 1-minute samples (linear for position, SOG and DTG; the short way round for COG).
  2. Keep each sample with probability 1/3, giving AIS-like gaps (measured on GC2026: median 2 min, 90th percentile 7 min).
  3. Drop by range from the receiver: always kept within 8 nm, drop chance rising linearly to 1 at 20 nm.
  4. Keep the receiver's own state at every report time.

  Use a seeded RNG so tests are deterministic.
- **Browser:** Playwright with headless Chromium for layout, touch, pinch, scroll and persistence checks (the prototype's test approach).
- **Performance budget:** around 15 ms per render with 48 boats and a 4-hour window was achieved in the prototype; don't regress it.

## 7. Phasing

1. **Skeleton:** plugin scaffold, config schema, AIS adapter, OwnState, TrackStore, staleness. A REST snapshot endpoint, and unit tests on replay data.
2. **Derivations:** frames, VMG, lead, TCF, in-range, all as pure tested functions.
3. **Webapp port:** Boats and Vectors first, then TCF and Geo, reading live data from the plugin API.
4. **Persistence and robustness:** nemesis list, TCFs and settings saved atomically; restart and brownout tests.
5. **Extras:** wind frame and VMG-to-wind (true wind from instruments, or the CYCA weather grid for replay); a tracker-feed adapter; post-race replay from stored history; instrument-display outputs.

## 8. Open decisions (Greg's call)

- Package name: `signalk-nemesis` (decided 2026-10-15; also the plugin id and URL path).
- TCF Should: decided 2026-10-15 as time owed at the trailing boat's smoothed VMG (3.6). The earlier course-distance form (route, named start waypoint, configured distance) was dropped.
- Next waypoint precedence between the Course API and raw NMEA: decided 2026-10-15, configurable (`waypointOrder`), default Course API first.
- Own state: decided 2026-10-15, both. Continuously for the recent window, and stored with each report.
- Track history persistence: decided 2026-10-15, append-only journal in the plugin data dir, 5 days by default.
- Strip chart sign: decided 2026-10-15, positive always means the other boat is doing better than us (ahead, or faster toward Up), so negative is good for us. This applies in every frame and to both columns. The prototype's Waypoint strip chart (`distMetric`) has the sign reversed and its North chart plots range; the port follows 3.3 instead.
- Which derived values, if any, to publish into the Signal K data model for instrument displays.
- How to map tracker-feed boat names to MMSIs.

## 9. Repo contents to bring across

- `prototype/nemesis-delta.html`: the UI and behaviour reference.
- `prototype/nemesis-delta-gc2026.html`: the same, with the race built in.
- `tools/pull-gc2026.mjs`: the CYCA feed puller.
- `test/data/gc2026-tracks.json`: the recorded race.
