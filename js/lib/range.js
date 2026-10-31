'use strict';
/* ─── page ranges ("1, 3-5", empty = all) ───
   DOM-free, so node tests can load it. Returns the sorted, de-duplicated
   1-based page numbers within 1..max; malformed chunks are skipped. */
function parsePageRange(str, max){
  if(!str.trim()) return Array.from({length: max}, (_, i) => i + 1);
  const out = new Set();
  str.split(',').forEach(chunk => {
    chunk = chunk.trim();
    if(!chunk) return;
    if(chunk.includes('-')){
      const [a, b] = chunk.split('-').map(n => parseInt(n, 10));
      if(isNaN(a) || isNaN(b)) return;
      for(let i = Math.max(1, Math.min(a, b)); i <= Math.min(max, Math.max(a, b)); i++) out.add(i);
    } else {
      const n = parseInt(chunk, 10);
      if(n >= 1 && n <= max) out.add(n);
    }
  });
  return Array.from(out).sort((a, b) => a - b);
}
