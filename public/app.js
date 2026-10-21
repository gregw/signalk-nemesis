'use strict';
/* global UNITS, GEO, DERIVE, DRAW */
/*
 * Nemesis Delta webapp core: data, time window, selection and the common controls.
 * Plain JS, no framework. The tabs (tab-*.js) register a render(view) function in ND.tabs.
 *
 * Data: polls the plugin's REST snapshot (names, nemesis, TCFs, waypoint, start time,
 * TCF VMG period, our state now) and track history (reports per boat plus our own
 * track). One poll in flight at a time, each request with a timeout; failures back off
 * exponentially and the last good data stays on screen marked stale. Tracks are fetched
 * incrementally (sinceT, with an overlap for late reports) and fully resynced every
 * minute or when the window changes. A server restart is just another failure.
 *
 * Time: live by default; the Time popup can look back through the server's history
 * (toT). All derivations come from public/derive.js, in SI; units convert only here.
 * TODO: WebSocket stream for lower latency, with this poll as the resync path.
 */

// eslint-disable-next-line no-unused-vars
const ND = (() => {
    // Reads: the plugin's routes on the Signal K API mount, which ordinary (non-admin)
    // accounts can read when security is on. Writes: Signal K PUT handlers.
    const API = '/signalk/v1/api/nemesis';
    const PUT_BASE = '/signalk/v1/api/vessels/self/navigation/racing/nemesis/';
    const LOGIN_URL = '/admin/#/login';
    // ?poll=<ms> overrides the interval (used by browser tests; floor of 200 ms).
    const POLL_MS = Math.max(200, Number(new URLSearchParams(location.search).get('poll')) || 5000);
    const TIMEOUT_MS = 8000;
    const MAX_BACKOFF_MS = 30000;
    const RESYNC_MS = 60e3; // full tracks refetch, catching anything incremental polls missed
    const OVERLAP_MS = 120e3; // incremental fetch re-asks this far back, for late reports
    const US_GAP_MS = 60e3; // our state counts as "at" a time if sampled within this
    const STEP_MS = 10 * 60e3; // the Time popup's back and forward buttons
    // Show = Sailing: AIS ship types kept (36 Sailing; signalk-schema design.json; 37 Pleasure
    // is hidden: decided 2026-10-16)
    // and the speed below which a boat counts as moored.
    const SAILING_TYPES = new Set([36]);
    const MOORED_SOG_MS = (0.5 * 1852) / 3600;
    const PREFS_KEY = 'nd_prefs';
    const OWN_ID = 'self';

    const $ = (id) => document.getElementById(id);

    const prefs = Object.assign(
        {
            tab: 'boats',
            mode: 'abs',
            up: 'waypoint',
            periodMin: 60,
            staleMin: 30,
            show: 'nemeses',
            sort: 'near',
            base: 'white',
            ladder: true, // Geo wind ladder
            courseLine: true // Geo course
        },
        loadPrefs()
    );
    // A stored Show value not offered (e.g. 'nemesi', the old misspelling) is ignored.
    if (!['nemeses', 'sailing', 'all', 'inrange', 'none'].includes(prefs.show)) prefs.show = 'nemeses';
    if (typeof prefs.ladder !== 'boolean') prefs.ladder = true;
    if (typeof prefs.courseLine !== 'boolean') prefs.courseLine = true;
    // Up 'course' used to mean our COG (now 'cog'); 'course' is now the course of marks.
    if (!prefs.upV) {
        if (prefs.up === 'course') prefs.up = 'cog';
        prefs.upV = 2;
    }

    const M = {
        snap: null, // last good snapshot
        fetchedAt: 0, // wall time it arrived
        boats: new Map(), // id -> reports [{t, lat, lon, cogRad, sogMs}] sorted by t
        us: [], // our own samples, sorted by t
        maxT: null, // newest report time held (for incremental fetches)
        tracksKey: '', // which window the held tracks describe
        tracksAt: 0, // wall time of the last full tracks fetch
        filled: null, // the plugin's backfill count at the last snapshot
        viewT: null // null = live; else the time being looked at (epoch ms)
    };

    let lastOkAt = 0;
    let failures = 0;
    let pollTimer = null;
    let inFlight = false;
    let again = false; // a poll was asked for while one was in flight
    let authNeeded = false;
    let sel = null; // selected boat id (highlight + popup), shared by all tabs
    // Optimistic edits not yet confirmed: re-applied over every snapshot so a poll that
    // started before the PUT can't flicker them back.
    const pendingNemesis = new Map();
    const pendingTcf = new Map();
    const tabs = {};

    /* ---------- prefs (per-viewer convenience only; the server holds real state) ---------- */
    function loadPrefs() {
        try {
            return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
        } catch (e) {
            return {};
        }
    }
    function savePrefs() {
        try {
            localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
        } catch (e) {
            /* private mode etc. */
        }
    }

    /* ---------- time window ---------- */
    const staleMs = () => prefs.staleMin * 60e3;
    const tcfVmgMs = () => (M.snap && M.snap.tcfVmgMs > 0 ? M.snap.tcfVmgMs : 600e3);
    const periodMs = () => prefs.periodMin * 60e3;
    // Tracks held cover the period plus enough before it to know who is current.
    // Fetch a little before the window, for the TCF tab's smoothed VMG at its oldest points.
    const spanMs = () => Math.max(periodMs(), staleMs()) + Math.max(10 * 60e3, tcfVmgMs());
    function liveNow() {
        return M.snap ? M.snap.now + (Date.now() - M.fetchedAt) : Date.now();
    }
    function nowT() {
        return M.viewT != null ? M.viewT : liveNow();
    }

    /* ---------- networking ---------- */
    async function fetchJson(url, opts = {}) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
        try {
            const r = await fetch(url, {...opts, signal: ac.signal, cache: 'no-store'});
            if (!r.ok) {
                const e = new Error('HTTP ' + r.status);
                e.status = r.status;
                throw e;
            }
            return await r.json();
        } finally {
            clearTimeout(timer);
        }
    }

    async function poll() {
        if (inFlight) {
            again = true;
            return;
        }
        inFlight = true;
        try {
            const snap = await fetchJson(API + '/snapshot');
            // A backfill filled in history (a new nemesis): fetch the tracks in full now,
            // not at the next resync, as the incremental fetch only asks for newer reports.
            const filled = snap.cyca ? snap.cyca.filled : null;
            if (filled != null && M.filled != null && filled !== M.filled) M.tracksKey = '';
            M.filled = filled;
            M.snap = applyPending(snap);
            M.fetchedAt = Date.now();
            syncUpOptions();
            await fetchTracks();
            lastOkAt = Date.now();
            failures = 0;
            authNeeded = false;
        } catch (e) {
            failures++;
            authNeeded = e.status === 401 || e.status === 403;
        } finally {
            inFlight = false;
        }
        render();
        if (again) {
            again = false;
            setTimeout(poll, 0);
        } else schedule();
    }

    function schedule() {
        clearTimeout(pollTimer);
        const delay = failures ? Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** (failures - 1)) : POLL_MS;
        pollTimer = setTimeout(poll, delay);
    }

    function wantedKey() {
        const s = Math.ceil(spanMs() / 1000);
        return M.viewT != null ? `at:${M.viewT}:${s}` : `live:${s}`;
    }

    async function fetchTracks() {
        const key = wantedKey();
        const spanS = Math.ceil(spanMs() / 1000);
        let q;
        let full = true;
        if (M.viewT != null) {
            if (key === M.tracksKey) return; // a past window doesn't change
            q = `periodS=${spanS}&toT=${Math.round(M.viewT)}`;
        } else {
            full = key !== M.tracksKey || M.maxT == null || Date.now() - M.tracksAt > RESYNC_MS;
            q = full ? `periodS=${spanS}` : `periodS=${spanS}&sinceT=${M.maxT - OVERLAP_MS}`;
        }
        const r = await fetchJson(`${API}/tracks?${q}`);
        // The window may have changed while this was in flight (slider moved): ask again.
        if (key !== wantedKey()) {
            again = true;
            return;
        }
        if (full) {
            M.boats = new Map();
            M.us = [];
            M.maxT = null;
            M.tracksKey = key;
            M.tracksAt = Date.now();
        }
        for (const [id, reps] of Object.entries(r.boats || {})) {
            M.boats.set(id, mergeSeries(M.boats.get(id) || [], reps));
            for (const x of reps) if (M.maxT == null || x.t > M.maxT) M.maxT = x.t;
        }
        M.us = mergeSeries(M.us, (r.own || []).concat(r.ownAtReports || []));
        // Keep memory bounded to the window.
        const from = r.toT - spanS * 1000;
        for (const [id, reps] of M.boats) {
            const k = reps.findIndex((x) => x.t >= from);
            if (k < 0) M.boats.delete(id);
            else if (k > 0) reps.splice(0, k);
        }
        const k = M.us.findIndex((x) => x.t >= from);
        if (k > 0) M.us.splice(0, k);
        else if (k < 0) M.us = [];
    }

    /** Merge items into a sorted series, a duplicate time replacing the older copy. */
    function mergeSeries(series, items) {
        if (!items.length) return series;
        const byT = new Map(series.map((x) => [x.t, x]));
        for (const x of items) byT.set(x.t, x);
        return [...byT.values()].sort((a, b) => a.t - b.t);
    }

    function applyPending(snap) {
        for (const b of snap.boats) {
            if (pendingNemesis.has(b.id)) b.nemesis = pendingNemesis.get(b.id);
            if (pendingTcf.has(b.id)) b.tcf = pendingTcf.get(b.id);
        }
        if (pendingTcf.has(OWN_ID)) snap.tcfUs = pendingTcf.get(OWN_ID);
        return snap;
    }

    /** Signal K PUT: body {value}; the reply's statusCode is the outcome. */
    function put(command, value) {
        return fetchJson(PUT_BASE + command, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({value})
        });
    }

    function noteWriteError(e) {
        if (e.status === 401 || e.status === 403) authNeeded = true;
    }

    async function toggleNemesis(id) {
        const b = M.snap && M.snap.boats.find((x) => x.id === id);
        if (!b) return;
        const want = !b.nemesis;
        pendingNemesis.set(id, want);
        applyPending(M.snap);
        render();
        try {
            await put('setNemesis', {id, nemesis: want});
        } catch (e) {
            noteWriteError(e);
            // Revert locally; the next poll is authoritative.
            const cur = M.snap && M.snap.boats.find((x) => x.id === id);
            if (cur && pendingNemesis.get(id) === want) cur.nemesis = !want;
        } finally {
            if (pendingNemesis.get(id) === want) pendingNemesis.delete(id);
            render();
        }
    }

    async function setTcf(id, tcf) {
        pendingTcf.set(id, tcf);
        if (M.snap) applyPending(M.snap);
        render(true);
        try {
            await put('setTcf', {id, tcf});
        } catch (e) {
            noteWriteError(e);
        } finally {
            if (pendingTcf.get(id) === tcf) pendingTcf.delete(id);
            poll();
        }
    }

    /** iso: RFC 3339 start time override, or null to clear it. Resolves to an error message or null. */
    async function setStart(iso) {
        try {
            const r = await put('setStartTime', {startTime: iso});
            if (r && r.statusCode && r.statusCode !== 200) return r.message || 'refused';
            return null;
        } catch (e) {
            noteWriteError(e);
            return e.status === 401 || e.status === 403 ? 'login needed' : e.message;
        } finally {
            poll();
        }
    }

    /* ---------- the view: everything a tab needs for one render ---------- */
    /*
     * Show = Sailing: nemesis and configured boats always; others when in range, not
     * known to be a non sailing type (no type yet counts as sailing: Class B static data
     * comes only every few minutes) and moving at least MOORED_SOG_MS at the view time.
     */
    function isSailing(b) {
        if (b.nemesis || b.configured) return true;
        if (!b.cur) return false;
        if (b.shipType != null && !SAILING_TYPES.has(b.shipType)) return false;
        return Number.isFinite(b.cur.sogMs) && b.cur.sogMs >= MOORED_SOG_MS;
    }

    function buildView() {
        const s = M.snap;
        const now = nowT();
        const live = M.viewT == null;
        const st = staleMs();
        const {frame, wp} = upChoice(s);
        let {upName} = upChoice(s);
        const ctx = {frame, wp, us: M.us, staleMs: st, usGapMs: US_GAP_MS};
        // Live, our current state is the snapshot's latest sample, and it ends our series too:
        // the fetched track keeps one sample per 30 s (and our state at each report, which
        // can be newer than the snapshot), so its last can differ, and a newest hull drawn
        // from it would sit off Up = COG.
        let usSeries = upTo(M.us, now);
        if (live && s && s.own) {
            let k = usSeries.length;
            while (k > 0 && usSeries[k - 1].t >= s.own.t) k--;
            usSeries = usSeries.slice(0, k).concat([s.own]);
        }
        const usNow = live && s && s.own ? s.own : DERIVE.stateAt(M.us, now, st);
        if (frame === 'course') {
            // Our next mark, and any configured mark the server did not find (a gap in the course).
            if (wp && usNow) upName += ' \u2192 ' + (wp.marks[wp.mark(usNow)].name || '?');
            const missing = ((s && s.course) || []).filter((m) => !m.found).map((m) => m.name);
            if (missing.length) upName += ` (not found: ${missing.join(', ')})`;
        }
        const up = DERIVE.upDir(frame, usNow, wp);
        const all = [];
        all.push({
            id: OWN_ID,
            name: 'Us',
            isUs: true,
            nemesis: false,
            tcf: s ? s.tcfUs || 1 : 1,
            color: DRAW.US_COLOR,
            series: usSeries,
            cur: usNow
        });
        for (const b of s ? s.boats : []) {
            const series = upTo(M.boats.get(b.id) || [], now);
            all.push({
                id: b.id,
                name: b.name || b.id,
                aisName: b.aisName && b.aisName !== b.name ? b.aisName : null, // configured name differs
                isUs: false,
                nemesis: b.nemesis,
                tcf: b.tcf || 1,
                configured: !!b.configured,
                shipType: b.shipType == null ? null : b.shipType,
                color: DRAW.colorFor(b.id),
                series,
                cur: DERIVE.stateAt(series, now, st)
            });
        }
        const visible = all.filter((b) => {
            if (b.isUs) return true; // our boat is always shown
            switch (prefs.show) {
                case 'all':
                    return true;
                case 'inrange':
                    return !!b.cur;
                case 'sailing':
                    return isSailing(b);
                case 'none':
                    return false;
                default:
                    return b.nemesis;
            }
        });
        return {
            snap: s,
            now,
            live,
            staleMs: st,
            tcfVmgMs: tcfVmgMs(),
            periodMs: periodMs(),
            mode: prefs.mode,
            frame,
            wp,
            upName,
            ctx,
            usNow,
            // Up direction now (rad true); null when unknown (no waypoint, no own COG): north up.
            up,
            upRad: up == null ? 0 : up,
            // Our smoothed TWD now (rad true, where the wind comes from); null without wind.
            twd: DERIVE.frameDir('upwind', usNow),
            // The course from the Course tab, whatever Up is; null with none.
            course: courseOf(s),
            all,
            visible,
            sel,
            usAt: (t) => DERIVE.stateAt(M.us, t, US_GAP_MS)
        };
    }

    /*
     * Up: a frame (waypoint = the plugin's automatic waypoint, course, north), or a named
     * waypoint picked by hand ('wpt:<name>', per screen), which is the Waypoint frame
     * toward that mark. A picked mark that has gone from the server gives no waypoint
     * (shown as such) rather than silently falling back to another mark.
     */
    const WPT = 'wpt:';
    function upChoice(s) {
        if (prefs.up.startsWith(WPT)) {
            const name = prefs.up.slice(WPT.length);
            const wp = pickable(s).find((w) => w.name === name) || null;
            return {frame: 'waypoint', wp, upName: name};
        }
        if (prefs.up === 'course') return {frame: 'course', wp: courseOf(s), upName: 'course'};
        return {frame: prefs.up, wp: s ? s.waypoint : null, upName: UP_NAME[prefs.up] || prefs.up};
    }
    const UP_NAME = {cog: 'COG', upwind: 'upwind', downwind: 'downwind'};
    let course = null; // rebuilt only when the marks change (it caches each report's mark)
    let courseKey = null;
    /** The course from the Course tab, its marks found (makeCourse skips the others); null if none. */
    function courseOf(s) {
        const marks = ((s && s.course) || []).filter((m) => m.found);
        const key = JSON.stringify(marks);
        if (key !== courseKey) {
            courseKey = key;
            course = DERIVE.makeCourse(marks);
        }
        return course;
    }

    /** Waypoints Up can be set to by hand: the course's marks, then the fallback waypoints; each name once. */
    function pickable(s) {
        const out = [];
        const seen = new Set();
        for (const w of ((s && s.course) || []).filter((m) => m.found).concat((s && s.namedWaypoints) || [])) {
            if (seen.has(w.name)) continue;
            seen.add(w.name);
            out.push(w);
        }
        return out;
    }

    // Up options: the fixed ones, then each named waypoint the server found, then a
    // picked one no longer found (so the choice is visible, not silently changed).
    let upOptsKey = null;
    function syncUpOptions() {
        const el = $('upSel');
        const names = pickable(M.snap).map((w) => w.name);
        const picked = prefs.up.startsWith(WPT) ? prefs.up.slice(WPT.length) : null;
        const missing = picked != null && !names.includes(picked) ? picked : null;
        const key = JSON.stringify([names, missing]);
        if (key === upOptsKey) return;
        upOptsKey = key;
        for (const o of [...el.querySelectorAll('option[data-wpt]')]) o.remove();
        const add = (name, label) => {
            const o = document.createElement('option');
            o.value = WPT + name;
            o.textContent = label;
            o.dataset.wpt = '1';
            el.appendChild(o);
        };
        for (const n of names) add(n, 'WPT ' + n);
        if (missing != null) add(missing, `WPT ${missing} (not found)`);
        el.value = prefs.up;
    }

    // A series cut at time t (history views don't show what came after).
    function upTo(series, t) {
        const k = DERIVE.indexAtOrBefore(series, t);
        return k === series.length - 1 ? series : series.slice(0, k + 1);
    }

    /** Items of a series within the period window ending at now. */
    function inWindow(series, view) {
        const from = view.now - view.periodMs;
        let k = series.length;
        while (k > 0 && series[k - 1].t >= from) k--;
        return series.slice(k);
    }

    /* ---------- rendering ---------- */
    let rafPending = false;
    let lastView = null;
    function render(force) {
        if (force) return doRender(true);
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => {
            rafPending = false;
            doRender(false);
        });
    }

    function doRender(force) {
        renderConn();
        renderTime();
        const view = buildView();
        lastView = view;
        $('fleetCount').textContent = view.visible.length + '/' + view.all.length;
        // The CYCA tab asks for the navigator: a CYCA boat with a candidate AIS match.
        const cyca = document.querySelector('#tabbar button[data-tab="cyca"]');
        if (cyca) cyca.classList.toggle('attn', !!(M.snap && M.snap.cyca && M.snap.cyca.needsAction));
        const t = tabs[prefs.tab];
        if (t) t.render(view, force);
        if (sel != null && !view.all.some((b) => b.id === sel)) clearSel();
    }

    function renderConn() {
        const el = $('conn');
        const age = lastOkAt ? Date.now() - lastOkAt : null;
        el.className = 'sub ' + (authNeeded || !lastOkAt ? 'bad' : failures ? 'warn' : 'ok');
        if (authNeeded) {
            el.innerHTML = `<a href="${LOGIN_URL}" target="_top">login needed</a>`;
            return;
        }
        el.textContent = !lastOkAt ? 'no data' : failures ? 'stale ' + UNITS.fmtAge(age) : 'live';
    }

    function fmtClock(t) {
        const d = new Date(t);
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }
    function fmtElapsed(ms) {
        if (ms == null || !Number.isFinite(ms)) return '?';
        const m = Math.floor(Math.abs(ms) / 60000);
        return (ms < 0 ? '-' : '') + Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0');
    }

    function renderTime() {
        const now = nowT();
        const start = M.snap && M.snap.start ? M.snap.start.t : null;
        const rel = start != null ? '+' + fmtElapsed(now - start) : fmtClock(now);
        const back = M.viewT != null ? ' · ' + fmtElapsed(liveNow() - M.viewT) + ' ago' : '';
        $('timeBtnVal').textContent = rel + back + ' · ' + prefs.periodMin + 'm';
        $('timeBtn').classList.toggle('past', M.viewT != null);
        $('timeVal').textContent =
            new Date(now).toLocaleString([], {weekday: 'short', hour: '2-digit', minute: '2-digit'}) +
            (start != null ? '  (race +' + fmtElapsed(now - start) + ')' : '') +
            (M.viewT == null ? '  live' : '');
        $('periodVal').textContent = prefs.periodMin + ' min';
        // Slider: the server's history, oldest report to now, in minutes.
        const sl = $('timeSlider');
        const live = liveNow();
        const oldest = M.snap && M.snap.oldestT != null ? M.snap.oldestT : live;
        const mins = Math.max(1, Math.ceil((live - oldest) / 60e3));
        sl.max = String(mins);
        if (document.activeElement !== sl)
            sl.value = String(M.viewT == null ? mins : Math.round((M.viewT - oldest) / 60e3));
        $('liveBtn').classList.toggle('on', M.viewT == null);
    }

    /* ---------- selection and the details popup ---------- */
    const tip = () => $('tip');

    /** Select a boat (highlight on every tab) and show its details near the given client point. */
    function select(id, clientX, clientY, t) {
        sel = id;
        render(true);
        showTip(id, clientX, clientY, t);
    }
    function clearSel() {
        const had = sel != null;
        sel = null;
        tip().style.display = 'none';
        if (had) render(true);
    }

    function showTip(id, cx, cy, t) {
        const view = lastView || buildView();
        const b = view.all.find((x) => x.id === id);
        if (!b) return;
        // The report at t (a tapped trail point), else the boat's current report.
        let s = t != null ? b.series.find((x) => x.t === t) : null;
        if (!s) s = b.cur || b.series[b.series.length - 1];
        if (!s) return;
        const i = b.series.indexOf(s);
        const u = b.isUs ? null : view.usAt(s.t);
        const wp = view.wp;
        const vmc = b.isUs
            ? DERIVE.ownVmgAbs(b.series, i, {...view.ctx, frame: 'waypoint'})
            : DERIVE.vmgAbs(b.series, i, {...view.ctx, frame: 'waypoint'});
        const dtg = DERIVE.dtg(s, wp);
        let rel = '';
        if (u) {
            const range = GEO.distance(u, s);
            const brg = GEO.bearing(u, s);
            rel =
                `&Delta;SOG ${DRAW.signed(UNITS.kn(s.sogMs - u.sogMs), 1)}kn  ` +
                `to us ${UNITS.fmt(UNITS.nm(range), 1)}nm @ ${pad3(UNITS.deg(brg))}&deg;<br>`;
        }
        const el = tip();
        el.innerHTML =
            `<span class="tipx" id="tipClose">&times;</span>` +
            `<b>${DRAW.esc(b.name)}</b>${b.nemesis ? ' &#9876;' : ''}` +
            (b.aisName ? ` <span class="tipt">AIS: ${DRAW.esc(b.aisName)}</span>` : '') +
            '<br>' +
            `SOG ${UNITS.fmt(UNITS.kn(s.sogMs), 1)}kn  COG ${pad3(UNITS.deg(s.cogRad))}&deg;<br>` +
            `VMC ${UNITS.fmt(UNITS.kn(vmc), 1)}kn  ${wp && wp.isCourse ? 'DTF' : 'DTG'} ${UNITS.fmt(UNITS.nm(dtg), 1)}nm<br>` +
            // On a course, the mark this report is sailing to (its own pick).
            (wp && wp.isCourse ? `next ${DRAW.esc(wp.marks[wp.mark(s)].name || '?')}<br>` : '') +
            rel +
            `<span class="tipt">${new Date(s.t).toLocaleTimeString()} (${UNITS.fmtAge(view.now - s.t)} ago)</span>`;
        el.style.display = 'block';
        // Clamp fully inside the viewport, measured after display.
        const m = 8;
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let x = (cx != null ? cx : vw / 2) + 12;
        let y = (cy != null ? cy : vh / 2) + 12;
        if (x + w > vw - m) x = Math.max(m, (cx != null ? cx : x) - 12 - w);
        if (y + h > vh - m) y = Math.max(m, (cy != null ? cy : y) - 12 - h);
        x = Math.max(m, Math.min(x, vw - m - w));
        y = Math.max(m, Math.min(y, vh - m - h));
        el.style.left = x + 'px';
        el.style.top = y + 'px';
        $('tipClose').addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            e.preventDefault();
            el.style.display = 'none'; // closes the popup, keeps the highlight
        });
    }

    const pad3 = (deg) => (deg == null ? '---' : String(Math.round(deg) % 360).padStart(3, '0'));

    // Any tap that is not on a boat (each surface marks its own hits) and not in the popup ends the selection.
    document.addEventListener('pointerdown', (ev) => {
        if (sel == null) return;
        const t = ev.target;
        if (t && t.closest && t.closest('[data-hit], #tip, #map, #polar')) return;
        clearSel();
    });

    /* ---------- controls ---------- */
    function setTab(t) {
        if (!document.querySelector(`#tabbar button[data-tab="${t}"]`)) t = 'boats';
        prefs.tab = t;
        savePrefs();
        for (const btn of document.querySelectorAll('#tabbar button')) {
            const on = btn.dataset.tab === t;
            btn.classList.toggle('on', on);
            $('pane-' + btn.dataset.tab).classList.toggle('hidden', !on);
        }
        tip().style.display = 'none';
        if (tabs[t] && tabs[t].shown) tabs[t].shown();
        render(true);
    }

    function bindSelect(id, key, after) {
        const el = $(id);
        el.value = prefs[key];
        if (el.value !== prefs[key]) prefs[key] = el.value; // stored value no longer offered
        el.addEventListener('change', () => {
            prefs[key] = el.value;
            savePrefs();
            if (after) after();
            render(true);
        });
    }

    function setViewT(t) {
        const live = liveNow();
        M.viewT = t == null || t >= live - 30e3 ? null : Math.max(t, (M.snap && M.snap.oldestT) || t);
        render(true);
        pollSoon();
    }
    let soonTimer = null;
    function pollSoon() {
        clearTimeout(soonTimer);
        soonTimer = setTimeout(poll, 150);
    }

    function bindTime() {
        const btn = $('timeBtn');
        const pop = $('timepop');
        function place() {
            const r = btn.getBoundingClientRect();
            const pw = Math.min(460, window.innerWidth - 20);
            const left = Math.max(10, Math.min(r.right - pw, window.innerWidth - 10 - pw));
            pop.style.left = left + 'px';
            pop.style.top = r.bottom + 6 + 'px';
        }
        const open = () => {
            pop.classList.remove('hidden');
            btn.classList.add('on');
            place();
        };
        const close = () => {
            pop.classList.add('hidden');
            btn.classList.remove('on');
        };
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            pop.classList.contains('hidden') ? open() : close();
        });
        pop.addEventListener('click', (e) => e.stopPropagation());
        document.addEventListener('click', () => {
            if (!pop.classList.contains('hidden')) close();
        });
        window.addEventListener('resize', () => {
            if (!pop.classList.contains('hidden')) place();
        });

        const sl = $('timeSlider');
        sl.addEventListener('input', () => {
            const live = liveNow();
            const oldest = M.snap && M.snap.oldestT != null ? M.snap.oldestT : live;
            setViewT(Number(sl.value) >= Number(sl.max) ? null : oldest + Number(sl.value) * 60e3);
        });
        $('liveBtn').addEventListener('click', () => setViewT(null));
        $('clearHist').addEventListener('click', async () => {
            if (!confirm("Clear all track history, ours and every boat's, on the server too?")) return;
            try {
                const r = await put('clearHistory', true);
                if (r && r.statusCode && r.statusCode !== 200) throw new Error(r.message || 'refused');
                M.tracksKey = ''; // fetch the (now empty) tracks in full
                setViewT(null);
            } catch (e) {
                noteWriteError(e);
                alert('Clear history failed: ' + (e.status === 401 || e.status === 403 ? 'login needed' : e.message));
            }
            pollSoon();
        });
        $('backBtn').addEventListener('click', () => setViewT(nowT() - STEP_MS));
        $('fwdBtn').addEventListener('click', () => (M.viewT == null ? null : setViewT(M.viewT + STEP_MS)));

        const ps = $('periodSlider');
        ps.value = String(prefs.periodMin);
        ps.addEventListener('input', () => {
            prefs.periodMin = Number(ps.value);
            savePrefs();
            render(true);
            pollSoon();
        });
        const sm = $('staleMin');
        sm.value = String(prefs.staleMin);
        sm.addEventListener('change', () => {
            const v = Math.max(5, Math.min(240, Number(sm.value) || 30));
            sm.value = String(v);
            prefs.staleMin = v;
            savePrefs();
            render(true);
            pollSoon();
        });
    }

    const INFO_TEXT = {
        boats: "Tap a boat's icon to mark or unmark it as a nemesis. Tap a name for details. 'Show' picks which boats appear on every view: Nemeses, Sailing, All, In range (a report within the 'Stale after' time) or None (just us). Each row has two strip charts over the period, newest on the left: VMG toward Up, and lead toward Up (how far ahead of us they are; + = they are ahead). In Relative mode VMG is theirs minus ours, so + = they are faster. Every chart in a column shares one height, shown under the column title, but each is centred on its own data.",
        vectors:
            'Velocity vectors with the chosen Up at the top. Each hull points the way that boat is moving; distance from the centre is speed. The centre is zero speed (Absolute) or our boat (Relative: their velocity minus ours). Comet tails join successive reports over the period, thick = now. Tap a boat to draw its true velocity vectors from the centre.',
        tcf: "Time-on-time handicap against us. Enter each boat's TCF (default 1.000; saved on the boat's server). Should = how far a boat must be ahead of us to be level on corrected time if the race ended at its report: the time owed over the elapsed time since the start (elapsed x the TCF ratio - 1), as a distance at the VMG to the waypoint of the boat that would be trailing. If it owes us time, at our VMG (Should +: it must be ahead); if we owe it time, at its VMG (Should -: it may be behind). VMGs are smoothed over the period set in the plugin config. Actual = how far it really is ahead toward Up. Net = Actual - Should, charted over the period (newest on the left) so an older report still shows the trend; + (orange) means it is beating us on handicap. Should is toward the waypoint, so it compares strictly with Actual only when Up = Waypoint.",
        course: "The course for Up = Course: its marks in order, the last being the finish. Add waypoints (made in Freeboard-SK or another chart app) and move them up and down, or import a route, which replaces the course. A mark passed twice, on the way out and again on the way back, is listed twice. Each boat's next mark is the closest one ahead of it whose leg (from the previous mark) points within 100 degrees of the way it is sailing, so the two passes are not confused. Waypoint marks follow the waypoint if it is moved; route points that are not waypoints stay where they were. The course is kept on the boat's server for every screen.",
        cyca: "The CYCA race tracker, for boats beyond AIS range (it needs internet). Pick the race at the top: races we are entered in say so. Positions come every 10 minutes. Below, link each CYCA boat to its AIS boat so the two show as one; the plugin suggests AIS boats that were in the same place at the same times over the last hour (a highlighted button is a clear match). Links are kept for the next race; Unlink if one is wrong. 'No AIS' quiets a boat for this race. The tab is highlighted while a CYCA boat has a likely AIS match not yet linked.",
        geo: 'Boats on the water, rotated so Up is at the top; the ringed WPT is the waypoint. Drag to pan, pinch or wheel to zoom (in Relative mode this switches to Absolute). Relative centres on us and fits all shown boats. Fit reframes. The Course box shows the course from the Course tab, whatever Up is. When our true wind is known, the Wind box shows the wind ladder: rungs across the wind, one through us, labelled in nm toward the wind (+ = upwind; with Up = Downwind, + = downwind), about 12 across the view. With Up = Upwind or Downwind the rungs are level. OSM and Sea basemaps need internet; White works offline.'
    };
    function bindInfo() {
        const pop = $('infoPop');
        let openFor = null;
        document.addEventListener('click', (e) => {
            const ic = e.target.closest && e.target.closest('.info');
            if (!ic || openFor === ic) {
                pop.style.display = 'none';
                openFor = null;
                return;
            }
            openFor = ic;
            pop.textContent = INFO_TEXT[ic.dataset.info] || '';
            pop.style.display = 'block';
            const r = ic.getBoundingClientRect();
            const pw = pop.offsetWidth;
            const ph = pop.offsetHeight;
            let x = r.left;
            let y = r.bottom + 6;
            if (x + pw > window.innerWidth - 8) x = window.innerWidth - 8 - pw;
            if (y + ph > window.innerHeight - 8) y = r.top - 6 - ph;
            pop.style.left = Math.max(8, x) + 'px';
            pop.style.top = Math.max(8, y) + 'px';
        });
    }

    function start() {
        document.querySelector('#tabbar').addEventListener('click', (e) => {
            const t = e.target.closest('button[data-tab]');
            if (t && t.dataset.tab !== prefs.tab) setTab(t.dataset.tab);
        });
        bindSelect('modeSel', 'mode', () => tabs.geo && tabs.geo.modeChanged && tabs.geo.modeChanged());
        syncUpOptions(); // a stored named-waypoint choice survives until the server answers
        bindSelect('upSel', 'up');
        bindSelect('showSel', 'show');
        bindSelect('sortSel', 'sort');
        bindTime();
        bindInfo();
        for (const t of Object.values(tabs)) if (t.init) t.init();
        // Resync immediately when the tablet wakes or the tab becomes visible.
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) poll();
        });
        window.addEventListener('online', () => poll());
        window.addEventListener('resize', () => render());
        setTab(prefs.tab);
        poll();
        // Connection age ticks every second; while polls fail, keep re-rendering so
        // ages and staleness advance on the client.
        setInterval(renderConn, 1000);
        setInterval(() => {
            if (failures) render();
        }, 5000);
    }

    window.addEventListener('DOMContentLoaded', start);

    return {
        OWN_ID,
        prefs,
        savePrefs,
        tabs,
        render,
        inWindow,
        select,
        clearSel,
        toggleNemesis,
        setTcf,
        setStart,
        refresh: () => poll(),
        liveNow,
        api: {
            get: (path) => fetchJson(API + path),
            put
        },
        setPrefs(kv) {
            Object.assign(prefs, kv);
            savePrefs();
            const ms = $('modeSel');
            if (ms.value !== prefs.mode) ms.value = prefs.mode;
        },
        get model() {
            return M;
        }
    };
})();
