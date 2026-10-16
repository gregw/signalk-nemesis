'use strict';
/* global ND, UNITS, DERIVE, DRAW */
/*
 * TCF tab (wiki section 3.6): time-on-time handicap against us. A TCF box per boat
 * (saved on the server, PUT setTcf), then Should and Actual in nm at the boat's latest
 * report, and Net (the TCF corrected lead) as a strip chart over the period like the
 * Boats tab, so a boat whose latest report is a little old still shows its trend.
 * Sorted by the latest Net.
 * Also the race start time (signalk-racer or a manual override, PUT setStartTime) and
 * how Should is worked out (time owed, at a smoothed VMG to the waypoint).
 * Inputs are never re-rendered while focused (prototype lesson).
 */
(() => {
    const $ = (id) => document.getElementById(id);
    let startMsg = null; // last start-time error, shown until the next change

    const nm = (m) => UNITS.nm(m);
    const fmt = (m) => DRAW.signed(nm(m), 1);

    function focusedInput() {
        const a = document.activeElement;
        return a && (a.classList.contains('tcfin') || a.id === 'startIn');
    }

    function toLocalInput(t) {
        const d = new Date(t);
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }

    function renderStart(view) {
        const st = view.snap && view.snap.start;
        const el = $('startVal');
        if (startMsg) {
            el.innerHTML = `<span class="err">${DRAW.esc(startMsg)}</span>`;
        } else if (st) {
            el.textContent =
                new Date(st.t).toLocaleString([], {
                    weekday: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit'
                }) + (st.src === 'override' ? ' (set here)' : ' (signalk-racer)');
        } else el.textContent = 'not known';
        $('startClear').disabled = !(st && st.src === 'override');
        if (document.activeElement !== $('startIn') && st) $('startIn').value = toLocalInput(st.t);

        const min = Math.round(view.tcfVmgMs / 60e3);
        const em = st ? Math.floor((view.now - st.t) / 60e3) : -1;
        const elapsed = em >= 0 ? ` &middot; elapsed ${Math.floor(em / 60)}h${String(em % 60).padStart(2, '0')}` : '';
        $('tcfMethod').innerHTML =
            `Should: time owed at the trailing boat's VMG to the waypoint over ${min} min${elapsed}`;
    }

    function render(view, force) {
        if (!force && focusedInput()) return;
        renderStart(view);
        const list = $('tcflist');
        if (!view.snap) {
            $('tcfhead').innerHTML = '';
            list.innerHTML = '<div class="empty">Waiting for data from the plugin.</div>';
            return;
        }
        const us = view.all.find((b) => b.isUs);
        const startT = view.snap.start ? view.snap.start.t : null;
        let reason = null;
        const tcfAt = (b, s) =>
            DERIVE.tcfRow({
                s,
                u: s ? view.usAt(s.t) : null,
                frame: view.frame,
                series: b.series,
                usSeries: us.series,
                wp: view.wp,
                startT,
                tcfUs: us.tcf,
                tcfBoat: b.tcf,
                vmgMs: view.tcfVmgMs,
                maxGapMs: view.staleMs
            });
        const rows = view.visible.map((b) => {
            if (b.isUs) return {b, net: 0, series: []};
            const r = tcfAt(b, b.cur);
            if (r.reason && r.reason !== 'no data' && !reason) reason = r.reason;
            const series = ND.inWindow(b.series, view).map((s) => ({t: s.t, v: nm(tcfAt(b, s).net)}));
            return {b, ...r, series};
        });
        // Handicap standing: most ahead of us on corrected time first; us at 0; no data last.
        rows.sort((x, y) => (y.net ?? -1e12) - (x.net ?? -1e12));

        // One chart height for the column (largest range in any row), each chart centred on its own data.
        let span = 0;
        for (const r of rows) {
            r.ext = DRAW.extent(r.series);
            if (r.ext[1] >= r.ext[0]) span = Math.max(span, r.ext[1] - r.ext[0]);
        }
        span = Math.max(span, 0.05);
        const fmtNet = (v) => DRAW.signed(v, Math.abs(v) < 10 ? 1 : 0);
        const chipCls = (v) => (v > 0.05 ? 'pos' : v < -0.05 ? 'neg' : '');

        const caveat =
            view.frame === 'waypoint' || view.frame === 'course'
                ? ''
                : ' (Should is toward the waypoint: compare with Up = Waypoint or Course)';
        $('tcfNote').innerHTML =
            ` &middot; vs us, toward ${DRAW.esc(view.upName)}${caveat}${reason ? ` &middot; <span class="err">Should: ${reason}</span>` : ''}`;
        $('tcfhead').innerHTML =
            `<span class="sp" style="width:10px"></span><span class="th-name"><b>Boat</b></span>` +
            `<span class="th-tcf"><b>TCF</b></span>` +
            `<span class="th-n"><b>Should</b><span class="bh-sub">nm</span></span>` +
            `<span class="th-n"><b>Actual</b><span class="bh-sub">nm</span></span>` +
            `<span class="th-chart"><b>Net</b><span class="bh-sub">+ beats us</span><span class="bh-sub">${DRAW.fmtSpan(span, 'nm')}</span></span>`;
        const scroll = list.scrollTop;
        list.innerHTML = rows
            .map((r) => {
                const [lo, hi] = DRAW.centred(r.ext, span);
                const p = DRAW.latestPos(r.series, lo, hi, view.now, view.periodMs);
                const chart = r.b.isUs
                    ? ''
                    : DRAW.chip(p, fmtNet, p ? chipCls(p.v) : '') +
                      `<span class="spkwrap">${DRAW.spark(r.series, r.b.color, lo, hi, view.now, view.periodMs, view.staleMs)}</span>`;
                return `<div class="brow trow2 ${r.b.isUs ? 'us' : ''} ${r.b.isUs || r.b.cur ? '' : 'gone'}${view.sel === r.b.id ? ' hi' : ''}" data-id="${DRAW.esc(r.b.id)}">
      <span class="sw" style="background:${r.b.color}"></span>
      <span class="bn ${r.b.isUs ? 'ref' : ''}" data-sel="${DRAW.esc(r.b.id)}" data-hit="1">${DRAW.esc(r.b.name)}</span>
      <input class="tcfin" type="number" inputmode="decimal" step="0.001" min="0.3" max="3" value="${r.b.tcf.toFixed(3)}" data-id="${DRAW.esc(r.b.id)}" aria-label="TCF ${DRAW.esc(r.b.name)}">
      <span class="tn">${r.b.isUs ? '&ndash;' : fmt(r.should)}</span>
      <span class="tn">${r.b.isUs ? '&ndash;' : fmt(r.actual)}</span>
      <div class="chart net">${chart}</div>
    </div>`;
            })
            .join('');
        list.scrollTop = scroll;
    }

    async function setStart(iso) {
        startMsg = await ND.setStart(iso);
        ND.render(true);
    }

    function init() {
        const list = $('tcflist');
        list.addEventListener('change', (e) => {
            const inp = e.target.closest('.tcfin');
            if (!inp) return;
            const v = Number(inp.value);
            if (v > 0.3 && v <= 3) ND.setTcf(inp.dataset.id, Number(v.toFixed(4)));
            else ND.render(true); // put the stored value back
        });
        list.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.classList.contains('tcfin')) e.target.blur();
        });
        list.addEventListener('click', (e) => {
            const s = e.target.closest('[data-sel]');
            if (s) ND.select(s.dataset.sel, e.clientX, e.clientY);
        });
        $('startSet').addEventListener('click', () => {
            const v = $('startIn').value;
            const t = v ? new Date(v).getTime() : NaN;
            if (!Number.isFinite(t)) {
                startMsg = 'enter a date and time';
                return ND.render(true);
            }
            setStart(new Date(t).toISOString());
        });
        $('startNow').addEventListener('click', () => setStart(new Date().toISOString()));
        $('startClear').addEventListener('click', () => setStart(null));
        $('startIn').addEventListener('input', () => {
            startMsg = null;
        });
    }

    ND.tabs.tcf = {init, render};
})();
