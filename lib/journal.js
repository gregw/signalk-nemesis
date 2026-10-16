'use strict';
/*
 * Append-only journal of ingested data, so track history survives a restart.
 *
 * Records are JSON lines in segment files under <data dir>/journal/, one segment
 * per segmentMs of wall-clock time: seg-<startMs>.jsonl. Lines are buffered and
 * appended with an fdatasync every flushMs, so a brownout loses at most that much.
 * Nothing is rewritten in place:
 *  - Segments wholly older than recentMs are compacted: rewritten (temp file, fsync,
 *    rename) as seg-<startMs>.thin.jsonl with each boat thinned to one report per
 *    thinMs and own-state samples dropped (reports carry our state at their time).
 *  - Segments wholly older than retainMs are deleted.
 * On start every segment is read back, oldest first, in chunks that yield to the
 * event loop. A torn last line (power cut mid-write) is skipped.
 *
 * Record kinds: {k: 'r', ...Report} an AIS report; {k: 'o', ...sample} own state;
 * {k: 'n', id, name} a boat name; {k: 'n', id, shipType} its AIS ship type.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {thinReports} = require('./thin');

const SEGMENT_RE = /^seg-(\d+)(\.thin)?\.jsonl$/;
const LINES_PER_CHUNK = 2000;

class Journal {
    /**
     * @param {object} opts
     * @param {string} opts.dir journal directory (created if missing)
     * @param {number} opts.retainMs delete segments older than this
     * @param {number} opts.recentMs compact segments older than this
     * @param {number} opts.thinMs report spacing kept per boat in compacted segments
     * @param {number} [opts.segmentMs=600000]
     * @param {number} [opts.flushMs=1000]
     * @param {() => number} [opts.clock]
     * @param {(e: Error) => void} [opts.onError]
     */
    constructor({dir, retainMs, recentMs, thinMs, segmentMs = 600e3, flushMs = 1000, clock = Date.now, onError}) {
        this.dir = dir;
        this.retainMs = retainMs;
        this.recentMs = recentMs;
        this.thinMs = thinMs;
        this.segmentMs = segmentMs;
        this.flushMs = flushMs;
        this.clock = clock;
        this.onError = onError || (() => {});
        this.buffer = [];
        // Flush and maintenance run one at a time on this queue, so a compaction can never
        // read and delete a raw segment while a flush is appending to it.
        this.queue = Promise.resolve();
        this.timer = null;
    }

    /**
     * Read back every segment, oldest first, calling onRecord for each record.
     * Stops early when cancelled() returns true. Never throws for bad content.
     */
    async load(onRecord, cancelled = () => false) {
        await fsp.mkdir(this.dir, {recursive: true});
        let count = 0;
        for (const f of await this._segments()) {
            let text;
            try {
                text = await fsp.readFile(path.join(this.dir, f.name), 'utf8');
            } catch (e) {
                this.onError(e);
                continue;
            }
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (cancelled()) return count;
                const line = lines[i];
                if (line) {
                    let rec = null;
                    try {
                        rec = JSON.parse(line);
                    } catch (e) {
                        // torn or corrupt line: skip it
                    }
                    if (rec && typeof rec === 'object') {
                        try {
                            onRecord(rec);
                            count++;
                        } catch (e) {
                            this.onError(e);
                        }
                    }
                }
                if (i % LINES_PER_CHUNK === LINES_PER_CHUNK - 1) await new Promise((r) => setImmediate(r));
            }
        }
        return count;
    }

    /** Begin periodic flush and maintenance (compaction, pruning). */
    start() {
        let ticks = 0;
        this.timer = setInterval(() => {
            this.flush();
            // Compaction and pruning concern segments hours old: once a minute is plenty.
            if (++ticks % Math.max(1, Math.round(60e3 / this.flushMs)) === 0) this.maintain();
        }, this.flushMs);
        this.timer.unref?.();
    }

    append(rec) {
        this.buffer.push(JSON.stringify(rec));
    }

    _enqueue(op) {
        const p = this.queue.then(op, op);
        this.queue = p.catch(() => {});
        return p;
    }

    /** Append buffered lines to the current segment and fdatasync. */
    flush() {
        return this._enqueue(() => (this.buffer.length ? this._flush() : undefined));
    }

    async _flush() {
        const now = this.clock();
        const segStart = now - (now % this.segmentMs);
        const lines = this.buffer;
        this.buffer = [];
        const file = path.join(this.dir, `seg-${segStart}.jsonl`);
        let fh;
        try {
            fh = await fsp.open(file, 'a');
            await fh.appendFile(lines.join('\n') + '\n');
            await fh.datasync();
        } catch (e) {
            // Keep the lines for the next attempt rather than lose them.
            this.buffer = lines.concat(this.buffer);
            this.onError(e);
        } finally {
            await fh?.close().catch(() => {});
        }
    }

    /** Compact and prune old segments. */
    maintain() {
        return this._enqueue(() => this._maintain());
    }

    async _maintain() {
        try {
            const now = this.clock();
            for (const f of await this._segments()) {
                const end = f.start + this.segmentMs;
                if (end <= now - this.retainMs) {
                    await fsp.rm(path.join(this.dir, f.name), {force: true});
                } else if (!f.thin && end <= now - this.recentMs) {
                    await this._compact(f);
                }
            }
        } catch (e) {
            this.onError(e);
        }
    }

    async _compact(f) {
        const src = path.join(this.dir, f.name);
        const dst = path.join(this.dir, `seg-${f.start}.thin.jsonl`);
        // Merge with an existing thin file for the same segment rather than replace it.
        const existing = await fsp.readFile(dst, 'utf8').catch(() => '');
        const text = existing + '\n' + (await fsp.readFile(src, 'utf8'));
        const reports = [];
        const names = [];
        for (const line of text.split('\n')) {
            if (!line) continue;
            let rec;
            try {
                rec = JSON.parse(line);
            } catch (e) {
                continue;
            }
            if (rec && rec.k === 'r') reports.push(rec);
            else if (rec && rec.k === 'n') names.push(rec);
            // own-state samples ('o') are dropped: reports carry our state at their time
        }
        const kept = thinReports(reports, this.thinMs);
        // Names after the reports: a name for a boat first heard in this segment needs the boat.
        const out = kept.concat(names).map((r) => JSON.stringify(r));
        const tmp = `${dst}.${process.pid}.tmp`;
        const fh = await fsp.open(tmp, 'w');
        try {
            await fh.writeFile(out.length ? out.join('\n') + '\n' : '');
            await fh.sync();
        } finally {
            await fh.close();
        }
        await fsp.rename(tmp, dst);
        await fsp.rm(src, {force: true});
    }

    async _segments() {
        let names;
        try {
            names = await fsp.readdir(this.dir);
        } catch (e) {
            return [];
        }
        const segs = [];
        for (const name of names) {
            const m = SEGMENT_RE.exec(name);
            if (m) segs.push({name, start: Number(m[1]), thin: !!m[2]});
        }
        // Oldest first, a thin file before a raw one with the same start. Both can exist
        // after a crash between rename and delete, or if the clock jumped backwards into a
        // compacted segment; both are read, and compacting the raw one merges them.
        segs.sort((a, b) => a.start - b.start || (a.thin ? -1 : 1));
        return segs;
    }

    /*
     * Stop timers and write what is buffered, synchronously (called from plugin stop).
     * An async flush may still be in flight; both append whole lines with O_APPEND, so
     * lines may land out of order but are never interleaved, and load tolerates order.
     */
    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        if (!this.buffer.length) return;
        try {
            const now = this.clock();
            const segStart = now - (now % this.segmentMs);
            const fd = fs.openSync(path.join(this.dir, `seg-${segStart}.jsonl`), 'a');
            try {
                fs.writeSync(fd, this.buffer.join('\n') + '\n');
                fs.fdatasyncSync(fd);
            } finally {
                fs.closeSync(fd);
            }
            this.buffer = [];
        } catch (e) {
            this.onError(e);
        }
    }
}

module.exports = {Journal};
