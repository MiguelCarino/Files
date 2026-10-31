// index.html's script wiring: the classic scripts share one global scope, so
// a name declared twice breaks the page; the order matters; vendor libraries
// load on demand only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, read, classicScripts } from './load.mjs';

const html = read('index.html');
const app = classicScripts(html);
const withI18n = app.includes('i18n.js') ? app : app.concat('i18n.js');

test('every classic script exists', () => {
  assert.ok(app.length > 10, app.join(', '));
  for (const s of withI18n) assert.ok(existsSync(path.join(ROOT, s)), s);
});

test('the app scripts + i18n.js compile as one script (no duplicate top-level names)', () => {
  let text = '';
  for (const s of withI18n) text += '\n;// ---- ' + s + '\n' + read(s);
  assert.doesNotThrow(() => new vm.Script(text, { filename: 'concat.js' }));
});

test('no lazily loaded vendor library redeclares an app name', () => {
  const core = read('js/core.js');
  const m = core.match(/const VENDOR = (\{[\s\S]*?\});/);
  assert.ok(m, 'js/core.js: VENDOR table not found');
  const vendor = Object.values(vm.runInNewContext('(' + m[1] + ')'));
  assert.ok(vendor.length >= 1);
  const clashes = [];
  for (const v of vendor) {
    assert.ok(existsSync(path.join(ROOT, v)), 'missing ' + v);
    const ctx = vm.createContext({});
    vm.runInContext('var window = this, self = this;', ctx);
    // No DOM here: runtime errors are expected and ignored; only a
    // SyntaxError (a redeclaration) counts.
    for (const s of withI18n) {
      try { vm.runInContext(read(s), ctx, { filename: s }); }
      catch (e) { if (e.name === 'SyntaxError') clashes.push(s + ': ' + e.message); }
    }
    try { vm.runInContext(read(v), ctx, { filename: v }); }
    catch (e) { if (e.name === 'SyntaxError') clashes.push(v + ': ' + e.message); }
  }
  assert.deepEqual(clashes, []);
});

test('no vendor <script> tag: vendor code loads on demand', () => {
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc="vendor\//);
});

test('js/file-screen.js after every workspace, before js/expose.js (last)', () => {
  const fs = app.indexOf('js/file-screen.js');
  const ex = app.indexOf('js/expose.js');
  const ws = app.filter((s) => s.startsWith('js/ws/'));
  assert.ok(fs >= 0 && ex >= 0, 'both present');
  assert.ok(ws.length >= 1, 'workspace scripts');
  for (const w of ws) assert.ok(app.indexOf(w) < fs, w + ' must come before js/file-screen.js');
  assert.ok(fs < ex, 'file-screen before expose');
  assert.equal(app[app.length - 1], 'js/expose.js', 'expose.js is the last classic script');
  for (const l of app.filter((s) => s.startsWith('js/lib/'))) assert.ok(app.indexOf(l) < app.indexOf(ws[0]), l + ' before the workspaces');
});

test('no inline event handler attributes', () => {
  assert.deepEqual(html.match(/\son(click|input|change|submit|load|error)=/gi) || [], []);
});

test('every carino-* file index.html references exists', () => {
  const refs = [...html.matchAll(/(?:src|href)="((?:[^"/]*\/)*carino-[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  assert.ok(refs.some((r) => r === 'carino-navbar.js'));
  for (const r of refs) assert.ok(existsSync(path.join(ROOT, r)), r);
});

test('the hash worker imports a lib file that exists', () => {
  const w = read('js/hash-worker.js');
  const imports = [...w.matchAll(/importScripts\(\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(imports.length >= 1);
  for (const i of imports) assert.ok(existsSync(path.join(ROOT, 'js', i)), i);
});
