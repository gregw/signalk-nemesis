'use strict'
/*
 * Re-assembles per-path subscription values into whole position reports.
 *
 * The server's subscription manager delivers one value per path bus
 * (signalk-server src/subscriptionmanager.ts handleSubscribeRow), even though the
 * AIS parsers emit position, COG and SOG together in a single update with one
 * timestamp (nmea0183-signalk hooks/VDM.js, n2k-signalk pgns/129039.js). Values
 * from the same context and the same update timestamp are therefore merged here.
 *
 * A pending report is flushed when a value with a different timestamp arrives for
 * that context, or after `windowMs` of quiet. Reports without a position are
 * discarded. Missing COG or SOG is passed through as null.
 */

const PATHS = {
  'navigation.position': 'position',
  'navigation.courseOverGroundTrue': 'cogRad',
  'navigation.speedOverGround': 'sogMs',
  'navigation.headingTrue': 'headingRad'
}

class Coalescer {
  /**
   * @param {(context: string, report: object) => void} onReport
   * @param {object} [opts]
   * @param {number} [opts.windowMs=250] quiet time before a pending report is flushed
   * @param {(fn: Function, ms: number) => any} [opts.setTimer] injectable for tests
   * @param {(handle: any) => void} [opts.clearTimer]
   */
  constructor (onReport, opts = {}) {
    this.onReport = onReport
    this.windowMs = opts.windowMs ?? 250
    this.setTimer = opts.setTimer ?? setTimeout
    this.clearTimer = opts.clearTimer ?? clearTimeout
    this.pending = new Map() // context -> {t, values, timer}
  }

  /** Feed one subscription delta. Never throws on malformed input. */
  accept (delta) {
    if (!delta || typeof delta.context !== 'string' || !Array.isArray(delta.updates)) return
    for (const update of delta.updates) {
      const t = Date.parse(update && update.timestamp)
      if (!Number.isFinite(t) || !Array.isArray(update.values)) continue
      for (const pv of update.values) {
        const key = pv && PATHS[pv.path]
        if (key) this._merge(delta.context, t, key, pv.value)
      }
    }
  }

  _merge (context, t, key, value) {
    let p = this.pending.get(context)
    if (p && p.t !== t) {
      this._flush(context)
      p = undefined
    }
    if (!p) {
      p = { t, values: {}, timer: null }
      this.pending.set(context, p)
    }
    p.values[key] = value
    if (p.timer) this.clearTimer(p.timer)
    p.timer = this.setTimer(() => this._flush(context), this.windowMs)
  }

  _flush (context) {
    const p = this.pending.get(context)
    if (!p) return
    this.pending.delete(context)
    if (p.timer) this.clearTimer(p.timer)
    const pos = p.values.position
    if (!pos || !Number.isFinite(pos.latitude) || !Number.isFinite(pos.longitude)) return
    const num = (v) => (Number.isFinite(v) ? v : null)
    this.onReport(context, {
      t: p.t,
      lat: pos.latitude,
      lon: pos.longitude,
      cogRad: num(p.values.cogRad),
      sogMs: num(p.values.sogMs),
      headingRad: num(p.values.headingRad)
    })
  }

  /** Flush everything now (used on stop). */
  flushAll () {
    for (const context of [...this.pending.keys()]) this._flush(context)
  }
}

module.exports = { Coalescer, PATHS }
