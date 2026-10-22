'use strict';
/*
 * Printable incident diagram from two boats' Expedition logs: each boat's track, its hull
 * outline every few seconds (numbered, the same number on both boats at the same instant),
 * the time, COG and SOG beside each outline, a table of the numbered positions with the distances
 * between the boats, a scale bar, north and wind arrows, and a statement of the error
 * margins. One A4 landscape page per panel, written as HTML and, with Playwright, PDF.
 * Static by design: protest hearings often will not look at video.
 *
 *   node tools/protest-diagram.js <config.json> <out-basename>
 *
 * Config (times ISO UTC; lengths in metres):
 *   {title, tzHours: 11, tzName: 'AEDT',
 *    boats: [{key, name, log, lengthM, beamM?, colour,
 *             antenna: {fromSternM, stbdM} | null,     // null: unknown, assumed at the centre
 *             headingCorrection?: {deg, source}}],     // added to the logged HDG (and TWD)
 *    panels: [{from, to, intervalS, title?}]}
 *
 * Boats are placed at their GPS fix times (the logs' "GPS time"), not the logging PC
 * clocks, which differed by about a second. Positions are interpolated between fixes;
 * the outline is turned to the logged compass heading, or the COG (dashed) where no
 * heading was logged within 2 s. Local metres on a tangent plane: exact enough over a
 * few hundred metres.
 */
const fs = require('node:fs');
const path = require('node:path');
const {parseExpedition} = require('../test/sim/expedition-log');

const R = 6371008.8; // mean Earth radius, m
const D2R = Math.PI / 180;
const KN = 1852 / 3600;
const HDG_MAX_GAP_MS = 2000;
const POS_MAX_GAP_MS = 3000;

/**
 * Rows with deg added to the logged heading, and to the TWD, which Expedition logs as
 * HDG + TWA (so it carries the same offset). For a heading logged as magnetic: deg is the
 * variation, east positive. TWA, COG and SOG are left as logged.
 */
function correctHeadings(rows, deg) {
    if (!deg) return rows;
    const d = deg * D2R;
    const add = (v) => (v == null ? v : (((v + d) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI));
    return rows.map((r) => ({...r, hdgRad: add(r.hdgRad), twdRad: add(r.twdRad)}));
}

/** Tangent-plane projection about (lat0, lon0): [x east, y north] in metres. */
function projector(lat0, lon0) {
    const c = Math.cos(lat0 * D2R);
    return (lat, lon) => [(lon - lon0) * D2R * R * c, (lat - lat0) * D2R * R];
}

/** [x, y] in a frame turned so that bearing `up` (rad) points along +y. */
function turn([x, y], up) {
    const c = Math.cos(up);
    const s = Math.sin(up);
    return [x * c - y * s, x * s + y * c];
}

/**
 * A boat's state at GPS time T from its rows (sorted by gpsT): position interpolated
 * between the fixes either side (none if they are more than 3 s apart), COG and SOG from
 * the nearest row, heading from the nearest row with one within 2 s (else null). Rows
 * with no fix time or position are skipped. Null outside the log.
 */
function stateAt(rows, T) {
    const rs = rows.filter((r) => r.gpsT != null && r.lat != null && r.lon != null);
    let i = rs.findIndex((r) => r.gpsT >= T);
    if (i < 0) return null;
    let lat;
    let lon;
    if (rs[i].gpsT === T || i === 0) {
        if (rs[i].gpsT - T > POS_MAX_GAP_MS / 2) return null;
        ({lat, lon} = rs[i]);
    } else {
        const a = rs[i - 1];
        const b = rs[i];
        if (b.gpsT - a.gpsT > POS_MAX_GAP_MS) return null;
        const f = (T - a.gpsT) / (b.gpsT - a.gpsT);
        lat = a.lat + (b.lat - a.lat) * f;
        lon = a.lon + (b.lon - a.lon) * f;
    }
    const byGap = rs.map((r) => [Math.abs(r.gpsT - T), r]).sort((x, y) => x[0] - y[0]);
    const near = byGap[0][1];
    const h = byGap.find(([g, r]) => g <= HDG_MAX_GAP_MS && r.hdgRad != null);
    return {
        T,
        lat,
        lon,
        cogRad: near.cogRad,
        sogMs: near.sogMs,
        hdgRad: h ? h[1].hdgRad : null,
        twdRad: near.twdRad,
        twaRad: near.twaRad,
        twsMs: near.twsMs
    };
}

/**
 * The hull centre (half way along the waterline length, on the centre line) from the GPS
 * antenna's position [x, y] and the heading. The antenna is fwdM forward of the centre and
 * stbdM to starboard.
 */
function hullCentre([ax, ay], hdgRad, fwdM, stbdM) {
    const fx = Math.sin(hdgRad);
    const fy = Math.cos(hdgRad);
    // Starboard is 90 degrees clockwise of forward.
    const sx = Math.cos(hdgRad);
    const sy = -Math.sin(hdgRad);
    return [ax - fwdM * fx - stbdM * sx, ay - fwdM * fy - stbdM * sy];
}

/**
 * Sideways separation of outline b from outline a across heading h (radians, clockwise from
 * the page's up): the gap between them ignoring how far one is ahead, so never more than the
 * shortest gap. Returns d (negative if they overlap sideways), sgn (+1 when b is to port of
 * a), and pa, pb: the points of each that face the other.
 */
function lateralGap(a, h, b) {
    const port = [-Math.cos(h), Math.sin(h)];
    const across = (q) => q[0] * port[0] + q[1] * port[1];
    const mean = (poly) => poly.reduce((n, q) => n + across(q), 0) / poly.length;
    const sgn = mean(b) >= mean(a) ? 1 : -1;
    const pick = (poly, dir) => poly.reduce((best, q) => (dir * across(q) > dir * across(best) ? q : best));
    const pa = pick(a, sgn);
    const pb = pick(b, -sgn);
    return {pa, pb, d: sgn * (across(pb) - across(pa)), sgn};
}

/** Schematic hull outline (polygon of [x, y]) of length L and beam B, centred, turned to the heading. */
// The hull shape: [forward, starboard] as fractions of L and B, bow to transom on the
// starboard side: a fine bow, the forward shoulder, widest just aft of amidships, the
// quarter, a broad transom.
const HULL = [
    [0.5, 0],
    [0.3, 0.36],
    [0.05, 0.5],
    [-0.3, 0.47],
    [-0.5, 0.4]
];
const SHOULDER = HULL[1];
/** Half breadth of the hull (fraction of B) at f of L forward of the centre, along its side. */
function halfBreadth(f) {
    for (let i = 0; i + 1 < HULL.length; i++) {
        const [[f0, t0], [f1, t1]] = [HULL[i], HULL[i + 1]];
        if (f <= f0 && f >= f1) return t0 + ((t1 - t0) * (f0 - f)) / (f0 - f1);
    }
    return f > 0 ? 0 : HULL.at(-1)[1];
}
const QUARTER = HULL[3];

/** A point on a hull: f of L forward of the centre and t of B to starboard. */
function hullPoint([cx, cy], h, L, B, [f, t]) {
    return [cx + f * L * Math.sin(h) + t * B * Math.cos(h), cy + f * L * Math.cos(h) - t * B * Math.sin(h)];
}

/**
 * A boat not logged, placed relative to a logged one (ref: its centre c, heading h, L, B,
 * outline poly), as a witness describes it. Returns {c, h, poly} for the boat (L, B):
 * - 'overlap': same heading as ref plus headingDeg, on ref's port (side 'port') or
 *   starboard side, its bow level with ref's stern, the hulls gapM apart.
 * - 'contact': heading ref's plus headingDeg, its starboard (or port) quarter touching
 *   ref's port (or starboard) forward shoulder.
 */
function witnessPose(pose, ref, L, B, up = 0) {
    const p = placePose(pose, ref, L, B);
    if (pose.hdgDeg == null) return p;
    // A true heading given: turned about the bow, which stays where the rule put it.
    const bow = hullPoint(p.c, p.h, L, B, [0.5, 0]);
    const h = pose.hdgDeg * D2R - up;
    const c = hullPoint(bow, h, L, B, [-0.5, 0]);
    return {c, h, poly: hullOutline(c, h, L, B)};
}
function placePose(pose, ref, L, B) {
    const h = ref.h + (pose.headingDeg || 0) * D2R;
    const port = (pose.side || 'port') === 'port' ? -1 : 1; // starboard fraction sign
    if (pose.rule === 'contact') {
        const at = hullPoint(ref.c, ref.h, ref.L, ref.B, [SHOULDER[0], port * SHOULDER[1]]);
        // The touching point on this boat's side: contactAtM forward of its centre (negative
        // aft), by default the quarter.
        const f = pose.contactAtM != null ? pose.contactAtM / L : QUARTER[0];
        const off = hullPoint([0, 0], h, L, B, [f, -port * halfBreadth(f)]);
        const c = [at[0] - off[0], at[1] - off[1]];
        return {c, h, poly: hullOutline(c, h, L, B)};
    }
    // overlap: slide sideways until the hulls are gapM apart.
    const sternMid = hullPoint(ref.c, ref.h, ref.L, ref.B, [-0.5, 0]);
    const at = (d) => {
        const bow = hullPoint(sternMid, ref.h, 1, 1, [0, port * d]);
        const c = hullPoint(bow, h, L, B, [-0.5, 0]);
        return {c, h, poly: hullOutline(c, h, L, B)};
    };
    // The gap: hull to hull (gapM), or this bow to ref's transom (bowToSternM).
    const transom = [
        hullPoint(ref.c, ref.h, ref.L, ref.B, [-0.5, -0.4]),
        hullPoint(ref.c, ref.h, ref.L, ref.B, [-0.5, 0.4])
    ];
    const gap = (p) => (pose.bowToSternM != null ? polyDistance([p.poly[0]], transom) : polyDistance(p.poly, ref.poly));
    const want = pose.bowToSternM ?? pose.gapM;
    let lo = 0;
    let hi = 100;
    for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (gap(at(mid)) < want) lo = mid;
        else hi = mid;
    }
    return at(hi);
}

