// The suite's command, in CI and the README, names the files:
//   node --test --test-concurrency=1 tests/*.test.mjs
// (the shell expands the glob, so Node 20 and 22 run the same set). This file
// only keeps the older `node --test tests/` working on Node 22, which resolves
// a folder argument to its index.js: it loads every *.test.mjs beside it, one
// after another. tests/smoke/ is the Playwright run, started by
// tests/smoke/run.sh, never by node --test.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.mjs')).sort()) {
    await import(pathToFileURL(path.join(__dirname, f)).href);
  }
})();
