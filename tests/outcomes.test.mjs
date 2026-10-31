// js/lib/outcomes.js: outcome card ranking and the visible cap with More.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib, need } from './load.mjs';

const ids = (list) => list.map((o) => o.id);
const card = (id, rank, extra) => Object.assign({ id, rank }, extra);

test('rankOutcomes: rank descending, then order, then as given', need('rankOutcomes'), () => {
  const { rankOutcomes } = lib;
  const list = [card('a', 50, { order: 10 }), card('b', 80, { order: 850 }), card('c', 50, { order: 5 }), card('d', 50, { order: 5 })];
  assert.deepEqual(ids(rankOutcomes(list)), ['b', 'c', 'd', 'a']);
  assert.deepEqual(ids(list), ['a', 'b', 'c', 'd'], 'the input is not reordered');
});

test('rankOutcomes: a missing rank is 100 - order/10', need('rankOutcomes', 'outcomeRank'), () => {
  const { rankOutcomes, outcomeRank } = lib;
  assert.equal(outcomeRank({ order: 900 }), 10);
  assert.equal(outcomeRank({}), 100);
  assert.equal(outcomeRank({ rank: 0, order: 10 }), 0, 'rank 0 is a rank');
  const list = [{ id: 'meta', order: 900 }, { id: 'sig', order: 10, rank: 50 }, { id: 'x', order: 100 }];
  assert.deepEqual(ids(rankOutcomes(list)), ['x', 'sig', 'meta']);
  assert.deepEqual(rankOutcomes(undefined), []);
});

test('layoutOutcomes: nothing overflows, no More', need('layoutOutcomes'), () => {
  const { layoutOutcomes } = lib;
  const r = layoutOutcomes([card('a', 90), card('b', 80), card('m', 10, { pin: 'last' })], 4);
  assert.deepEqual(ids(r.visible), ['a', 'b', 'm']);
  assert.deepEqual(r.more, []);
  assert.deepEqual(layoutOutcomes([], 4), { visible: [], more: [] });
});

test('layoutOutcomes: the cap includes the pinned card, which stays last', need('layoutOutcomes'), () => {
  const { layoutOutcomes } = lib;
  const list = [card('m', 10, { pin: 'last' }), card('a', 95), card('b', 80), card('c', 70), card('d', 50)];
  const r4 = layoutOutcomes(list, 4);
  assert.deepEqual(ids(r4.visible), ['a', 'b', 'c', 'm']);
  assert.deepEqual(ids(r4.more), ['d']);
  const r3 = layoutOutcomes(list, 3);
  assert.deepEqual(ids(r3.visible), ['a', 'b', 'm']);
  assert.deepEqual(ids(r3.more), ['c', 'd']);
});

test('layoutOutcomes: exactly cap cards fit with no More', need('layoutOutcomes'), () => {
  const { layoutOutcomes } = lib;
  const r = layoutOutcomes([card('a', 90), card('b', 80), card('c', 70), card('m', 10, { pin: 'last' })], 4);
  assert.deepEqual(ids(r.visible), ['a', 'b', 'c', 'm']);
  assert.deepEqual(r.more, []);
});

test('layoutOutcomes: more: true always goes behind More, whatever its rank', need('layoutOutcomes'), () => {
  const { layoutOutcomes } = lib;
  const list = [card('gps', 99, { more: true }), card('a', 80), card('m', 10, { pin: 'last' }), card('cmp', 5, { more: true })];
  const r = layoutOutcomes(list, 4);
  assert.deepEqual(ids(r.visible), ['a', 'm']);
  assert.deepEqual(ids(r.more), ['gps', 'cmp'], 'More keeps the ranked order');
});

test('layoutOutcomes: overflow and more: true share the More list in ranked order', need('layoutOutcomes'), () => {
  const { layoutOutcomes } = lib;
  const list = [card('a', 90), card('x', 85, { more: true }), card('b', 80), card('c', 70), card('m', 10, { pin: 'last' })];
  const r = layoutOutcomes(list, 3);
  assert.deepEqual(ids(r.visible), ['a', 'b', 'm']);
  assert.deepEqual(ids(r.more), ['x', 'c']);
});

test('layoutOutcomes: a pin marked more is not pinned; cap 0 and cap 1', need('layoutOutcomes'), () => {
  const { layoutOutcomes } = lib;
  const r = layoutOutcomes([card('a', 90), card('m', 10, { pin: 'last', more: true })], 4);
  assert.deepEqual(ids(r.visible), ['a']);
  assert.deepEqual(ids(r.more), ['m']);
  const one = layoutOutcomes([card('a', 90), card('m', 10, { pin: 'last' })], 1);
  assert.deepEqual(ids(one.visible), ['m']);
  assert.deepEqual(ids(one.more), ['a']);
  const zero = layoutOutcomes([card('a', 90)], 0);
  assert.deepEqual(zero.visible, []);
  assert.deepEqual(ids(zero.more), ['a']);
});

test('layoutOutcomes: no pinned card fills every slot with ranked cards', need('layoutOutcomes'), () => {
  const { layoutOutcomes } = lib;
  const r = layoutOutcomes([card('a', 90), card('b', 80), card('c', 70), card('d', 60), card('e', 50)], 4);
  assert.deepEqual(ids(r.visible), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids(r.more), ['e']);
});
