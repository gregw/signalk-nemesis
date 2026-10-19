'use strict';
/*
 * Temp dirs for tests, removed when the process exits (node --test runs each
 * file in its own process, so a file's dirs go when it finishes).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dirs = [];
process.once('exit', () => {
    for (const d of dirs) fs.rmSync(d, {recursive: true, force: true});
});

function tmpdir(prefix = 'nemesis-') {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(d);
    return d;
}

module.exports = {tmpdir};
