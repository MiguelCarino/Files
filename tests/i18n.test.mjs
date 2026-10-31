// Every UI string exists in es, pt-BR, ja and ru:
//   - leaf [data-i18n] text and [data-i18n-html] markup in index.html
//   - ATTR_I18N and DYNAMIC_DEFAULTS keys in i18n.js
//   - detection labels and advisory keys in js/lib/detect.js
//   - advisory keys (key: '…' with a space) anywhere in js/
//   - every T('…') / t('…') string literal in js/**/*.js, and the runtime
//     label keys: fmtT('…'), setText(el, '…'), setState('…'), { t: '…' }
//     and data-tk="…" (keys with no words of their own are skipped)
// and no [data-i18n] element has element children (i18n.js replaces its text).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, read } from './load.mjs';

const LOCALES = ['es', 'pt-BR', 'ja', 'ru'];
// Brand names, formats and symbols that read the same in every language.
const ALLOW = new Set(['SHA-256', 'PNG', 'JPEG', 'WebP', 'PDF', 'H.264', 'H.265', 'AV1', 'VP9', 'AAC 192k',
  'English', 'Español', 'Português', 'English + Español', 'English + Português', 'Español + Português',
  '1080p', '720p', '480p', '1×', '2×', '4×', '↓ PNG', '↓ ZIP', '+', '↩', '‹', '›', '✕', 'Carino Files — Metadata']);

const ctx = vm.createContext({ window: { addEventListener() {} }, document: { documentElement: {} } });
vm.runInContext(read('i18n.js') + '\n;this.__I = I18N; this.__A = ATTR_I18N; this.__D = DYNAMIC_DEFAULTS;', ctx, { filename: 'i18n.js' });
const I18N = ctx.__I;
const html = read('index.html');
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

const need = new Map();   // key → where it was found
const add = (k, where) => {
  if (k == null) return;
  k = String(k);
  if (!k.trim() || ALLOW.has(k) || need.has(k)) return;
  // A key with no words of its own ('{fmt} {w}×{h} · {size}') only arranges
  // its vars, which are translated keys themselves or language-neutral.
  if (!/\p{L}/u.test(k.replace(/\{\w+\}/g, ''))) return;
  need.set(k, where);
};

const nonLeaf = [];
for (const m of html.matchAll(/<([a-z0-9]+)\b([^>]*?)\sdata-i18n(\s[^>]*)?>/gi)) {
  const tag = m[1];
  const start = m.index + m[0].length;
  const inner = html.slice(start, html.indexOf('</' + tag + '>', start));
  if (/</.test(inner)) { nonLeaf.push('<' + tag + '>: ' + inner.slice(0, 60)); continue; }
  add(decode(inner.trim()), 'index.html data-i18n');
}
for (const m of html.matchAll(/<([a-z0-9]+)\b[^>]*\sdata-i18n-html\b[^>]*>([\s\S]*?)<\/\1>/gi))
  add(m[2].trim().replace(/\s+/g, ' '), 'index.html data-i18n-html');
ctx.__A.forEach(([, , k]) => add(k, 'ATTR_I18N'));
ctx.__D.forEach(([, k]) => add(k, 'DYNAMIC_DEFAULTS'));

const jsFiles = [];
(function walk(d) {
  for (const f of readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p); else if (f.name.endsWith('.js')) jsFiles.push(p);
  }
})(path.join(ROOT, 'js'));
const lit = String.raw`'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"`;
const unq = (m, i) => (m[i] != null ? m[i] : m[i + 1]).replace(/\\(['"\\])/g, '$1');
for (const p of jsFiles) {
  const rel = path.relative(ROOT, p);
  const s = read(rel);
  for (const m of s.matchAll(new RegExp(String.raw`(?<![\w.$])[Tt]\(\s*(?:${lit})\s*[),]`, 'g'))) add(unq(m, 1), rel + ' T()');
  // Runtime labels (js/core.js): fmtT(key, …), setText(el, key, …) and the
  // OCR badge's setState(key, …); a translatable var { t: key }; and the
  // data-tk="key" a rendered card carries for the language switch.
  for (const m of s.matchAll(new RegExp(String.raw`\b(?:fmtT|setState)\(\s*(?:${lit})\s*[),]`, 'g'))) add(unq(m, 1), rel + ' fmtT()');
  for (const m of s.matchAll(new RegExp(String.raw`\bsetText\(\s*(?:[^,()]|\([^()]*\))+,\s*(?:${lit})\s*[),]`, 'g'))) add(unq(m, 1), rel + ' setText()');
  for (const m of s.matchAll(new RegExp(String.raw`[{,]\s*t:\s*(?:${lit})`, 'g'))) add(unq(m, 1), rel + ' { t: key }');
  for (const m of s.matchAll(/\bdata-tk="([^"$]*)"/g)) add(m[1], rel + ' data-tk');
  // key: '…' with a space is an advisory sentence; one word is a row's field id.
  for (const m of s.matchAll(new RegExp(String.raw`\bkey:\s*(?:${lit})`, 'g'))) { const k = unq(m, 1); if (/\s/.test(k)) add(k, rel + ' advisory key'); }
  for (const m of s.matchAll(new RegExp(String.raw`renderReco\([^;]*?,\s*(?:${lit})\s*\)`, 'g'))) add(unq(m, 1), rel + ' reco label');
  if (rel === path.join('js', 'lib', 'detect.js')) {
    for (const m of s.matchAll(new RegExp(String.raw`\bmk\(\s*(?:${lit})\s*,\s*(?:${lit})`, 'g'))) add(unq(m, 3), rel + ' label');
    for (const m of s.matchAll(new RegExp(String.raw`\b[A-Z0-9]+_ADV\s*=\s*(?:${lit})`, 'g'))) add(unq(m, 1), rel + ' advisory');
    const office = s.match(/const office = (\{[^}]*\})/);
    assert.ok(office, 'detect.js: office label table not found');
    Object.values(vm.runInNewContext('(' + office[1] + ')')).forEach((v) => add(v, rel + ' office label'));
  }
}

test('the checker found the strings it should', () => {
  assert.ok(need.size > 200, need.size + ' strings');
  assert.ok(need.has('Inspect / edit metadata'));
  assert.ok(need.has('DICOM medical image'));
});

for (const L of LOCALES) {
  test('every UI string has a ' + L + ' translation', () => {
    assert.ok(I18N[L], 'no ' + L + ' table');
    const missing = [...need].filter(([k]) => !Object.prototype.hasOwnProperty.call(I18N[L], k)).map(([k, where]) => where + ': ' + JSON.stringify(k));
    assert.deepEqual(missing, []);
  });
}

test('no [data-i18n] element has element children', () => {
  assert.deepEqual(nonLeaf, []);
});
