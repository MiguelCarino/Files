'use strict';
/* ─── where a printed document's pages end (the report preview) ───
   DOM-free, so node tests can load it. js/report-preview.js measures the
   report as laid out at the paper's content width and hands its block boxes
   here: { t, b, avoid, kids } with t/b the top and bottom in px from the top
   of the content, avoid for break-inside: avoid (a section, a table row) and
   kids the box's own block children. pageH is one page's content height.

   A box that fits on the current page is left alone. An avoid box that does
   not fit, is no taller than a page and does not already start the page
   moves whole to the next page, which then starts at its top (everything
   after it moves down with it, so measuring on from its top stays right).
   Any other box is looked into; one with no block children (a paragraph)
   breaks at the page's end, as its lines would. It is an estimate of what the
   browser does, close for a report of sections and table rows: the print
   dialog's own preview is the last word.

   Returns the y of each page break, ascending; the page count is length + 1. */
function printPageBreaks(blocks, pageH){
  const breaks = [];
  if(!(pageH > 0)) return breaks;
  let start = 0;
  const EPS = 0.5;
  const walk = (box) => {
    if(!box || !(box.b > box.t)) return;
    if(box.b <= start + pageH + EPS) return;
    const kids = Array.isArray(box.kids) ? box.kids : [];
    if(box.avoid && box.b - box.t <= pageH + EPS && box.t > start + EPS){
      breaks.push(box.t); start = box.t;
      return;
    }
    if(kids.length){
      kids.forEach(walk);
      return;
    }
    if(box.t > start + EPS && box.t >= start + pageH - EPS){ breaks.push(box.t); start = box.t; }
    while(box.b > start + pageH + EPS){ start += pageH; breaks.push(start); }
  };
  (blocks || []).forEach(walk);
  return breaks;
}
