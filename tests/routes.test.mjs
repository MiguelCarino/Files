// js/lib/routes.js: the hash → route → workspace resolution js/router.js uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib, need } from './load.mjs';

const ROUTES = { file: 'auto', 'file/pages': 'pages', 'file/compare': 'compare', metadata: 'metadata', transcode: 'transcode' };

test('fullRoute: the part before the first &, with the mode path', need('fullRoute'), () => {
  const { fullRoute } = lib;
  assert.equal(fullRoute('#file/pages'), 'file/pages');
  assert.equal(fullRoute('#file/pages&x=1'), 'file/pages');
  assert.equal(fullRoute('#metadata&carino-bridge'), 'metadata');
  assert.equal(fullRoute('file'), 'file');
  assert.equal(fullRoute(''), '');
  assert.equal(fullRoute('#'), '');
  assert.equal(fullRoute(undefined), '');
  assert.equal(fullRoute('#file%2Fpages'), 'file/pages');
  assert.equal(fullRoute('#bad%E0%A4%A'), 'bad%E0%A4%A', 'a malformed escape is read as written');
});

test('resolveRoute: a mode route wins over its module', need('resolveRoute'), () => {
  const { resolveRoute } = lib;
  assert.equal(resolveRoute(ROUTES, 'file', 'pages'), 'pages');
  assert.equal(resolveRoute(ROUTES, 'file', 'compare'), 'compare');
  assert.equal(resolveRoute(ROUTES, 'file', undefined), 'auto');
  assert.equal(resolveRoute(ROUTES, 'metadata', ''), 'metadata');
});

test('resolveRoute: an unknown path falls back to the module, an unknown id to null', need('resolveRoute'), () => {
  const { resolveRoute } = lib;
  assert.equal(resolveRoute(ROUTES, 'file', 'xyz'), 'auto');
  assert.equal(resolveRoute(ROUTES, 'transcode', 'pages'), 'transcode');
  assert.equal(resolveRoute(ROUTES, 'nope', 'pages'), null);
  assert.equal(resolveRoute(ROUTES, null, 'pages'), null);
  assert.equal(resolveRoute(ROUTES, '', undefined), null);
  assert.equal(resolveRoute(null, 'file', 'pages'), null);
});

test('resolveRoute: inherited object keys are not routes', need('resolveRoute'), () => {
  const { resolveRoute } = lib;
  assert.equal(resolveRoute(ROUTES, 'constructor', undefined), null);
  assert.equal(resolveRoute(ROUTES, 'file', '__proto__'), 'auto');
  assert.equal(resolveRoute(ROUTES, 'toString', 'x'), null);
});
