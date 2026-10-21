'use strict';
/*
 * Reads an Expedition instrument log (the "!log=v3" CSV). The first two lines name the
 * columns ("!Boat,Utc,BSP,..." and their ids "!boat,0,1,2,..."); each data row is the boat
 * number, the Utc, then id,value pairs for the columns that have a value. Boat 0 is the
 * logging boat; other boat numbers are targets Expedition was tracking. A logger restart
 * repeats the header lines mid-file, and may leave a truncated line before them.
 *
 * Times (checked against the Oct 2026 logs, not a format spec):
 * - Utc is a Windows FILETIME: 100 ns ticks since 1601-01-01 UTC.
 * - "GPS time" is the GPS fix time, in the same ticks since 1601 (Expedition 12.9) or ticks
 *   since 1899-12-30, the OLE date epoch (12.8). Whichever lands near Utc is taken.
 * Units as logged: angles in degrees, speeds in knots (BSP and SOG agree, and TWS is a
 * plausible 12 kn). Converted to SI here: rad and m/s.
 *
 * A heading of exactly 0.00 is a dropout, not north: K logged it in 27 of 234 rows in
 * 16:58-17:02 on 16 Oct 2026 while its COG was 20 to 40 degrees.
 */

const FT_1601 = 116444736000000000n; // 1601-01-01 to 1970-01-01, 100 ns ticks
const OLE_1899 = 22091616000000000n; // 1899-12-30 to 1970-01-01, 100 ns ticks
const KN = 1852 / 3600;
const D2R = Math.PI / 180;

/** Ticks since an epoch, as epoch ms (fractional), from a decimal string. */
function ticksToMs(s, epochTicks) {
    const v = BigInt(s) - epochTicks;
    return Number(v / 10000n) + Number(v % 10000n) / 1e4;
}

const num = (s) => (s === undefined || s === '' ? null : Number.isFinite(Number(s)) ? Number(s) : null);
const rad = (d) => (d == null ? null : d * D2R);
const ms = (kn) => (kn == null ? null : kn * KN);

/**
 * Parses log text. Returns the column names and the rows of boat 0 in file order:
 * {t: Utc epoch ms, gpsT: GPS fix epoch ms or null, lat, lon (deg), hdgRad, cogRad, sogMs,
 * bspMs, twdRad, twaRad, twsMs, awaRad, awsMs, raw: {column name: number}}.
 */
function parseExpedition(text) {
    const lines = text.split(/\r?\n/);
    let names = null;
    let name = null;
    const rows = [];
    let skipped = 0;
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (!l) continue;
        if (l.startsWith('!Boat,')) names = l.slice(1).split(',');
        else if (l.startsWith('!boat,') && names) {
            const ids = l.slice(1).split(',');
            name = Object.fromEntries(ids.map((id, k) => [id, names[k]]));
        } else if (l[0] === '!') continue;
        else if (!name || !/^\d+,\d+,\d+,/.test(l))
            skipped++; // a cut-off row has no column
        else {
            const p = l.split(',');
            if (p[0] !== '0') continue; // another boat Expedition tracked
            const raw = {};
            let g = null; // GPS time ticks, kept as a string: they exceed 2^53
            for (let k = 2; k + 1 < p.length; k += 2) {
                const col = name[p[k]] || 'id' + p[k];
                if (col === 'GPS time') g = p[k + 1];
                const v = num(p[k + 1]);
                if (v != null) raw[col] = v;
            }
            const t = ticksToMs(p[1], FT_1601);
            let gpsT = null;
            if (g && /^\d+$/.test(g)) {
                const a = ticksToMs(g, FT_1601);
                const b = ticksToMs(g, OLE_1899);
                gpsT = Math.abs(a - t) < Math.abs(b - t) ? a : b;
            }
            rows.push({
                t,
                gpsT,
                lat: raw.Lat ?? null,
                lon: raw.Lon ?? null,
                hdgRad: raw.HDG ? rad(raw.HDG) : null, // exactly 0 is a dropout
                cogRad: rad(raw.COG ?? null),
                sogMs: ms(raw.SOG ?? null),
                bspMs: ms(raw.BSP ?? null),
                twdRad: rad(raw.TWD ?? null),
                twaRad: rad(raw.TWA ?? null),
                twsMs: ms(raw.TWS ?? null),
                awaRad: rad(raw.AWA ?? null),
                awsMs: ms(raw.AWS ?? null),
                raw
            });
        }
    }
    return {columns: names || [], rows, skipped};
}

module.exports = {parseExpedition, ticksToMs, FT_1601, OLE_1899};
