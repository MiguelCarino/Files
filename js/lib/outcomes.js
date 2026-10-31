'use strict';
/* ─── outcome cards: rank, cap and More (DOM-free; tests/outcomes.test.mjs) ───
   An outcome entry is { id, icon, title, desc, run, rank?, more?, pin?, order }.
   - rank 0–100, higher first; missing, it is 100 - order/10 (order: the
     workspace's registry order, which FilesApp.outcomes copies onto each card).
   - more: true sends the card behind the More tile whatever its rank.
   - pin: 'last' keeps the card as the last visible one (Inspect / edit
     metadata), inside the cap. */

function outcomeRank(o){
  const r = o && typeof o.rank === 'number' && isFinite(o.rank) ? o.rank : 100 - ((o && o.order) || 0) / 10;
  return r;
}

// A new array: rank (descending), then order, then the order given (stable).
function rankOutcomes(list){
  return (list || []).map((o, i) => ({ o, i }))
    .sort((a, b) => (outcomeRank(b.o) - outcomeRank(a.o))
      || (((a.o && a.o.order) || 0) - ((b.o && b.o.order) || 0))
      || (a.i - b.i))
    .map(x => x.o);
}

/* list: already ranked. cap: how many cards show (the pinned one included).
   → { visible, more }: visible in display order (the pin last), more in list
   order. more is empty when nothing overflows, so no More tile is drawn. */
function layoutOutcomes(list, cap){
  list = (list || []).filter(Boolean);
  cap = Math.max(0, cap | 0);
  const pinned = list.filter(o => o.pin === 'last' && !o.more);
  const rest = list.filter(o => !pinned.includes(o));
  const normal = rest.filter(o => !o.more);
  const pins = pinned.slice(0, cap);
  const slots = Math.max(0, cap - pins.length);
  const shown = new Set(normal.slice(0, slots).concat(pins));
  const visible = normal.slice(0, slots).concat(pins);
  const more = list.filter(o => !shown.has(o));
  return { visible, more };
}
