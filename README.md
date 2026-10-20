# Nemesis Delta (signalk-nemesis)

A Signal K server plugin and webapp that tracks how nearby competitors (your nemesis boats)
are sailing relative to you during a race, from AIS and, for CYCA races, the CYCA race tracker
(picked on the CYCA tab; it needs internet). It answers: who is going faster toward
where we are heading, who is gaining or losing on us, and who is beating us on handicap.

The design brief is in [`wiki/overview.md`](wiki/overview.md); work in progress is in
[`TODO.md`](TODO.md).

---

## Development: deploying to a local server as a test

The plugin has no runtime dependencies, so a checkout can be loaded by a server as it is:
the server finds plugins and webapps in `<config dir>/node_modules/` by their
`signalk-node-server-plugin` and `signalk-webapp` keywords (signalk-server
`src/modules.ts`, `modulesWithKeyword`). A plain symlink is enough; no `npm` is needed in
the server's config directory.

The recipe below was checked with signalk-server 2.30.0 on Node 22.22.2 (the HALPI2
versions), from an empty config directory.

### 1. A scratch server with its own config directory (recommended)

This keeps your real `~/.signalk` untouched. Pick any directory, here `~/sk-dev`:

```text
mkdir -p ~/sk-dev/server ~/sk-dev/config/node_modules ~/sk-dev/config/plugin-config-data
cd ~/sk-dev/server
npm init -y
npm install signalk-server@2.30.0
ln -s ~/src/signalk-nemesis ~/sk-dev/config/node_modules/signalk-nemesis
```

In this layout npm puts the server's bundled plugins in `~/sk-dev/server/node_modules/@signalk/`,
where the server does not look (it scans `<config dir>/node_modules/` and its own
`node_modules/`, signalk-server `src/modules.ts` `getModulePaths`). Link any you need, e.g. the
resources provider for waypoints such as the `nemesis` fallback:

```text
mkdir -p ~/sk-dev/config/node_modules/@signalk
ln -s ~/sk-dev/server/node_modules/@signalk/resources-provider ~/sk-dev/config/node_modules/@signalk/
```

Enable the plugin before the first start (or do it later in the admin UI, see step 2):

```text
echo '{"enabled":true,"configuration":{}}' \
  > ~/sk-dev/config/plugin-config-data/signalk-nemesis.json
```

Start the server on a port of your choice, with that config directory:

```text
cd ~/sk-dev/server
PORT=3399 npx signalk-server -c ~/sk-dev/config
```

