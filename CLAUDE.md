# CLAUDE.md

Conduct rules for this repository. The project brief is in `wiki/overview.md`; read it before starting any task.

## Verify, don't assert

- Never state a Signal K API, data path, unit, npm package version, Node API or NMEA PGN from memory. Check the signalk-server source, the spec or the package docs first, and cite where you checked.
- If you can't verify something, say so plainly and mark it `TODO(verify)` in code. Don't hedge silently.
- Don't build on an unverified premise. If an earlier assumption turns out wrong, say so and unwind what depended on it.

## Signal K discipline

- Always be explicit about which layer you mean: **data model path**, **REST endpoint**, **WebSocket PUT handler**, or **internal plugin state**. Never blur them.
- Use SI units everywhere internally and on the wire: radians, m/s, metres, seconds. Convert to knots, degrees and nm only at the UI edge.
- Don't publish under other vessels' contexts. Derived values belong under our own namespace or behind the plugin's own API.
- Target Node 22 (the HALPI2 boat computer is pinned to 22.22.2). Don't use language or runtime features newer than that.
- Never run `npm` inside `~/.signalk`.

## Race-critical behaviour

- Deterministic and predictable during racing. Missing or late data degrades gracefully and never throws.
- Assume brownouts, forced shutdowns and network drops. Persist with atomic writes (write a temp file, then rename). State must survive a restart.
- Never block the event loop. Keep memory bounded (ring buffers with explicit limits).
- Point out race conditions, ordering assumptions and state-divergence risks when you see them, including in your own code.

## Design

- Prefer adapter interfaces and explicit seams for decisions that are deferred (data sources, waypoint source, wind source, persistence).
- Keep distinct concerns separate: ingest vs derivation vs presentation, snapshot vs stream, reception state vs selection state.
- Correctness before elegance. Refactor only when it materially improves structure or reliability.
- Webapp: plain HTML, CSS and JS with no framework, built for unreliable onboard networks (reconnect, resync, tolerate server restarts).

## Testing and done-ness

- Every change comes with tests. Run them before claiming anything works.
- Geometry and handicap maths get unit tests with known worked values (see `wiki/overview.md`).
- UI changes involving layout, touch, gestures or rendering must be checked in a real headless browser (Playwright with Chromium), not reasoned about. Fixes based on reasoning alone failed repeatedly in the prototype.
- Test against the recorded Gold Coast 2026 data through the AIS simulator before claiming a feature works end to end.

## Communication and git

- Be concise and direct. Be critical in reviews rather than polite.
- No em dash characters in docs, code comments or commit messages.
- Small, focused commits. Don't push, publish or tag without asking.
- Ask when a decision is genuinely Greg's (scope, UX, data semantics). Otherwise make the conventional choice and say what you chose.
