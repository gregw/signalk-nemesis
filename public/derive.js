/*
 * Derivations (wiki section 3), shared by the webapp (global DERIVE) and the unit tests.
 * Pure functions, SI throughout: positions {lat, lon} in degrees, angles in radians
 * true, speeds in m/s, distances in metres, times in epoch ms.
 *
 * A report or own sample is {t, lat, lon, cogRad, sogMs}. Series are arrays sorted by t.
 * Every comparison with us uses our state at the other boat's report time (section 2.2).
 *
 * Sign convention (wiki section 8): positive always means the other boat is doing
 * better than us, so in Relative mode and for the lead, negative is good for us.
 *
 * Distances to the waypoint all use the waypoint in use now. Comparing two positions
 * with the same mark stays consistent after a mark rounding; only the absolute DTG of
 * old reports refers to a mark they were not yet sailing to.
 */

(function (root) {
    'use strict';
    const G = typeof module !== 'undefined' && module.exports ? require('./geo.js') : root.GEO;

    // Our own VMC (Waypoint frame) is measured over at least this long, so the 1 Hz
    // position jitter of our own samples doesn't swamp it.
    const OWN_VMC_MIN_MS = 60e3;

    const fin = (v) => typeof v === 'number' && Number.isFinite(v);

    // A leg is a boat's leg while its COG is within this of the leg's heading: wide enough
    // for beating (tacks some 45 to 60 degrees off) and current, narrow enough to tell an
    // out-and-back's outbound and return legs apart (about 170 degrees off).
    const LEG_MAX_OFF = (100 * Math.PI) / 180;
    const SAME_M = 1; // a repeated mark: distances equal within this

    /*
     * A target is what the Waypoint and Course frames measure progress toward:
     *  - a point {lat, lon}: the waypoint;
     *  - a course (makeCourse): marks in order; a mark may be listed more than once (one
     *    passed on the way out and again on the way back). Each report picks its own next
     *    mark, so a boat can switch marks from one report to the next (decided 2026-10-16:
     *    drifting backwards must not count as a rounding). The pick is by leg (decided
     *    2026-10-20): of the marks it has positive instant VMC toward, those whose leg
     *    (from the previous mark) heads within LEG_MAX_OFF of its COG, the closest; the
     *    first leg has no previous mark, so no heading test (it is often pre-start). A
     *    mark listed twice at the same distance goes to the better aligned leg. With no
     *    such mark, the closest with positive VMC, else the closest. Its distance to go
     *    (DTF) is to that mark, then along every later mark.
     * mark(p) picks a handle for a position; dist(p, h) and brg(p, h) use it, so two
     * positions can be measured toward the same mark (VMC across a mark switch).
     */
    const pointTargets = new WeakMap();
    function target(wp) {
        if (!wp) return null;
        if (wp.isCourse) return wp;
        let t = pointTargets.get(wp);
        if (!t) {
            t = {mark: () => 0, dist: (p) => G.distance(p, wp), brg: (p) => G.bearing(p, wp)};
            pointTargets.set(wp, t);
        }
        return t;
    }

    /** A course target from marks [{lat, lon, name}] in course order, or null if none. */
    function makeCourse(marks) {
        const ms = (marks || []).filter((m) => m && fin(m.lat) && fin(m.lon));
        if (!ms.length) return null;
        const after = new Array(ms.length).fill(0); // distance from mark k to the last mark
        for (let k = ms.length - 2; k >= 0; k--) after[k] = after[k + 1] + G.distance(ms[k], ms[k + 1]);
        // Heading of the leg ending at mark k; the first leg has none. A repeated mark
        // listed twice in a row is a zero-length leg: no heading either.
        const legBrg = ms.map((m, k) => (k > 0 && G.distance(ms[k - 1], m) > SAME_M ? G.bearing(ms[k - 1], m) : null));
        const cosMax = Math.cos(LEG_MAX_OFF);
        const picked = new WeakMap(); // report -> mark index (reports are immutable)
        return {
            isCourse: true,
            marks: ms,
            after,
            legBrg,
            mark(p) {
                let k = picked.get(p);
                if (k !== undefined) return k;
                let leg = -1; // closest positive VMC mark on a leg the boat is sailing
                let legD = Infinity;
                let legA = -Infinity;
                let ahead = -1; // closest positive VMC mark
                let aheadD = Infinity;
                let near = 0;
                let nearD = Infinity;
                const moving = fin(p.sogMs) && fin(p.cogRad);
                for (let i = 0; i < ms.length; i++) {
                    const d = G.distance(p, ms[i]);
                    if (d < nearD) {
                        nearD = d;
                        near = i;
                    }
                    if (!moving || !(Math.cos(p.cogRad - G.bearing(p, ms[i])) * p.sogMs > 0)) continue;
                    if (d < aheadD) {
                        aheadD = d;
                        ahead = i;
                    }
                    // Alignment with the leg: 0 (neutral) for a leg with no heading.
                    const a = legBrg[i] == null ? 0 : Math.cos(p.cogRad - legBrg[i]);
                    if (legBrg[i] != null && a < cosMax) continue;
                    if (d < legD - SAME_M || (Math.abs(d - legD) <= SAME_M && a > legA)) {
                        legD = d;
                        legA = a;
                        leg = i;
                    }
                }
                k = leg >= 0 ? leg : ahead >= 0 ? ahead : near;
                picked.set(p, k);
                return k;
            },
            dist: (p, k) => G.distance(p, ms[k]) + after[k],
            brg: (p, k) => G.bearing(p, ms[k])
        };
    }

    /** Index of the latest item with item.t <= t in a sorted series, or -1. */
    function indexAtOrBefore(series, t) {
        let lo = 0;
        let hi = series.length - 1;
        let k = -1;
        while (lo <= hi) {
            const m = (lo + hi) >> 1;
            if (series[m].t <= t) {
                k = m;
                lo = m + 1;
            } else hi = m - 1;
        }
        return k;
    }

    /** Latest item at or before t, if no older than maxAgeMs; else null. */
    function stateAt(series, t, maxAgeMs) {
        const k = indexAtOrBefore(series, t);
        return k >= 0 && t - series[k].t <= maxAgeMs ? series[k] : null;
    }

    /** Frames measured toward a target (a waypoint or a course): VMC and distance to go. */
    const toward = (frame) => frame === 'waypoint' || frame === 'course';

    /**
     * The direction of a frame set by our own state u (rad true): cog = our COG, upwind =
     * our smoothed TWD (where the wind comes from), downwind = the opposite. Else null.
     */
    function frameDir(frame, u) {
        if (!u) return null;
        if (frame === 'cog') return fin(u.cogRad) ? u.cogRad : null;
        if (frame === 'upwind' || frame === 'downwind') {
            if (!fin(u.twdRad)) return null;
            return frame === 'upwind' ? u.twdRad : (u.twdRad + Math.PI) % (2 * Math.PI);
        }
        return null;
    }
    const byDir = (frame) => frame === 'cog' || frame === 'upwind' || frame === 'downwind';

    /**
     * Up direction (rad true): north 0, cog = our COG, upwind / downwind = into / away from
     * our smoothed TWD, waypoint = bearing from us to the waypoint, course = bearing from us
     * to our next mark. Null when not known.
     */
    function upDir(frame, us, wp) {
        if (frame === 'north') return 0;
        if (!us) return null;
        if (byDir(frame)) return frameDir(frame, us);
        if (toward(frame)) {
            const T = target(wp);
            return T ? T.brg(us, T.mark(us)) : null;
        }
        return null;
    }

    /** Distance to go (m): to the waypoint, or along the course from this position's next mark; or null. */
    function dtg(p, wp) {
        const T = target(wp);
        return p && T ? T.dist(p, T.mark(p)) : null;
    }

    /**
     * VMC (m/s, + closing) between two positions of one boat, toward cur's mark (or mark h)
     * for both, or null if the gap is not in (0, maxGapMs].
     */
    function vmc(prev, cur, wp, maxGapMs, h) {
        const T = target(wp);
        if (!prev || !cur || !T) return null;
        const dtMs = cur.t - prev.t;
        if (!(dtMs > 0) || dtMs > maxGapMs) return null;
        const k = h ?? T.mark(cur);
        return (T.dist(prev, k) - T.dist(cur, k)) / (dtMs / 1000);
    }

    /**
     * Instant VMC (m/s, + closing) from one report: SOG x cos(COG - that boat's own
     * bearing to the waypoint). The fallback when there is no usable previous report
     * (first report, or a gap over stale). Over ground like the positional VMC, but
     * not averaged over the report interval. Null without SOG, COG or waypoint.
     */
    function vmcInstant(s, wp) {
        const T = target(wp);
        if (!s || !T || !fin(s.sogMs) || !fin(s.cogRad)) return null;
        return s.sogMs * Math.cos(s.cogRad - T.brg(s, T.mark(s)));
    }

    /**
     * Absolute VMG toward Up of the report at index i of a boat's series.
     * ctx: {frame, wp, us (our series), staleMs, usGapMs}
     * Waypoint: VMC from the boat's own previous report (section 3.2), else from this
     * report's SOG and COG (vmcInstant).
     * Course: the same toward the boat's own next mark of the course.
     * COG: SOG x cos(COG - our COG at their report time).
     */
    function vmgAbs(reports, i, ctx) {
        const s = reports[i];
        if (!s) return null;
        switch (ctx.frame) {
            case 'waypoint':
            case 'course': {
                const v = vmc(reports[i - 1], s, ctx.wp, ctx.staleMs);
                return v != null ? v : vmcInstant(s, ctx.wp);
            }
            case 'north':
                return fin(s.sogMs) && fin(s.cogRad) ? s.sogMs * Math.cos(s.cogRad) : null;
            case 'cog':
            case 'upwind':
            case 'downwind': {
                // Along our direction at their report time (our COG, or the wind then).
                const dir = frameDir(ctx.frame, stateAt(ctx.us, s.t, ctx.usGapMs));
                if (dir == null || !fin(s.sogMs) || !fin(s.cogRad)) return null;
                return s.sogMs * Math.cos(s.cogRad - dir);
            }
        }
        return null;
    }

    /**
     * Our VMG toward Up matched to the boat report at index i: for the Waypoint frame over
     * the same interval as their VMC, so theirs minus ours compares like with like; when
     * theirs is instant (no usable previous report), ours is instant too.
     */
    function ourVmgFor(reports, i, ctx) {
        const s = reports[i];
        if (!s) return null;
        const u = stateAt(ctx.us, s.t, ctx.usGapMs);
        if (!u) return null;
        switch (ctx.frame) {
            case 'waypoint':
            case 'course': {
                const p = reports[i - 1];
                if (vmc(p, s, ctx.wp, ctx.staleMs) == null) return vmcInstant(u, ctx.wp);
                const u0 = stateAt(ctx.us, p.t, ctx.usGapMs);
                return u0 && u0 !== u ? vmc(u0, u, ctx.wp, ctx.staleMs) : null;
            }
            case 'north':
                return fin(u.sogMs) && fin(u.cogRad) ? u.sogMs * Math.cos(u.cogRad) : null;
            case 'cog':
            case 'upwind':
            case 'downwind':
                return alongDir(u, ctx.frame);
        }
        return null;
    }

    /** Our speed along a direction frame's own direction (for COG, just our SOG). */
    function alongDir(u, frame) {
        const dir = frameDir(frame, u);
        if (dir == null || !fin(u.sogMs) || !fin(u.cogRad)) return null;
        return u.sogMs * Math.cos(u.cogRad - dir);
    }

    /** VMG for the strip chart: absolute, or theirs minus ours in Relative mode. */
    function vmgToward(reports, i, ctx, mode) {
        const v = vmgAbs(reports, i, ctx);
        if (v == null || mode !== 'rel') return v;
        const o = ourVmgFor(reports, i, ctx);
        return o == null ? null : v - o;
    }

    /** Our own absolute VMG at index j of our series (VMC over at least OWN_VMC_MIN_MS). */
    function ownVmgAbs(us, j, ctx) {
        const u = us[j];
        if (!u) return null;
        switch (ctx.frame) {
            case 'waypoint':
            case 'course': {
                let k = j - 1;
                while (k >= 0 && u.t - us[k].t < OWN_VMC_MIN_MS) k--;
                const v = k >= 0 ? vmc(us[k], u, ctx.wp, ctx.staleMs) : null;
                return v != null ? v : vmcInstant(u, ctx.wp);
            }
            case 'north':
                return fin(u.sogMs) && fin(u.cogRad) ? u.sogMs * Math.cos(u.cogRad) : null;
            case 'cog':
            case 'upwind':
            case 'downwind':
                return alongDir(u, ctx.frame);
        }
        return null;
    }

    /**
     * Lead toward Up (m), + = they are ahead (section 3.3), comparing their report s with
     * our state u at their report time.
     */
    function lead(s, u, frame, wp) {
        if (!s || !u) return null;
        if (toward(frame)) {
            // Each boat's own distance to go (for a course: from its own next mark).
            const T = target(wp);
            return T ? T.dist(u, T.mark(u)) - T.dist(s, T.mark(s)) : null;
        }
        const d = G.displacement(u, s);
        if (frame === 'north') return d.n;
        if (byDir(frame)) {
            const dir = frameDir(frame, u);
            return dir == null ? null : d.e * Math.sin(dir) + d.n * Math.cos(dir);
        }
        return null;
    }

    /** A velocity rotated so Up is +y: {x, y} in m/s (section 3.7). Relative subtracts ours. */
    function vectorPoint(s, u, mode, upRad) {
        if (!s || !fin(s.sogMs) || !fin(s.cogRad)) return null;
        let v = G.velocity(s.cogRad, s.sogMs);
        if (mode === 'rel') {
            if (!u || !fin(u.sogMs) || !fin(u.cogRad)) return null;
            const o = G.velocity(u.cogRad, u.sogMs);
            v = {e: v.e - o.e, n: v.n - o.n};
        }
        const c = Math.cos(upRad);
        const sn = Math.sin(upRad);
        return {x: v.e * c - v.n * sn, y: v.e * sn + v.n * c};
    }

    /**
     * Smoothed VMC toward the waypoint (m/s, + closing) of a series at time t: from the
     * latest item at or before t - windowMs to the latest at or before t. Uses the oldest
     * item after t - windowMs when there is none before it, so a boat first heard
     * recently still has a value. With no usable interval (one report, or a gap over
     * windowMs + maxGapMs), the instant VMC of the latest item. Null if the latest item
     * is older than maxGapMs at t.
     */
    function vmcOver(series, t, wp, windowMs, maxGapMs) {
        const T = target(wp);
        if (!T || !series || !series.length) return null;
        const j = indexAtOrBefore(series, t);
        if (j < 0 || t - series[j].t > maxGapMs) return null;
        let i = indexAtOrBefore(series, t - windowMs);
        if (i < 0) i = 0;
        // Toward the latest item's mark for the whole window (a course switches marks).
        const v = vmc(series[i], series[j], wp, windowMs + maxGapMs, T.mark(series[j]));
        return v != null ? v : vmcInstant(series[j], wp);
    }

    /**
     * Should (m): how far ahead a boat must be to be level on corrected time (section 3.6),
     * time on time, "if the race ended now". Level when TCFus x Tus = TCFboat x Tboat.
     * The time owed builds up over the elapsed time e; the trailing boat at the finish
     * covers it at its own VMG:
     *   boat owes us (TCFboat > TCFus): dt = e (TCFboat / TCFus - 1); Should = + ourVmg x dt
     *   we owe it    (TCFboat < TCFus): dt = e (TCFus / TCFboat - 1); Should = - itsVmg x dt
     * The VMG is only needed for the side that trails. Null when it is unknown or not
     * positive (no progress toward the waypoint, so no distance equivalent).
     */
    function should(elapsedMs, tcfUs, tcfBoat, vmgUsMs, vmgBoatMs) {
        if (!fin(elapsedMs) || !(tcfUs > 0) || !(tcfBoat > 0)) return null;
        if (elapsedMs <= 0 || tcfBoat === tcfUs) return 0;
        if (tcfBoat > tcfUs) {
            if (!fin(vmgUsMs) || vmgUsMs <= 0) return null;
            return vmgUsMs * (elapsedMs / 1000) * (tcfBoat / tcfUs - 1);
        }
        if (!fin(vmgBoatMs) || vmgBoatMs <= 0) return null;
        return -vmgBoatMs * (elapsedMs / 1000) * (tcfUs / tcfBoat - 1);
    }

    /**
     * TCF row for one boat's report s and our state u at its time.
     * series / usSeries: the boat's reports and our samples, for the smoothed VMGs
     * (over vmgMs, toward the waypoint in use now). maxGapMs: stale limit.
     * @returns {{should, actual, net, reason}} metres; reason says why Should is missing.
     */
    function tcfRow({s, u, series, usSeries, frame, wp, startT, tcfUs, tcfBoat, vmgMs, maxGapMs}) {
        const out = {should: null, actual: null, net: null, reason: null};
        if (!s || !u) {
            out.reason = 'no data';
            return out;
        }
        out.actual = lead(s, u, frame, wp);
        if (startT == null) out.reason = 'no start time';
        else if (s.t <= startT) out.reason = 'before start';
        else if (!wp) out.reason = 'no waypoint';
        else {
            const owesUs = tcfBoat > tcfUs;
            const vUs = owesUs ? vmcOver(usSeries, s.t, wp, vmgMs, maxGapMs) : null;
            const vBoat = tcfBoat < tcfUs ? vmcOver(series, s.t, wp, vmgMs, maxGapMs) : null;
            out.should = should(s.t - startT, tcfUs, tcfBoat, vUs, vBoat);
            if (out.should == null) out.reason = owesUs ? 'no VMG (ours)' : 'no VMG (theirs)';
        }
        if (out.should != null && out.actual != null) out.net = out.actual - out.should;
        return out;
    }

    /** Age fraction: 1 at nowMs, 0 at nowMs - spanMs (timestamp based, for irregular AIS cadence). */
    function ageFrac(t, nowMs, spanMs) {
        return Math.max(0, Math.min(1, 1 - (nowMs - t) / Math.max(1, spanMs)));
    }

    /** A round step (1, 2 or 5 x 10^n) giving about count rings or ticks up to max. */
    function niceStep(max, count = 3) {
        const raw = max / count || 1;
        const pw = Math.pow(10, Math.floor(Math.log10(raw)));
        const n = raw / pw;
        return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * pw;
    }

    const DERIVE = {
        OWN_VMC_MIN_MS,
        indexAtOrBefore,
        stateAt,
        frameDir,
        upDir,
        dtg,
        vmc,
        vmcInstant,
        makeCourse,
        vmgAbs,
        ourVmgFor,
        vmgToward,
        ownVmgAbs,
        lead,
        vectorPoint,
        vmcOver,
        should,
        tcfRow,
        ageFrac,
        niceStep
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = DERIVE;
    else root.DERIVE = DERIVE;
})(this);
