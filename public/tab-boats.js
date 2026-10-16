'use strict';
/* global ND, UNITS, GEO, DERIVE, DRAW */
/*
 * Boats tab (wiki section 5): one row per shown boat with a nemesis toggle, name over
 * SOG/COG, and two strip charts over the period, newest on the left: VMG toward Up and
 * lead toward Up. Sign: + = they are doing better than us (wiki section 8).
 * Every chart is centred on its own data; a column shares one window height.
 */
(() => {
    const $ = (id) => document.getElementById(id);
    const pad3 = (deg) => (deg == null ? '---' : String(Math.round(deg) % 360).padStart(3, '0'));

    const VMG_LABEL = {
        waypoint: 'VMG&#8594;wpt',
        course: 'VMG&#8594;crs',
        cog: 'VMG COG',
        north: 'VMG N',
        wind: 'VMG&#8594;wind'
    };
    const LEAD_LABEL = {waypoint: 'Lead wpt', course: 'Lead crs', cog: 'Lead COG', north: 'Lead N', wind: 'Lead wind'};
    // Frames that need a waypoint or a course, and what to say when there is none.
    const NO_TARGET = {waypoint: 'no waypoint', course: 'no course'};

    /** Chart series in display units (kn, nm) plus the values used for sorting. */
    function rowData(b, view) {
        const win = ND.inWindow(b.series, view);
        const off = b.series.length - win.length;
        const vmg = [];
        const lead = [];
        for (let j = 0; j < win.length; j++) {
            const i = off + j;
            const r = win[j];
            let v;
            if (b.isUs) v = view.mode === 'rel' ? null : DERIVE.ownVmgAbs(b.series, i, view.ctx);
            else v = DERIVE.vmgToward(b.series, i, view.ctx, view.mode);
            vmg.push({t: r.t, v: UNITS.kn(v)});
            if (!b.isUs) lead.push({t: r.t, v: UNITS.nm(DERIVE.lead(r, view.usAt(r.t), view.frame, view.wp))});
        }
        const s = b.cur;
        const ci = s ? b.series.indexOf(s) : -1;
        const u = s && !b.isUs ? view.usAt(s.t) : null;
        const vmgNow = !s
            ? null
            : b.isUs
              ? DERIVE.ownVmgAbs(b.series, ci, view.ctx)
              : DERIVE.vmgAbs(b.series, ci, view.ctx);
        return {
            b,
            s,
            u,
            vmg,
            lead,
            dist: b.isUs ? 0 : s && u ? GEO.distance(u, s) : Infinity,
            dtg: (s && DERIVE.dtg(s, view.wp)) ?? Infinity, // to the waypoint, or along the course
            // Absolute, so the ranking is the same in both modes; no value sorts last.
            vmgSort: vmgNow != null && Number.isFinite(vmgNow) ? vmgNow : -Infinity
        };
    }

    const {extent, centred, chip, fmtSpan} = DRAW;

    function render(view) {
        const list = $('blist');
        if (!view.snap) {
            const noWp = NO_TARGET[view.frame] && !view.wp ? `<span class="err">${NO_TARGET[view.frame]}</span>` : null;
            $('bhead').innerHTML = '';
            list.innerHTML = '<div class="empty">Waiting for data from the plugin.</div>';
            return;
        }
        const rows = view.visible.map((b) => rowData(b, view));
        const sort = ND.prefs.sort;
        if (sort === 'near') rows.sort((x, y) => x.dist - y.dist);
        else if (sort === 'waypoint') rows.sort((x, y) => x.dtg - y.dtg);
        else if (sort === 'vmg') rows.sort((x, y) => y.vmgSort - x.vmgSort);
        else rows.sort((x, y) => (x.b.isUs ? -1 : y.b.isUs ? 1 : x.b.name.localeCompare(y.b.name)));

        // Window height per column: the largest range in any shown row, with a floor so
        // a flat line doesn't magnify noise.
        let vSpan = 0;
        let dSpan = 0;
        for (const r of rows) {
            r.vExt = extent(r.vmg);
            r.dExt = extent(r.lead);
            if (r.vExt[1] >= r.vExt[0]) vSpan = Math.max(vSpan, r.vExt[1] - r.vExt[0]);
            if (r.dExt[1] >= r.dExt[0]) dSpan = Math.max(dSpan, r.dExt[1] - r.dExt[0]);
        }
        vSpan = Math.max(vSpan, 0.2);
        dSpan = Math.max(dSpan, 0.05);

        const fmtV = (v) => (view.mode === 'rel' ? DRAW.signed(v, 1) : v.toFixed(1));
        const fmtD = (v) => DRAW.signed(v, Math.abs(v) < 10 ? 1 : 0);
        const html = rows.map((r) => {
            const b = r.b;
            const s = r.s;
            const sel = view.sel === b.id ? ' hi' : '';
            let hdr;
            if (!s) hdr = '<span class="muted">no fix</span>';
            else if (view.mode === 'abs' || b.isUs || !r.u)
                hdr = `${UNITS.fmt(UNITS.kn(s.sogMs), 1)}kn ${pad3(UNITS.deg(s.cogRad))}&deg;`;
            else {
                const dS = UNITS.kn(s.sogMs - r.u.sogMs);
                const dC = ((((UNITS.deg(s.cogRad) - UNITS.deg(r.u.cogRad)) % 360) + 540) % 360) - 180;
                hdr = `<span class="${dS >= 0 ? 'fast' : 'slow'}">${DRAW.signed(dS, 1)}kn</span> ${DRAW.signed(dC, 0)}&deg;`;
            }
            // Up = Course: the mark this boat's latest report is sailing to (its own pick).
            const next =
                s && view.wp && view.wp.isCourse
                    ? `<span class="rd nm" title="next mark">&#8594; ${DRAW.esc(view.wp.marks[view.wp.mark(s)].name || '?')}</span>`
                    : '';
            const [vLo, vHi] = centred(r.vExt, vSpan);
            const [dLo, dHi] = centred(r.dExt, dSpan);
            const vChart = DRAW.spark(r.vmg, b.color, vLo, vHi, view.now, view.periodMs, view.staleMs);
            const dChart = b.isUs ? '' : DRAW.spark(r.lead, b.color, dLo, dHi, view.now, view.periodMs, view.staleMs);
            const vCv = chip(DRAW.latestPos(r.vmg, vLo, vHi, view.now, view.periodMs), fmtV);
            const dCv = b.isUs ? '' : chip(DRAW.latestPos(r.lead, dLo, dHi, view.now, view.periodMs), fmtD);
            const icon = b.isUs
                ? `<span class="bico me">${DRAW.listIcon(b.color)}</span>`
                : `<button class="bico ${b.nemesis ? 'nem' : ''}" data-nem="${DRAW.esc(b.id)}" data-hit="1" title="${b.nemesis ? 'nemesis: tap to remove' : 'tap to mark as nemesis'}">${DRAW.listIcon(b.color)}</button>`;
            return `<div class="brow ${s ? '' : 'gone'} ${b.isUs ? 'us' : ''}${sel}" data-id="${DRAW.esc(b.id)}">
        ${icon}
        <div class="idcol" data-sel="${DRAW.esc(b.id)}" data-hit="1">
          <span class="bn ${b.isUs ? 'ref' : ''}">${DRAW.esc(b.name)}</span>
          <span class="rd">${hdr}</span>${next}
        </div>
        <div class="chart">${vCv}<span class="spkwrap">${vChart}</span></div>
        <div class="chart">${dCv}<span class="spkwrap">${dChart}</span></div>
      </div>`;
        });
        if (rows.length <= 1) html.push('<div class="empty">No other boats to show. Try Show: All.</div>');

        const noWp = NO_TARGET[view.frame] && !view.wp ? `<span class="err">${NO_TARGET[view.frame]}</span>` : null;
        $('bhead').innerHTML =
            `<span class="sp" style="width:30px"></span>` +
            `<span class="bh-id"><b>Boat</b><span class="bh-sub">${view.mode === 'rel' ? '&Delta;SOG/COG' : 'SOG/COG'}</span></span>` +
            `<span class="bh-col"><b>${view.mode === 'rel' ? '&Delta;' : ''}${VMG_LABEL[view.frame]}</b><span class="bh-rng" title="height of every chart in this column">${noWp || fmtSpan(vSpan, 'kn')}</span></span>` +
            `<span class="bh-col"><b>${LEAD_LABEL[view.frame]}</b><span class="bh-rng" title="height of every chart in this column">${noWp || fmtSpan(dSpan, 'nm')}</span></span>`;
        const scroll = list.scrollTop; // preserve scroll across re-renders
        list.innerHTML = html.join('');
        list.scrollTop = scroll;
    }

    function init() {
        $('blist').addEventListener('click', (e) => {
            const n = e.target.closest('[data-nem]');
            if (n) return ND.toggleNemesis(n.dataset.nem);
            const s = e.target.closest('[data-sel]');
            if (s) ND.select(s.dataset.sel, e.clientX, e.clientY);
        });
    }

    ND.tabs.boats = {init, render};
})();
