'use strict';
/*
 * Course tab: the marks of the course for Up = Course, in order, kept by the plugin so
 * every screen shares them. Add waypoint resources, move and remove marks, or import a
 * Signal K route (replacing the course). A mark may be listed twice (out and back).
 * Each edit sends the whole list (PUT setCourse), then refetches.
 */
(() => {
    const $ = (id) => document.getElementById(id);
    const REFRESH_MS = Math.max(1000, 3 * Number(new URLSearchParams(location.search).get('poll')) || 10e3);

    const D = {
        course: null, // {seeded, marks: [{name, waypointId, lat, lon, found, src}]}
        waypoints: null, // [{id, name, lat, lon}]
        routes: null, // [{id, name, points}]
        busy: false,
        msg: null,
        timer: null
    };

    const esc = (s) => DRAW.esc(s == null ? '' : String(s));
    const focusedSelect = () => {
        const a = document.activeElement;
        return a && a.tagName === 'SELECT' && a.closest('#pane-course');
    };

    /** A resolved mark as the plugin stores it. */
    function stored(m) {
        const out = {name: m.name};
        if (m.waypointId) out.waypointId = m.waypointId;
        if (Number.isFinite(m.lat) && Number.isFinite(m.lon)) {
            out.lat = m.lat;
            out.lon = m.lon;
        }
        return out;
    }

    function fillSelect(el, items, label, placeholder) {
        if (document.activeElement === el) return;
        const keep = el.value;
        el.innerHTML =
            `<option value="">${esc(placeholder)}</option>` +
            (items || []).map((x) => `<option value="${esc(x.id)}">${esc(label(x))}</option>`).join('');
        if ((items || []).some((x) => x.id === keep)) el.value = keep;
    }

    function render() {
        fillSelect($('courseAdd'), D.waypoints, (w) => w.name, D.waypoints ? 'Waypoint…' : 'Loading…');
        fillSelect(
            $('courseRoute'),
            D.routes,
            (r) => `${r.name} (${r.points} points)`,
            D.routes ? 'Route…' : 'Loading…'
        );
        $('courseAddBtn').disabled = D.busy;
        $('courseImport').disabled = D.busy;

        const marks = D.course ? D.course.marks : [];
        let total = 0;
        let prev = null;
        const rows = marks.map((m, i) => {
            let leg = '';
            if (m.found && prev) {
                const d = GEO.distance(prev, m);
                total += d;
                leg = `${UNITS.fmt(UNITS.nm(d), 1)} nm · ${String(Math.round(UNITS.deg(GEO.bearing(prev, m)))).padStart(3, '0')}°T`;
            } else if (m.found && i === 0) leg = 'first mark';
            if (m.found) prev = m;
            const kind = !m.found
                ? '<span class="err">not found</span>'
                : m.src === 'fixed'
                  ? 'fixed point'
                  : m.src === 'last'
                    ? '<span class="warn">waypoint gone: last position</span>'
                    : 'waypoint';
            return `<div class="mrow" data-i="${i}">
      <span class="mnum">${i + 1}</span>
      <div class="mname"><b>${esc(m.name)}</b><span class="csub">${kind}${leg ? ' · ' + leg : ''}</span></div>
      <div class="mbtns">
        <button class="mapbtn" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="move ${esc(m.name)} up">&uarr;</button>
        <button class="mapbtn" data-act="down" ${i === marks.length - 1 ? 'disabled' : ''} aria-label="move ${esc(m.name)} down">&darr;</button>
        <button class="mapbtn" data-act="del" aria-label="remove ${esc(m.name)}">&times;</button>
      </div>
    </div>`;
        });
        const list = $('courselist');
        const scroll = list.scrollTop;
        list.innerHTML = rows.length
            ? rows.join('')
            : `<div class="empty">${D.course ? 'No marks: add waypoints or import a route.' : 'Loading the course…'}</div>`;
        list.scrollTop = scroll;

        const parts = [];
        if (D.msg) parts.push(`<span class="err">${esc(D.msg)}</span>`);
        if (marks.length)
            parts.push(`${marks.length} marks · ${UNITS.fmt(UNITS.nm(total), 1)} nm, the last is the finish`);
        if (D.course && D.course.seeded && marks.length) parts.push('from the plugin config until changed here');
        $('courseStatus').innerHTML = parts.join(' · ');
    }

    async function get(path) {
        try {
            return await ND.api.get(path);
        } catch (e) {
            D.msg = e.status === 401 || e.status === 403 ? 'login needed' : 'plugin unreachable';
            return null;
        }
    }

    async function load(all) {
        const [course, waypoints, routes] = await Promise.all([
            get('/course'),
            all || !D.waypoints ? get('/course/waypoints') : D.waypoints,
            all || !D.routes ? get('/course/routes') : D.routes
        ]);
        if (course) D.course = course;
        if (waypoints) D.waypoints = waypoints;
        if (routes) D.routes = routes;
        if (!focusedSelect()) render();
    }

    async function save(value) {
        if (D.busy) return;
        D.busy = true;
        D.msg = null;
        render();
        try {
            const r = await ND.api.put('setCourse', value);
            if (r && r.statusCode && r.statusCode !== 200) D.msg = r.message || 'refused';
        } catch (e) {
            D.msg = e.status === 401 || e.status === 403 ? 'login needed' : e.message;
        } finally {
            D.busy = false;
        }
        await load(false);
        ND.refresh();
    }

    function edit(fn) {
        if (!D.course) return;
        const marks = D.course.marks.map(stored);
        fn(marks);
        save({marks});
    }

    function tick() {
        clearTimeout(D.timer);
        if (ND.prefs.tab !== 'course') return;
        load(false).finally(() => {
            if (ND.prefs.tab === 'course') D.timer = setTimeout(tick, REFRESH_MS);
        });
    }

    function init() {
        $('courseAddBtn').addEventListener('click', () => {
            const w = (D.waypoints || []).find((x) => x.id === $('courseAdd').value);
            if (!w) return;
            edit((marks) => marks.push({name: w.name, waypointId: w.id, lat: w.lat, lon: w.lon}));
        });
        $('courseImport').addEventListener('click', () => {
            const r = (D.routes || []).find((x) => x.id === $('courseRoute').value);
            if (!r) return;
            const n = D.course ? D.course.marks.length : 0;
            if (n && !confirm(`Replace the ${n} marks of the course with the route ${r.name}?`)) return;
            save({routeId: r.id});
        });
        $('courseRefresh').addEventListener('click', () => load(true));
        $('courselist').addEventListener('click', (e) => {
            const b = e.target.closest('button[data-act]');
            const row = e.target.closest('.mrow');
            if (!b || !row || b.disabled) return;
            const i = Number(row.dataset.i);
            edit((marks) => {
                if (b.dataset.act === 'del') marks.splice(i, 1);
                else {
                    const j = b.dataset.act === 'up' ? i - 1 : i + 1;
                    if (j < 0 || j >= marks.length) return;
                    [marks[i], marks[j]] = [marks[j], marks[i]];
                }
            });
        });
    }

    ND.tabs.course = {init, render: () => !focusedSelect() && render(), shown: () => load(true).then(tick)};
})();
