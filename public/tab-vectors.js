'use strict';
/* global ND, UNITS, DERIVE, DRAW */
/*
 * Vectors tab (wiki section 3.7): each boat's velocity with Up at the top. Absolute:
 * the origin is zero velocity. Relative: the origin is us (their velocity minus ours,
 * so current and leeway cancel). Comet tails join successive reports, tapering with
 * the age of each segment's endpoints. The selected boat's true velocity vectors are
 * drawn as dashed shafts. Auto-fit: origin plus all shown boats and tails, 10% margin.
 *
 * Rendered content has pointer-events: none; taps hit-test in code against the
 * positions drawn (prototype lesson: never make re-rendered children gesture targets).
 */
(() => {
    const $ = (id) => document.getElementById(id);
    const FONT = 'ui-monospace, Menlo, Consolas, monospace';
    const OWN_STEP_MS = 120e3; // our own track is dense; one hull per 2 min is plenty
    let hits = []; // [{id, t, x, y, newest}] in svg coordinates
    let size = {w: 400, h: 400};

    const kn = (p) => p && {x: UNITS.kn(p.x), y: UNITS.kn(p.y)};

    function pointsFor(b, view) {
        const out = [];
        const win = ND.inWindow(b.series, view);
        if (b.isUs) {
            if (view.mode === 'rel') {
                if (b.cur) out.push({t: b.cur.t, p: {x: 0, y: 0}});
            } else {
                let lastT = -Infinity;
                for (let j = win.length - 1; j >= 0; j--) {
                    // newest first, so the latest sample is always kept
                    if (lastT - win[j].t < OWN_STEP_MS && j !== win.length - 1) continue;
                    lastT = win[j].t;
                    const p = kn(DERIVE.vectorPoint(win[j], null, 'abs', view.upRad));
                    if (p) out.unshift({t: win[j].t, p});
                }
            }
        } else {
            for (const r of win) {
                const p = kn(DERIVE.vectorPoint(r, view.usAt(r.t), view.mode, view.upRad));
                if (p) out.push({t: r.t, p, src: r.src});
            }
        }
        // The newest point is the boat's current state unless it is older than stale.
        if (out.length && view.now - out[out.length - 1].t <= view.staleMs) out[out.length - 1].newest = true;
        return out;
    }

    function render(view) {
        const el = $('polar');
        let BW = el.clientWidth;
        let BH = el.clientHeight;
        if (!(BW > 20 && BH > 20)) {
            BW = 400;
            BH = 400;
        }
        size = {w: BW, h: BH};
        el.setAttribute('viewBox', `0 0 ${BW} ${BH}`);
        hits = [];
        const ref =
            DRAW.esc(view.upName) + ' up' + (view.up == null && view.frame !== 'north' ? ' (unknown: north up)' : '');
        $('modeLine').innerHTML = `<b>${view.mode === 'rel' ? 'Relative to us' : 'Absolute'}</b> &middot; ${ref}`;
        if (!view.snap) {
            el.innerHTML = '';
            $('scaleLine').textContent = '';
            return;
        }

        const draw = [];
        let anyTracker = false;
        const XY = [[0, 0]]; // the origin is always in view
        for (const b of view.visible) {
            const proj = pointsFor(b, view);
            if (!proj.length) continue;
            for (const q of proj) XY.push([q.p.x, q.p.y]);
            draw.push({b, proj});
        }

        const CX = BW / 2;
        const CY = BH / 2;
        const xs = XY.map((p) => p[0]);
        const ys = XY.map((p) => p[1]);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        const cx0 = (minX + maxX) / 2;
        const cy0 = (minY + maxY) / 2;
        const scale = Math.min((BW * 0.8) / Math.max(maxX - minX, 0.1), (BH * 0.8) / Math.max(maxY - minY, 0.1));
        const sx = (x) => CX + (x - cx0) * scale;
        const sy = (y) => CY - (y - cy0) * scale;
        const maxMag = Math.max(0.05, ...XY.map((p) => Math.hypot(p[0], p[1])));
        const step = DERIVE.niceStep(maxMag);
        const oX = sx(0);
        const oY = sy(0);

        let s = `<defs><clipPath id="polclip"><rect x="0" y="0" width="${BW}" height="${BH}"/></clipPath></defs><g clip-path="url(#polclip)">`;
        s += `<line x1="${oX.toFixed(1)}" y1="0" x2="${oX.toFixed(1)}" y2="${BH}" stroke="#8ea3bc" stroke-width="1.2"/>`;
        s += `<line x1="0" y1="${oY.toFixed(1)}" x2="${BW}" y2="${oY.toFixed(1)}" stroke="#c6d3e2"/>`;
        // Ring labels sit along the line from the origin toward the centre of the box.
        let dx = CX - oX;
        let dy = CY - oY;
        const dl = Math.hypot(dx, dy) || 1;
        dx /= dl;
        dy /= dl;
        const ring = (rv, stroke, w, label, fill) => {
            const rr = rv * scale;
            const tx = oX + dx * rr;
            return (
                `<circle cx="${oX.toFixed(1)}" cy="${oY.toFixed(1)}" r="${rr.toFixed(1)}" fill="none" stroke="${stroke}" stroke-width="${w}"/>` +
                `<text x="${tx.toFixed(1)}" y="${(oY + dy * rr).toFixed(1)}" text-anchor="${tx > BW - 60 ? 'end' : 'start'}" font-family="${FONT}" font-size="11" fill="${fill}">${label}</text>`
            );
        };
        for (let rv = step; rv <= maxMag - step * 0.5; rv += step)
            s += ring(rv, '#aebfd4', 1.1, +rv.toFixed(2), '#5a7290');
        s += ring(maxMag, '#7f95b0', 1.4, +maxMag.toFixed(2) + 'kn', '#42566f');

        // Our heading relative to Up, for our hull at the origin in Relative mode.
        let usAng = -Math.PI / 2;
        if (view.usNow && Number.isFinite(view.usNow.cogRad)) {
            const brg = view.usNow.cogRad - view.upRad;
            usAng = Math.atan2(-Math.cos(brg), Math.sin(brg));
        }

        const z = (x) => (x.b.id === view.sel ? 2 : x.b.isUs ? 1 : 0); // us, then the selection, on top
        draw.sort((a, b) => z(a) - z(b));
        for (const {b, proj} of draw) {
            const isUs = b.isUs;
            const color = b.color;
            const spanMs = Math.max(1, view.now - proj[0].t);
            const selMul = b.id === view.sel ? 1.5 : 1;
            const wMin = isUs ? 0.5 : 0.4;
            const wMax = isUs ? 7.2 : 5.2;
            const segs = [];
            for (let i = 0; i < proj.length - 1; i++) {
                if (proj[i + 1].t - proj[i].t > view.staleMs) continue; // break only on long gaps
                const a = proj[i].p;
                const c = proj[i + 1].p;
                const f =
                    (DERIVE.ageFrac(proj[i].t, view.now, spanMs) + DERIVE.ageFrac(proj[i + 1].t, view.now, spanMs)) / 2;
                segs.push([sx(a.x), sy(a.y), sx(c.x), sy(c.y), f]);
            }
            s += DRAW.taper(segs, color, wMin, wMax, 0.08, 0.9);
            if (b.id === view.sel) {
                for (const q of proj) {
                    const f = q.newest ? 1 : DERIVE.ageFrac(q.t, view.now, spanMs);
                    s +=
                        `<line x1="${oX.toFixed(1)}" y1="${oY.toFixed(1)}" x2="${sx(q.p.x).toFixed(1)}" y2="${sy(q.p.y).toFixed(1)}" ` +
                        `stroke="${color}" stroke-width="${(0.5 + 3 * f).toFixed(2)}" opacity="${(0.14 + 0.66 * f).toFixed(2)}" stroke-linecap="round" stroke-dasharray="5 4"/>`;
                }
            }
            // Older hulls are grouped into one path per age step (render budget).
            const STEPS = 6;
            const old = new Array(STEPS).fill('');
            const oldTrk = new Array(STEPS).fill('');
            const hiCls = b.id === view.sel ? ' class="hi"' : '';
            let front = '';
            for (const q of proj) {
                const px = sx(q.p.x);
                const py = sy(q.p.y);
                let ang = Math.atan2(py - oY, px - oX); // along the velocity (the shaft)
                if (isUs && q.newest && Math.hypot(px - oX, py - oY) < 2) ang = usAng;
                if (q.newest) {
                    let sz = ((isUs ? 11 : 9) + 4) * 2 * selMul;
                    if (isUs) {
                        sz *= 1.4;
                        front += `<polygon${hiCls} points="${DRAW.boatIcon(px, py, ang, sz)}" fill="${color}" stroke="#fff" stroke-width="1.8"/>`;
                        front += `<text x="${px.toFixed(1)}" y="${(py - sz * 0.55 - 6).toFixed(1)}" text-anchor="middle" font-family="${FONT}" font-size="9" fill="${color}">US</text>`;
                    } else {
                        front += `<polygon${hiCls} points="${DRAW.boatIcon(px, py, ang, sz)}" ${DRAW.hullStyle(q, color, 1)}/>`;
                        anyTracker = anyTracker || DRAW.isTracker(q);
                    }
                } else {
                    const k = Math.min(STEPS - 1, Math.floor(DERIVE.ageFrac(q.t, view.now, spanMs) * STEPS));
                    const fr = (k + 0.5) / STEPS;
                    const sz = (isUs ? 11 : 9) * (0.45 + 0.55 * fr) * 2 * selMul;
                    const d = 'M' + DRAW.boatIcon(px, py, ang, sz).replace(/ /g, 'L') + 'Z';
                    // Tracker fixes as outlines, in their own path per age step.
                    if (DRAW.isTracker(q)) {
                        anyTracker = true;
                        oldTrk[k] += d;
                    } else old[k] += d;
                }
                hits.push({id: b.id, t: q.t, x: px, y: py, newest: !!q.newest});
            }
            for (let k = 0; k < STEPS; k++) {
                const op = (0.25 + (0.6 * (k + 0.5)) / STEPS).toFixed(2);
                if (old[k]) s += `<path${hiCls} d="${old[k]}" fill="${color}" opacity="${op}"/>`;
                if (oldTrk[k])
                    s += `<path${hiCls} d="${oldTrk[k]}" fill="#fff" fill-opacity="0.6" stroke="${color}" stroke-width="1.2" opacity="${op}"/>`;
            }
            s += front;
        }
        s += '</g>';
        el.innerHTML = s;
        $('scaleLine').innerHTML =
            `ring ${+step.toFixed(2)}kn  max ~${+maxMag.toFixed(2)}kn` +
            (anyTracker ? ' &middot; ' + DRAW.TRACKER_KEY : '');
    }

    /** Nearest drawn point to an svg position; current positions win over trail points. */
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

    function init() {
        const el = $('polar');
        el.addEventListener('pointerdown', (ev) => {
            const r = el.getBoundingClientRect();
            if (!r.width) return;
            const h = hitTest(((ev.clientX - r.left) * size.w) / r.width, ((ev.clientY - r.top) * size.h) / r.height);
            if (h) ND.select(h.id, ev.clientX, ev.clientY, h.t);
            else ND.clearSel();
        });
    }

    ND.tabs.vectors = {init, render, hitTest: (x, y) => hitTest(x, y)};
})();
