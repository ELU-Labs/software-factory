'use strict';
// Makes `node --test factory/test/` work on Node 22: that runner treats a bare
// directory argument as a module and loads this file. It then imports every
// *.test.mjs suite here into one test process. When the runner finds this file
// by its own default patterns (for example `cd factory && node --test`),
// argv[1] is this file rather than the directory, so it does nothing and the
// suites are not run twice. CommonJS on purpose: a directory resolves to
// index.js, never index.mjs.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

if (path.resolve(process.argv[1] || '') === __dirname) {
  (async () => {
    const suites = fs
      .readdirSync(__dirname)
      .filter((name) => name.endsWith('.test.mjs'))
      .sort();
    for (const name of suites) {
      await import(pathToFileURL(path.join(__dirname, name)).href);
    }
  })().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
