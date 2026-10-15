'use strict';
/* UI-edge unit conversions. Everything from the plugin is SI; convert only here. */
/* eslint-disable no-unused-vars */
const UNITS = {
    KN_PER_MS: 3600 / 1852,
    M_PER_NM: 1852,
    kn(ms) {
        return ms == null ? null : ms * UNITS.KN_PER_MS;
    },
    nm(m) {
        return m == null ? null : m / UNITS.M_PER_NM;
    },
    deg(rad) {
        if (rad == null) return null;
        const d = (rad * 180) / Math.PI;
        return ((d % 360) + 360) % 360;
    },
    fmt(v, digits) {
        return v == null || !Number.isFinite(v) ? '–' : v.toFixed(digits);
    },
    fmtAge(ms) {
        if (ms == null || !Number.isFinite(ms)) return '?';
        const s = Math.max(0, Math.round(ms / 1000));
        return s < 90 ? s + 's' : Math.round(s / 60) + 'm';
    }
};
if (typeof module !== 'undefined') module.exports = UNITS;
