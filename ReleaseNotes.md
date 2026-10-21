## 0.3.0 CYCA race tracker
 + Optional second source: the CYCA race tracker (the YB units on the Sydney Gold Coast, the
   Hobart and the Blue Water Pointscore races), for boats beyond AIS range. It needs internet.
   The SIs allow reading it while racing (2025 NSGCYR SI 10.3, the BWPS addition to RRS 41).
 + New CYCA tab: pick the race from a menu of current and upcoming races, with the ones we are
   entered in marked. The plugin then polls the race every 10 minutes while it runs.
 + CYCA boats are linked to their AIS boats on the CYCA tab, so the two show as one boat.
   Suggestions come from AIS boats that were in the same place at the same times over the
   last hour, or that have the same name; 'Link all' takes every clear one. Links are kept
   for the next race and can be undone. The tab is highlighted while a likely match is not
   yet linked.
 + A linked boat's tracker positions fill only the gaps in its AIS track (none within 10
   minutes of an AIS report). Nemesis boats are backfilled from their CYCA tracks over the
   display period, so a boat that went out of range, or a period made longer, fills in.
 + Our own CYCA entry is never shown as a competitor.
 + New Course tab: the course for Up = Course is set in the webapp and kept by the plugin for
   every screen. Add waypoints, move them up and down, or import a Signal K route. Waypoint
   marks follow the waypoint if it is moved. `waypointNames` in the plugin config now only
   names the fallback waypoints, and is the course until one is set on the tab.
 + Up = Course picks each boat's next mark by leg: of the marks ahead of it, the closest whose
   leg from the previous mark heads within 100 degrees of its COG. A mark can be listed twice
   (out and back). Before this, boats heading out on an out-and-back course could pick a mark
   meant for the way back and skip the whole out-and-back in their DTF.
 + Up = Upwind and Downwind: VMG and lead along our true wind direction
   (environment.wind.directionTrue), smoothed over 2 minutes (`windSmoothSeconds`). Without
   wind instruments these say 'no wind'.
 + Geo wind ladder in any Up frame when our true wind is known, about 12 rungs across the
   view, with a Wind box to hide it.
 + Geo shows the course from the Course tab whatever Up is, with a Course box to hide it.
 + Show = Nemesi is now spelt Nemeses. A screen that had it picked starts on Nemeses, the default.
 + Tests leave no temporary directories behind.

## 0.2.1 Show = Sailing
 + Show = Sailing hides boats of a known non sailing AIS ship type, Pleasure craft (type 37)
   included, and boats under 0.5 kn, unless they are a nemesis or configured.

## 0.2.0 Up = Course
 + Up = Course: the named waypoints in order are the course, and each boat's lead and VMG
   are by its distance to finish along it. Each boat picks its own next mark, shown on the
   Boats tab. The old Course (our COG) is now called COG.
 + VMC to the waypoint from a single report when there is no previous one.
 + The README points at the GitHub release download.

## 0.1.0 First release
 + AIS competitors relative to us, on four tabs: Boats (VMG and lead toward Up, as strip
   charts), TCF (time-on-time Should, Actual and Net), Vectors and Geo.
 + Up = Waypoint (the active next point, or named waypoints, each pickable by hand), COG or
   North.
 + Nemesis boats and their TCFs can be entered in advance in the plugin config; the nemesis
   list, TCFs and track history are kept on the server and survive restarts.
