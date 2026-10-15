'use strict'
/* global UNITS */
/*
 * Nemesis Delta webapp skeleton. Plain JS, no framework.
 *
 * Data: polls the plugin's REST snapshot. One request in flight at a time, each
 * with a timeout; failures back off exponentially and the last good snapshot
 * stays on screen marked as stale. A server restart (503 while the plugin starts)
 * is just another failure and recovers on its own.
 * TODO: WebSocket stream for low-latency updates, with this poll as the resync path.
 */

const API = '/plugins/signalk-nemesis'
// ?poll=<ms> overrides the interval (used by browser tests; floor of 200 ms).
const POLL_MS = Math.max(200, Number(new URLSearchParams(location.search).get('poll')) || 5000)
const TIMEOUT_MS = 8000
const MAX_BACKOFF_MS = 30000
const PREFS_KEY = 'nd_prefs'

const $ = (id) => document.getElementById(id)

const prefs = Object.assign(
  { tab: 'boats', mode: 'abs', up: 'waypoint', period: '60', show: 'nemesi', sort: 'near' },
  loadPrefs()
)

let snapshot = null // last good snapshot
let lastOkAt = 0 // wall time of last good fetch
let failures = 0
let pollTimer = null
let inFlight = false

/* ---------- prefs (per-viewer convenience only; server holds real state) ---------- */
function loadPrefs () {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') } catch (e) { return {} }
}
function savePrefs () {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch (e) { /* private mode etc. */ }
}

/* ---------- networking ---------- */
async function fetchJson (url, opts = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal, cache: 'no-store' })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    return await r.json()
  } finally {
    clearTimeout(timer)
  }
}

async function poll () {
  if (inFlight) return
  inFlight = true
  try {
    snapshot = await fetchJson(API + '/snapshot')
    lastOkAt = Date.now()
    failures = 0
  } catch (e) {
    failures++
  } finally {
    inFlight = false
  }
  render()
  schedule()
}

function schedule () {
  clearTimeout(pollTimer)
  const delay = failures ? Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** (failures - 1)) : POLL_MS
  pollTimer = setTimeout(poll, delay)
}

// Resync immediately when the tablet wakes or the tab becomes visible.
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll() })
window.addEventListener('online', () => poll())

async function toggleNemesis (id) {
  const b = snapshot && snapshot.boats.find((x) => x.id === id)
  if (!b) return
  const want = !b.nemesis
  b.nemesis = want // optimistic
  render()
  try {
    await fetchJson(API + '/nemesis/' + encodeURIComponent(id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nemesis: want })
    })
  } catch (e) {
    b.nemesis = !want // revert; the next poll is authoritative anyway
    render()
  }
}

/* ---------- rendering ---------- */
function render () {
  renderConn()
  const boats = visibleBoats()
  $('fleetCount').textContent = boats.length + '/' + (snapshot ? snapshot.boats.length : 0)
  if (prefs.tab === 'boats') renderBoats(boats)
}

function renderConn () {
  const el = $('conn')
  const age = lastOkAt ? Date.now() - lastOkAt : null
  el.className = 'sub ' + (!lastOkAt ? 'bad' : failures ? 'warn' : 'ok')
  el.textContent = !lastOkAt ? 'no data' : failures ? 'stale ' + UNITS.fmtAge(age) : 'live'
}

function visibleBoats () {
  if (!snapshot) return []
  const bs = snapshot.boats
  switch (prefs.show) {
    case 'all': return bs
    case 'inrange': return bs.filter((b) => b.current)
    case 'none': return []
    default: return bs.filter((b) => b.nemesis)
  }
}

function renderBoats (boats) {
  const list = $('blist')
  const scroll = list.scrollTop // preserve scroll across re-renders
  if (!snapshot) {
    list.innerHTML = '<div class="empty">Waiting for data from the plugin.</div>'
    return
  }
  const sorted = boats.slice().sort(prefs.sort === 'alpha'
    ? (a, b) => (a.name || a.id).localeCompare(b.name || b.id)
    : (a, b) => (a.rangeM ?? Infinity) - (b.rangeM ?? Infinity))
  const own = snapshot.own
  const rows = []
  rows.push(`<div class="brow us"><span class="nem" aria-hidden="true"></span>
    <div class="bname"><div class="n">Us</div>
    <div class="s">${own ? UNITS.fmt(UNITS.kn(own.sogMs), 1) + ' kn  ' + UNITS.fmt(UNITS.deg(own.cogRad), 0) + '°' : 'no own position'}</div></div>
    <div class="bmeta">${own ? UNITS.fmtAge(snapshot.now - own.t) : ''}</div></div>`)
  for (const b of sorted) {
    const l = b.latest
    rows.push(`<div class="brow ${b.current ? '' : 'gone'}" data-id="${esc(b.id)}">
      <button class="nem ${b.nemesis ? 'on' : ''}" data-nem="${esc(b.id)}" title="toggle nemesis">⚔</button>
      <div class="bname"><div class="n">${esc(b.name || b.id)}</div>
      <div class="s">${UNITS.fmt(UNITS.kn(l.sogMs), 1)} kn  ${UNITS.fmt(UNITS.deg(l.cogRad), 0)}°</div></div>
      <div class="bmeta">${UNITS.fmt(UNITS.nm(b.rangeM), 1)} nm<br>${UNITS.fmtAge(b.ageMs)}</div></div>`)
  }
  if (!sorted.length) rows.push('<div class="empty">No boats to show. Try Show: All.</div>')
  list.innerHTML = rows.join('')
  list.scrollTop = scroll
}

function esc (s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

/* ---------- controls ---------- */
function setTab (t) {
  prefs.tab = t
  savePrefs()
  for (const btn of document.querySelectorAll('#tabbar button')) {
    const on = btn.dataset.tab === t
    btn.classList.toggle('on', on)
    $('pane-' + btn.dataset.tab).classList.toggle('hidden', !on)
  }
  render()
}

function bindSelect (id, key) {
  const el = $(id)
  el.value = prefs[key]
  if (el.value !== prefs[key]) prefs[key] = el.value // stored value no longer offered
  el.addEventListener('change', () => { prefs[key] = el.value; savePrefs(); render() })
}

document.querySelector('#tabbar').addEventListener('click', (e) => {
  const t = e.target.closest('button[data-tab]')
  if (t) setTab(t.dataset.tab)
})
$('blist').addEventListener('click', (e) => {
  const n = e.target.closest('[data-nem]')
  if (n) toggleNemesis(n.dataset.nem)
})
bindSelect('modeSel', 'mode')
bindSelect('upSel', 'up')
bindSelect('periodSel', 'period')
bindSelect('showSel', 'show')
bindSelect('sortSel', 'sort')
setTab(prefs.tab)
poll()
setInterval(renderConn, 1000)
