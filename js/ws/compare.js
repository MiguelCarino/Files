'use strict';
/* ════════════════════════════════════════════════════════════════
   COMPARE (#file/compare) — a mode under the File slice (spec §11).
   Two files side by side: what each is (type, size, MIME, signature), its
   SHA-256 (MD5 and SHA-1 on request) and every metadata row the metadata
   workspace reads, with the differences highlighted.

   The rail holds two slots, File A and File B: a compact dropzone each
   until filled, then a .file-chip whose ✕ empties it; ⇄ Swap between them.
   The pane: the verdict (.alert), Differences | All, and a table.data of
   Field | A | B. The diff itself is js/lib/compare.js; the hashes are the
   Verify path (digestOf, js/core.js), so the summary card and this table
   share one computation per file and algorithm; the metadata rows come
   from MetaTool.extract, as the set export reads them.

   Ways in: the set card Compare (exactly 2 files), the single file's
   Compare with… (A is that file; B's dropzone gets focus), a link to
   #file/compare (two empty slots). Done, Esc and Back go to #file.
   ════════════════════════════════════════════════════════════════ */
const CompareTool = (() => {
  const root = $('tool-compare');
  const verdict = $('cmp-verdict'), body = $('cmp-body'), none = $('cmp-none');
  const tbody = $('cmp-table').querySelector('tbody');
  const exportBtn = $('cmp-export-btn'), moreBtn = $('cmp-more-hashes'), swapBtn = $('cmp-swap');
  const SIDES = ['a', 'b'];
  const BASE_ALGOS = ['SHA-256'], EXTRA_ALGOS = ['MD5', 'SHA-1'];
  // The File group rows the fixed rows above already show (js/lib/tray.js
  // drops the same ones from the set export), plus the signature.
  const COVERED = SET_FILE_COVERED.concat(['File signature (hex)']);

  /* A slot: { file, info, sig, hash: { algo: { hex } | { pending } |
     { tooLarge } | { err } }, meta: rows | null }. */
  const slots = { a: null, b: null };
  let extra = false;        // MD5 and SHA-1 asked for
  let rows = [];            // the last diff drawn, for the exports
  const held = (s) => !!s && (slots.a === s || slots.b === s);
  const hex12 = (b) => Array.from(b.subarray(0, 12), x => x.toString(16).padStart(2, '0')).join(' ').toUpperCase();
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if(cls) e.className = cls;
    if(text != null) e.textContent = text;
    return e;
  };

  /* ─── filling a slot ───
     Everything about the file arrives in pieces (detection, head, hashes,
     metadata); each one draws the table again as it lands. A slot emptied
     or replaced meanwhile is simply no longer held, and its pieces drop. */
  async function load(side, file, info){
    if(!file) return;
    const s = { file, info: info || null, sig: null, hash: {}, meta: null };
    slots[side] = s;
    paintSlots();
    render();
    if(!s.info){
      try { s.info = await sniffFile(file); }
      catch(e){ s.info = null; }
      if(!held(s)) return;
      paintSlots();
    }
    try { s.sig = hex12(await headOf(file)); } catch(_){ s.sig = ''; }
    if(!held(s)) return;
    BASE_ALGOS.concat(extra ? EXTRA_ALGOS : []).forEach(a => startHash(s, a));
    render();
    try {
      const c = await MetaTool.extract(file, s.info);
      s.meta = metaRows(c.groups);
    } catch(e){
      s.meta = [{ group: 'Parser', key: 'Note', value: String(e && e.message || e) }];
    }
    if(held(s)) render();
  }
  function startHash(s, algo, retried){
    if(s.hash[algo] && !s.hash[algo].err && !retried) return;
    s.hash[algo] = { pending: true };
    digestOf(s.file, algo).then(hex => { s.hash[algo] = { hex }; },
      e => {
        // A streaming SHA-256 is cancelled when another file lands on the
        // file screen (cancelHashes): ask again, once.
        if(e && e.name === 'AbortError' && !retried && held(s)) return startHash(s, algo, true);
        s.hash[algo] = e && e.code === 'too-large' ? { tooLarge: true } : { err: String(e && e.message || e) };
      }).then(() => { if(held(s)) render(); });
  }
  // MetaTool groups → rows, keeping the template of the app's own messages
  // (rowT) so they show in the page's language; the value compared and
  // exported stays the English one.
  function metaRows(groups){
    const out = [];
    (groups || []).forEach(g => (g && g.rows || []).forEach(r => {
      if(!r || r.key === '__sha') return;
      if(g.name === 'File' && COVERED.includes(r.k)) return;
      out.push({ group: String(g.name), key: String(r.k), value: r.v == null ? '' : String(r.v), tr: r.tr || null, trv: r.trv || null });
    }));
    return out;
  }

  // One side's rows: the fixed ones, the hashes, then the metadata.
  function rowsOf(s){
    const det = (s.info && s.info.det) || {};
    const label = det.label || (s.info && s.info.label) || '';
    const n = s.file.size;
    const out = [
      { group: 'File', key: 'Type', value: label, tr: label || null, pending: !s.info && !label && s.sig == null },
      { group: 'File', key: 'Size', value: String(n), tr: '{size} ({n} bytes)', trv: { size: fmtBytes(n), n: n.toLocaleString() } },
      { group: 'File', key: 'MIME (guess)', value: det.mime || s.file.type || '' },
      { group: 'File', key: 'File signature (hex)', value: s.sig || '', pending: s.sig == null },
    ];
    BASE_ALGOS.concat(extra ? EXTRA_ALGOS : []).forEach(algo => {
      const h = s.hash[algo] || { pending: true };
      out.push({ group: 'File', key: algo, value: h.hex || '', pending: !!h.pending,
        note: h.tooLarge ? 'Too large to check here' : h.err ? '—' : null });
    });
    return out.concat(s.meta || []);
  }

  /* ─── the pane ─── */
  const view = () => { const r = document.querySelector('input[name="cmp-view"]:checked'); return r ? r.value : 'diff'; };
  function setVerdict(tone, key, vars){
    verdict.className = 'alert ' + tone;
    setText(verdict, key, vars);
  }
  function render(){
    const A = slots.a, B = slots.b;
    swapBtn.disabled = !A && !B;
    if(!A || !B){
      rows = [];
      body.classList.add('hidden');
      exportBtn.disabled = true;
      setVerdict('info', (A || B) ? 'Choose the second file' : 'Choose two files');
      return;
    }
    body.classList.remove('hidden');
    moreBtn.classList.toggle('hidden', extra);
    // A row still being worked out on either side counts as no difference
    // (yet) and reads "Hashing…".
    rows = diffRows(rowsOf(A), rowsOf(B)).map(r => {
      const pending = !!((r.ar && r.ar.pending) || (r.br && r.br.pending));
      return Object.assign(r, { pending, same: pending ? true : r.same });
    });
    const shaA = A.hash['SHA-256'] || {}, shaB = B.hash['SHA-256'] || {};
    const settled = !shaA.pending && !shaB.pending;
    const n = countDiffs(rows);
    if(shaA.hex && shaB.hex && shaA.hex === shaB.hex) setVerdict('ok', 'Identical bytes');
    else if((shaA.hex && shaB.hex) || A.file.size !== B.file.size)
      setVerdict('info', '{x} · {y}', { x: { t: 'Different files' }, y: { t: '{n} differences', v: { n } } });
    // SHA-256 settled without a value on a side (read error, too large):
    // the bytes cannot be told apart, so say so instead of waiting.
    else if(settled) setVerdict('warn', '{x} · {y}', { x: { t: 'Could not hash both files' }, y: { t: '{n} differences', v: { n } } });
    else setVerdict('info', 'Hashing…');
    exportBtn.disabled = !settled || !A.meta || !B.meta;
    drawTable();
  }
  function cell(r, side){
    const td = el('td', 'cmp-v');
    td.dataset.side = side.toUpperCase();
    const v = side === 'a' ? r.a : r.b, src = side === 'a' ? r.ar : r.br;
    if(v === null){ td.append(setText(el('span', 'hint'), '— (missing)')); return td; }
    if(src && src.pending){ td.append(setText(el('span', 'hint'), 'Hashing…')); return td; }
    if(src && src.note){ td.append(el('span', 'hint', src.note === '—' ? '—' : T(src.note))); return td; }
    td.textContent = src && src.tr ? fmtT(src.tr, src.trv || undefined) : v;
    return td;
  }
  function drawTable(){
    tbody.innerHTML = '';
    const list = view() === 'all' ? rows : rows.filter(r => !r.same);
    let group = null;
    list.forEach(r => {
      if(r.group !== group){
        group = r.group;
        const g = el('tr', 'cmp-group');
        const th = el('th', '', T(group));
        th.colSpan = 3;
        th.scope = 'colgroup';
        g.append(th);
        tbody.append(g);
      }
      const tr = el('tr', r.same ? '' : 'diff');
      const f = el('td', 'cmp-f');
      if(!r.same){
        const ne = el('span', 'cmp-ne', '≠');
        ne.setAttribute('aria-hidden', 'true');
        f.append(ne);
      }
      f.append(el('span', 't-label', T(r.key)));
      tr.append(f, cell(r, 'a'), cell(r, 'b'));
      tbody.append(tr);
    });
    none.classList.toggle('hidden', list.length > 0);
    $('cmp-table').classList.toggle('hidden', list.length === 0);
  }
  document.querySelectorAll('input[name="cmp-view"]').forEach(r => r.addEventListener('change', drawTable));
  moreBtn.addEventListener('click', () => {
    extra = true;
    SIDES.forEach(k => { if(slots[k] && slots[k].sig != null) EXTRA_ALGOS.forEach(a => startHash(slots[k], a)); });
    render();
    $('cmp-view-all').focus({ preventScroll: true });
  });

  /* ─── the rail ─── */
  function paintSlots(){
    SIDES.forEach(k => {
      const s = slots[k], drop = $('cmp-drop-' + k), chip = $('cmp-chip-' + k);
      drop.classList.toggle('hidden', !!s);
      chip.classList.toggle('hidden', !s);
      const x = chip.querySelector('.f-x');
      x.title = T('Clear');
      x.setAttribute('aria-label', T('Clear') + ' · ' + T(k === 'a' ? 'File A' : 'File B'));
      if(!s) return;
      const name = chip.querySelector('.f-name');
      name.textContent = s.file.name;
      name.title = s.file.name;
      const meta = chip.querySelector('.f-meta');
      if(s.info) setText(meta, '{label} · {size}', { label: { t: s.info.label }, size: fmtBytes(s.file.size) });
      else setRaw(meta, '… · ' + fmtBytes(s.file.size));
    });
  }
  function clearSlot(k){
    slots[k] = null;
    paintSlots();
    render();
    $('cmp-drop-' + k).focus({ preventScroll: true });
  }
  // Two or more files on either slot fill both, in order.
  function take(k, files){
    files = Array.from(files || []);
    if(!files.length) return;
    if(files.length > 1){ load('a', files[0]); load('b', files[1]); return; }
    load(k, files[0]);
    // A filled, B still empty: B is next.
    if(k === 'a' && !slots.b) $('cmp-drop-b').focus({ preventScroll: true });
  }
  SIDES.forEach(k => {
    wireDrop($('cmp-drop-' + k), $('cmp-input-' + k), files => take(k, files), { multiple: true });
    $('cmp-chip-' + k).querySelector('.f-x').addEventListener('click', () => clearSlot(k));
  });
  swapBtn.addEventListener('click', () => {
    const a = slots.a;
    slots.a = slots.b;
    slots.b = a;
    paintSlots();
    render();
  });
  // A paste while Compare is up fills the next empty slot (B when both are
  // full); several files fill both. Registered before the file screen's own
  // paste handler (this script loads first), which then stays out of it.
  window.addEventListener('paste', e => {
    if(!root.classList.contains('active')) return;
    const fs = e.clipboardData && e.clipboardData.files;
    if(!fs || !fs.length) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    take(!slots.a ? 'a' : 'b', fs);
  });

  /* ─── exports ─── */
  function exportAs(kind){
    const A = slots.a, B = slots.b;
    if(!A || !B || exportBtn.disabled) return;
    const list = rows.filter(r => !r.pending);
    const shaA = (A.hash['SHA-256'] || {}).hex, shaB = (B.hash['SHA-256'] || {}).hex;
    let blob, name;
    if(kind === 'json'){
      name = 'comparison.json';
      blob = new Blob([JSON.stringify({
        a: { name: A.file.name, size: A.file.size },
        b: { name: B.file.name, size: B.file.size },
        identical: shaA && shaB ? shaA === shaB : null,
        differences: countDiffs(list),
        rows: list.map(r => ({ group: r.group, field: r.key, a: r.a, b: r.b, same: r.same })),
      }, null, 2)], { type: 'application/json' });
    } else {
      name = 'comparison.csv';
      blob = new Blob([compareCsv(list, { a: A.file.name, b: B.file.name })], { type: 'text/csv' });
    }
    downloadBlob(blob, name);
    toast(T('Downloaded') + ' ' + name);
  }
  $('cmp-export-csv').addEventListener('click', () => exportAs('csv'));
  $('cmp-export-json').addEventListener('click', () => exportAs('json'));
  menuKeys(exportBtn, $('cmp-export-menu'));

  modeDoneChip(root);
  window.addEventListener('files:i18n', () => { paintSlots(); render(); });
  paintSlots();
  render();

  /* state.compare: [{ file, info }, …] from a card (A, then B); focusB: B's
     dropzone takes focus (Compare with…). Anything else (a link, Back) keeps
     whatever the slots hold. */
  function enter(state){
    if(state && Array.isArray(state.compare)){
      slots.a = slots.b = null;
      const [x, y] = state.compare;
      if(x) load('a', x.file, x.info);
      if(y) load('b', y.file, y.info);
      paintSlots();
      render();
      // After showTool has put focus on the pane title.
      if(state.focusB) setTimeout(() => { const d = $('cmp-drop-b'); if(d && !d.classList.contains('hidden')) d.focus(); }, 0);
    } else { paintSlots(); render(); }
  }

  FilesApp.register({
    id: 'compare', route: 'file/compare', parent: 'auto', mode: true, order: 860,
    accepts: () => true,
    // Every single file can be compared with another: a quiet card in More.
    outcomes: (info, files) => [{
      id: 'compare-with', more: true, icon: '⚖️', title: T('Compare with…'),
      desc: T('Put a second file beside this one: hashes and metadata, the differences highlighted.'),
      run: (card) => FilesApp.enterMode('compare', { compare: [{ file: files[0], info }], focusB: true }, card),
    }],
    // Exactly two files in the set: comparing them leads.
    setOutcomes: (set) => set.length !== 2 ? [] : [{
      id: 'compare', rank: 100, icon: '⚖️', title: T('Compare'),
      desc: T('The two files side by side: hashes and metadata, the differences highlighted.') + ' ' + fmtT('{k} of {n} files', { k: 2, n: 2 }),
      run: (card) => FilesApp.enterMode('compare', { compare: set.map(x => ({ file: x.file, info: x.info })) }, card),
    }],
    enter,
  });

  return { load, slots: () => ({ a: slots.a, b: slots.b }), rows: () => rows.slice() };
})();
