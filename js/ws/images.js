'use strict';
/* ════════════════════════════════════════════════════════════════
   4 · IMAGE CONVERTER  (canvas re-encode, batch + ZIP)
   ════════════════════════════════════════════════════════════════ */
const ImgTool = (() => {
  const items = []; // {file, name, img, w, h, outBlob, outExt, card}
  const grid = $('img-grid'), empty = $('img-empty'), statusEl = $('img-status');
  const btnConvert = $('img-convert'), btnZip = $('img-zip'), btnClear = $('img-clear');

  const getFmt = () => document.querySelector('input[name="img-fmt"]:checked').value;
  document.querySelectorAll('input[name="img-fmt"]').forEach(r => r.addEventListener('change', () => {
    $('img-quality-group').classList.toggle('hidden', getFmt() === 'image/png');
  }));
  $('img-quality').addEventListener('input', () => $('img-quality-val').textContent = $('img-quality').value + '%');

  /* ─── metadata policy on conversion ───
     The canvas writes no metadata, so a conversion has always dropped the
     EXIF (location included); the Strip · Keep control says so, and Keep
     carries the source's EXIF into a JPEG made from a JPEG. Same markup in
     the Images rail (img-) and the file screen's Convert panel (ac-). */
  function metaOpts(prefix){
    const r = document.querySelector(`input[name="${prefix}-meta"]:checked`);
    const g = $(prefix + '-meta-gps');
    return { meta: r && r.value === 'keep' ? 'keep' : 'strip', keepGps: !!(g && g.checked) };
  }
  function wireMetaPolicy(prefix){
    const sync = () => {
      const keep = metaOpts(prefix).meta === 'keep';
      $(prefix + '-meta-note').classList.toggle('hidden', keep);
      $(prefix + '-meta-keepnote').classList.toggle('hidden', !keep);
      $(prefix + '-meta-gps-row').classList.toggle('hidden', !keep);
    };
    document.querySelectorAll(`input[name="${prefix}-meta"]`).forEach(r => r.addEventListener('change', sync));
    sync();
  }
  wireMetaPolicy('img');
  wireMetaPolicy('ac');

  const u8ToBin = (u8) => { let s = ''; for(let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return s; };
  const binToU8 = (bin) => { const u = new Uint8Array(bin.length); for(let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i) & 0xff; return u; };
  /* out (from encodeFromImage) gains .meta: 'stripped' | 'kept' | 'kept-nogps'
     | 'none' (the source had no EXIF) | 'not-carried', and .metaFmt. Only a
     JPEG made from a JPEG can carry it: piexif writes EXIF into JPEG only. */
  const EXIF_TAIL_MAX = 128 * 1024;   // past the 512 KiB head, at most this much more
  async function carryMeta(src, out, format, opts){
    out.meta = 'stripped';
    if(!opts || opts.meta !== 'keep') return out;
    let head = null;
    try { head = await headOf(src); } catch(_){}
    const srcDet = head ? detectFormat(head, src.name || '', src.type || '') : null;
    const srcJpeg = !!srcDet && srcDet.id === 'jpeg';
    out.meta = 'not-carried';
    out.metaFmt = format !== 'image/jpeg' ? out.ext.toUpperCase() : (srcDet ? srcDet.id.toUpperCase() : '?');
    if(format !== 'image/jpeg' || !srcJpeg) return out;
    try {
      await needLib('piexif');
      // Only the Exif APP1 segment is read: from the cached head, or, when
      // the head cuts it off, one slice up to its end (an APP1 is at most
      // 64 KiB; EXIF_TAIL_MAX bounds it anyway). Never the whole JPEG.
      const span = jpegExifSpan(head);
      if(!span){ out.meta = 'none'; return out; }
      let seg;
      if(span.end <= head.length) seg = head.subarray(span.start, span.end);
      else if(span.end - head.length <= EXIF_TAIL_MAX) seg = new Uint8Array(await src.slice(span.start, span.end).arrayBuffer());
      else throw new Error('Exif segment past the read limit');
      let ex;
      // piexif.load takes the APP1 payload ('Exif\0\0' + TIFF) as is.
      try { ex = piexif.load(u8ToBin(seg.subarray(4))); } catch(_){ out.meta = 'none'; return out; }
      const zeroth = ex['0th'] || {}, exif = ex['Exif'] || {};
      delete zeroth[piexif.ImageIFD.Orientation];          // the canvas already turned the pixels
      // The embedded thumbnail and the stored size describe the old picture.
      delete ex['1st']; delete ex.thumbnail;
      if(exif[piexif.ExifIFD.PixelXDimension] != null) exif[piexif.ExifIFD.PixelXDimension] = out.w;
      if(exif[piexif.ExifIFD.PixelYDimension] != null) exif[piexif.ExifIFD.PixelYDimension] = out.h;
      const hadGps = !!(ex.GPS && Object.keys(ex.GPS).length);
      if(!opts.keepGps) ex.GPS = {};
      const bin = piexif.insert(piexif.dump(ex), u8ToBin(new Uint8Array(await out.blob.arrayBuffer())));
      out.blob = new Blob([binToU8(bin)], { type: 'image/jpeg' });
      out.meta = hadGps && !opts.keepGps ? 'kept-nogps' : 'kept';
    } catch(e){ console.warn('EXIF carry failed', e); out.meta = 'not-carried'; out.metaFmt = 'JPEG'; }
    return out;
  }
  // The result card's badge for out.meta, as { t: key, v: vars } for
  // setText/fmtT (so a status line holding it re-renders in a new language),
  // and as text.
  function metaBadgeKey(out){
    switch(out && out.meta){
      case 'kept': return { t: 'EXIF kept' };
      case 'kept-nogps': return { t: 'EXIF kept, GPS removed' };
      case 'none': return { t: 'No EXIF in the source' };
      case 'not-carried': return { t: 'metadata not carried ({FMT})', v: { FMT: out.metaFmt || '?' } };
      default: return { t: 'EXIF removed' };
    }
  }
  const metaBadge = (out) => { const b = metaBadgeKey(out); return fmtT(b.t, b.v); };

  function refreshCount(){
    if(items.length === 1) setText($('img-count'), '{n} file', { n: 1 });
    else setText($('img-count'), '{n} files', { n: items.length });
    btnConvert.disabled = !items.length;
    btnClear.disabled = !items.length;
    empty.classList.toggle('hidden', !!items.length);
  }

  function addFiles(files){
    files.forEach(async orig => {
      if(!isImageLike(orig)) return;
      const srcType = isHeicName(orig.name) || /hei[cf]/.test(orig.type || '')
        ? 'HEIC' : (orig.type.split('/')[1] || '?').toUpperCase();
      let file;
      try { file = await normalizeImageFile(orig); }
      catch(e){ setText(statusEl, 'Error: {msg}', { msg: String(e && e.message || e) }); return; }
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const card = document.createElement('div');
        card.className = 'rcard';
        card.innerHTML = `
          <div class="thumb"><img alt=""></div>
          <div class="rbody">
            <div class="rmeta"><span class="chip"></span><span class="dims"></span></div>
            <div class="rmeta out-meta hidden"><span>→</span><span class="out-info"></span><span class="chip meta-badge"></span></div>
            <div class="btn-row">
              <button class="btn btn-sm grow dl-btn hidden" data-tk="Download">${T('Download')}</button>
              <button class="btn btn-sm rm-btn" title="${T('Remove')}">✕</button>
            </div>
          </div>`;
        card.querySelector('.thumb img').src = url;
        card.querySelector('.chip').textContent = srcType;
        card.querySelector('.dims').textContent = `${img.naturalWidth}×${img.naturalHeight} · ${fmtBytes(file.size)}`;
        const item = { file, orig, name: file.name, img, outBlob: null, outExt: null, card };
        card.querySelector('.rm-btn').addEventListener('click', () => {
          const i = items.indexOf(item);
          if(i >= 0) items.splice(i, 1);
          card.remove();
          URL.revokeObjectURL(url);
          refreshCount();
          btnZip.disabled = !items.some(it => it.outBlob);
        });
        grid.appendChild(card);
        items.push(item);
        refreshCount();
      };
      img.onerror = () => URL.revokeObjectURL(url);
      img.src = url;
    });
  }
  wireDrop($('img-drop'), $('img-input'), addFiles, { multiple: true });

  /* The encoder proper. Kept free of any DOM the batch grid owns so the file
     screen can convert a pasted image through exactly this path — one encoder,
     one set of defaults, no chance of the two drifting apart. */
  async function encodeFromImage(img, name, format, quality, maxDim){
    let w = img.naturalWidth, h = img.naturalHeight;
    if(maxDim && Math.max(w, h) > maxDim){
      const s = maxDim / Math.max(w, h);
      w = Math.max(1, Math.round(w * s));
      h = Math.max(1, Math.round(h * s));
    }
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if(format === 'image/jpeg'){ ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise(r => canvas.toBlob(r, format, quality));
    if(!blob) throw new Error(T('Encoding failed for {name}').replace('{name}', name));
    const ext = format === 'image/jpeg' ? 'jpg' : format.split('/')[1];
    return { blob, ext, w, h, name: name.replace(/\.[^.]+$/, '') + '.' + ext };
  }

  /* Same encoder starting from a File — decodes (and un-HEICs) it first. */
  /* opts: { meta: 'strip' | 'keep', keepGps, source } — source is the file
     the EXIF comes from when `file` is already a decoded copy of it. */
  async function encodeFile(file, format, quality, maxDim, opts){
    const norm = await normalizeImageFile(file);
    const url = URL.createObjectURL(norm);
    try {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error(T('Could not load image.')));
        i.src = url;
      });
      const out = await encodeFromImage(img, norm.name, format, quality, maxDim);
      return await carryMeta((opts && opts.source) || file, out, format, opts);
    } finally { URL.revokeObjectURL(url); }
  }

  async function convertOne(item, format, quality, maxDim, opts){
    const out = await carryMeta(item.orig || item.file, await encodeFromImage(item.img, item.name, format, quality, maxDim), format, opts);
    const { blob, w, h } = out;
    item.outBlob = blob;
    item.outInfo = out;
    item.outExt = out.ext;
    item.outName = out.name;
    const om = item.card.querySelector('.out-meta');
    om.classList.remove('hidden');
    item.card.querySelector('.out-info').textContent = `${item.outExt.toUpperCase()} ${w}×${h} · ${fmtBytes(blob.size)}`;
    item.card.querySelector('.meta-badge').textContent = metaBadge(out);
    const dl = item.card.querySelector('.dl-btn');
    dl.classList.remove('hidden');
    dl.onclick = () => downloadBlob(item.outBlob, item.outName);
  }

  btnConvert.addEventListener('click', async () => {
    if(!items.length) return;
    btnConvert.disabled = true; btnZip.disabled = true;
    const format = getFmt();
    const quality = (parseInt($('img-quality').value, 10) || 85) / 100;
    const maxDim = parseInt($('img-maxdim').value, 10) || 0;
    const opts = metaOpts('img');
    let ok = 0;
    for(const item of items){
      setText(statusEl, 'Converting {name}…', { name: item.name });
      try { await convertOne(item, format, quality, maxDim, opts); ok++; }
      catch(e){ console.error(e); setText(statusEl, 'Error: {msg}', { msg: String(e && e.message || e) }); }
      await new Promise(r => setTimeout(r, 0));
    }
    setText(statusEl, 'Converted {ok}/{n} image(s).', { ok, n: items.length });
    btnConvert.disabled = false;
    btnZip.disabled = !items.some(it => it.outBlob);
  });

  btnZip.addEventListener('click', async () => {
    const converted = items.filter(it => it.outBlob);
    if(!converted.length) return;
    btnZip.disabled = true;
    setText(statusEl, 'Building ZIP…');
    const seen = new Map();
    const zip = await makeZip(converted.map(it => {
      let name = it.outName;
      const n = seen.get(name) || 0;
      seen.set(name, n + 1);
      if(n) name = name.replace(/\.([^.]+)$/, `-${n}.$1`);
      return { name, blob: it.outBlob };
    }));
    downloadBlob(zip, 'converted-images.zip');
    setText(statusEl, 'ZIP ready ({size})', { size: fmtBytes(zip.size) });
    btnZip.disabled = false;
  });

  btnClear.addEventListener('click', () => {
    items.splice(0, items.length);
    grid.querySelectorAll('.rcard').forEach(c => c.remove());
    setText(statusEl, '');
    btnZip.disabled = true;
    refreshCount();
  });

  // Badges follow the language.
  window.addEventListener('files:i18n', () => items.forEach(it => {
    if(it.outInfo) it.card.querySelector('.meta-badge').textContent = metaBadge(it.outInfo);
  }));

  return { open: addFiles, encodeFile, metaOpts, metaBadge, metaBadgeKey };
})();

// A module with no card of its own: the file screen converts inline and its
// "Batch converter" button opens this one. It accepts images all the same, so
// the other workspaces' "Same file:" chips can send the file here; open()
// adds the received files (HEIC is decoded by addFiles itself).
FilesApp.register({
  id: 'images', route: 'images', order: 30,
  accepts: (info) => info.kind === 'image' || info.kind === 'heic',
  outcomes: () => [],
  // The set view (spec §6.8, §9.8): every image in the tray, in tray order,
  // into the batch converter. Rows still being detected are not counted yet;
  // the cards are drawn again as they resolve.
  setOutcomes: (set) => {
    const imgs = set.filter(x => x.info && (x.info.kind === 'image' || x.info.kind === 'heic')).map(x => x.file);
    if(!imgs.length) return [];
    return [{ id: 'convert-all', rank: 60, icon: '🖼️', title: T('Convert images'),
      desc: T('Opens them together in the image converter.') + ' ' + fmtT('{k} of {n} files', { k: imgs.length, n: set.length }),
      run: () => { ImgTool.open(imgs); showTool('images'); } }];
  },
  open: (file) => ImgTool.open(FilesApp.state.files.length ? FilesApp.state.files : [file]),
});
