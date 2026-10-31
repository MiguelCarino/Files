'use strict';
/* ─── the batch tray: pure helpers (DOM-free; tests/tray.test.mjs) ───
   A set (spec §9) is [{ file, info }], info null until the row is detected
   (sniffFile, js/sniff.js). Here: the kind badge a file shows (the same on
   the rail chip and every tray row), the set's one-line summary, and the
   metadata export of the whole set (one CSV row or JSON object per file). */

// The kind code and its ct-cat-* colour, as #auto-ico shows them. info null:
// not detected yet ('…').
const KIND_CODES = { pdf: 'PDF', image: 'IMG', heic: 'HEIC', audio: 'AUD', video: 'VID', dicom: 'DCM' };
const KIND_CATS = { pdf: 'purple', image: 'pink', heic: 'pink', audio: 'amber', video: 'teal', dicom: 'blue' };
function kindBadge(info){
  if(!info) return { code: '…', cat: 'grey' };
  return { code: KIND_CODES[info.kind] || 'BIN', cat: KIND_CATS[info.kind] || 'grey' };
}

/* items: [{ file, info }] → { n, size, mix }. mix is the count per kind code,
   in a fixed order ("3 PDF", "4 IMG", "1 …" while rows are still being
   detected): codes, not words, so it reads the same in every language and
   matches the badges on the rows. size is in bytes. */
const SET_MIX_ORDER = ['PDF', 'IMG', 'HEIC', 'AUD', 'VID', 'DCM', 'BIN', '…'];
function setSummary(items){
  items = items || [];
  const counts = new Map();
  let size = 0;
  for(const it of items){
    if(!it) continue;
    size += (it.file && +it.file.size) || 0;
    const code = kindBadge(it.info).code;
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  const mix = SET_MIX_ORDER.filter(c => counts.has(c)).map(c => counts.get(c) + ' ' + c);
  return { n: items.filter(Boolean).length, size, mix };
}

/* MetaTool groups → [{ group, key, value }]. The File group's rows that the
   export already has as columns (name, size, type, MIME) and the SHA-256 row
   (not computed for a set) are left out. */
const SET_FILE_COVERED = ['Name', 'Size', 'Detected type', 'MIME (guess)', 'SHA-256'];
function flattenMeta(groups){
  const out = [];
  (groups || []).forEach(g => (g && g.rows || []).forEach(r => {
    if(!r) return;
    if(g.name === 'File' && SET_FILE_COVERED.includes(r.k)) return;
    if(r.key === '__sha') return;
    out.push({ group: String(g.name), key: String(r.k), value: r.v == null ? '' : String(r.v) });
  }));
  return out;
}

// One column per "Group: Key", in the order first seen across the rows.
const metaColumn = (m) => m.group + ': ' + m.key;
function unionColumns(rows){
  const seen = new Set(), cols = [];
  (rows || []).forEach(r => (r && r.meta || []).forEach(m => {
    const c = metaColumn(m);
    if(!seen.has(c)){ seen.add(c); cols.push(c); }
  }));
  return cols;
}

/* rows: [{ file, type, size, mime, meta: [{ group, key, value }] }] → CSV text:
   file, type, size, MIME, then the union of the metadata columns. A key that
   repeats within one file (two "Note" rows) keeps every value, joined with
   "; ". Every cell goes through csvCell (js/lib/csv.js). */
function rowsToCsv(rows){
  rows = rows || [];
  const cols = unionColumns(rows);
  const head = ['file', 'type', 'size', 'MIME'].concat(cols);
  const lines = [head.map(csvCell).join(',')];
  rows.forEach(r => {
    const vals = new Map();
    (r.meta || []).forEach(m => {
      const c = metaColumn(m);
      vals.set(c, vals.has(c) ? vals.get(c) + '; ' + m.value : m.value);
    });
    lines.push([r.file, r.type, r.size, r.mime].concat(cols.map(c => vals.has(c) ? vals.get(c) : ''))
      .map(csvCell).join(','));
  });
  return lines.join('\n');
}

/* The JSON export: [{ file, type, size, metadata: { group: { key: value } } }],
   the single-file export's "extracted" shape, per file. A repeated key keeps
   every value, as in the CSV. */
function rowsToJson(rows){
  return (rows || []).map(r => {
    const metadata = {};
    (r.meta || []).forEach(m => {
      const g = metadata[m.group] || (metadata[m.group] = {});
      g[m.key] = Object.prototype.hasOwnProperty.call(g, m.key) ? g[m.key] + '; ' + m.value : m.value;
    });
    return { file: r.file, type: r.type, size: r.size, metadata };
  });
}

/* The same file dropped twice (same name, size and date) joins the set once. */
function sameFile(a, b){
  if(a === b) return true;
  return !!a && !!b && a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
}
