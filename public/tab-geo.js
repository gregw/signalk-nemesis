'use strict';
/* global ND, DERIVE, DRAW */
/*
 * Geo tab: Web Mercator map rotated so Up is at the top, with the waypoint marker and
 * age-tapered tails. Absolute: pan and zoom freely; it follows us until the first pan or
 * zoom, and Fit re-frames (and follows again). Relative: centred on us, fitted to every
 * shown boat. A gesture in Relative mode switches to Absolute.
 *
 * Gestures (prototype lessons): all map content has pointer-events: none so every event
 * targets the persistent <svg> root; boats are hit-tested in code. Mouse uses pointer
 * events; touch uses native touch events (pointer capture mishandles a second finger),
 * and a pinch is computed from the state when the second finger landed, keeping the
 * point under the fingers fixed. Tiles live in their own group, rebuilt only when the
 * view changes, so data polls don't refetch them.
 */
(() => {
    const $ = (id) => document.getElementById(id);
    const FONT = 'ui-monospace, Menlo, Consolas, monospace';
    const d2r = (d) => (d * Math.PI) / 180;
    const r2d = (r) => (r * 180) / Math.PI;
    const OWN_STEP_MS = 120e3;
    const TAP = 6; // px of movement below which a press counts as a tap
    const MIN_Z = 3;
    const MAX_Z = 16;

    let W = 700;
    let H = 500;
    let center = {wx: 0.5, wy: 0.5};
    let zoom = 8;
    let fitted = false;
    let follow = true; // Absolute: keep us in view until the user pans or zooms
    let rotDeg = 0;
    let hits = [];
    let tileKey = '';
    let lastView = null;

    const mercX = (lon) => lon / 360 + 0.5;
    const mercY = (lat) => {
        const s = Math.sin(d2r(Math.max(-85, Math.min(85, lat))));
        return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    };
    const invMercLat = (wy) => r2d(2 * Math.atan(Math.exp((0.5 - wy) * 2 * Math.PI)) - Math.PI / 2);
    const scale = () => 256 * Math.pow(2, zoom); // px per world unit
    const projPx = (wx, wy) => [(wx - center.wx) * scale() + W / 2, (wy - center.wy) * scale() + H / 2];
    // Rotation of a screen offset (x right, y down), as SVG rotate(deg).
    function rotXY(x, y, deg) {
        const a = d2r(deg);
        const c = Math.cos(a);
        const s = Math.sin(a);
        return [x * c - y * s, x * s + y * c];
    }
    function pxPerNm() {
        const lat = invMercLat(center.wy);
        return Math.abs(mercY(lat + 1 / 60) - mercY(lat)) * scale();
    }

    const BASES = {
        osm: [{max: 16, url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`}],
        // Esri Ocean base (tiles are z/y/x) plus the OpenSeaMap seamark overlay.
        sea: [
            {
                max: 13,
                url: (z, x, y) =>
                    `https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/${z}/${y}/${x}`
            },
            {max: 16, url: (z, x, y) => `https://tiles.openseamap.org/seamark/${z}/${x}/${y}.png`}
        ]
    };
    const ATTR = {osm: '&#169; OpenStreetMap contributors', sea: 'Esri, GEBCO, NOAA &middot; OpenSeaMap'};

    function tileImages(Z, url) {
        const sc = scale();
        const n = Math.pow(2, Z);
        const R = Math.hypot(W, H) / 2; // circumscribing radius: rotation-proof
        const tx0 = Math.floor((center.wx - R / sc) * n);
        const tx1 = Math.floor((center.wx + R / sc) * n);
        const ty0 = Math.floor((center.wy - R / sc) * n);
        const ty1 = Math.floor((center.wy + R / sc) * n);
        const tilePx = sc / n;
        let out = '';
        let cnt = 0;
        for (let tx = tx0; tx <= tx1; tx++) {
            for (let ty = ty0; ty <= ty1; ty++) {
                if (tx < 0 || ty < 0 || tx >= n || ty >= n) continue;
                if (++cnt > 200) return out;
                const [px, py] = projPx(tx / n, ty / n);
                out += `<image href="${url(Z, tx, ty)}" x="${px.toFixed(1)}" y="${py.toFixed(1)}" width="${(tilePx + 0.5).toFixed(2)}" height="${(tilePx + 0.5).toFixed(2)}"/>`;
            }
        }
        return out;
    }

    function renderTiles() {
        const base = ND.prefs.base;
        const key = `${base}|${center.wx}|${center.wy}|${zoom}|${W}x${H}`;
        if (key === tileKey) return;
        tileKey = key;
        const layers = BASES[base];
        if (!layers) {
            $('maptiles').innerHTML = '';
            return;
        }
        const Z = Math.max(2, Math.min(16, Math.round(zoom)));
        $('maptiles').innerHTML = layers.map((l) => tileImages(Math.min(Z, l.max), l.url)).join('');
    }

    function northIndicator(rot) {
        const x = W - 20;
        const y = 22;
        const len = 12;
        const a = d2r(-rot);
        const nx = x + len * Math.sin(a);
        const ny = y - len * Math.cos(a);
        return (
            `<g opacity="0.8"><line x1="${x}" y1="${y}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" stroke="#cc2033" stroke-width="2"/>` +
            `<circle cx="${x}" cy="${y}" r="2" fill="#556070"/>` +
            `<text x="${nx.toFixed(1)}" y="${(ny - 3).toFixed(1)}" text-anchor="middle" font-family="${FONT}" font-size="9" fill="#cc2033">N</text></g>`
        );
    }
    function rangeRings() {
        const ppn = pxPerNm();
        if (!Number.isFinite(ppn) || ppn <= 0) return '';
        const maxNm = Math.min(W, H) / 2 / ppn;
        const stepNm = DERIVE.niceStep(maxNm);
        let out = '';
        for (let r = stepNm; r <= maxNm + 1e-6; r += stepNm) {
            const rr = r * ppn;
            out += `<circle cx="${W / 2}" cy="${H / 2}" r="${rr.toFixed(1)}" fill="none" stroke="#c9d5e3"/>`;
            out += `<text x="${W / 2 + 4}" y="${(H / 2 - rr + 11).toFixed(1)}" font-family="${FONT}" font-size="9" fill="#8a9bb0">${+r.toFixed(r < 1 ? 1 : 0)}nm</text>`;
        }
        return out;
    }
    function scaleBar() {
        const ppn = pxPerNm();
        if (!Number.isFinite(ppn) || ppn <= 0) return '';
        const nm = DERIVE.niceStep((W * 0.25) / ppn);
        const w = nm * ppn;
        const x = 14;
        const y = H - 16;
        return (
            `<line x1="${x}" y1="${y}" x2="${(x + w).toFixed(1)}" y2="${y}" stroke="#556070" stroke-width="2"/>` +
            `<line x1="${x}" y1="${y - 3}" x2="${x}" y2="${y + 3}" stroke="#556070" stroke-width="2"/>` +
            `<line x1="${(x + w).toFixed(1)}" y1="${y - 3}" x2="${(x + w).toFixed(1)}" y2="${y + 3}" stroke="#556070" stroke-width="2"/>` +
            `<text x="${(x + w / 2).toFixed(1)}" y="${y - 5}" text-anchor="middle" font-family="${FONT}" font-size="9" fill="#556070">${+nm.toFixed(nm < 1 ? 1 : 0)} nm</text>`
        );
    }

    /** World points of a boat's trail over the period (our dense track thinned). */
    function trail(b, view) {
        const win = ND.inWindow(b.series, view);
        const pts = [];
        let lastT = Infinity;
        for (let j = win.length - 1; j >= 0; j--) {
            const s = win[j];
            if (b.isUs && j !== win.length - 1 && lastT - s.t < OWN_STEP_MS) continue;
            lastT = s.t;
            pts.unshift({wx: mercX(s.lon), wy: mercY(s.lat), t: s.t, cogRad: s.cogRad});
        }
        if (pts.length && view.now - pts[pts.length - 1].t <= view.staleMs) pts[pts.length - 1].newest = true;
        return pts;
    }

    function fitTo(view) {
        const pts = [];
        for (const b of view.visible) {
            const s = b.cur || b.series[b.series.length - 1];
            if (s) pts.push([mercX(s.lon), mercY(s.lat)]);
        }
        if (!pts.length) return false;
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        const wx0 = Math.min(...xs);
        const wx1 = Math.max(...xs);
        const wy0 = Math.min(...ys);
        const wy1 = Math.max(...ys);
        center = {wx: (wx0 + wx1) / 2, wy: (wy0 + wy1) / 2};
        // Rotation-proof: fit the diagonal of the box into the smaller screen side.
        const span = Math.max(1e-7, Math.hypot(wx1 - wx0, wy1 - wy0));
        zoom = Math.max(MIN_Z, Math.min(pts.length < 2 ? 12 : 15, Math.log2((Math.min(W, H) * 0.82) / (256 * span))));
        return true;
    }

    function measure() {
        const el = $('map');
        const cw = el.clientWidth;
        const ch = el.clientHeight;
        if (cw > 20 && ch > 20 && (cw !== W || ch !== H)) {
            W = cw;
            H = ch;
            el.setAttribute('viewBox', `0 0 ${W} ${H}`);
            for (const id of ['mapcliprect', 'mapbg']) {
                $(id).setAttribute('width', W);
                $(id).setAttribute('height', H);
            }
        }
    }

    function render(view) {
        lastView = view;
        measure();
        if (!view.snap) return;
        rotDeg = r2d(view.upRad);
        const boats = [];
        const allW = [];
        for (const b of view.visible) {
            const pts = trail(b, view);
            if (!pts.length) continue;
            for (const p of pts) allW.push([p.wx, p.wy]);
            boats.push({b, pts});
        }
        const us = view.usNow;
        if (!fitted && fitTo(view)) fitted = true;
        if (view.mode === 'rel') {
            if (us) center = {wx: mercX(us.lon), wy: mercY(us.lat)};
            let mr = 1e-9;
            for (const [wx, wy] of allW) mr = Math.max(mr, Math.hypot(wx - center.wx, wy - center.wy));
            zoom = Math.max(MIN_Z, Math.min(17, Math.log2((Math.min(W, H) * 0.45) / (256 * mr))));
        } else if (follow && us) {
            // Nudge just enough to keep us inside the inner 80%, in rotated screen space.
            const [sx, sy] = rotXY(
                (mercX(us.lon) - center.wx) * scale(),
                (mercY(us.lat) - center.wy) * scale(),
                -rotDeg
            );
            const px = W / 2 + sx;
            const py = H / 2 + sy;
            const mx = W * 0.1;
            const my = H * 0.1;
            let ddx = 0;
            let ddy = 0;
            if (px < mx) ddx = mx - px;
            else if (px > W - mx) ddx = W - mx - px;
            if (py < my) ddy = my - py;
            else if (py > H - my) ddy = H - my - py;
            if (ddx || ddy) {
                const [nux, nuy] = rotXY(ddx, ddy, rotDeg);
                center = {wx: center.wx - nux / scale(), wy: center.wy - nuy / scale()};
            }
        }
        draw(view, boats);
    }

    function draw(view, boats) {
        const cx = W / 2;
        const cy = H / 2;
        $('maprot').setAttribute('transform', `rotate(${(-rotDeg).toFixed(3)}, ${cx.toFixed(1)}, ${cy.toFixed(1)})`);
        renderTiles();
        let s = '';
        const upright = (x, y) => `transform="rotate(${rotDeg.toFixed(3)}, ${x.toFixed(1)}, ${y.toFixed(1)})"`;
        if (view.wp) {
            const [wx, wy] = projPx(mercX(view.wp.lon), mercY(view.wp.lat));
            s +=
                `<circle cx="${wx.toFixed(1)}" cy="${wy.toFixed(1)}" r="9" fill="none" stroke="#cc2033" stroke-width="2"/>` +
                `<circle cx="${wx.toFixed(1)}" cy="${wy.toFixed(1)}" r="3.5" fill="#cc2033"/>` +
                `<text ${upright(wx, wy)} x="${(wx + 13).toFixed(1)}" y="${(wy + 4).toFixed(1)}" font-family="${FONT}" font-size="11" font-weight="700" fill="#cc2033" stroke="#fff" stroke-width="3" paint-order="stroke">${DRAW.esc(view.wp.name || 'WPT')}</text>`;
        }
        hits = [];
        const z = (x) => (x.b.id === view.sel ? 2 : x.b.isUs ? 1 : 0); // us, then the selection, on top
        boats.sort((a, b) => z(a) - z(b));
        for (const {b, pts} of boats) {
            const proj = pts.map((p) => {
                const [px, py] = projPx(p.wx, p.wy);
                return {...p, px, py};
            });
            for (const q of proj) {
                const [ox, oy] = rotXY(q.px - cx, q.py - cy, -rotDeg); // screen position after rotation
                hits.push({id: b.id, t: q.t, x: cx + ox, y: cy + oy, newest: !!q.newest});
            }
            const wMin = b.isUs ? 0.5 : 0.4;
            const wMax = b.isUs ? 7.2 : 5.2;
            const spanMs = Math.max(1, view.now - proj[0].t);
            const segs = [];
            for (let i = 0; i < proj.length - 1; i++) {
                if (proj[i + 1].t - proj[i].t > view.staleMs) continue; // break only on long gaps
                const f =
                    (DERIVE.ageFrac(proj[i].t, view.now, spanMs) + DERIVE.ageFrac(proj[i + 1].t, view.now, spanMs)) / 2;
                segs.push([proj[i].px, proj[i].py, proj[i + 1].px, proj[i + 1].py, f]);
            }
            s += DRAW.taper(segs, b.color, wMin, wMax, 0.08, 0.9);
            const hi = b.id === view.sel ? ' class="hi"' : '';
            for (const q of proj) {
                if (q.newest) {
                    const th = Number.isFinite(q.cogRad) ? q.cogRad : 0;
                    const ang = Math.atan2(-Math.cos(th), Math.sin(th)); // north-up screen direction
                    const len = (b.isUs ? 13 : 11) * 2 * (b.id === view.sel ? 1.5 : 1);
                    s += `<polygon${hi} points="${DRAW.boatIcon(q.px, q.py, ang, len)}" fill="${b.color}" stroke="#fff" stroke-width="1.3"/>`;
                    if (b.isUs)
                        s += `<text ${upright(q.px, q.py - 15)} x="${q.px.toFixed(1)}" y="${(q.py - 15).toFixed(1)}" text-anchor="middle" font-family="${FONT}" font-size="9" fill="${b.color}">US</text>`;
                } else {
                    const fr = DERIVE.ageFrac(q.t, view.now, spanMs);
                    s += `<circle cx="${q.px.toFixed(1)}" cy="${q.py.toFixed(1)}" r="2.2" fill="${b.color}" opacity="${(0.1 + 0.55 * fr).toFixed(2)}"/>`;
                }
            }
        }
        $('mapcontent').innerHTML = s;
        $('maprings').innerHTML = view.mode === 'rel' ? rangeRings() : '';
        let o = scaleBar() + northIndicator(rotDeg);
        if (ATTR[ND.prefs.base])
            o += `<text x="${W - 4}" y="${H - 5}" text-anchor="end" font-family="${FONT}" font-size="8" fill="#8090a0">${ATTR[ND.prefs.base]}</text>`;
        $('mapoverlay').innerHTML = o;
        $('mapLine').innerHTML =
            `<b>Geographic</b> &middot; ${DRAW.esc(view.upName)} up` +
            (view.up == null && view.frame !== 'north' ? ' (unknown: north up)' : '') +
            ` &middot; ${view.mode === 'rel' ? 'fit all' : 'z' + zoom.toFixed(1)}`;
    }

    /** Nearest drawn boat point to an svg position; current positions win over trail dots. */
    function hitTest(x, y) {
        let best = null;
        let bd = Infinity;
        for (const h of hits) {
            const r = h.newest ? 22 : 9;
            const d = Math.hypot(h.x - x, h.y - y);
            if (d <= r) {
                const score = d - (h.newest ? 100 : 0);
                if (score < bd) {
                    bd = score;
                    best = h;
                }
            }
        }
        return best;
    }

    function redraw() {
        if (lastView) render({...lastView, mode: ND.prefs.mode});
    }

    function goAbs() {
        follow = false;
        if (ND.prefs.mode === 'abs') return;
        ND.setPrefs({mode: 'abs'});
        ND.render(true);
    }

    function zoomAbout(x, y, dz) {
        const sc = scale();
        const [ox, oy] = rotXY(x - W / 2, y - H / 2, rotDeg);
        const wxAt = center.wx + ox / sc;
        const wyAt = center.wy + oy / sc;
        zoom = Math.max(MIN_Z, Math.min(MAX_Z, zoom + dz));
        const s2 = scale();
        center = {wx: wxAt - ox / s2, wy: wyAt - oy / s2};
    }

    function init() {
        const svg = $('map');
        const px = (cx, cy) => {
            const r = svg.getBoundingClientRect();
            if (!r.width) return [0, 0];
            return [((cx - r.left) * W) / r.width, ((cy - r.top) * H) / r.height];
        };
        const moved = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) > TAP;
        function panTo(cur, start) {
            goAbs();
            const sc = scale();
            const [nux, nuy] = rotXY(cur[0] - start.p[0], cur[1] - start.p[1], rotDeg);
            center = {wx: start.c.wx - nux / sc, wy: start.c.wy - nuy / sc};
            redraw();
        }
        function tapAt(pt, client) {
            const h = hitTest(pt[0], pt[1]);
            if (h) ND.select(h.id, client[0], client[1], h.t);
            else ND.clearSel();
        }

        // Mouse and pen: pointer events, captured on the svg root.
        let mDrag = null;
        svg.addEventListener('pointerdown', (ev) => {
            if (ev.pointerType === 'touch') return;
            ev.preventDefault();
            try {
                svg.setPointerCapture(ev.pointerId);
            } catch (e) {
                /* not capturable */
            }
            mDrag = {p: px(ev.clientX, ev.clientY), c: {...center}, panning: false};
        });
        svg.addEventListener('pointermove', (ev) => {
            if (ev.pointerType === 'touch' || !mDrag) return;
            const cur = px(ev.clientX, ev.clientY);
            if (!mDrag.panning && moved(cur, mDrag.p)) mDrag.panning = true;
            if (mDrag.panning) panTo(cur, mDrag);
        });
        const mEnd = (ev) => {
            if (ev.pointerType === 'touch' || !mDrag) return;
            if (!mDrag.panning && ev.type === 'pointerup') tapAt(px(ev.clientX, ev.clientY), [ev.clientX, ev.clientY]);
            mDrag = null;
        };
        svg.addEventListener('pointerup', mEnd);
        svg.addEventListener('pointercancel', mEnd);
        svg.addEventListener(
            'wheel',
            (ev) => {
                ev.preventDefault();
                const [x, y] = px(ev.clientX, ev.clientY);
                goAbs();
                zoomAbout(x, y, ev.deltaY < 0 ? 0.35 : -0.35);
                redraw();
            },
            {passive: false}
        );

        // Touch: a tap selects, one finger pans, two fingers pinch.
        let tDrag = null;
        let pin = null;
        const tlist = (tl) => [...tl].map((t) => px(t.clientX, t.clientY));
        svg.addEventListener(
            'touchstart',
            (ev) => {
                ev.preventDefault();
                if (ev.touches.length >= 2) {
                    const [a, b] = tlist(ev.touches);
                    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
                    const sc = scale();
                    const [ox, oy] = rotXY(mid[0] - W / 2, mid[1] - H / 2, rotDeg);
                    // The world point under the fingers at pinch start stays under their midpoint.
                    pin = {
                        d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1,
                        z: zoom,
                        w: [center.wx + ox / sc, center.wy + oy / sc]
                    };
                    tDrag = null;
                } else {
                    const t = ev.touches[0];
                    tDrag = {
                        p: px(t.clientX, t.clientY),
                        c: {...center},
                        client: [t.clientX, t.clientY],
                        panning: false
                    };
                    pin = null;
                }
            },
            {passive: false}
        );
        svg.addEventListener(
            'touchmove',
            (ev) => {
                ev.preventDefault();
                if (ev.touches.length >= 2 && pin) {
                    const [a, b] = tlist(ev.touches);
                    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
                    goAbs();
                    // Absolute (not incremental) from the pinch-start state: no drift.
                    zoom = Math.max(MIN_Z, Math.min(MAX_Z, pin.z + Math.log2(Math.max(1e-3, d / pin.d))));
                    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
                    const sc = scale();
                    const [ox, oy] = rotXY(mid[0] - W / 2, mid[1] - H / 2, rotDeg);
                    center = {wx: pin.w[0] - ox / sc, wy: pin.w[1] - oy / sc};
                    redraw();
                } else if (ev.touches.length === 1 && tDrag) {
                    const cur = px(ev.touches[0].clientX, ev.touches[0].clientY);
                    if (!tDrag.panning && moved(cur, tDrag.p)) tDrag.panning = true;
                    if (tDrag.panning) panTo(cur, tDrag);
                }
            },
            {passive: false}
        );
        const tEnd = (ev) => {
            if (ev.touches.length === 0) {
                if (ev.type === 'touchend' && tDrag && !tDrag.panning && !pin) tapAt(tDrag.p, tDrag.client);
                tDrag = null;
                pin = null;
            } else if (ev.touches.length === 1) {
                // Pinch down to one finger: continue as a pan.
                pin = null;
                const t = ev.touches[0];
                tDrag = {p: px(t.clientX, t.clientY), c: {...center}, client: [t.clientX, t.clientY], panning: true};
            }
        };
        svg.addEventListener('touchend', tEnd);
        svg.addEventListener('touchcancel', tEnd);

        $('baseSeg').addEventListener('click', (e) => {
            const v = e.target.dataset && e.target.dataset.base;
            if (!v) return;
            ND.setPrefs({base: v});
            syncBase();
            tileKey = '';
            redraw();
        });
        $('fitBtn').addEventListener('click', () => {
            if (lastView && fitTo(lastView)) {
                follow = true;
                redraw();
            }
        });
        syncBase();
    }

    function syncBase() {
        for (const b of document.querySelectorAll('#baseSeg button'))
            b.classList.toggle('on', b.dataset.base === ND.prefs.base);
    }

    // Exposed for browser tests: the current view state.
    const state = () => ({center: {...center}, zoom, rotDeg, follow, W, H});

    ND.tabs.geo = {
        init,
        render,
        shown() {
            measure();
        },
        modeChanged() {
            if (ND.prefs.mode === 'abs') follow = true;
        },
        state,
        hitTest: (x, y) => hitTest(x, y)
    };
})();