function hullOutline([cx, cy], hdgRad, L, B) {
    const half = HULL;
    const pts = half.concat(
        half
            .slice(1)
            .reverse()
            .map(([f, s]) => [f, -s])
    );
    const fx = Math.sin(hdgRad);
    const fy = Math.cos(hdgRad);
    return pts.map(([f, s]) => [cx + f * L * fx + s * B * fy, cy + f * L * fy - s * B * fx]);
}

/** Distance between two closed polygons (0 if they touch or overlap). */
function polyDistance(P, Q) {
    const segs = (A) => A.map((p, i) => [p, A[(i + 1) % A.length]]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    // Segments cross or touch. Collinear ones (every cross product 0) only if they overlap,
    // which the point-to-segment distances below find as 0.
    const intersect = ([p1, p2], [q1, q2]) => {
        const [a, b, c, d] = [cross(p1, p2, q1), cross(p1, p2, q2), cross(q1, q2, p1), cross(q1, q2, p2)];
        if (a === 0 && b === 0) return false;
        return a * b <= 0 && c * d <= 0;
    };
    const ptSeg = (p, [a, b]) => {
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const f = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
        return Math.hypot(p[0] - a[0] - f * dx, p[1] - a[1] - f * dy);
    };
    const inside = (p, A) => {
        let c = false;
        for (const [a, b] of segs(A))
            if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
        return c;
    };
    if (inside(P[0], Q) || inside(Q[0], P)) return 0;
    let d = Infinity;
    for (const s of segs(P))
        for (const t of segs(Q)) {
            if (intersect(s, t)) return 0;
            d = Math.min(d, ptSeg(s[0], t), ptSeg(s[1], t), ptSeg(t[0], s), ptSeg(t[1], s));
        }
    return d;
}

/** Circular mean (rad, 0..2pi) and the half-range about it (rad), of the non-null angles. */
function circStats(as) {
    const v = as.filter((a) => a != null);
    if (!v.length) return null;
    const m = Math.atan2(
        v.reduce((s, a) => s + Math.sin(a), 0),
        v.reduce((s, a) => s + Math.cos(a), 0)
    );
    const dev = v.map((a) => Math.atan2(Math.sin(a - m), Math.cos(a - m)));
    return {mean: (m + 2 * Math.PI) % (2 * Math.PI), lo: Math.min(...dev), hi: Math.max(...dev)};
}

// Labels: two lines of up to 11 monospace characters at 2.2 mm.
const LABEL_W = 22; // one line: "59:30 021° 0.8kn"
const LABEL_H = 2.9;
const WIND_W = 15; // wind marker: an arrow over a one-line label
const WIND_H = 9.5;
const WIND = '#4a5868'; // neutral: not one of the boats' colours
const GAP = 2.5; // mm between a boat and its labels, and between label columns
// Outline strength: fill and line opacity, line width (mm), label opacity.
const SHADES = {
    faint: {fill: 0.06, line: 0.45, width: 0.3, text: 0.75},
    medium: {fill: 0.22, line: 0.8, width: 0.45, text: 1},
    full: {fill: 0.5, line: 1, width: 0.75, text: 1, row: 'bold'},
    // The full fill with the faint line; its table row in bold on a grey band.
    filled: {fill: 0.5, line: 0.45, width: 0.3, text: 1, row: 'band'}
};
const fillOf = (b) => b.colour;
const GHOST = {fill: 0.03, line: 0.25, width: 0.2}; // outlines after the period
const WITNESS_DASH = '1.6 0.9'; // outlines of boats not logged

/** "every 10 s, 5 s from 59:30, 10 s from 59:50" for the subtitle. */
function stepsText(panel, mmss) {
    const st = panel.steps || [[panel.from, panel.intervalS]];
    return st.map(([t, sec], i) => (i ? `${sec} s from ${mmss(Date.parse(t))}` : `every ${sec} s`)).join(', ');
}
const WRAP = 100; // characters per line of notes in the side column
const rectPoly = ([x, y, w, h]) => [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h]
];

/** Words of text in lines of at most n characters. */
function wrap(text, n) {
    const out = [];
    let cur = '';
    for (const w of text.split(' ')) {
        if (cur && cur.length + 1 + w.length > n) {
            out.push(cur);
            cur = w;
        } else cur = cur ? cur + ' ' + w : w;
    }
    if (cur) out.push(cur);
    return out;
}

/**
 * Tops of h-high labels stacked so their numbers rise up the page: label n+1 at least h + gap
 * above label n, each as near its wanted top as the order allows (least squares: pool
 * adjacent violators on y_n + n (h + gap), which must not increase), then the column
 * shifted to lie within [top, bottom].
 */
function stackUp(want, h, gap, top, bottom) {
    if (!want.length) return [];
    const s = h + gap;
    const blocks = [];
    want.forEach((y, n) => {
        blocks.push({sum: y + n * s, cnt: 1});
        while (blocks.length > 1) {
            const [a, b] = blocks.slice(-2);
            if (b.sum / b.cnt <= a.sum / a.cnt) break;
            blocks.splice(-2, 2, {sum: a.sum + b.sum, cnt: a.cnt + b.cnt});
        }
    });
    let ys = blocks.flatMap((bk) => Array(bk.cnt).fill(bk.sum / bk.cnt)).map((z, n) => z - n * s);
    const lo = Math.min(...ys);
    if (lo < top) ys = ys.map((y) => y + top - lo);
    const hi = Math.max(...ys) + h;
    if (hi > bottom) ys = ys.map((y) => y - (hi - bottom));
    return ys;
}

