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

    /**
     * Up direction (rad true): north 0, course = our COG, waypoint = bearing from us
     * to the waypoint. Null when not known (wind: not yet).
     */
    function upDir(frame, us, wp) {
        if (frame === 'north') return 0;
        if (!us) return null;
        if (frame === 'course') return fin(us.cogRad) ? us.cogRad : null;
        if (frame === 'waypoint') return wp ? G.bearing(us, wp) : null;
        return null;
    }

    /** Distance to the waypoint (m), or null. */
    function dtg(p, wp) {
        return p && wp ? G.distance(p, wp) : null;
    }

    /** VMC (m/s, + closing) between two positions of one boat, or null if the gap is not in (0, maxGapMs]. */
    function vmc(prev, cur, wp, maxGapMs) {
        if (!prev || !cur || !wp) return null;
        const dtMs = cur.t - prev.t;
        if (!(dtMs > 0) || dtMs > maxGapMs) return null;
        return (G.distance(prev, wp) - G.distance(cur, wp)) / (dtMs / 1000);
    }

    /**
     * Instant VMC (m/s, + closing) from one report: SOG x cos(COG - that boat's own
     * bearing to the waypoint). The fallback when there is no usable previous report
     * (first report, or a gap over stale). Over ground like the positional VMC, but
     * not averaged over the report interval. Null without SOG, COG or waypoint.
     */
    function vmcInstant(s, wp) {
        if (!s || !wp || !fin(s.sogMs) || !fin(s.cogRad)) return null;
        return s.sogMs * Math.cos(s.cogRad - G.bearing(s, wp));
    }

    /**
     * Absolute VMG toward Up of the report at index i of a boat's series.
     * ctx: {frame, wp, us (our series), staleMs, usGapMs}
     * Waypoint: VMC from the boat's own previous report (section 3.2), else from this
     * report's SOG and COG (vmcInstant).
     * Course: SOG x cos(COG - our COG at their report time).
     */
    function vmgAbs(reports, i, ctx) {
        const s = reports[i];
        if (!s) return null;
        switch (ctx.frame) {
            case 'waypoint': {
                const v = vmc(reports[i - 1], s, ctx.wp, ctx.staleMs);
                return v != null ? v : vmcInstant(s, ctx.wp);
            }
            case 'north':
                return fin(s.sogMs) && fin(s.cogRad) ? s.sogMs * Math.cos(s.cogRad) : null;
            case 'course': {
                const u = stateAt(ctx.us, s.t, ctx.usGapMs);
                if (!u || !fin(u.cogRad) || !fin(s.sogMs) || !fin(s.cogRad)) return null;
                return s.sogMs * Math.cos(s.cogRad - u.cogRad);
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
            case 'waypoint': {
                const p = reports[i - 1];
                if (vmc(p, s, ctx.wp, ctx.staleMs) == null) return vmcInstant(u, ctx.wp);
                const u0 = stateAt(ctx.us, p.t, ctx.usGapMs);
                return u0 && u0 !== u ? vmc(u0, u, ctx.wp, ctx.staleMs) : null;
            }
            case 'north':
                return fin(u.sogMs) && fin(u.cogRad) ? u.sogMs * Math.cos(u.cogRad) : null;
            case 'course':
                return fin(u.sogMs) ? u.sogMs : null;
        }
        return null;
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
            case 'waypoint': {
                let k = j - 1;
                while (k >= 0 && u.t - us[k].t < OWN_VMC_MIN_MS) k--;
                const v = k >= 0 ? vmc(us[k], u, ctx.wp, ctx.staleMs) : null;
                return v != null ? v : vmcInstant(u, ctx.wp);
            }
            case 'north':
                return fin(u.sogMs) && fin(u.cogRad) ? u.sogMs * Math.cos(u.cogRad) : null;
            case 'course':
                return fin(u.sogMs) ? u.sogMs : null;
        }
        return null;
    }

    /**
     * Lead toward Up (m), + = they are ahead (section 3.3), comparing their report s with
     * our state u at their report time.
     */
    function lead(s, u, frame, wp) {
        if (!s || !u) return null;
        if (frame === 'waypoint') return wp ? G.distance(u, wp) - G.distance(s, wp) : null;
        const d = G.displacement(u, s);
        if (frame === 'north') return d.n;
        if (frame === 'course') return fin(u.cogRad) ? d.e * Math.sin(u.cogRad) + d.n * Math.cos(u.cogRad) : null;
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
        if (!wp || !series || !series.length) return null;
        const j = indexAtOrBefore(series, t);
        if (j < 0 || t - series[j].t > maxGapMs) return null;
        let i = indexAtOrBefore(series, t - windowMs);
        if (i < 0) i = 0;
        const v = vmc(series[i], series[j], wp, windowMs + maxGapMs);
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

    /** A round axis step giving about three rings or ticks up to max. */
    function niceStep(max) {
        const raw = max / 3 || 1;
        const pw = Math.pow(10, Math.floor(Math.log10(raw)));
        const n = raw / pw;
        return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * pw;
    }

    const DERIVE = {
        OWN_VMC_MIN_MS,
        indexAtOrBefore,
        stateAt,
        upDir,
        dtg,
        vmc,
        vmcInstant,
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
