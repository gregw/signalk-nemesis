#!/usr/bin/env node
// Pull full fleet tracks for Noakes Sydney Gold Coast 2026 (raceId 194)
// from the CYCA feed, one call per 10-minute timepoint, and write a compact JSON.
//
// Endpoint (reverse-engineered from the tracker HAR):
//   GET https://feeds.cycaracing.com/Yachts/194?raceTime=YYYYMMDDHHMMSS
//   -> array of 48 boats, each with a Position {Latitude,Longitude,
//      SpeedOverGround,CourseOverGround,DistanceToGo,DistanceToLeader,...}
//   raceTime is LOCAL wall clock (AEST, UTC+10). Positions are null before the
//   start and after a boat finishes.
//
// Node 18+ (global fetch). No dependencies.
//   node pull-gc2026.mjs                 # positions only -> gc2026-tracks.json
//   node pull-gc2026.mjs --from 20260725130000 --to 20260728140000
//
// Output schema (see bottom of file).

const RACE_ID = 194;
const BASE = `https://feeds.cycaracing.com/Yachts/${RACE_ID}`;
const STEP_MS = 10 * 60 * 1000;
const CONC = 5;                 // parallel requests
const STOP_AFTER_EMPTY = 6;     // stop after N consecutive all-null snapshots (past start)

// ---- args ----
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const FROM = arg('--from', '20260725130000');   // 2026-07-25 13:00 local (start)
const TO   = arg('--to',   '20260728140000');   // safe upper bound

// raceTime label <-> epoch, treating the label as a wall-clock in a fixed +10 zone.
// We anchor on a UTC epoch whose UTC fields equal the local wall clock, then format
// with getUTC*, so arithmetic stays trivial and labels come out local.
function labelToMs(s) {
  const y=+s.slice(0,4), mo=+s.slice(4,6)-1, d=+s.slice(6,8),
        h=+s.slice(8,10), mi=+s.slice(10,12), se=+s.slice(12,14);
  return Date.UTC(y, mo, d, h, mi, se);
}
function msToLabel(ms) {
  const d = new Date(ms), p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}`+
         `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}
function msToISO(ms) {                    // unambiguous instant, AEST
  const d = new Date(ms), p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())}`+
         `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+10:00`;
}

async function fetchSnapshot(label, tries = 3) {
  const url = `${BASE}?raceTime=${label}`;
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(url, { headers: { 'accept': 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (t === tries - 1) { console.error(`  ! ${label} failed: ${e.message}`); return null; }
      await new Promise(r => setTimeout(r, 400 * (t + 1)));
    }
  }
}

// number|null from the feed's stringy numeric fields
const num = v => (v === null || v === undefined || v === '') ? null : Number(v);

async function main() {
  const t0 = labelToMs(FROM), t1 = labelToMs(TO);
  const labels = [];
  for (let ms = t0; ms <= t1; ms += STEP_MS) labels.push(ms);
  console.error(`Pulling raceId ${RACE_ID}: ${labels.length} timepoints ${FROM}..${TO}`);

  const boats = new Map();      // RaceEntryId -> {id,name,club,owner,categories,samples:[]}
  let started = false, emptyRun = 0, done = 0;

  // simple bounded-concurrency, but preserve time order in output by collecting then sorting
  const results = new Array(labels.length);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++; if (i >= labels.length) return;
      const ms = labels[i];
      const data = await fetchSnapshot(msToLabel(ms));
      results[i] = { ms, data };
      done++;
      if (done % 25 === 0) console.error(`  ${done}/${labels.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  for (const { ms, data } of results) {
    if (!Array.isArray(data)) continue;
    let withPos = 0;
    for (const y of data) {
      const id = y.RaceEntryId;
      if (!boats.has(id)) boats.set(id, {
        id, name: y.Name, club: y.Club, owner: y.Owner,
        categories: (y.Categories || []).map(c => ({ name: c.Name, division: c.Division })),
        samples: []
      });
      const p = y.Position;
      if (p && p.Latitude != null && p.Longitude != null) {
        withPos++;
        boats.get(id).samples.push([
          msToISO(ms), num(p.Latitude), num(p.Longitude),
          num(p.SpeedOverGround), num(p.CourseOverGround),
          num(p.DistanceToGo), num(p.DistanceToLeader)
        ]);
      }
    }
    if (withPos > 0) { started = true; emptyRun = 0; }
    else if (started) { if (++emptyRun >= STOP_AFTER_EMPTY) break; }
  }

  const out = {
    race: { id: RACE_ID, name: 'Noakes Sydney Gold Coast Yacht Race 2026',
            start: '2026-07-25T13:00:00+10:00', tz: '+10:00' },
    step_s: STEP_MS / 1000,
    sample_fields: ['t', 'lat', 'lon', 'sog_kn', 'cog_deg', 'dtg_nm', 'dtl_nm'],
    boats: [...boats.values()].filter(b => b.samples.length > 0)
  };
  const fs = await import('node:fs');
  fs.writeFileSync('gc2026-tracks.json', JSON.stringify(out));
  const n = out.boats.length, pts = out.boats.reduce((a, b) => a + b.samples.length, 0);
  console.error(`\nWrote gc2026-tracks.json : ${n} boats, ${pts} position points`);
  console.error(`Longest track: ${Math.max(...out.boats.map(b => b.samples.length))} points`);
}
main();

// ---- OUTPUT SCHEMA ----------------------------------------------------------
// {
//   race:  { id, name, start, tz },
//   step_s: 600,
//   sample_fields: ["t","lat","lon","sog_kn","cog_deg","dtg_nm","dtl_nm"],
//   boats: [
//     { id, name, club, owner,
//       categories: [{name,division}],
//       samples: [ ["2026-07-25T13:00:00+10:00", -33.85, 151.28, 8.4, 45, 384.0, 0.0], ... ]
//     }, ...
//   ]
// }
// All boats share the same 10-min timepoint grid, so matched-sample alignment
// across boats is just index/timestamp equality. DistanceToGo (dtg_nm) gives
// VMG-to-finish (VMC) from consecutive samples with no wind needed.
