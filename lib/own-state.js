'use strict'
/*
 * Bounded history of our own state so every competitor report can be compared
 * with our state at that report's time, never with our state "now"
 * (brief section 2.2).
 *
 * Samples are kept on arrival, thinned to at most one per minIntervalMs.
 * TODO(decision): brief section 8 leaves open whether to keep own state only at
 * other boats' report times or continuously. This keeps it continuously.
 */

const { RingBuffer } = require('./track-store')

class OwnState {
  constructor ({ minIntervalMs = 1000, maxSpanMs = 6 * 3600e3 } = {}) {
    this.minIntervalMs = minIntervalMs
    this.maxSpanMs = maxSpanMs
    // Count cap derived from span and interval, so memory is bounded either way.
    this.buf = new RingBuffer(Math.ceil(maxSpanMs / minIntervalMs) + 1)
  }

  add (sample) {
    const last = this.buf.latest()
    if (last && sample.t > last.t && sample.t - last.t < this.minIntervalMs) return
    this.buf.insert(sample)
    this.buf.trimBefore(this.buf.latest().t - this.maxSpanMs)
  }

  latest () { return this.buf.latest() }

  /**
   * Our state at time t: the latest sample at or before t, if within maxGapMs.
   * TODO: interpolate between bracketing samples (position linear, COG short way).
   */
  at (t, maxGapMs = 10e3) {
    const s = this.buf.atOrBefore(t)
    return s && t - s.t <= maxGapMs ? s : null
  }

  between (fromT, toT) { return this.buf.between(fromT, toT) }
}

module.exports = { OwnState }
