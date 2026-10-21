'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {parseExpedition, FT_1601, OLE_1899} = require('./sim/expedition-log');

const D2R = Math.PI / 180;
const ticks = (iso, epoch) => String(BigInt(Date.parse(iso)) * 10000n + epoch);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

const HEAD = ['!Boat,Utc,BSP,HDG,Lat,Lon,COG,SOG,GPS time', '!boat,0,1,13,48,49,50,51,146', '!v12.8.11', '!log=v3'];

test('Expedition log: FILETIME Utc, GPS time in either epoch, knots and degrees to SI', () => {
    const t = '2026-10-16T05:58:00.500Z';
    const text = [
        ...HEAD,
        // GPS time 1.5 s before Utc, ticks since 1899-12-30 (Expedition 12.8).
        `0,${ticks(t, FT_1601)},1,6.0,13,045.00,48,-33.864470,49,151.245230,50,050.00,51,5.0,146,${ticks('2026-10-16T05:57:59.000Z', OLE_1899)}`,
        // GPS time in ticks since 1601 (Expedition 12.9); heading exactly 0 is a dropout.
        `0,${ticks('2026-10-16T05:58:01.500Z', FT_1601)},13,000.00,48,-33.8644,49,151.2453,146,${ticks('2026-10-16T05:58:01.000Z', FT_1601)}`,
        // Another boat Expedition tracked: not ours.
        `2,${ticks(t, FT_1601)},48,-33.87,49,151.23`
    ].join('\r\n');
    const {rows, skipped} = parseExpedition(text);
    assert.equal(rows.length, 2);
    assert.equal(skipped, 0);
    const [a, b] = rows;
    assert.equal(a.t, Date.parse(t));
    assert.equal(a.gpsT, Date.parse('2026-10-16T05:57:59.000Z'), 'OLE epoch');
    assert.equal(b.gpsT, Date.parse('2026-10-16T05:58:01.000Z'), '1601 epoch');
    near(a.hdgRad, 45 * D2R, 1e-12, 'HDG');
    near(a.cogRad, 50 * D2R, 1e-12, 'COG');
    near(a.sogMs, (5 * 1852) / 3600, 1e-12, 'SOG');
    near(a.bspMs, (6 * 1852) / 3600, 1e-12, 'BSP');
    assert.equal(a.lat, -33.86447);
    assert.equal(a.lon, 151.24523);
    assert.equal(b.hdgRad, null, 'heading 000.00 is a dropout');
    assert.equal(b.sogMs, null, 'not logged in that row');
});

test('Expedition log: a logger restart mid-file and its truncated line', () => {
    const r = (iso) => `0,${ticks(iso, FT_1601)},1,5.0`;
    const text = [
        ...HEAD,
        r('2026-10-16T03:00:00Z'),
        '0,1343659',
        '12' + HEAD[0],
        ...HEAD.slice(1),
        r('2026-10-16T03:40:00Z')
    ].join('\n');
    const {rows, skipped} = parseExpedition(text);
    assert.deepEqual(
        rows.map((x) => new Date(x.t).toISOString()),
        ['2026-10-16T03:00:00.000Z', '2026-10-16T03:40:00.000Z']
    );
    assert.equal(skipped, 2, 'the cut-off row and the line it ran into');
});
