'use strict';
/*
 * CYCA tab: the race whose tracker feed the plugin polls, and the table linking
 * CYCA boats to AIS boats. Links are kept by the plugin across races (by CYCA
 * name); "No AIS" is for this race only. Reads /cyca/races and /cyca/mapping
 * while the tab is shown; writes are Signal K PUTs, then a refetch.
 */
(() => {
    const $ = (id) => document.getElementById(id);
    // ?poll=<ms> (browser tests) speeds this up as it does the app's own poll.
    const REFRESH_MS = Math.max(1000, 3 * Number(new URLSearchParams(location.search).get('poll')) || 10e3);

    const D = {
        races: null, // {fetchedT, error, races, selected}
        map: null, // {raceId, lastOkT, lastError, completed, needsAction, rows}
        busy: false, // a PUT in flight
        msg: null, // last write error
        timer: null
    };

    const esc = (s) => DRAW.esc(s == null ? '' : String(s));

    function fmtStart(t) {
        return new Date(t).toLocaleString([], {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    function raceLabel(r) {
        const name = r.name || `CYCA race ${r.raceId}`;
        const fleet = r.fleet != null ? ` · ${r.fleet} boats` : '';
        return `${fmtStart(r.startT)} · ${name}${fleet}${r.entered ? ' · we are entered' : ''}`;
    }

    // A select the navigator has open must not be rebuilt under their finger.
    const busyUi = () => {
        const a = document.activeElement;
        return a && a.tagName === 'SELECT' && a.closest('#pane-cyca');
    };

    function renderRaces() {
        const sel = $('cycaRace');
        if (busyUi() === sel || document.activeElement === sel) return;
        const d = D.races;
        const selected = D.map ? D.map.raceId : d ? d.selected : null;
        const races = d ? d.races.slice() : [];
        // The selected race stays listed even once it has dropped off the feed's list.
        if (selected != null && !races.some((r) => r.raceId === selected))
            races.unshift({raceId: selected, name: null, startT: NaN});
        sel.innerHTML =
            '<option value="">Off</option>' +
            races
                .map(
                    (r) =>
                        `<option value="${r.raceId}"${r.raceId === selected ? ' selected' : ''}>${esc(
                            Number.isFinite(r.startT) ? raceLabel(r) : `CYCA race ${r.raceId}`
                        )}</option>`
                )
                .join('');
        sel.value = selected == null ? '' : String(selected);
    }

    function renderStatus() {
        const el = $('cycaStatus');
        const m = D.map;
        const parts = [];
        if (D.msg) parts.push(`<span class="err">${esc(D.msg)}</span>`);
        if (D.races && D.races.error) parts.push(`<span class="err">race list: ${esc(D.races.error)}</span>`);
        for (const e of (D.races && D.races.recordedErrors) || [])
            parts.push(`<span class="err">recorded race ${esc(e)}</span>`);
        if (!m || m.raceId == null) {
            parts.push('Pick the race to follow on the CYCA tracker.');
        } else {
            const now = ND.liveNow(); // server time: the tablet's clock may be off
            if (m.completed) parts.push('race completed: no longer polled');
            const startT = m.race && m.race.startT;
            if (startT && now < startT) parts.push(`starts ${esc(fmtStart(startT))} · positions from 10 min before`);
            else if (m.lastOkT) parts.push(`last fetch ${UNITS.fmtAge(now - m.lastOkT)} ago`);
            else if (!m.lastError) parts.push('waiting for the first fetch');
            if (m.lastError) parts.push(`<span class="err">feed: ${esc(m.lastError)}</span>`);
            const n = m.rows.length;
            const linked = m.rows.filter((r) => r.link).length;
            parts.push(`${n} boats, ${linked} linked`);
        }
        el.innerHTML = parts.join(' · ');
        // One tap for every clear suggestion (at a start every AIS name may match).
        const n = suggested().length;
        const all = $('cycaLinkAll');
        all.textContent = `Link all ${n} suggested`;
        all.classList.toggle('hidden', n < 2);
        all.disabled = D.busy;
    }

    function aisOptions(row, snap) {
        const linked = new Set((D.map ? D.map.rows : []).map((r) => r.link).filter(Boolean));
        const ais = (snap ? snap.boats : [])
            .filter((b) => !b.id.startsWith('cyca:') && !b.cycaId && !linked.has(b.id))
            .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
        return (
            `<option value="">Pick AIS boat…</option>` +
            ais.map((b) => `<option value="${esc(b.id)}">${esc(b.name || b.id)} (${esc(b.id)})</option>`).join('')
        );
    }

    function candChip(row, c) {
        const rec = row.recommended === c.mmsi;
        const what = [];
        if (c.distanceM != null) what.push(UNITS.fmt(UNITS.nm(c.distanceM), 2) + ' nm');
        if (c.dSogMs != null) what.push(DRAW.signed(UNITS.kn(c.dSogMs), 1) + ' kn');
        if (c.sameName) what.push('same name');
        return `<button class="mapbtn cand${rec ? ' rec' : ''}" data-act="link" data-name="${esc(row.name)}" data-mmsi="${esc(c.mmsi)}" title="link to this AIS boat">${esc(c.name || c.mmsi)}<span class="cand-sub">${esc(what.join(', '))}</span></button>`;
    }

    function renderRows(view) {
        const list = $('cycalist');
        if (busyUi()) return;
        const m = D.map;
        if (!m || m.raceId == null) {
            list.innerHTML = '<div class="empty">No race selected.</div>';
            return;
        }
        if (!m.rows.length) {
            list.innerHTML = '<div class="empty">No entries yet: the race list comes from the feed.</div>';
            return;
        }
        const now = ND.liveNow();
        const scroll = list.scrollTop;
        list.innerHTML = m.rows
            .map((r) => {
                const age = r.lastT ? 'fix ' + UNITS.fmtAge(now - r.lastT) + ' ago' : 'no fix yet';
                let body;
                if (r.link) {
                    body =
                        `<span class="linked">AIS ${esc(r.linkName || 'not heard yet')} (${esc(r.link)})</span>` +
                        `<button class="mapbtn" data-act="unlink" data-name="${esc(r.name)}">Unlink</button>`;
                } else {
                    const chips = r.candidates.map((c) => candChip(r, c)).join('');
                    body =
                        (r.noAis
                            ? '<span class="noais">No AIS this race</span>'
                            : chips || '<span class="nocand">no AIS boat nearby</span>') +
                        `<select class="pick" data-name="${esc(r.name)}" aria-label="AIS boat for ${esc(r.name)}">${aisOptions(r, view.snap)}</select>` +
                        `<button class="mapbtn${r.noAis ? ' on' : ''}" data-act="noais" data-entry="${r.entryId}" data-on="${r.noAis ? '0' : '1'}">No AIS</button>`;
                }
                return `<div class="crow${r.needsAction ? ' attn' : ''}${r.link ? ' done' : ''}">
      <div class="cname"><b>${esc(r.name)}</b><span class="csub">${esc([r.owner, r.club].filter(Boolean).join(' · '))}${r.owner || r.club ? ' · ' : ''}${esc(age)}</span></div>
      <div class="cact">${body}</div>
    </div>`;
            })
            .join('');
        list.scrollTop = scroll;
    }

    function render(view) {
        renderRaces();
        renderStatus();
        renderRows(view);
    }

    async function load(refreshRaces) {
        try {
            const [races, map] = await Promise.all([
                D.races && !refreshRaces ? D.races : ND.api.get('/cyca/races' + (refreshRaces ? '?refresh=1' : '')),
                ND.api.get('/cyca/mapping')
            ]);
            D.races = races;
            D.map = map;
        } catch (e) {
            D.msg = e.status === 401 || e.status === 403 ? 'login needed' : 'plugin unreachable';
        }
        ND.render(true);
    }

    /** Rows needing action with a clear (recommended) match. */
    function suggested() {
        return D.map ? D.map.rows.filter((r) => r.needsAction && r.recommended) : [];
    }

    /** One or more PUTs in order, then a refetch. Stops at the first failure. */
    async function write(command, value, more = []) {
        if (D.busy) return;
        D.busy = true;
        D.msg = null;
        try {
            for (const [c, v] of [[command, value], ...more]) {
                const r = await ND.api.put(c, v);
                if (r && r.statusCode && r.statusCode !== 200) {
                    D.msg = r.message || 'refused';
                    break;
                }
            }
        } catch (e) {
            D.msg = e.status === 401 || e.status === 403 ? 'login needed' : e.message;
        } finally {
            D.busy = false;
        }
        await load(false);
        ND.refresh();
    }

    function tick() {
        clearTimeout(D.timer);
        if (ND.prefs.tab !== 'cyca') return;
        load(false).finally(() => {
            if (ND.prefs.tab === 'cyca') D.timer = setTimeout(tick, REFRESH_MS);
        });
    }

    function init() {
        $('cycaRace').addEventListener('change', (e) => {
            const v = e.target.value;
            write('setCycaRace', {raceId: v === '' ? null : Number(v)});
            e.target.blur();
        });
        $('cycaRefresh').addEventListener('click', () => load(true));
        $('cycaLinkAll').addEventListener('click', () => {
            const puts = suggested().map((r) => ['setCycaLink', {name: r.name, mmsi: r.recommended}]);
            if (puts.length) write(...puts[0], puts.slice(1));
        });
        const list = $('cycalist');
        list.addEventListener('click', (e) => {
            const b = e.target.closest('button[data-act]');
            if (!b) return;
            if (b.dataset.act === 'link') write('setCycaLink', {name: b.dataset.name, mmsi: b.dataset.mmsi});
            else if (b.dataset.act === 'unlink') write('setCycaLink', {name: b.dataset.name, mmsi: null});
            else if (b.dataset.act === 'noais')
                write('setCycaNoAis', {entryId: Number(b.dataset.entry), noAis: b.dataset.on === '1'});
        });
        list.addEventListener('change', (e) => {
            const s = e.target.closest('select.pick');
            if (!s || !s.value) return;
            const mmsi = s.value;
            s.blur();
            write('setCycaLink', {name: s.dataset.name, mmsi});
        });
    }

    ND.tabs.cyca = {init, render, shown: () => load(!D.races).then(tick)};
})();
