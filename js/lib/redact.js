'use strict';
/* ─── Redact: the geometry and the word search (spec §12.4, F-5) ───
   DOM-free, so it is unit-tested in node (tests/redact.test.mjs). The Redact
   mode (js/ws/redact.js) keeps its boxes as { x, y, w, h } in image pixels
   (the picture as the browser shows it, EXIF orientation applied) and only
   converts at the edges: pointer positions in, OCR word boxes in, fillRect
   on the full-resolution canvas out.

   normRect(x0, y0, x1, y1)      a drag from either corner → { x, y, w, h }, w/h ≥ 0
   clampRect(r, w, h)            r cut to the image (0..w × 0..h); w/h 0 when outside
   toImageRect(r, dW, dH, iW, iH) a rect in displayed (CSS) pixels → image pixels
   padRect(r, p, w, h)           r grown by p on every side, then clamped
   redactWordsOf(data)           a Tesseract result → words, each with its line index
   matchWords(words, query)      the boxes of every match of query (see below)
   redactOutType(mime)           the output { mime, ext, quality } (spec §12.3)
   redactClean(bytes, mime)      the output re-checked for EXIF / XMP (js/lib/scrub.js) */

function normRect(x0, y0, x1, y1){
  x0 = +x0 || 0; y0 = +y0 || 0; x1 = +x1 || 0; y1 = +y1 || 0;
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

function clampRect(r, w, h){
  const x0 = Math.max(0, Math.min(w, r.x)), y0 = Math.max(0, Math.min(h, r.y));
  const x1 = Math.max(0, Math.min(w, r.x + r.w)), y1 = Math.max(0, Math.min(h, r.y + r.h));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

function toImageRect(r, displayW, displayH, imgW, imgH){
  const sx = displayW > 0 ? imgW / displayW : 1, sy = displayH > 0 ? imgH / displayH : 1;
  return { x: r.x * sx, y: r.y * sy, w: r.w * sx, h: r.h * sy };
}

function padRect(r, p, w, h){
  p = +p || 0;
  return clampRect({ x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p }, w, h);
}

/* Tesseract.js v6+ returns its words inside blocks → paragraphs → lines;
   flattened here with the index of the line each came from, so a phrase is
   only matched across words that really sit on one line. A result that
   already has a flat words list (older versions) keeps it as is: matchWords
   then judges lines from the boxes. */
function redactWordsOf(data){
  if(!data) return [];
  const out = [];
  let line = 0;
  for(const b of data.blocks || [])
    for(const p of b.paragraphs || [])
      for(const l of p.lines || []){
        for(const w of l.words || []) if(w && w.bbox) out.push({ text: w.text, bbox: w.bbox, line });
        line++;
      }
  if(!out.length && Array.isArray(data.words)) return data.words.filter(w => w && w.bbox);
  return out;
}

/* Matching. Case- and diacritic-insensitive (NFD, combining marks dropped),
   and blind to punctuation, so "jose" finds "José," and "smith" finds
   "Smith.". One word in the query: every OCR word that contains it (a
   redaction errs on the side of covering the whole word). Several: runs of
   consecutive words on one line whose first word ends with the first query
   word, whose middle words equal the middle ones and whose last word starts
   with the last one; the run's boxes merge into one. Returns { x, y, w, h }
   in image pixels, each box once. */
function _redactFold(s){
  return String(s == null ? '' : s).normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}
function _redactSameLine(a, b){
  if(a.line != null && b.line != null) return a.line === b.line;
  const A = a.bbox, B = b.bbox;
  const overlap = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0);
  const shorter = Math.min(A.y1 - A.y0, B.y1 - B.y0);
  return shorter > 0 && overlap >= shorter / 2 && B.x0 >= A.x0;
}
function matchWords(words, query){
  const q = String(query == null ? '' : query).split(/\s+/).map(_redactFold).filter(Boolean);
  if(!q.length || !Array.isArray(words)) return [];
  const list = words.filter(w => w && w.bbox).map(w => ({ w, f: _redactFold(w.text) })).filter(x => x.f);
  const out = [], seen = new Set();
  const push = (run) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for(const { w } of run){
      x0 = Math.min(x0, w.bbox.x0); y0 = Math.min(y0, w.bbox.y0);
      x1 = Math.max(x1, w.bbox.x1); y1 = Math.max(y1, w.bbox.y1);
    }
    const r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    const k = [r.x, r.y, r.w, r.h].join(',');
    if(r.w > 0 && r.h > 0 && !seen.has(k)){ seen.add(k); out.push(r); }
  };
  for(let i = 0; i < list.length; i++){
    if(q.length === 1){
      if(list[i].f.includes(q[0])) push([list[i]]);
      continue;
    }
    if(i + q.length > list.length) break;
    const run = list.slice(i, i + q.length);
    let ok = run[0].f.endsWith(q[0]) && run[run.length - 1].f.startsWith(q[q.length - 1]);
    for(let j = 1; ok && j < q.length - 1; j++) ok = run[j].f === q[j];
    for(let j = 1; ok && j < run.length; j++) ok = _redactSameLine(run[j - 1].w, run[j].w);
    if(ok) push(run);
  }
  return out;
}

/* JPEG stays JPEG (q 0.92), PNG and WebP stay; HEIC, AVIF and everything
   else become PNG, which every browser's canvas can write. */
function redactOutType(mime){
  const m = String(mime || '').toLowerCase();
  if(m === 'image/jpeg' || m === 'image/jpg' || m === 'image/pjpeg') return { mime: 'image/jpeg', ext: 'jpg', quality: 0.92 };
  if(m === 'image/webp') return { mime: 'image/webp', ext: 'webp', quality: 0.92 };
  return { mime: 'image/png', ext: 'png', quality: undefined };
}

/* The re-check before download: a canvas re-encode carries no metadata, and
   this proves it on the bytes. found lists what the strip found (EXIF, XMP,
   anything else it drops); bytes is the output with it gone, so even an
   encoder that wrote some never hands it on. */
function redactClean(bytes, mime){
  const strip = mime === 'image/jpeg' ? jpegStrip : mime === 'image/png' ? pngStrip : mime === 'image/webp' ? webpStrip : null;
  if(!strip) return { bytes, found: [] };
  const r = strip(bytes);
  return { bytes: r.bytes, found: r.removed.slice() };
}
