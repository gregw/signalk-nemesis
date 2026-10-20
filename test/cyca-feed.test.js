'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const feed = require('../lib/cyca-feed');

const TZ = 'Australia/Sydney';
const fixture = (f) => require('./data/cyca/' + f);
const KN = 1852 / 3600;

test('race-local times convert to UTC either side of daylight saving', () => {
    assert.equal(feed.localToUtc('2026-07-26T12:00:00', TZ), Date.parse('2026-07-26T02:00:00Z')); // AEST +10
    assert.equal(feed.localToUtc('2026-12-26T13:00:00', TZ), Date.parse('2026-12-26T02:00:00Z')); // AEDT +11
    // Clocks go forward at 02:00 AEST on 4 Oct 2026.
    assert.equal(feed.localToUtc('2026-10-04T01:50:00', TZ), Date.parse('2026-10-03T15:50:00Z'));
    assert.equal(feed.localToUtc('2026-10-04T03:00:00', TZ), Date.parse('2026-10-03T16:00:00Z'));
    assert.equal(feed.localToUtc('0001-01-01T00:00:00', TZ), null);
    assert.equal(feed.localToUtc('nonsense', TZ), null);
    assert.equal(feed.localToUtc('2026-07-26T12:00:00', 'Not/AZone'), null);
});

test('snapshot tokens are race-local and floored to 10 minutes', () => {
    assert.equal(feed.snapshotToken(Date.parse('2026-07-26T02:09:59Z'), TZ), '202607261200');
    assert.equal(feed.snapshotToken(Date.parse('2026-12-26T02:10:00Z'), TZ), '202612261310');
});

test('URLs match the tracker page module', () => {
    const u = feed.urls();
    assert.equal(u.status(194, 'live'), 'https://feeds.cycaracing.com/v2/races/194/at/live/status');
    assert.equal(u.track(194, 18921, 'live'), 'https://feeds.cycaracing.com/v2/races/194/entries/18921/track/at/live');
    assert.equal(u.seriesRaces(14), 'https://feeds.cycaracing.com/v2/series/14/races');
    assert.equal(u.yearSeries(2026), 'https://feeds.cycaracing.com/v2/years/2026/series');
});

test('race detail and series races parse', () => {
    const r = feed.parseRace(fixture('race-194.json'));
    assert.equal(r.raceId, 194);
    assert.equal(r.startT, Date.parse('2026-07-25T03:00:00Z'));
    assert.equal(r.timeZone, TZ);
    assert.equal(r.running, false);
    const races = feed.parseRaces(fixture('series-14-races.json'));
    assert.ok(races.length > 3);
    const bird = races.find((x) => x.raceId === 197);
    assert.equal(bird.status, 'Pre-race');
    assert.equal(bird.startT, Date.parse('2026-11-13T23:00:00Z')); // 10:00 AEDT 14 Nov
    assert.deepEqual(feed.parseRaces({not: 'a list'}), []);
});

test('entries parse, with the race name from the cmsUrl slug', () => {
    const {entries, raceName} = feed.parseEntries(fixture('entries-197.json'));
    assert.equal(entries.length, 4);
    assert.equal(entries[0].name, 'Akonga');
    assert.equal(entries[0].entryId, 19231);
    assert.equal(raceName, 'Bird Island Race');
    // Single race series have no slug.
    assert.equal(feed.parseEntries(fixture('entries-194.json')).raceName, null);
});

test('status parses to SI with the slot as time; entries without a position are skipped', () => {
    const rows = feed.parseStatus(fixture('status-194-202607261200.json'), TZ);
    const a = rows.find((r) => r.entryId === 18921);
    assert.equal(a.t, Date.parse('2026-07-26T02:00:00Z'));
    assert.equal(a.lat, -30.91191);
    assert.equal(a.lon, 153.13005);
    assert.ok(Math.abs(a.sogMs - 9.9 * KN) < 1e-9);
    assert.ok(Math.abs(a.cogRad - (324 * Math.PI) / 180) < 1e-9);
    assert.ok(Math.abs(a.dtgM - 180.79 * 1852) < 1e-6);
    assert.equal(a.racing, true);
    const retired = rows.filter((r) => !r.racing);
    assert.equal(retired.length, 2);
    assert.match(retired[0].status, /^Retired/);
    // Pre-race: no positions, raceTime is the year 1 sentinel.
    assert.deepEqual(feed.parseStatus(fixture('status-197-live.json'), TZ), []);
    assert.deepEqual(feed.parseStatus(null, TZ), []);
});

test('a track maps point i to slot i while racing, without the start placeholder', () => {
    const start = Date.parse('2026-07-25T03:00:00Z');
    const pts = feed.parseTrack(fixture('track-194-18921-202607261200.json'), start);
    assert.equal(pts.length, 138); // 139 slots 13:00 25 Jul to 12:00 26 Jul, less the placeholder
    assert.equal(pts[0].t, start + 600e3);
    assert.equal(pts.at(-1).t, Date.parse('2026-07-26T02:00:00Z'));
    // The last slot agrees with the status snapshot at that time.
    const st = feed.parseStatus(fixture('status-194-202607261200.json'), TZ).find((r) => r.entryId === 18921);
    assert.equal(pts.at(-1).lat, st.lat);
    assert.equal(pts.at(-1).lon, st.lon);
    // Points stop at the first one not racing.
    const cut = feed.parseTrack(
        [
            {isRacing: true, latitude: -33, longitude: 151, speedOverGround: '5'},
            {isRacing: false, latitude: -30, longitude: 153, speedOverGround: '0'}
        ],
        start
    );
    assert.equal(cut.length, 1);
});

test('fetchJson never throws', async () => {
    const ok = await feed.fetchJson(async () => ({ok: true, json: async () => [1]}), 'u');
    assert.deepEqual(ok, {ok: true, json: [1]});
    assert.deepEqual(await feed.fetchJson(async () => ({ok: false, status: 503}), 'u'), {ok: false, error: 'HTTP 503'});
    const down = await feed.fetchJson(async () => {
        throw new TypeError('fetch failed');
    }, 'u');
    assert.deepEqual(down, {ok: false, error: 'fetch failed'});
    const bad = await feed.fetchJson(async () => ({ok: true, json: async () => JSON.parse('{')}), 'u');
    assert.equal(bad.ok, false);
    const slow = await feed.fetchJson(
        (url, {signal}) =>
            new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
        'u',
        20
    );
    assert.deepEqual(slow, {ok: false, error: 'timeout'});
});

test('name keys ignore case and spacing', () => {
    assert.equal(feed.nameKey('  Blue  Planet DH '), 'blue planet dh');
    assert.equal(feed.nameKey(null), '');
});