To run on exactly the boat's Node version: `PORT=3399 npx -y -p node@22.22.2 node
node_modules/.bin/signalk-server -c ~/sk-dev/config`.

A fresh config has security off (the data feed in step 3 also works with it on). An
`EADDRINUSE :::10110` message only means another server already owns the NMEA 0183 TCP port;
it is harmless here.

### 2. Check it loaded

- Admin UI: <http://localhost:3399/admin/>, **Server > Plugin Config > Nemesis Delta**.
  Enable it there if you skipped the config file, and set the options (table below).
- Webapp: <http://localhost:3399/signalk-nemesis/> (also listed under **Webapps**).
- API: <http://localhost:3399/signalk/v1/api/nemesis/snapshot> returns JSON.

### 3. Feed it the recorded race

With no boats around, feed the seeded AIS simulation of the Gold Coast 2026 race (our boat
is Kanreki, MMSI 503029690; the other boats get made-up MMSIs) into the server over its
WebSocket:

```text
cd ~/src/signalk-nemesis
node test/sim/live-feed.js --url ws://127.0.0.1:3399 --hours 6 --live
```

`--hours 6` puts "now" 6 hours into the race; that history is sent at once, then `--live`
keeps sending in real time (Ctrl-C stops it). It sends the boat names, our own position
and the finish as an NMEA RMB next waypoint, but no start time: set one on the TCF tab
(**Now**, or a date and time) or run signalk-racer alongside.

With security on, add `--user <name>` (a user with read/write or admin permission). It
prompts for the password, logs in and sends with that token; the password can also be piped
in (`echo pw | node test/sim/live-feed.js ... --user admin`). Without it a secured server
silently drops the data. Only feed a test server: the feed sends our own position and a next
waypoint, which on a boat would mix with the real instruments.

### 4. Edit, reload, repeat

- Changes under `public/` (the webapp) need only a browser reload with cache bypass
  (Ctrl+Shift+R).
- Changes to `index.js` or `lib/` need a server restart (Ctrl-C and start it again). The
  plugin's state (nemesis list, TCFs, start time override, 5 days of track history) is kept
  in `~/sk-dev/config/plugin-config-data/signalk-nemesis/` and survives restarts; delete that
  directory to start clean.

### Using an existing local server instead

The same symlink works in an existing server's config directory, typically `~/.signalk`:

```text
ln -s ~/src/signalk-nemesis ~/.signalk/node_modules/signalk-nemesis
```

then restart the server and enable the plugin in the admin UI. Caveats:

- Don't run `npm install` or `npm link` there for this. The link is not in
  `~/.signalk/package.json`, so an npm run in that directory (including installing or
  updating any plugin from the Appstore) can remove it as extraneous: checked with a copied
  (unpacked) plugin, which npm 10 removed; a symlink is expected to go the same way. Look
  with `readlink -f ~/.signalk/node_modules/signalk-nemesis` and recreate it if gone.
- With security on, feed with `--user` (step 3), and the webapp asks you to log in (the
  "login needed" link goes to the server's login page).

### Installing on a boat

From the Signal K admin UI: **Appstore > Available**, find **Nemesis Delta**
(`signalk-nemesis`), **Install**, then restart the server. The Appstore lists npm packages
with the `signalk-node-server-plugin` keyword (signalk-server 2.30.0 `src/modules.ts`
searches the npm registry for it), so a new release shows there once npm has indexed it.

### Installing from a package file (e.g. Windows 10, or a build not on npm)

Install it from a package file the same way the Appstore installs plugins (npm in the
server's config folder), so it is recorded in that folder's `package.json` and survives
later Appstore installs.

1. Download `signalk-nemesis-<version>.tgz` from the
   [GitHub releases](https://github.com/gregw/signalk-nemesis/releases), or build it on a
   development machine: `npm run pack` makes `dist/signalk-nemesis-<version>.tgz` (about
   100 kB: the plugin and webapp only, no tests or test data).
2. Copy it to the boat computer, into the Signal K config folder: the one holding
   `settings.json`, `package.json` and `plugin-config-data`. On a plain Node install that is
   `%USERPROFILE%\.signalk`; the Signal K Windows installer may put it elsewhere
   (TODO(verify)).
3. In a Command Prompt in that folder:

   ```text
   npm install signalk-nemesis-<version>.tgz
   ```

   `npm` must be the one belonging to the Node.js the server runs on (TODO(verify): how the
   Windows installer exposes it on the PATH).
4. Restart the server (admin UI **Restart**), then **Server > Plugin Config > Nemesis
   Delta**: enable it and fill in the boats and waypoint names. The webapp is under
   **Webapps**, or `http://<boat computer>:3000/signalk-nemesis/`.

To update, copy the new `.tgz` and run the same `npm install` (a rebuilt package with the
same version number does replace the old one); restart the server. To remove:
`npm uninstall signalk-nemesis` in the same folder.

Checked on Linux with signalk-server 2.30.0 and Node 22.22.2 (not yet on Windows): installed
from the package into a fresh config folder, found and enabled, fed with the simulated race
(47 boats); a later unrelated npm install in the folder kept it. Don't unpack or copy the
plugin folder into `node_modules` by hand: that copy was removed by the next npm install.

The plugin needs Node 22 or newer (`engines`); the server's Node version is at the bottom of
the admin UI. On older Node npm warns and the plugin is untested.

### Without a Signal K server

A stand-in server runs the plugin on the simulated race and serves the webapp, for quick UI
work:

```text
node test/sim/dev-server.js 3300 6     # port, hours into the race
```

then open <http://127.0.0.1:3300/signalk-nemesis/>.

### Tests

```text
npm test                  # unit and end-to-end replay tests (node:test)
npm run test:browser      # webapp in headless Chromium (Playwright)
npm run test:node22       # both, on Node 22.22.2
```

The first browser run on a machine needs `npm install` in the checkout and
`npx playwright install chromium`. `npm run format` applies the code style.

---

## Configuration

