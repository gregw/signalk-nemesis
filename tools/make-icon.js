'use strict';
/*
 * Generates the Nemesis Delta app icon from the prototype's hull geometry:
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
    delta: '#4a8be0', // prototype --accent, lightened for a dark ground
    us: '#ffffff',
    nemesis: '#e0303f', // prototype --port, slightly brighter
};

/* Prototype boatIcon(): forward = +x, BEAM 0.7 (a little beamier here so it reads at 72 px). */
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

function svg() {
    const deg = (d) => (d * Math.PI) / 180;
    // Delta: equilateral-ish triangle, apex up.
    const tri = '256,70 452,418 60,418';
    // Both boats sailing Up (the app's frame), the nemesis ahead and to the right.
    const H = 132; // hull length scale
    const B = 0.85; // beam factor
    const up = deg(-90);
    const us = {x: 200, y: 318, a: up};
    const nem = {x: 290, y: 256, a: up};
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect x="0" y="0" width="512" height="512" rx="96" fill="${C.bg}"/>
  <polygon points="${tri}" fill="none" stroke="${C.delta}" stroke-width="30" stroke-linejoin="round"/>
  <polygon points="${hull(nem.x, nem.y, nem.a, H, B)}" fill="${C.nemesis}" stroke="${C.bg}" stroke-width="6" stroke-linejoin="round"/>
  <polygon points="${hull(us.x, us.y, us.a, H, B)}" fill="${C.us}" stroke="${C.bg}" stroke-width="6" stroke-linejoin="round"/>
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
