'use strict';
/* ─── OCR → searchable PDF: the geometry (spec §7.3, F-2) ───
   DOM-free and pdf-lib-free, so it is unit-tested in node
   (tests/ocrpdf.test.mjs). js/ws/ocr.js turns what comes back into pdf-lib
   operators: an image drawn full page, then one invisible (text render
   mode 3) word per op on top of it, so the page reads as the picture and
   selects, searches and copies as text.

   Coordinates. Tesseract gives word boxes in image pixels with y growing
   down; PDF user space has y growing up from the bottom-left corner. A page
   of pageW × pageH points carries an image of imgW × imgH pixels stretched
   over the whole page, so a pixel maps to (pageW / imgW, pageH / imgH)
   points and y flips around the page height.

   Page size for an image: 1 pixel = 1 point (the spec's "the image's pixel
   size"), clamped to the PDF limit of 14400 points a side with the aspect
   kept. A PDF page keeps its own size; its render is just more pixels over
   the same points.

   Text. The invisible layer uses the standard Helvetica (WinAnsi encoding),
   so nothing is embedded: a character WinAnsi cannot hold is written as '?'
   in the invisible layer only. The picture is untouched, so what is seen
   is always right; only search and copy see the '?'. */

const OCRPDF_MAX_PT = 14400;

// An image's page in points: 1 px = 1 pt, scaled down to fit 14400 pt.
function ocrImagePageSize(pxW, pxH){
  pxW = Math.max(1, +pxW || 0); pxH = Math.max(1, +pxH || 0);
  const k = Math.min(1, OCRPDF_MAX_PT / Math.max(pxW, pxH));
  return { w: pxW * k, h: pxH * k };
}

// The pixel size a page of wPt × hPt points renders to at dpi.
function ocrRenderPx(wPt, hPt, dpi){
  const s = (+dpi || 72) / 72;
  // Less a hair before rounding up: 792 × 300 / 72 is 3300.0000000000005.
  return { w: Math.max(1, Math.ceil(wPt * s - 1e-6)), h: Math.max(1, Math.ceil(hPt * s - 1e-6)) };
}

/* The words of a Tesseract result, flat. Tesseract.js v6+ only returns them
   inside blocks → paragraphs → lines → words (the worker must be asked for
   { blocks: true }); older versions also had data.words. Either way each
   word is { text, bbox: { x0, y0, x1, y1 } }. */
function ocrWordsOf(data){
  if(!data) return [];
  if(Array.isArray(data.words) && data.words.length) return data.words;
  const out = [];
  for(const b of data.blocks || [])
    for(const p of b.paragraphs || [])
      for(const l of p.lines || [])
        for(const w of l.words || []) out.push(w);
  return out;
}

// WinAnsi (the standard fonts' encoding): printable ASCII, Latin-1 and the
// 0x80–0x9F extras. Anything else becomes '?'; control characters go.
const OCRPDF_WINANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
function ocrPdfSafeText(text){
  let out = '';
  for(const ch of String(text == null ? '' : text)){
    const c = ch.codePointAt(0);
    if((c >= 0x20 && c <= 0x7E) || (c >= 0xA0 && c <= 0xFF) || OCRPDF_WINANSI_EXTRA.includes(ch)) out += ch;
    else if(c < 0x20 || c === 0x7F) continue;
    else out += '?';
  }
  return out;
}

/* Word boxes → text-drawing ops in PDF space:
     [{ text, x, y, size, hScale }]
   x, y   the baseline start, in points from the bottom-left. The baseline is
          put at the bottom of the box: invisible text only has to land on
          the word for selection and search, not match its descenders.
   size   the font size, the box height in points.
   hScale horizontal scaling in percent (PDF Tz), so the word spans exactly
          the box width. measure(text, size) gives the text's natural width
          in points (pdf-lib font.widthOfTextAtSize); without it, 100.
   Words with no text or a box of no area are skipped. */
function wordsToPdfOps(words, imgW, imgH, pageW, pageH, measure){
  const out = [];
  if(!Array.isArray(words) || !(imgW > 0) || !(imgH > 0)) return out;
  const sx = pageW / imgW, sy = pageH / imgH;
  for(const w of words){
    if(!w || !w.bbox) continue;
    const text = ocrPdfSafeText(String(w.text || '').trim());
    if(!text) continue;
    const { x0, y0, x1, y1 } = w.bbox;
    const bw = (x1 - x0) * sx, bh = (y1 - y0) * sy;
    if(!(bw > 0) || !(bh > 0)) continue;
    const size = bh;
    let hScale = 100;
    if(typeof measure === 'function'){
      const natural = +measure(text, size);
      if(natural > 0) hScale = bw / natural * 100;
    }
    out.push({ text, x: x0 * sx, y: pageH - y1 * sy, size, hScale });
  }
  return out;
}