| Option                     | Meaning                                                                         | Default        |
|----------------------------|---------------------------------------------------------------------------------|----------------|
| `boats`                    | Nemesis boats entered in advance: `{mmsi, name, tcf}`. See below                | none           |
| `staleSeconds`             | A boat is stale (greyed, lines broken) after this long without a report         | 1800           |
| `historyHours`             | Track history kept in memory and on disk                                        | 120 (5 d)      |
| `recentHours`              | Full resolution window; older history is thinned                               | 6              |
| `thinSeconds`              | One report per boat per this interval in older history                          | 120            |
| `maxReportsPerBoat`        | Hard cap per boat                                                               | 5000           |
| `maxBoats`                 | Hard cap on boats tracked                                                       | 500            |
| `ownSampleSeconds`         | Minimum interval between stored own-boat samples                                | 1              |
| `tcfVmgSeconds`            | TCF Should: VMG to the waypoint smoothed over this long                         | 600 (10 min)   |
| `maxRaceHours`             | Ignore a start time older than this                                             | 96             |
| `waypointOrder`            | Next waypoint: `course,nmea` (Course API first) or `nmea,course`                | `course,nmea`  |
| `nmeaWaypointStaleSeconds` | Ignore an NMEA next point not updated for this long                             | 30             |
| `waypointNames`            | Fallback waypoints (resources, by name): the first found is the waypoint when neither the Course API nor NMEA has one; each found can be picked as Up. Also the course until one is set on the Course tab | `[nemesis]` |

Boats entered in advance (`boats`) are made nemeses with their TCF when they are added, and
their TCF is set again when it is changed in the configuration. What was applied is
remembered, so a restart (or a brownout) with the same configuration never undoes changes
made in the webapp since. Removing a boat from the list leaves it as it is. A configured name
is shown in this plugin instead of the name the boat sends over AIS (the snapshot's `aisName`
keeps that, and the boat popup shows it); the Signal K data model is not changed.

The course for Up = Course is set on the webapp's **Course** tab and kept by the plugin
(`course.json` in its data folder), so every screen shares it: add waypoints and move them up
and down, or import a Signal K route (it replaces the course). A mark passed twice, out and
back, is listed twice. Waypoint marks follow the waypoint if it is moved in the chart app;
route points that are not waypoints stay where they were imported. Until a course is set
there, `waypointNames` is the course, as in earlier versions.

The webapp's **Show** filter has a **Sailing** choice for busy harbours: it hides boats whose
AIS ship type is known and is not Sailing (36), so Pleasure (37) too, boats under 0.5 kn and
boats out of range, but always shows nemesis and configured boats. A boat that has not sent a
ship type yet is shown.

## Interfaces

- **REST (read):** `GET /signalk/v1/api/nemesis/snapshot`, `/tracks?periodS=&toT=&sinceT=`,
  `/user`, `/course` (the course, resolved), `/course/waypoints` and `/course/routes` (what
  the Course tab can add), and for the CYCA tracker `/cyca` (poll state), `/cyca/races` (`?refresh=1` reads
  the feed first) and `/cyca/mapping` (also at `/plugins/signalk-nemesis/*`, which is admin
  only when security is on).
- **PUT handlers (write, need read/write access):** `navigation.racing.nemesis.setNemesis`
  `{id, nemesis}`, `.setTcf` `{id, tcf}` (id `self` is our boat), `.setStartTime`
  `{startTime: RFC 3339 | null}`, `.setCycaRace` `{raceId | null}`, `.setCycaLink`
  `{name: CYCA boat name, mmsi | null}`, `.setCycaNoAis` `{entryId, noAis}`, `.setCourse`
  `{marks: [{name, waypointId?, lat?, lon?}]}` or `{routeId}`. As REST: `PUT /signalk/v1/api/vessels/self/navigation/racing/nemesis/setTcf`
  with body `{"value": {...}}`.
- **Consumed:** other vessels' AIS position, COG, SOG and name; our position, COG, SOG,
  heading; the Course API and waypoint/route resources; NMEA next point
  (`navigation.courseRhumbline|courseGreatCircle.nextPoint.*`); signalk-racer's
  `navigation.racing.startTime`; our vessel name (to find our own CYCA entry).
- **Fetched (only with a CYCA race picked):** `https://feeds.cycaracing.com/v2/...`, the
  race list when the CYCA tab asks for it, the race's fleet every 10 minutes while it runs,
  and a nemesis boat's track when its history has a gap.
- **Published to the data model:** nothing yet.

All values are SI on the wire (radians, m/s, metres, epoch ms); the webapp converts to
knots, degrees and nm.