/** Median of angles (rad, 0..2pi): the median deviation about their circular mean. */
function circMedian(as) {
    const st = circStats(as);
    if (!st) return null;
    const dev = as
        .filter((a) => a != null)
        .map((a) => Math.atan2(Math.sin(a - st.mean), Math.cos(a - st.mean)))
        .sort((x, y) => x - y);
    return (((st.mean + median(dev)) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
}
function median(xs) {
    const v = xs.filter((x) => x != null).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * The boats' wind over [from, to): each boat's median TWD and TWS over its own readings,
 * then the circular mean of those TWDs and the mean of those TWSs, so a boat that logged
 * more often does not outweigh the other. {twdRad, twsMs}, either null without readings.
 */
function boatsWind(boats, from, to) {
    const per = boats.map((b) => {
        const rs = b.rows.filter((r) => r.gpsT >= from && r.gpsT < to);
        return {twd: circMedian(rs.map((r) => r.twdRad)), tws: median(rs.map((r) => r.twsMs))};
    });
    const twds = per.map((p) => p.twd).filter((x) => x != null);
    const twss = per.map((p) => p.tws).filter((x) => x != null);
    const m = circStats(twds);
    return {twdRad: m ? m.mean : null, twsMs: twss.length ? twss.reduce((a, x) => a + x, 0) / twss.length : null};
}

const niceStep = (x) => {
    const p = Math.pow(10, Math.floor(Math.log10(x)));
    const n = x / p;
    return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p;
};
const deg3 = (r) => (r == null ? '---' : String(Math.round(((r / D2R) % 360) + 360) % 360).padStart(3, '0'));
const kn1 = (v) => (v == null ? '-' : (v / KN).toFixed(1));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);

/**
 * The boats' geometry: antenna offset from the hull centre (fwd, stbd), and the margin
 * an unknown antenna adds (the furthest the antenna could be from the assumed centre).
 */
function boatGeom(b) {
    const L = b.lengthM;
    const B = b.beamM ?? +(L / 3.1).toFixed(1);
    const known = !!b.antenna;
    const fwd = known ? b.antenna.fromSternM - L / 2 : 0;
    const stbd = known ? b.antenna.stbdM : 0;
    return {...b, L, B, fwd, stbd, known, beamAssumed: b.beamM == null};
}

/** One panel's data: samples every intervalS and the 1 Hz tracks, in local metres. */
/** The gap between two boats' outlines (m), or null without both. */
const gapOf = (a, c) => (a && c && a.poly && c.poly ? polyDistance(a.poly, c.poly) : null);

function panelData(boats, panel, proj, up = 0, witnesses = []) {
    const from = Date.parse(panel.from);
    const to = Date.parse(panel.to);
    const times = [];
    // steps: [[iso, seconds], ...]: from each time on, outlines that many seconds apart.
    const steps = (panel.steps || [[panel.from, panel.intervalS]]).map(([t, sec]) => [Date.parse(t), sec * 1000]);
    for (let T = from; T <= to + 1; ) {
        times.push(T);
        T += steps.filter(([t]) => t <= T).at(-1)[1];
    }
    const per = boats.map((b) => {
        // Each logged fix once: a position repeated from the row before is a stale fix.
        const track = b.rows
            .filter((r) => r.gpsT >= from && r.gpsT <= to && r.lat != null)
            .filter((r, i, rs) => i === 0 || r.lat !== rs[i - 1].lat || r.lon !== rs[i - 1].lon)
            .map((r) => proj(r.lat, r.lon));
        const markAt = (T, k) => {
            const s = stateAt(b.rows, T);
            if (!s) return null;
            const ant = proj(s.lat, s.lon);
            const dashed = s.hdgRad == null;
            const h = dashed ? s.cogRad : s.hdgRad;
            if (h == null) return {n: k + 1, s, ant, poly: null, dashed};
            const c = hullCentre(ant, h - up, b.fwd, b.stbd);
            return {n: k + 1, s, ant, c, h: h - up, poly: hullOutline(c, h - up, b.L, b.B), dashed};
        };
        const marks = times.map(markAt);
        // ghosts: outlines after the period, drawn faintly behind everything for context.
        const ghosts = (panel.ghosts || []).map((t) => markAt(Date.parse(t), -1)); // null where no fix
        return {b, track, marks, ghosts, markAt};
    });
    // The closest approach over the panel, outline to outline (the gap), at 0.2 s steps.
    let close = null;
    for (let T = from; T <= to; T += 200) {
        const d = gapOf(per[0].markAt(T, -1), per[1].markAt(T, -1));
        if (d != null && (!close || d < close.d)) close = {T, d};
    }
    // Boats not logged, at the times a witness places them relative to a logged boat.
    const extra = witnesses.map((w) => {
        const b = boatGeom(w);
        const ref = per.find((p) => p.b.key === w.ref);
        const marks = (w.poses || []).map((pose) => {
            const T = Date.parse(pose.at);
            const n = times.indexOf(T);
            const r = ref && n >= 0 ? ref.marks[n] : null;
            if (!r || !r.poly) return null;
            return {n: n + 1, s: {T}, ...witnessPose(pose, {...r, L: ref.b.L, B: ref.b.B}, b.L, b.B, up)};
        });
        return {b, marks};
    });
    return {times, per, close, extra};
}

function renderPage(cfg, boats, panel, data, pageNo, pages, proj, up = 0) {
    const W = 297;
    const H = 210;
    const map = {x: 8, y: 20, w: 168, h: 182};
    const tz = (T) => new Date(T + cfg.tzHours * 3600e3).toISOString().slice(11, 19);
    const mmss = (T) => tz(T).slice(3); // the hour is in the subtitle
    // Fit all outlines and tracks, north up.
    const pts = data.per
        .flatMap((p) => p.track.concat(p.marks.flatMap((m) => (m && m.poly) || [])))
        .concat(data.per.flatMap((p) => p.ghosts.flatMap((m) => (m && m.poly) || [])))
        .concat(data.extra.flatMap((p) => p.marks.flatMap((m) => (m && m.poly) || [])));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const pad = 8; // metres
    const [x0, x1, y0, y1] = [
        Math.min(...xs) - pad,
        Math.max(...xs) + pad,
        Math.min(...ys) - pad,
        Math.max(...ys) + pad
    ];
    // Room beside the boats for the label columns: wind and left-side boats' labels on the
    // left, right-side boats' labels on the right.
    const sideOf = (b) => b.labelSide || 'right';
    const padL =
        (panel.windEveryS ? WIND_W + GAP : 0) + (boats.some((b) => sideOf(b) === 'left') ? LABEL_W + GAP : 0) + GAP;
    const padR = (boats.some((b) => sideOf(b) === 'right') ? LABEL_W + GAP : 0) + GAP;
    const inner = {x: map.x + padL, w: map.w - padL - padR};
    const k = Math.min(inner.w / (x1 - x0), map.h / (y1 - y0)); // mm per metre
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const X = (x) => inner.x + inner.w / 2 + (x - cx) * k;
    const Y = (y) => map.y + map.h / 2 - (y - cy) * k;
    const P = (p) => `${X(p[0]).toFixed(2)},${Y(p[1]).toFixed(2)}`;

    let svg = `<rect x="${map.x}" y="${map.y}" width="${map.w}" height="${map.h}" fill="#fbfdff" stroke="#9aa8b8" stroke-width="0.3"/>`;
    // Light 10 m grid for reading distances off the page.
    const g = niceStep(20 / k); // about every 20 mm
    for (let gx = Math.ceil((cx - map.w / 2 / k) / g) * g; X(gx) <= map.x + map.w; gx += g)
        svg += `<line x1="${X(gx).toFixed(2)}" y1="${map.y}" x2="${X(gx).toFixed(2)}" y2="${map.y + map.h}" stroke="#e3e9f0" stroke-width="0.2"/>`;
    for (let gy = Math.floor((cy + map.h / 2 / k) / g) * g; Y(gy) <= map.y + map.h; gy -= g)
        svg += `<line x1="${map.x}" y1="${Y(gy).toFixed(2)}" x2="${map.x + map.w}" y2="${Y(gy).toFixed(2)}" stroke="#e3e9f0" stroke-width="0.2"/>`;

    // shade: [[iso, 'faint' | 'medium' | 'full'], ...]: from each time on, outlines that strong.
    const shades = (panel.shade || []).map(([t, v]) => [Date.parse(t), v]);
    const shadeOf = (T) => SHADES[(shades.filter(([t]) => t <= T).at(-1) || [0, 'medium'])[1]];
    // events: [[iso, text], ...]: notes for the legend and the table, such as "approx. time of contact".
    const events = new Map((panel.events || []).map(([t, v]) => [Date.parse(t), v]));
    const eventOf = (T) => events.get(T);
    const hulls = [];
    // Ghosts first of all: the logged boats after the period, barely there.
    for (const {b, ghosts} of data.per)
        for (const m of ghosts.filter((g) => g && g.poly))
            svg += `<polygon points="${m.poly.map(P).join(' ')}" fill="${b.colour}" fill-opacity="${GHOST.fill}" stroke="${b.colour}" stroke-opacity="${GHOST.line}" stroke-width="${GHOST.width}"/>`;
    // Witness boats next, underneath everything, faded by their opacity (a reconstruction):
    // outline and number only (no logged course or speed to label).
    for (const {b, marks} of data.extra) {
        svg += `<g opacity="${b.opacity ?? 0.6}">`;
        for (const m of marks) {
            if (!m) continue;
            hulls.push(m.poly.map(([x, y]) => [X(x), Y(y)]));
            const sh = shadeOf(m.s.T);
            svg += `<polygon points="${m.poly.map(P).join(' ')}" fill="${fillOf(b, sh)}" fill-opacity="${sh.fill}" stroke="${b.colour}" stroke-opacity="${sh.line}" stroke-width="${sh.width}" stroke-dasharray="${WITNESS_DASH}"/>`;
            const [nx, ny] = hullPoint(m.c, m.h, b.L, b.B, [0.15, 0]);
            svg += `<text x="${X(nx).toFixed(2)}" y="${(Y(ny) + 0.7).toFixed(2)}" text-anchor="middle" class="hnum" fill="${b.textColour || b.colour}">${m.n}</text>`;
        }
        svg += '</g>';
    }
    for (const {b, track} of data.per) {
        svg += `<polyline points="${track.map(P).join(' ')}" fill="none" stroke="${b.colour}" stroke-width="0.35" opacity="0.7"/>`;
        // A dot, a little wider than the line, at every fix.
        for (const q of track)
            svg += `<circle cx="${X(q[0]).toFixed(2)}" cy="${Y(q[1]).toFixed(2)}" r="0.3" fill="${b.colour}" opacity="0.8"/>`;
    }
    // Outlines, then labels on top, each placed clear of every hull and earlier label.
    let nums = '';
    for (const {b, marks} of data.per)
        for (const m of marks) {
            if (!m || !m.poly) continue;
            const pp = m.poly.map(([x, y]) => [X(x), Y(y)]);
            hulls.push(pp);
            const sh = shadeOf(m.s.T);
            svg += `<polygon points="${m.poly.map(P).join(' ')}" fill="${fillOf(b, sh)}" fill-opacity="${sh.fill}" stroke="${b.colour}" stroke-opacity="${sh.line}" stroke-width="${sh.width}"${m.dashed ? ' stroke-dasharray="1.2 0.8"' : ''}/>`;
            svg += `<circle cx="${X(m.ant[0]).toFixed(2)}" cy="${Y(m.ant[1]).toFixed(2)}" r="0.45" fill="${b.colour}" fill-opacity="${sh.line}"/>`;
            // The sequence number inside the hull, a little forward of the centre.
            const [nx, ny] = [m.c[0] + Math.sin(m.h) * b.L * 0.15, m.c[1] + Math.cos(m.h) * b.L * 0.15];
            nums += `<text x="${X(nx).toFixed(2)}" y="${(Y(ny) + 0.7).toFixed(2)}" text-anchor="middle" class="hnum" fill="${b.textColour || b.colour}">${m.n}</text>`;
        }
    svg += nums;
    // Labels in columns: each boat's on its side, the wind's left of everything, numbers
    // rising up the page in every column. A label that cannot sit level with its boat is
    // joined to the boat's bow by a thin line.
    let leaders = ''; // drawn under every label
    let labels = '';
    const boxes = []; // placed label boxes [x, y, w, h], for the wind column to keep clear of
    const band = (y, h) => hulls.filter((p) => p.some((q) => q[1] > y - GAP && q[1] < y + h + GAP));
    for (const {b, marks} of data.per) {
        const ms = marks.filter((m) => m && m.poly);
        const left = sideOf(b) === 'left';
        // Each label aims to sit level with its boat's bow, so its line runs across the page.
        const want = ms.map((m) => Y(m.poly[0][1]) - LABEL_H / 2);
        const ys = stackUp(want, LABEL_H, 1, map.y + 1, map.y + map.h - 1);
        const ink = b.textColour || b.colour;
        ms.forEach((m, j) => {
            const by = ys[j];
            const near = band(by, LABEL_H).flat();
            const pp = m.poly.map(([x, y]) => [X(x), Y(y)]);
            const edge = left
                ? Math.min(...near.map((q) => q[0]), ...pp.map((q) => q[0])) - GAP
                : Math.max(...near.map((q) => q[0]), ...pp.map((q) => q[0])) + GAP;
            const bx = Math.max(map.x + 1, Math.min(map.x + map.w - 1 - LABEL_W, left ? edge - LABEL_W : edge));
            boxes.push([bx, by, LABEL_W, LABEL_H]);
            // Every label is joined to its boat's bow.
            const [ex, ey] = [left ? bx + LABEL_W : bx, by + LABEL_H / 2];
            leaders += `<line x1="${ex.toFixed(2)}" y1="${ey.toFixed(2)}" x2="${pp[0][0].toFixed(2)}" y2="${pp[0][1].toFixed(2)}" stroke="${b.colour}" stroke-width="0.15" opacity="0.8"/>`;
            const sh = shadeOf(m.s.T);
            const tx = left ? bx + LABEL_W - 0.4 : bx + 0.4;
            const anchor = left ? 'end' : 'start';
            labels += `<text x="${tx.toFixed(2)}" y="${(by + 2.2).toFixed(2)}" text-anchor="${anchor}" class="lab${sh.row ? ' b' : ''}" fill="${ink}" fill-opacity="${sh.text}">${mmss(m.s.T)} ${deg3(m.s.cogRad)}° ${kn1(m.s.sogMs)}kn</text>`;
        });
    }
    // Wind every windEveryS: an arrow the way the wind blows at the boats' median TWD over the
    // windEveryS around that time, with their median TWS and the number of the outlines at
    // that time, in a column left of the windNear boat and its labels.
    const wb = data.per.find((p) => p.b.key === panel.windNear) || data.per[0];
    const wind = [];
    for (let T = Date.parse(panel.from); panel.windEveryS && T <= Date.parse(panel.to); T += panel.windEveryS * 1000) {
        const half = (panel.windEveryS * 1000) / 2;
        const {twdRad: twd, twsMs: tws} = boatsWind(boats, T - half, T + half);
        const st = stateAt(wb.b.rows, T);
        if (twd == null || !st) continue;
        const n = data.times.indexOf(T);
        const [, py] = proj(st.lat, st.lon);
        wind.push({T, twd, tws, n: n < 0 ? null : n + 1, want: Y(py) - WIND_H / 2});
    }
    const wys = stackUp(
        wind.map((w) => w.want),
        WIND_H,
        1,
        map.y + 1,
        map.y + map.h - 1
    );
    wind.forEach((w, j) => {
        const by = wys[j];
        const clear = (r) => r[1] < by + WIND_H + GAP && r[1] + r[3] > by - GAP;
        const xs = boxes
            .filter(clear)
            .map((r) => r[0])
            .concat(
                band(by, WIND_H)
                    .flat()
                    .map((q) => q[0])
            );
        const bx = Math.max(map.x + 1, Math.min(...xs, map.x + map.w) - GAP - WIND_W);
        const [ux, uy] = [-Math.sin(w.twd - up), Math.cos(w.twd - up)]; // downwind, paper y down
        const [wx, wy] = [bx + WIND_W / 2 + 2, by + 3.6];
        const tail = [wx - ux * 3.2, wy - uy * 3.2];
        const head = [wx + ux * 3.2, wy + uy * 3.2];
        const hx = (q) => (head[0] - ux * 1.8 + q * uy * 1.1).toFixed(2);
        const hy = (q) => (head[1] - uy * 1.8 - q * ux * 1.1).toFixed(2);
        if (w.n)
            labels += `<text x="${(bx + 1).toFixed(2)}" y="${(by + 4.4).toFixed(2)}" class="wnum" fill="${WIND}">${w.n}</text>`;
        labels += `<line x1="${tail[0].toFixed(2)}" y1="${tail[1].toFixed(2)}" x2="${head[0].toFixed(2)}" y2="${head[1].toFixed(2)}" stroke="${WIND}" stroke-width="0.6"/>`;
        labels += `<path d="M${head[0].toFixed(2)},${head[1].toFixed(2)} L${hx(1)},${hy(1)} L${hx(-1)},${hy(-1)} Z" fill="${WIND}"/>`;
        labels += `<text x="${(bx + WIND_W / 2).toFixed(2)}" y="${(by + WIND_H - 0.6).toFixed(2)}" text-anchor="middle" class="wlab" fill="${WIND}">${kn1(w.tws)}kn ${deg3(w.twd)}°</text>`;
    });
    svg += leaders + labels;

    // A dark bold note in the nearest free spot to `at` (left of it first), with a thin line to it.
    function note(txt, at) {
        const [w, h] = [txt.length * 1.32 + 1, 3];
        for (let r = 5; r <= 40; r += 1.5)
            for (let q = 0; q < 12; q++) {
                const ang = Math.PI + (q % 2 ? 1 : -1) * Math.ceil(q / 2) * (Math.PI / 6);
                const bb = [at[0] + Math.cos(ang) * r - w / 2, at[1] + Math.sin(ang) * r - h / 2, w, h];
                const inMap =
                    bb[0] > map.x + 1 &&
                    bb[1] > map.y + 1 &&
                    bb[0] + w < map.x + map.w - 1 &&
                    bb[1] + h < map.y + map.h - 1;
                const clearOf = (r2) =>
                    !(bb[0] < r2[0] + r2[2] && r2[0] < bb[0] + w && bb[1] < r2[1] + r2[3] && r2[1] < bb[1] + h);
                if (!inMap || !boxes.every(clearOf) || !hulls.every((hp) => polyDistance(rectPoly(bb), hp) > 0.4))
                    continue;
                boxes.push(bb);
                const near = [Math.max(bb[0], Math.min(bb[0] + w, at[0])), Math.max(bb[1], Math.min(bb[1] + h, at[1]))];
                svg += `<line x1="${at[0].toFixed(2)}" y1="${at[1].toFixed(2)}" x2="${near[0].toFixed(2)}" y2="${near[1].toFixed(2)}" stroke="#1d2733" stroke-width="0.15"/>`;
                svg += `<text x="${(bb[0] + 0.5).toFixed(2)}" y="${(bb[1] + 2.2).toFixed(2)}" class="lab b" fill="#1d2733">${esc(txt)}</text>`;
                return;
            }
    }
    // Measures: how far a point of a boat (its bow) moved between two outline times, drawn
    // as a dark line between the two points with its length beside it.
    const measured = [];
    for (const ms of panel.measures || []) {
        const p = data.per.find((q) => q.b.key === ms.key);
        const [i, j] = [data.times.indexOf(Date.parse(ms.from)), data.times.indexOf(Date.parse(ms.to))];
        const [a, c] = p && i >= 0 && j >= 0 ? [p.marks[i], p.marks[j]] : [];
        if (!a || !c || !a.poly || !c.poly) continue;
        // The bow's movement split along and across the heading at the later time: the
        // sideways part is how much the bow closed (or opened) a gap beside it.
        const [pa, pc] = [a.poly[0], c.poly[0]]; // bows
        const [dx, dy] = [pc[0] - pa[0], pc[1] - pa[1]];
        const fwd = [Math.sin(c.h), Math.cos(c.h)];
        const port = [-Math.cos(c.h), Math.sin(c.h)];
        const along = dx * fwd[0] + dy * fwd[1];
        const across = dx * port[0] + dy * port[1]; // + to port
        const side = across >= 0 ? 'port' : 'starboard';
        measured.push({b: p.b, ms, along, across, side, hdg: c.h + up});
        // A right angle: forward along the heading (thin, dashed), then across it (the measure).
        const foot = [pa[0] + along * fwd[0], pa[1] + along * fwd[1]];
        const [x1, y1, xf, yf, x2, y2] = [X(pa[0]), Y(pa[1]), X(foot[0]), Y(foot[1]), X(pc[0]), Y(pc[1])];
        svg += `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${xf.toFixed(2)}" y2="${yf.toFixed(2)}" stroke="#1d2733" stroke-width="0.2" stroke-dasharray="0.8 0.6"/>`;
        svg += `<line x1="${xf.toFixed(2)}" y1="${yf.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="#1d2733" stroke-width="0.5"/>`;
        for (const [x, yy] of [
            [x1, y1],
            [x2, y2]
        ])
            svg += `<circle cx="${x.toFixed(2)}" cy="${yy.toFixed(2)}" r="0.55" fill="#1d2733"/>`;
        // The length in the nearest free spot, joined to the sideways leg's middle.
        note(`drift ${Math.abs(across).toFixed(1)} m to ${side}`, [(xf + x2) / 2, (yf + y2) / 2]);
    }

    // Distances: between a point of one boat and the nearest point of a part of another at a
    // time, such as a bow to a stern as an overlap begins; drawn with the length beside it.
    const spans = [];
    const marksOf = (key) =>
        (data.per.find((q) => q.b.key === key) || data.extra.find((q) => q.b.key === key) || {}).marks;
    const PARTS = {
        bow: (m) => [m.poly[0], m.poly[0]],
        stern: (m) => [m.poly[4], m.poly[5]] // the transom, port to starboard corner
    };
    for (const dsp of panel.distances || []) {
        const T = Date.parse(dsp.at);
        const k = data.times.indexOf(T);
        const [ma, mb] = [marksOf(dsp.from.key), marksOf(dsp.to.key)].map((ms) =>
            ms ? ms.find((m) => m && m.s.T === T) : null
        );
        if (k < 0 || !ma || !mb) continue;
        const pa = PARTS[dsp.from.part](ma)[0];
        const [q0, q1] = PARTS[dsp.to.part](mb);
        // Nearest point of the segment q0-q1 to pa.
        const [ex, ey] = [q1[0] - q0[0], q1[1] - q0[1]];
        const f = Math.max(0, Math.min(1, ((pa[0] - q0[0]) * ex + (pa[1] - q0[1]) * ey) / (ex * ex + ey * ey || 1)));
        const pb = [q0[0] + f * ex, q0[1] + f * ey];
        const d = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
        spans.push({dsp, d});
        const [x1, y1, x2, y2] = [X(pa[0]), Y(pa[1]), X(pb[0]), Y(pb[1])];
        svg += `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="#1d2733" stroke-width="0.4" stroke-dasharray="1.2 0.6"/>`;
        for (const [x, yy] of [
            [x1, y1],
            [x2, y2]
        ])
            svg += `<circle cx="${x.toFixed(2)}" cy="${yy.toFixed(2)}" r="0.55" fill="#1d2733"/>`;
        // The length along the line, upright, just above it.
        let ang = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
        if (ang > 90) ang -= 180;
        if (ang < -90) ang += 180;
        const [mx, my] = [(x1 + x2) / 2, (y1 + y2) / 2];
        svg += `<text x="${mx.toFixed(2)}" y="${(my - 0.9).toFixed(2)}" text-anchor="middle" transform="rotate(${ang.toFixed(1)}, ${mx.toFixed(2)}, ${my.toFixed(2)})" class="lab b" fill="#1d2733">${d.toFixed(1)} m</text>`;
    }

    // Laterals: the separation of two outlines across one boat's heading at a time (how far
    // apart they are sideways, ignoring how far one is ahead): no more than the shortest gap.
    // Drawn as a guide line along the heading past each boat's nearest side, and the measure
    // across between them from the first boat's nearest point.
    const laterals = [];
    for (const lt of panel.laterals || []) {
        const T = Date.parse(lt.at);
        const [ma, mb] = [lt.of, lt.to].map((key) => (marksOf(key) || []).find((m) => m && m.s.T === T));
        if (!ma || !mb || !ma.poly || !mb.poly) continue;
        const fwd = [Math.sin(ma.h), Math.cos(ma.h)];
        const port = [-Math.cos(ma.h), Math.sin(ma.h)];
        const {pa, pb, d, sgn} = lateralGap(ma.poly, ma.h, mb.poly);
        laterals.push({lt, d: Math.max(0, d), side: sgn > 0 ? 'port' : 'starboard', hdg: ma.h + up});
        const foot = [pa[0] + d * sgn * port[0], pa[1] + d * sgn * port[1]];
        // Guide lines along the heading: a short one through the first boat's point, and one
        // from the other boat's point to the end of the measure, a little past it.
        const along = (pb[0] - foot[0]) * fwd[0] + (pb[1] - foot[1]) * fwd[1];
        const over = along >= 0 ? -1.5 : 1.5;
        const guides = [
            [pa, -1.5, 1.5],
            [foot, over, along]
        ];
        for (const [q, f0, f1] of guides)
            svg += `<line x1="${X(q[0] + f0 * fwd[0]).toFixed(2)}" y1="${Y(q[1] + f0 * fwd[1]).toFixed(2)}" x2="${X(q[0] + f1 * fwd[0]).toFixed(2)}" y2="${Y(q[1] + f1 * fwd[1]).toFixed(2)}" stroke="#1d2733" stroke-width="0.2" stroke-dasharray="0.8 0.6"/>`;
        const [x1, y1, x2, y2] = [X(pa[0]), Y(pa[1]), X(foot[0]), Y(foot[1])];
        svg += `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="#1d2733" stroke-width="0.5"/>`;
        for (const [x, yy] of [
            [x1, y1],
            [x2, y2]
        ])
            svg += `<circle cx="${x.toFixed(2)}" cy="${yy.toFixed(2)}" r="0.55" fill="#1d2733"/>`;
        note(`lateral ${Math.max(0, d).toFixed(1)} m`, [(x1 + x2) / 2, (y1 + y2) / 2]);
    }

    // Each boat's wind over the panel: TWD median and range, TWS median and range.
    const winds = boats.map((b) => {
        const rs = b.rows.filter((r) => r.gpsT >= Date.parse(panel.from) && r.gpsT <= Date.parse(panel.to));
        const ts = rs.map((r) => r.twsMs).filter((v) => v != null);
        return {
            b,
            w: circStats(rs.map((r) => r.twdRad)),
            twd: circMedian(rs.map((r) => r.twdRad)),
            tws: ts.length ? {med: median(ts), lo: Math.min(...ts), hi: Math.max(...ts)} : null
        };
    });
    // Top right of the map: north and wind arrows, and each boat's wind over the panel.
    {
        const bw = 84;
        const bh = 25;
        const bx = map.x + map.w - bw - 2;
        const by = map.y + 2;
        svg += `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="#fff" fill-opacity="0.92" stroke="#c9d3de" stroke-width="0.25"/>`;
        const [ncx, ncy] = [bx + 9, by + 12];
        svg += `<g transform="rotate(${(-up / D2R).toFixed(2)}, ${ncx}, ${ncy})"><path d="M${ncx},${ncy - 4.5} L${ncx + 2.5},${ncy + 4.5} L${ncx},${ncy + 2.8} L${ncx - 2.5},${ncy + 4.5} Z" fill="#1d2733"/></g>`;
        svg += `<text x="${(ncx + Math.sin(-up) * 7).toFixed(2)}" y="${(ncy - Math.cos(-up) * 7 + 1).toFixed(2)}" text-anchor="middle" class="bold">N</text>`;
        const wAll = boatsWind(boats, Date.parse(panel.from), Date.parse(panel.to) + 1).twdRad;
        if (wAll != null) {
            // Large, the way the wind blows.
            const [ux, uy] = [-Math.sin(wAll - up), Math.cos(wAll - up)];
            const [wx, wy] = [bx + 22, by + 11];
            const tail = [wx - ux * 7, wy - uy * 7];
            const head = [wx + ux * 7, wy + uy * 7];
            const hx = (q) => (head[0] - ux * 3.6 + q * uy * 2.2).toFixed(2);
            const hy = (q) => (head[1] - uy * 3.6 - q * ux * 2.2).toFixed(2);
            svg += `<line x1="${tail[0].toFixed(2)}" y1="${tail[1].toFixed(2)}" x2="${(head[0] - ux * 3).toFixed(2)}" y2="${(head[1] - uy * 3).toFixed(2)}" stroke="${WIND}" stroke-width="1.4"/>`;
            svg += `<path d="M${head[0].toFixed(2)},${head[1].toFixed(2)} L${hx(1)},${hy(1)} L${hx(-1)},${hy(-1)} Z" fill="${WIND}"/>`;
            svg += `<text x="${wx}" y="${by + bh - 2}" text-anchor="middle" class="small" fill="${WIND}">wind ${deg3(wAll)}°</text>`;
        }
        let ly = by + 4.5;
        const lx = bx + 31;
        svg += `<text x="${lx}" y="${ly}" class="tiny">Median (range) over ${mmss(Date.parse(panel.from))}-${mmss(Date.parse(panel.to))}:</text>`;
        ly += 3.6;
        for (const {b, w, twd, tws} of winds) {
            const name = esc(b.name.split(' (')[0]);
            if (w && twd != null)
                svg += `<text x="${lx}" y="${ly.toFixed(2)}" class="small"><tspan fill="${b.textColour || b.colour}" class="bold">${name}</tspan> TWD ${deg3(twd)}° (${deg3(w.mean + w.lo)}-${deg3(w.mean + w.hi)}°)</text>`;
            ly += 3.4;
            if (tws)
                svg += `<text x="${lx}" y="${ly.toFixed(2)}" class="small">TWS ${kn1(tws.med)} kn (${kn1(tws.lo)}-${kn1(tws.hi)} kn)</text>`;
            ly += 3.8;
        }
    }

    // Right column: title, legend, table, notes.
    const tx = 182;
    let side = '';
    let y = 23; // below the title, which may run across the page
    const line = (txt, cls = 'small', dy = 3.6) => {
        side += `<text x="${tx}" y="${y.toFixed(2)}" class="${cls}">${txt}</text>`;
        y += dy;
    };
    for (const b of boats) {
        side += `<rect x="${tx}" y="${(y - 2.4).toFixed(2)}" width="5" height="2.6" fill="${b.colour}" fill-opacity="0.15" stroke="${b.colour}" stroke-width="0.35"/>`;
        side += `<text x="${tx + 6.5}" y="${y.toFixed(2)}" class="small"><tspan fill="${b.colour}" class="bold">${esc(b.key)}</tspan> ${esc(b.name)}: ${b.L} m${b.known ? `, GPS ${b.antenna.fromSternM} m from stern, ${b.antenna.stbdM} m to starboard` : ', GPS position unknown: assumed at the centre'}</text>`;
        y += 3.6;
    }
    for (const {b} of data.extra) {
        side += `<rect x="${tx}" y="${(y - 2.4).toFixed(2)}" width="5" height="2.6" fill="${b.colour}" fill-opacity="0.15" stroke="${b.colour}" stroke-width="0.35" stroke-dasharray="${WITNESS_DASH}"/>`;
        side += `<text x="${tx + 6.5}" y="${y.toFixed(2)}" class="small"><tspan fill="${b.colour}" class="bold">${esc(b.key)}</tspan> ${esc(b.name)}: ${b.L} m, not logged: drawn from ${esc(b.source || 'a witness account')}</text>`;
        y += 3.6;
    }
    y += 2;
    y += 2;
    if (panel.windEveryS) {
        side += `<path d="M${tx + 1},${y} L${tx + 6},${y}" stroke="${WIND}" stroke-width="0.6"/><path d="M${tx + 6},${y} L${tx + 4.2},${y - 1.1} L${tx + 4.2},${y + 1.1} Z" fill="${WIND}"/>`;
        for (const t of wrap(
            `Wind on the map: the average of the two boats' median TWD and TWS over the ${panel.windEveryS} s around each time, the arrow the way the wind blows.`,
            WRAP - 10
        )) {
            side += `<text x="${tx + 8}" y="${(y + 0.8).toFixed(2)}" class="tiny">${esc(t)}</text>`;
            y += 3;
        }
    }
    if (shades.length) {
        // A swatch per shading change, with the times it covers.
        y += 1;
        const x = tx + 1;
        for (const [i, [t, v]] of shades.entries()) {
            const sh = SHADES[v];
            const until = data.times.filter((T) => T >= t && (i + 1 >= shades.length || T < shades[i + 1][0]));
            let txt = until.length > 1 ? `${mmss(until[0])}-${mmss(until.at(-1))}` : until.length ? mmss(until[0]) : '';
            if (until.length === 1 && eventOf(until[0])) txt += `: ${eventOf(until[0])}`;
            side += `<rect x="${x}" y="${(y - 1.6).toFixed(2)}" width="4" height="2.6" fill="${fillOf(boats[0], sh)}" fill-opacity="${sh.fill}" stroke="${boats[0].colour}" stroke-opacity="${sh.line}" stroke-width="${sh.width}"/>`;
            side += `<text x="${x + 5.5}" y="${(y + 0.6).toFixed(2)}" class="tiny${sh.row ? ' b' : ''}">${esc(txt)}</text>`;
            y += 3.4;
        }
        const gh = (panel.ghosts || []).map((t) => mmss(Date.parse(t)));
        if (gh.length) {
            side += `<rect x="${x}" y="${(y - 1.6).toFixed(2)}" width="4" height="2.6" fill="${boats[0].colour}" fill-opacity="${GHOST.fill}" stroke="${boats[0].colour}" stroke-opacity="${GHOST.line}" stroke-width="${GHOST.width}"/>`;
            side += `<text x="${x + 5.5}" y="${(y + 0.6).toFixed(2)}" class="tiny">${gh.join(', ')}: after the contact, for context (no labels)</text>`;
            y += 3.4;
        }
    }
    y += 4;
    // Table.
    // Per boat COG, SOG, HDG, and TWA for a boat with tableTwa.
    const per = (b) => ['COG', 'SOG', 'HDG', ...(b.tableTwa ? ['TWA'] : [])];
    const head = ['#', 'time', ...boats.flatMap(per), 'GAP'];
    const cols = [0, 6];
    for (const b of boats)
        for (let k = 0; k < per(b).length; k++) cols.push(cols.at(-1) + (k ? 9.5 : cols.length > 2 ? 13 : 16));
    cols.push(cols.at(-1) + 13);
    for (const [i, b] of boats.entries())
        side += `<text x="${tx + cols[2 + boats.slice(0, i).reduce((n, o) => n + per(o).length, 0)]}" y="${y.toFixed(2)}" class="th" fill="${b.colour}">${esc(b.name.split(' (')[0])}</text>`;
    y += 3.2;
    side += head.map((h, i) => `<text x="${tx + cols[i]}" y="${y.toFixed(2)}" class="th">${h}</text>`).join('');
    y += 1.2;
    side += `<line x1="${tx}" y1="${y}" x2="${W - 6}" y2="${y}" stroke="#9aa8b8" stroke-width="0.2"/>`;
    const rowH = Math.min(3.4, (H - 70 - y) / (data.times.length + (panel.ghosts || []).length + events.size * 0.8));
    y += rowH;
    // TWA as logged: positive is wind on the starboard side.
    const twa = (r) => (r == null ? '---' : `${Math.round(Math.abs(r / D2R))}${r < 0 ? 'P' : 'S'}`);
    const vals = (m, b) =>
        per(b).map((h) =>
            !m
                ? '-'
                : h === 'COG'
                  ? deg3(m.s.cogRad)
                  : h === 'SOG'
                    ? kn1(m.s.sogMs)
                    : h === 'HDG'
                      ? deg3(m.s.hdgRad)
                      : twa(m.s.twaRad)
        );
    for (const [n, T] of data.times.entries()) {
        const [a, c] = data.per.map((p) => p.marks[n]);
        const gg = gapOf(a, c) == null ? '-' : gapOf(a, c).toFixed(1);
        const cells = [String(n + 1), mmss(T), ...vals(a, boats[0]), ...vals(c, boats[1]), gg];
        if (shadeOf(T).row === 'band')
            side += `<rect x="${tx - 1}" y="${(y - rowH + 0.8).toFixed(2)}" width="${W - 6 - tx + 1}" height="${rowH.toFixed(2)}" fill="#e3e8ee"/>`;
        side += cells
            .map(
                (v, i) =>
                    `<text x="${tx + cols[i]}" y="${y.toFixed(2)}" class="td${shadeOf(T).row ? ' b' : ''}">${v}</text>`
            )
            .join('');
        y += rowH;
        if (eventOf(T)) {
            // The note under its row, in the gap below.
            side += `<text x="${tx + cols[1]}" y="${(y - rowH * 0.25).toFixed(2)}" class="tiny b">↑ ${esc(eventOf(T))}</text>`;
            y += rowH * 0.8;
        }
    }
    // Rows after the period (the background outlines), in grey and unnumbered.
    for (const [g, t] of (panel.ghosts || []).entries()) {
        const [a, c] = data.per.map((p) => p.ghosts[g]);
        const gg = gapOf(a, c) == null ? '-' : gapOf(a, c).toFixed(1);
        const cells = ['', mmss(Date.parse(t)), ...vals(a, boats[0]), ...vals(c, boats[1]), gg];
        side += cells
            .map((v, i) => `<text x="${tx + cols[i]}" y="${y.toFixed(2)}" class="td" fill="#8a96a3">${v}</text>`)
            .join('');
        y += rowH;
    }
    y += 1;
    for (const t of wrap(
        `${spans.map(({dsp, d}) => `At ${mmss(Date.parse(dsp.at))} ${dsp.from.key}'s ${dsp.from.part} was ${d.toFixed(1)} m from ${dsp.to.key}'s ${dsp.to.part} (${dsp.from.key} reconstructed). `).join('')}${measured.map(({b, ms, along, across, side, hdg}) => `Between ${mmss(Date.parse(ms.from))} and ${mmss(Date.parse(ms.to))} ${b.name.split(' (')[0]}'s bow moved ${Math.abs(across).toFixed(1)} m to ${side}, across her ${mmss(Date.parse(ms.to))} heading of ${deg3(hdg)}° (and ${Math.abs(along).toFixed(1)} m ${along >= 0 ? 'forward' : 'back'}). `).join('')}${laterals.map(({lt, d, hdg}) => `At ${mmss(Date.parse(lt.at))} the ${lt.of} and ${lt.to} outlines were ${d.toFixed(1)} m apart sideways, across ${lt.of}'s heading of ${deg3(hdg)}° (lateral). `).join('')}GAP: the shortest distance between the ${boats[0].name.split(' (')[0]} and ${boats[1].name.split(' (')[0]} outlines, m; smallest ${data.close.d.toFixed(1)} m at ${new Date(data.close.T + cfg.tzHours * 3600e3).toISOString().slice(11, 21)}. COG and SOG as each boat logged them (degrees true, kn); HDG compass heading${corrText(boats)}, --- where none was logged.${boats
            .filter((b) => b.tableTwa)
            .map((b) => ` TWA as ${b.name.split(' (')[0]} logged it, S or P the side the wind is on.`)
            .join('')} Times ${cfg.tzName} from each boat's GPS fix time.`,
        WRAP
    ))
        line(esc(t), 'tiny', 3);
    // Scale bar (the map's scale on paper).
    y += 6;
    const sm = niceStep(60 / k); // about 60 mm long
    const sx = tx + 1;
    side += `<text x="${sx}" y="${(y - 3).toFixed(2)}" class="small">Scale: 1 mm = ${(1 / k).toFixed(2)} m</text>`;
    side += `<line x1="${sx}" y1="${y}" x2="${(sx + sm * k).toFixed(2)}" y2="${y}" stroke="#1d2733" stroke-width="0.6"/>`;
    // Ticks at round values: a 50 m bar in 10s, a 20 m bar in 5s, a 10 m bar in 2s.
    const mant = sm / Math.pow(10, Math.floor(Math.log10(sm) + 1e-9));
    const ticks = mant === 2 ? 4 : 5;
    for (let q = 0; q <= ticks; q++) {
        const x = sx + (sm * k * q) / ticks;
        side += `<line x1="${x.toFixed(2)}" y1="${y - (q % ticks ? 0.9 : 1.6)}" x2="${x.toFixed(2)}" y2="${y}" stroke="#1d2733" stroke-width="0.35"/>`;
        side += `<text x="${x.toFixed(2)}" y="${(y + 3.4).toFixed(2)}" class="tiny" text-anchor="middle">${+((sm * q) / ticks).toFixed(1)}${q === ticks ? ' m' : ''}</text>`;
    }
    y += 6;

    // Margins.
    const s = boats.find((b) => !b.known);
    const notes = [
        'Error margins',
        ...data.extra.map(
            ({b}) =>
                `${b.key}: positions are a reconstruction from ${b.source || 'a witness account'}, placed relative to ${(b.poses || [])[0]?.ref || b.ref}'s logged position at the times shown (beam ${b.B} m${b.beamM == null ? ' assumed' : ''}); they carry the error of that account, not of a measurement.`
        ),
        s
            ? `${s.key}: GPS position on board unknown, drawn at the hull centre. If it is elsewhere on board, ${s.key}'s outline could be up to ${(s.L / 2).toFixed(1)} m further forward or aft and ${(s.B / 2).toFixed(1)} m to either side of where it is drawn, and each GAP out by as much.`
            : null,
        ...boats
            .filter((b) => b.known)
            .map(
                (b) =>
                    `${b.key}: GPS position on board about ${b.antenna.fromSternM} m from the stern, ${b.antenna.stbdM} m to starboard (${b.antenna.source || "owner's figure"}).`
            ),
        // One note per distinct correction, naming the boats it applies to.
        ...[...new Set(boats.filter((b) => b.headingCorrection).map((b) => JSON.stringify(b.headingCorrection)))].map(
            (k) => {
                const c = JSON.parse(k);
                const keys = boats.filter((b) => JSON.stringify(b.headingCorrection) === k).map((b) => b.key);
                return `${keys.join(', ')}: logged heading${keys.length > 1 ? 's' : ''} taken as magnetic: ${c.deg}° added to HDG, and so to TWD (logged as HDG + TWA), for the outline${keys.length > 1 ? 's' : ''}, the HDG column and the wind (${c.source}).`;
            }
        ),
        'GPS receiver error is not recorded in either log and is not in these margins.',
        `Fixes about 1 per second, interpolated; each boat's clock aligned to its own GPS. Outlines are schematic (beam ${boats.map((b) => `${b.key} ${b.B} m${b.beamAssumed ? ' assumed' : ''}`).join(', ')}), turned to the compass heading; dashed where none was logged within 2 s (COG used). Compass calibration unknown.`
    ].filter(Boolean);
    const noteLines = notes.flatMap((t, i) => (i ? wrap(t, WRAP) : [t]));
    y = Math.max(y + 2, H - 4 - noteLines.length * 3);
    for (const [i, t] of noteLines.entries()) line(esc(t), i ? 'tiny' : 'bold', 3);

    const title = `<text x="${map.x}" y="9" class="title">${esc(cfg.title)}</text><text x="${map.x}" y="15" class="sub">${esc(panel.title || '')} ${tz(Date.parse(panel.from))} to ${tz(Date.parse(panel.to))} ${esc(cfg.tzName)}, outlines ${stepsText(panel, mmss)}${up ? `; turned so the wind (the boats' median TWD, averaged: ${deg3(up)}°) blows down the page` : ', north up'}${pages > 1 ? ` · page ${pageNo} of ${pages}` : ''}</text>`;
    return `<section class="page"><svg viewBox="0 0 ${W} ${H}" width="${W}mm" height="${H}mm" xmlns="http://www.w3.org/2000/svg">${title}${svg}${side}</svg></section>`;
}

function render(cfg) {
    const boats = cfg.boats.map((b) => {
        const g = boatGeom(b);
        const logged = parseExpedition(fs.readFileSync(b.log, 'utf8')).rows.filter((r) => r.gpsT != null);
        const rows = correctHeadings(logged, b.headingCorrection && b.headingCorrection.deg);
        rows.sort((x, y) => x.gpsT - y.gpsT);
        return {...g, rows, headingCorrection: b.headingCorrection || null};
    });
    const first = boats[0].rows.find((r) => r.gpsT >= Date.parse(cfg.panels[0].from) && r.lat != null);
    const proj = projector(first.lat, first.lon);
    const pages = cfg.panels.map((p, i) => {
        // up: 'wind' turns the map so the median TWD of both boats over the panel is at the top.
        const [from, to] = [Date.parse(p.from), Date.parse(p.to)];
        const up = p.up === 'wind' ? boatsWind(boats, from, to + 1).twdRad : 0;
        const pr = (lat, lon) => turn(proj(lat, lon), up);
        return renderPage(
            cfg,
            boats,
            p,
            panelData(boats, p, pr, up, cfg.witnesses || []),
            i + 1,
            cfg.panels.length,
            pr,
            up
        );
    });
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(cfg.title)}</title>
<style>
@page { size: A4 landscape; margin: 0; }
body { margin: 0; background: #fff; font-family: 'DejaVu Sans', Arial, sans-serif; }
.page { width: 297mm; height: 210mm; page-break-after: always; overflow: hidden; }
.page:last-child { page-break-after: auto; }
svg text:not([fill]) { fill: #1d2733; }
.title { font-size: 5px; font-weight: 700; }
.sub { font-size: 3px; fill: #45525f; }
.small { font-size: 2.5px; }
.tiny { font-size: 2.1px; fill: #36424f; }
.bold { font-size: 2.6px; font-weight: 700; }
.th { font-size: 2.2px; font-weight: 700; }
.td { font-size: 2.2px; font-family: 'DejaVu Sans Mono', monospace; }
.lab { font-size: 2.2px; font-family: 'DejaVu Sans Mono', monospace; paint-order: stroke; stroke: #fff; stroke-width: 0.6px; }
.lab .num { font-weight: 700; }
.lab.b, .tiny.b { font-weight: 700; }
.wnum { font-size: 2.4px; font-weight: 700; font-family: 'DejaVu Sans', Arial, sans-serif; }
.hnum { font-size: 2.1px; font-weight: 700; font-family: 'DejaVu Sans', Arial, sans-serif; paint-order: stroke; stroke: #fff; stroke-width: 0.5px; }
.wlab { font-size: 2.1px; font-family: 'DejaVu Sans Mono', monospace; paint-order: stroke; stroke: #fff; stroke-width: 0.6px; }
.td.b { font-weight: 700; }
</style></head><body>
${pages.join('\n')}
</body></html>
`;
}

/** ' (K, S: logged + 12.9°)' for the boats whose heading was corrected, or ''. */
function corrText(boats) {
    const c = boats.filter((b) => b.headingCorrection);
    if (!c.length) return '';
    const degs = [...new Set(c.map((b) => b.headingCorrection.deg))];
    return degs.length === 1
        ? ` (${c.map((b) => b.key).join(', ')}: logged + ${degs[0]}°)`
        : ` (${c.map((b) => `${b.key}: logged + ${b.headingCorrection.deg}°`).join('; ')})`;
}

async function main() {
    const [cfgPath, outBase] = process.argv.slice(2);
    if (!cfgPath || !outBase) {
        console.error('usage: node tools/protest-diagram.js <config.json> <out-basename>');
        process.exit(2);
    }
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const dir = path.dirname(path.resolve(cfgPath));
    for (const b of cfg.boats) b.log = path.resolve(dir, b.log);
    const html = render(cfg);
    fs.writeFileSync(outBase + '.html', html);
    const {chromium} = require('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage({viewport: {width: 1123, height: 794}, deviceScaleFactor: 2});
    await page.goto('file://' + path.resolve(outBase + '.html'));
    await page.pdf({path: outBase + '.pdf', format: 'A4', landscape: true, printBackground: true});
    const n = await page.locator('section.page').count();
    for (let i = 0; i < n; i++)
        await page
            .locator('section.page')
            .nth(i)
            .screenshot({path: `${outBase}-${i + 1}.png`});
    await browser.close();
    console.log(`wrote ${outBase}.html, .pdf and ${n} png`);
}

if (require.main === module) main();

module.exports = {
    boatsWind,
    correctHeadings,
    lateralGap,
    witnessPose,
    hullPoint,
    stackUp,
    turn,
    circMedian,
    median,
    projector,
    stateAt,
    hullCentre,
    hullOutline,
    polyDistance,
    circStats,
    boatGeom,
    render
};
