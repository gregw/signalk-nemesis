'use strict';
/*
 * Generates the Nemesis Delta app icon from the prototype's hull geometry (our boat
 * white, the nemesis red and ahead with a comet tail, inside a delta):
 * public/assets/signalk-nemesis.svg plus PNG renders (72x72 for the Signal K
 * appIcon, as signalk-racer ships, and larger sizes for docs).
 *
 *   node tools/make-icon.js            # needs the playwright dev dependency for PNGs
 */

const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'public', 'assets');

const C = {
    bg: '#1a2a3a', // prototype --ink
    rings: '#4a8be0', // prototype --accent, lightened for a dark ground
    us: '#ffffff',
    nemesis: '#e0303f', // prototype --port, slightly brighter
    lead: '#ffffff'
};

/* Prototype boatIcon(): forward = +x, BEAM 0.7. */
function hull(px, py, ang, size, beam = 0.7) {
    const P = [
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
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    return P.map(([lx, ly0]) => {
        const ly = ly0 * beam;
        return `${(px + (lx * c - ly * s) * size).toFixed(1)},${(py + (lx * s + ly * c) * size).toFixed(1)}`;
    }).join(' ');
}

// A faint VMG strip chart: our trace and the nemesis trace, wandering across the icon.
function strip() {
    const trace = (y0, amp, ph, colour) => {
        const pts = [];
        for (let x = 0; x <= 512; x += 16) {
            const y = y0 + amp * (Math.sin(x / 41 + ph) * 0.6 + Math.sin(x / 17 + 2 * ph) * 0.3 + Math.sin(x / 7 + 3 * ph) * 0.1);
            pts.push(`${x},${y.toFixed(1)}`);
        }
        return `<polyline points="${pts.join(' ')}" fill="none" stroke="${colour}" stroke-width="10" stroke-linejoin="round" opacity="0.22"/>`;
    };
    return `<g clip-path="url(#bg)">${trace(370, 46, 0.4, C.us)}${trace(395, 52, 2.1, C.nemesis)}</g>`;
}

// Range rings and cross hairs centred on our boat, as on a radar or AIS display.
function rings(c) {
    let out = `<g clip-path="url(#bg)" fill="none" stroke="${C.rings}">`;
    out += `<line x1="${c.x}" y1="0" x2="${c.x}" y2="512" stroke-width="6" opacity="0.45"/>`;
    out += `<line x1="0" y1="${c.y}" x2="512" y2="${c.y}" stroke-width="6" opacity="0.45"/>`;
    for (const r of [80, 160, 240]) out += `<circle cx="${c.x}" cy="${c.y}" r="${r}" stroke-width="16"/>`;
    return out + '</g>';
}

function svg() {
    const deg = (d) => (d * Math.PI) / 180;
    // Delta: equilateral-ish triangle, apex up.
    // Our boat lower left; the nemesis ahead, with a comet tail along its track.
    const us = {x: 256, y: 256, a: deg(-80)};
    const nem = {x: 366, y: 131, a: deg(-68)};
    let tail = '';
    const n = 4;
    for (let i = 0; i < n; i++) {
        const back = (k) => [nem.x - Math.cos(nem.a) * (70 + 34 * k), nem.y - Math.sin(nem.a) * (70 + 34 * k)];
        const [x1, y1] = back(i);
        const [x2, y2] = back(i + 1);
        const f = 1 - i / n;
        tail += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${C.nemesis}" stroke-width="${(6 + 16 * f).toFixed(1)}" stroke-linecap="round" opacity="${(0.25 + 0.6 * f).toFixed(2)}"/>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect x="0" y="0" width="512" height="512" rx="96" fill="${C.bg}"/>
  <clipPath id="bg"><rect x="0" y="0" width="512" height="512" rx="96"/></clipPath>
  ${strip()}
  ${rings(us)}
  <line x1="${us.x}" y1="${us.y}" x2="${nem.x}" y2="${nem.y}" stroke="${C.lead}" stroke-width="10" stroke-dasharray="4 22" stroke-linecap="round" opacity="0.85"/>
  ${tail}
  <polygon points="${hull(nem.x, nem.y, nem.a, 150)}" fill="${C.nemesis}" stroke="${C.bg}" stroke-width="8" stroke-linejoin="round"/>
  <polygon points="${hull(us.x, us.y, us.a, 150)}" fill="${C.us}" stroke="${C.bg}" stroke-width="8" stroke-linejoin="round"/>
</svg>
`;
}

async function main() {
    fs.mkdirSync(OUT, {recursive: true});
    const file = path.join(OUT, 'signalk-nemesis.svg');
    const s = svg();
    fs.writeFileSync(file, s);
    console.log('wrote', file);

    let chromium;
    try {
        ({chromium} = require('playwright'));
    } catch (e) {
        console.log('playwright not installed: PNGs not rendered');
        return;
    }
    const browser = await chromium.launch();
    for (const size of [72, 192, 512]) {
        const page = await browser.newPage({viewport: {width: size, height: size}});
        await page.setContent(
            `<html><body style="margin:0;background:transparent">${s.replace('width="512" height="512"', `width="${size}" height="${size}"`)}</body></html>`
        );
        const png = path.join(OUT, `signalk-nemesis-${size}x${size}.png`);
        await page.screenshot({path: png, omitBackground: true});
        console.log('wrote', png);
        await page.close();
    }
    await browser.close();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
