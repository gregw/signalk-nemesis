'use strict';
/*
 * Reads a YB Tracking race KML (https://yb.tl/<raceKey>.kml): one Placemark per tracker
 * unit in a "Tracks" folder, its name the unit's boat name and a gx:Track of <when> times
 * and <gx:coord> "lon,lat,x" points in the same order (KML 2.2 gx:Track).
 *
 * Checked against the Tollgate Islands Race 2026 (bwps2026_2), fetched 2026-10-22:
 * Kanreki's fixes were within 8 m of her own Expedition log at the stamped times
 * (05:30-13:00Z, 30 fixes), so <when> is the fix time. The third coord value is not SOG
 * (2 where the log had 10 kn); TODO(verify) what it is. It is ignored.
 */

/** Parses KML text to [{name, samples: [[tMs, lat, lon]]}] in file order, samples by time. */
function parseYbKml(text) {
    const out = [];
    const pm = /<(?:\w+:)?Placemark>([\s\S]*?)<\/(?:\w+:)?Placemark>/g;
    for (let m; (m = pm.exec(text));) {
        const body = m[1];
        const name = /<(?:\w+:)?name>([^<]*)</.exec(body);
        const track = /<gx:Track>([\s\S]*?)<\/gx:Track>/.exec(body);
        if (!name || !track) continue;
        const when = [...track[1].matchAll(/<(?:\w+:)?when>([^<]*)</g)].map((x) => Date.parse(x[1]));
        const coord = [...track[1].matchAll(/<gx:coord>([^<]*)</g)].map((x) =>
            x[1]
                .trim()
                .split(/[\s,]+/)
                .map(Number)
        );
        const samples = [];
        for (let i = 0; i < Math.min(when.length, coord.length); i++) {
            const [lon, lat] = coord[i];
            if (Number.isFinite(when[i]) && Number.isFinite(lat) && Number.isFinite(lon))
                samples.push([when[i], lat, lon]);
        }
        samples.sort((a, b) => a[0] - b[0]);
        out.push({name: unescapeXml(name[1].trim()), samples});
    }
    return out;
}

function unescapeXml(s) {
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

module.exports = {parseYbKml};
