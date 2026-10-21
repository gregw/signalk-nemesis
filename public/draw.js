'use strict';
/* global DERIVE */
/*
 * Drawing helpers shared by the tabs (ported from the prototype): hull icons, strip
 * charts, colours, escaping. Pure string builders, no DOM access.
 */
// eslint-disable-next-line no-unused-vars
const DRAW = (() => {
    const US_COLOR = '#1a2a3a';

    /** Stable colour per boat id (MMSI), spread round the hue circle as the prototype's palette. */
    function colorFor(id) {
        if (id === 'self') return US_COLOR;
        let h = 0;
        for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
        return `hsl(${((h % 997) * 137.508) % 360} 55% 45%)`;
    }

    /**
     * A report from a race tracker (YB units through the CYCA feed, src 'cyca'), not heard
     * on AIS: drawn hollow, as an outline hull or a ring, so the two can be told apart.
     */
    const isTracker = (r) => !!r && r.src != null && r.src !== 'ais';
    /** Fill and stroke for a current hull: solid for AIS and us, hollow for a tracker fix. */
    function hullStyle(r, color, strokeW) {
        return isTracker(r)
            ? `fill="#fff" fill-opacity="0.85" stroke="${color}" stroke-width="${(strokeW + 1).toFixed(1)}"`
            : `fill="${color}" stroke="#fff" stroke-width="${strokeW}"`;
    }
    /** The key for hollow tracker fixes, for a tab's info line. */
    const TRACKER_KEY = '<span class="trkkey">&#9675; tracker (YB)</span>';

    /* Top-view hull outline, forward = +x, length about size (prototype boatIcon). */
    const HULL = [
        [0.58, 0],
        [0.34, 0.2],
        [0.08, 0.34],
        [-0.18, 0.34],
        [-0.4, 0.27],
        [-0.55, 0.21],
        [-0.55, -0.21],
        [-0.4, -0.27],
        [-0.18, -0.34],
        [0.08, -0.34],
        [0.34, -0.2]
    ];
    function boatIcon(px, py, ang, size) {
        const c = Math.cos(ang);
        const s = Math.sin(ang);
        const BEAM = 0.7;
        return HULL.map(([lx, ly0]) => {
            const ly = ly0 * BEAM;
            return `${(px + (lx * c - ly * s) * size).toFixed(1)},${(py + (lx * s + ly * c) * size).toFixed(1)}`;
        }).join(' ');
    }

    /** Bow-up hull for the boat list. */
    function listIcon(color) {
        return `<svg width="26" height="26" viewBox="0 0 26 26"><polygon points="${boatIcon(13, 13, -Math.PI / 2, 21)}" fill="${color}" stroke="#fff" stroke-width="1"/></svg>`;
    }

    const W = 100;
    const H = 30;
    const TAPER_STEPS = 8;

    /**
     * Age-tapered line segments [[x1, y1, x2, y2, f]] (f: 1 newest .. 0 oldest), drawn as
     * one path per taper step rather than one element per segment: thousands of
     * elements cost far more to parse than the few paths do (render budget).
     */
    function taper(segs, color, wMin, wMax, opMin, opMax, extra = '') {
        const d = new Array(TAPER_STEPS).fill('');
        for (const [x1, y1, x2, y2, f] of segs) {
            const k = Math.min(TAPER_STEPS - 1, Math.max(0, Math.floor(f * TAPER_STEPS)));
            d[k] += `M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}`;
        }
        let out = '';
        for (let k = 0; k < TAPER_STEPS; k++) {
            if (!d[k]) continue;
            const f = (k + 0.5) / TAPER_STEPS;
            out +=
                `<path d="${d[k]}" fill="none" stroke="${color}" stroke-width="${(wMin + (wMax - wMin) * f).toFixed(2)}" ` +
                `opacity="${(opMin + (opMax - opMin) * f).toFixed(2)}" stroke-linecap="round"${extra}/>`;
        }
        return out;
    }

    // Shared mapping of a strip chart: x by age (newest at the left edge), y by value.
    function mapper(lo, hi, nowT, periodMs) {
        const pad = (hi - lo) * 0.06;
        const L = lo - pad;
        const U = hi + pad;
        return {
            X: (t) => 1 + Math.max(0, Math.min(1, (nowT - t) / Math.max(1, periodMs))) * (W - 2),
            Y: (v) => H - 1 - ((v - L) / (U - L)) * (H - 2)
        };
    }

    /**
     * Strip chart, newest on the LEFT, comet taper (thick and solid recent, thin and faint
     * old). pts = [{t, v}] oldest first (v may be null). Lines bridge gaps up to staleMs.
     */
    function spark(pts, color, lo, hi, nowT, periodMs, staleMs) {
        const valid = pts.filter((p) => p.v != null && Number.isFinite(p.v));
        if (!valid.length || !(hi > lo))
            return `<svg class="spk" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"></svg>`;
        const {X, Y} = mapper(lo, hi, nowT, periodMs);
        const zero =
            lo < 0 && hi > 0
                ? `<line x1="1" y1="${Y(0).toFixed(1)}" x2="${W - 1}" y2="${Y(0).toFixed(1)}" stroke="#d0d9e4" vector-effect="non-scaling-stroke"/>`
                : '';
        const segs = [];
        for (let k = 0; k < valid.length - 1; k++) {
            const a = valid[k];
            const b = valid[k + 1];
            if (b.t - a.t > staleMs) continue;
            const f = (DERIVE.ageFrac(a.t, nowT, periodMs) + DERIVE.ageFrac(b.t, nowT, periodMs)) / 2;
            segs.push([X(a.t), Y(a.v), X(b.t), Y(b.v), f]);
        }
        const lines = taper(segs, color, 0.6, 3.6, 0.18, 1, ' vector-effect="non-scaling-stroke"');
        const last = valid[valid.length - 1];
        const x = X(last.t).toFixed(2);
        const y = Y(last.v).toFixed(2);
        // A zero-length round-capped line stays circular when the chart is stretched.
        const dot = `<line class="dot" x1="${x}" y1="${y}" x2="${x}" y2="${y}" stroke="${color}" stroke-width="6" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
        return `<svg class="spk" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${zero}${lines}${dot}</svg>`;
    }

    /** The latest value and its position as fractions of the chart box (same mapping as spark). */
    function latestPos(pts, lo, hi, nowT, periodMs) {
        if (!(hi > lo)) return null;
        for (let i = pts.length - 1; i >= 0; i--) {
            const v = pts[i].v;
            if (v != null && Number.isFinite(v)) {
                const {X, Y} = mapper(lo, hi, nowT, periodMs);
                return {v, xf: X(pts[i].t) / W, yf: Y(v) / H};
            }
        }
        return null;
    }

    /** [min, max] of the finite values in a chart series. */
    function extent(pts) {
        let a = Infinity;
        let z = -Infinity;
        for (const p of pts) {
            if (p.v == null || !Number.isFinite(p.v)) continue;
            if (p.v < a) a = p.v;
            if (p.v > z) z = p.v;
        }
        return [a, z];
    }

    /** A window of the given height centred on a series' extent. */
    function centred(mm, span) {
        if (!(mm[1] >= mm[0])) return [-span / 2, span / 2];
        const mid = (mm[0] + mm[1]) / 2;
        return [mid - span / 2, mid + span / 2];
    }

    /** The value label over a chart's latest dot (p from latestPos). */
    function chip(p, fmt, cls = '') {
        if (!p) return '';
        const tx = p.xf < 0.15 ? '0%' : p.xf > 0.85 ? '-100%' : '-50%';
        // Above the dot, or below it when the dot is near the top, so it stays inside the row.
        const ty = p.yf < 0.45 ? '4px' : 'calc(-100% - 3px)';
        return `<span class="cv ${cls}" style="left:${(p.xf * 100).toFixed(1)}%;top:${(p.yf * 100).toFixed(1)}%;transform:translate(${tx},${ty})">${fmt(p.v)}</span>`;
    }

    /** Column header text for a shared chart height. */
    function fmtSpan(v, u) {
        return `&#8597; ${v < 1 ? v.toFixed(2) : v < 10 ? v.toFixed(1) : Math.round(v)} ${u}`;
    }

    function esc(s) {
        return String(s).replace(
            /[&<>"']/g,
            (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]
        );
    }

    /** Signed number with a real minus sign, or an en dash when missing. */
    function signed(v, digits) {
        if (v == null || !Number.isFinite(v)) return '&ndash;';
        const r = Number(v.toFixed(digits));
        return (r > 0 ? '+' : r < 0 ? '&minus;' : '') + Math.abs(r).toFixed(digits);
    }

    return {
        US_COLOR,
        colorFor,
        boatIcon,
        isTracker,
        hullStyle,
        TRACKER_KEY,
        listIcon,
        taper,
        spark,
        latestPos,
        extent,
        centred,
        chip,
        fmtSpan,
        esc,
        signed
    };
})();
