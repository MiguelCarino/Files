'use strict';
/* ─── Compare (spec §11): the pure diff (DOM-free; tests/compare.test.mjs) ───
   A side is a list of rows { group, key, value, … } in display order: the
   fixed file rows first (Type, Size, MIME, signature, hashes), then the
   metadata groups as MetaTool.extract() gave them.

   diffRows(a, b) → [{ key, group, a, b, same, ar, br }]
   - the union of both sides' rows, matched on group + key (a key that
     repeats inside one group, two "Note" rows, is matched by occurrence);
   - stable order: groups in the order first seen (A's, then any only B
     has), and inside a group A's rows, then the rows only B has;
   - a row missing on one side has null there, and is never the same;
   - ar / br: the input rows themselves (or null), for whatever else the
     page keeps on them (a translation template, a pending flag).
   countDiffs(rows): how many are not the same.
   compareCsv(rows, names?): group, field, A, B, same; every cell through
   csvCell (js/lib/csv.js), so a value from the file cannot run as a formula.
   names: { a, b }, the two file names, for the A and B column heads. */

function diffRows(aRows, bRows){
  const id = (r, n) => String(r.group) + '\u0000' + String(r.key) + '\u0000' + n;
  const index = (rows) => {
    const seen = new Map(), out = [];
    (rows || []).forEach(r => {
      if(!r) return;
      const base = String(r.group) + '\u0000' + String(r.key);
      const n = seen.get(base) || 0;
      seen.set(base, n + 1);
      out.push({ id: id(r, n), r });
    });
    return out;
  };
  const A = index(aRows), B = index(bRows);
  const bById = new Map(B.map(x => [x.id, x.r]));
  const aIds = new Set(A.map(x => x.id));
  // Group order: A's first, then the groups only B has.
  const groups = [];
  const byGroup = new Map();
  const slot = (g) => {
    if(!byGroup.has(g)){ byGroup.set(g, []); groups.push(g); }
    return byGroup.get(g);
  };
  A.forEach(x => slot(String(x.r.group)).push({ ar: x.r, br: bById.has(x.id) ? bById.get(x.id) : null }));
  B.forEach(x => { if(!aIds.has(x.id)) slot(String(x.r.group)).push({ ar: null, br: x.r }); });
  const val = (r) => r == null ? null : (r.value == null ? '' : String(r.value));
  const out = [];
  groups.forEach(g => byGroup.get(g).forEach(p => {
    const r = p.ar || p.br;
    const a = val(p.ar), b = val(p.br);
    out.push({ key: String(r.key), group: g, a, b, same: a !== null && b !== null && a === b, ar: p.ar, br: p.br });
  }));
  return out;
}

function countDiffs(rows){
  return (rows || []).filter(r => r && !r.same).length;
}

function compareCsv(rows, names){
  const ha = names && names.a ? 'A: ' + names.a : 'A';
  const hb = names && names.b ? 'B: ' + names.b : 'B';
  const lines = [['group', 'field', ha, hb, 'same'].map(csvCell).join(',')];
  (rows || []).forEach(r => {
    if(!r) return;
    lines.push([r.group, r.key, r.a == null ? '' : r.a, r.b == null ? '' : r.b, r.same ? 'yes' : 'no'].map(csvCell).join(','));
  });
  return lines.join('\n');
}
