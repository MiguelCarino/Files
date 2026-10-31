'use strict';
/* ════════════════════════════════════════════════════════════════
   3 · SIGNATURE CLEANUP  (pure canvas pipeline — no OpenCV)
   grayscale → auto polarity → background flattening → Otsu with
   ink-coverage cap → despeckle → auto-crop → recolor → PNG
   ════════════════════════════════════════════════════════════════ */
const SigTool = (() => {

  /* ---- core pipeline (also exposed for testing) ---- */
  function otsu(hist, total){
    let sum = 0;
    for(let i = 0; i < 256; i++) sum += i * hist[i];
    // The dark class is [0..t]. A clean two-tone image (a digital signature
    // on white) has empty bins between its peaks, so the best split is a
    // plateau: take its middle, not its first bin (which is the ink value
    // itself and left nothing below the threshold). The +1 makes the
    // returned value exclusive, as the alpha ramp (thr - v) reads it.
    let sumB = 0, wB = 0, maxVar = -1, first = 126, last = 126;
    for(let t = 0; t < 256; t++){
      wB += hist[t];
      if(wB === 0) continue;
      const wF = total - wB;
      if(wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if(between > maxVar){ maxVar = between; first = last = t; }
      else if(between === maxVar) last = t;
    }
    return Math.min(255, ((first + last + 1) >> 1) + 1);
  }

  /* despeckle: 4-connected flood fill over the ink mask, drop small blobs */
  function despeckle(mask, w, h, minSize){
    const visited = new Uint8Array(mask.length);
    const stack = new Int32Array(mask.length);
    let kept = 0, dropped = 0;
    const component = new Int32Array(mask.length);
    for(let start = 0; start < mask.length; start++){
      if(!mask[start] || visited[start]) continue;
      let sp = 0, count = 0;
      stack[sp++] = start; visited[start] = 1;
      while(sp > 0){
        const i = stack[--sp];
        component[count++] = i;
        const x = i % w, y = (i / w) | 0;
        if(x > 0     && mask[i-1] && !visited[i-1]){ visited[i-1] = 1; stack[sp++] = i-1; }
        if(x < w - 1 && mask[i+1] && !visited[i+1]){ visited[i+1] = 1; stack[sp++] = i+1; }
        if(y > 0     && mask[i-w] && !visited[i-w]){ visited[i-w] = 1; stack[sp++] = i-w; }
        if(y < h - 1 && mask[i+w] && !visited[i+w]){ visited[i+w] = 1; stack[sp++] = i+w; }
      }
      if(count < minSize){
        for(let k = 0; k < count; k++) mask[component[k]] = 0;
        dropped++;
      } else kept++;
    }
    return { kept, dropped };
  }

  /* coarse illumination map: area-average downscale, then a 3×3 max filter
     (removes dark ink strokes from the estimate) and a 3×3 box blur */
  function estimateBackground(gray, w, h){
    const sw = Math.max(8, Math.min(48, w));
    const sh = Math.max(8, Math.min(48, Math.max(1, Math.round(h * sw / w))));
    const sum = new Float64Array(sw * sh), cnt = new Float64Array(sw * sh);
    for(let y = 0; y < h; y++){
      const sy = Math.min(sh - 1, (y * sh / h) | 0), row = y * w;
      for(let x = 0; x < w; x++){
        const si = sy * sw + Math.min(sw - 1, (x * sw / w) | 0);
        sum[si] += gray[row + x]; cnt[si]++;
      }
    }
    let a = new Float32Array(sw * sh);
    for(let i = 0; i < a.length; i++) a[i] = cnt[i] ? sum[i] / cnt[i] : 255;
    let b = new Float32Array(sw * sh);
    for(let pass = 0; pass < 2; pass++){
      for(let y = 0; y < sh; y++) for(let x = 0; x < sw; x++){
        let m = 0;
        for(let dy = -1; dy <= 1; dy++) for(let dx = -1; dx <= 1; dx++){
          const nx = Math.min(sw - 1, Math.max(0, x + dx));
          const ny = Math.min(sh - 1, Math.max(0, y + dy));
          const v = a[ny * sw + nx];
          if(v > m) m = v;
        }
        b[y * sw + x] = m;
      }
      const t = a; a = b; b = t;
    }
    for(let pass = 0; pass < 2; pass++){
      for(let y = 0; y < sh; y++) for(let x = 0; x < sw; x++){
        let s = 0, n = 0;
        for(let dy = -1; dy <= 1; dy++) for(let dx = -1; dx <= 1; dx++){
          const nx = x + dx, ny = y + dy;
          if(nx >= 0 && nx < sw && ny >= 0 && ny < sh){ s += a[ny * sw + nx]; n++; }
        }
        b[y * sw + x] = s / n;
      }
      const t = a; a = b; b = t;
    }
    return { bg: a, sw, sh };
  }

  function bgAt(bg, sw, sh, x, y, w, h){
    const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * sw / w - 0.5));
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * sh / h - 0.5));
    const x0 = fx | 0, y0 = fy | 0;
    const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    const top = bg[y0 * sw + x0] * (1 - tx) + bg[y0 * sw + x1] * tx;
    const bot = bg[y1 * sw + x0] * (1 - tx) + bg[y1 * sw + x1] * tx;
    return top * (1 - ty) + bot * ty;
  }

  /**
   * @param {HTMLImageElement|HTMLCanvasElement} img
   * @param {object} opts {autoThreshold, threshold, flatten, polarity:'auto'|'dark'|'light',
   *                       minBlob, pad, softEdges, inkColor:[r,g,b]}
   * @returns {canvas, stats, threshold}
   */
  function processSignature(img, opts){
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const stats = {};
    const src = document.createElement('canvas');
    src.width = w; src.height = h;
    const sctx = src.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(img, 0, 0);
    stats.in = `${w}×${h}`;
    const px = sctx.getImageData(0, 0, w, h).data;

    const gray = new Uint8ClampedArray(w * h);
    for(let i = 0, j = 0; i < px.length; i += 4, j++)
      gray[j] = (px[i] * 0.299 + px[i+1] * 0.587 + px[i+2] * 0.114) | 0;

    // polarity — the paper must end up bright; judge from the border ring
    let inverted = opts.polarity === 'light';
    if(opts.polarity === 'auto'){
      const ring = [];
      const step = Math.max(1, ((w + h) / 256) | 0);
      for(let x = 0; x < w; x += step) ring.push(gray[x], gray[(h - 1) * w + x]);
      for(let y = 0; y < h; y += step) ring.push(gray[y * w], gray[y * w + w - 1]);
      ring.sort((p, q) => p - q);
      if(ring[(ring.length / 2) | 0] < 110) inverted = true;
    }
    if(inverted) for(let j = 0; j < gray.length; j++) gray[j] = 255 - gray[j];
    stats.ink = inverted ? 'light-on-dark' : 'dark-on-light';

    // flatten uneven lighting: divide by the smoothed background estimate,
    // so a shadow across the photo no longer reads as one giant ink blob
    let norm = gray;
    if(opts.flatten){
      const { bg, sw, sh } = estimateBackground(gray, w, h);
      norm = new Uint8ClampedArray(w * h);
      for(let y = 0; y < h; y++){
        const row = y * w;
        for(let x = 0; x < w; x++){
          const b = Math.max(24, bgAt(bg, sw, sh, x, y, w, h));
          norm[row + x] = Math.min(255, gray[row + x] * 242 / b);
        }
      }
    }

    const total = w * h;
    const hist = new Uint32Array(256);
    for(let j = 0; j < total; j++) hist[norm[j]]++;
    const cum = new Uint32Array(256);
    let acc = 0;
    for(let t = 0; t < 256; t++){ acc += hist[t]; cum[t] = acc; }

    let thr = opts.autoThreshold ? otsu(hist, total) : opts.threshold;
    if(opts.autoThreshold){
      // Otsu can split a noisy histogram on the paper side and blacken the
      // whole frame — cap auto-selected ink coverage at 35%
      while(thr > 1 && cum[thr - 1] / total > 0.35) thr--;
    }

    const band = opts.softEdges ? 26 : 2;
    const alpha = new Uint8Array(total);
    const mask = new Uint8Array(total);
    let inkCount = 0;
    for(let j = 0; j < total; j++){
      const a = Math.max(0, Math.min(255, Math.round((thr - norm[j]) * 255 / band)));
      alpha[j] = a;
      if(a > 16){ mask[j] = 1; inkCount++; }
    }
    stats.threshold = thr + (opts.autoThreshold ? ' auto' : '');
    stats.inkPct = ((inkCount / total) * 100).toFixed(1) + '%';

    const { kept, dropped } = despeckle(mask, w, h, Math.max(1, opts.minBlob));
    stats.blobs = `${kept} kept / ${dropped} dropped`;
    stats.kept = kept; stats.dropped = dropped;
    for(let j = 0; j < total; j++) if(!mask[j]) alpha[j] = 0;

    let minX = w, minY = h, maxX = -1, maxY = -1;
    for(let y = 0; y < h; y++){
      const row = y * w;
      for(let x = 0; x < w; x++) if(mask[row + x]){
        if(x < minX) minX = x;
        if(x > maxX) maxX = x;
        if(y < minY) minY = y;
        if(y > maxY) maxY = y;
      }
    }
    let cx = 0, cy = 0, cw = w, ch = h;
    if(maxX >= minX){
      const pad = Math.max(0, opts.pad);
      cx = Math.max(0, minX - pad);
      cy = Math.max(0, minY - pad);
      cw = Math.min(w, maxX + 1 + pad) - cx;
      ch = Math.min(h, maxY + 1 + pad) - cy;
    } else {
      stats.warning = 'no ink detected';
    }
    stats.out = `${cw}×${ch}`;

    const [ir, ig, ib] = opts.inkColor;
    const out = document.createElement('canvas');
    out.width = cw; out.height = ch;
    const octx = out.getContext('2d');
    const od = octx.createImageData(cw, ch);
    const op = od.data;
    for(let y = 0; y < ch; y++){
      const srcRow = (y + cy) * w + cx, dstRow = y * cw;
      for(let x = 0; x < cw; x++){
        const o = (dstRow + x) * 4;
        op[o] = ir; op[o+1] = ig; op[o+2] = ib; op[o+3] = alpha[srcRow + x];
      }
    }
    octx.putImageData(od, 0, 0);
    return { canvas: out, stats, threshold: thr, crop: { x: cx, y: cy } };
  }

  /* ---- UI helpers ---- */
  function hexToRgb(hex){
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    const n = m ? parseInt(m[1], 16) : 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function downloadCanvas(canvas, scale, filename){
    scale = parseInt(scale, 10) || 1;
    let src = canvas;
    if(scale !== 1){
      const out = document.createElement('canvas');
      out.width = canvas.width * scale;
      out.height = canvas.height * scale;
      const ctx = out.getContext('2d');
      ctx.imageSmoothingEnabled = false; // nearest-neighbour keeps ink crisp
      ctx.drawImage(canvas, 0, 0, out.width, out.height);
      src = out;
    }
    src.toBlob(b => downloadBlob(b, filename), 'image/png');
  }

  function eraserCursorCSS(r){
    r = Math.max(4, r);
    const d = r * 2;
    const svg = encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d}">` +
      `<circle cx="${r}" cy="${r}" r="${r-2}" fill="none" stroke="rgba(0,0,0,0.8)" stroke-width="1.5"/>` +
      `<circle cx="${r}" cy="${r}" r="${r-2}" fill="none" stroke="rgba(255,255,255,0.7)" stroke-width="0.7"/>` +
      `</svg>`);
    return `url("data:image/svg+xml,${svg}") ${r} ${r}, crosshair`;
  }

  /* Destination-out along a path of canvas points (one point draws a dot). */
  function eraseAlong(ctx, pts, r){
    if(!pts.length) return;
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = r * 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if(pts.length === 1){
      ctx.arc(pts[0].x, pts[0].y, r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.moveTo(pts[0].x, pts[0].y);
      for(let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* The eraser works on one item. Its strokes are kept in image coordinates
     (item.strokes, js/lib/eraser.js) so reprocess() can lay them again over a
     fresh threshold; its undo snapshots (item.undo) are { w, h, data, n, gen }:
     the canvas size and pixels before a stroke, the stroke count then, and the
     processing generation they belong to. */
  function setupEraser(item, wrapper, sizeSlider, toggleBtn, undoBtn){
    const canvas = item.canvas;
    if(canvas._eraserAbort) canvas._eraserAbort.abort();
    const ac = new AbortController();
    canvas._eraserAbort = ac;
    const sig = { signal: ac.signal };
    let active = false, drawing = false, stroke = null;

    let cursorEl = wrapper.querySelector('.eraser-cursor');
    if(!cursorEl){
      cursorEl = document.createElement('div');
      cursorEl.className = 'eraser-cursor';
      wrapper.appendChild(cursorEl);
    }
    const updateCursorSize = () => {
      const r = parseInt(sizeSlider.value, 10);
      cursorEl.style.width = r * 2 + 'px';
      cursorEl.style.height = r * 2 + 'px';
      if(active) canvas.style.cursor = eraserCursorCSS(r);
    };
    updateCursorSize();
    sizeSlider.addEventListener('input', updateCursorSize, sig);

    const client = e => e.touches ? e.touches[0] : e;
    const imagePos = e => {
      const c = client(e);
      return eraserPoint(c.clientX, c.clientY, canvas.getBoundingClientRect(), canvas.width, canvas.height, item.crop);
    };
    const moveCursor = e => {
      const c = client(e), wr = wrapper.getBoundingClientRect();
      cursorEl.style.left = (c.clientX - wr.left) + 'px';
      cursorEl.style.top = (c.clientY - wr.top) + 'px';
    };
    const start = e => {
      const ctx = canvas.getContext('2d');
      item.undo.push({ w: canvas.width, h: canvas.height, data: ctx.getImageData(0, 0, canvas.width, canvas.height), n: item.strokes.length, gen: item.gen });
      if(item.undo.length > 20) item.undo.shift();
      syncUndo();
      const r = eraserRadius(parseInt(sizeSlider.value, 10), canvas.getBoundingClientRect(), canvas.width);
      stroke = { r, pts: [imagePos(e)] };
      item.strokes.push(stroke);
      eraseAlong(ctx, eraserReplay(stroke, item.crop), r);
      drawing = true;
    };
    const extend = e => {
      const p = imagePos(e);
      const prev = stroke.pts[stroke.pts.length - 1];
      stroke.pts.push(p);
      eraseAlong(canvas.getContext('2d'), eraserReplay({ pts: [prev, p] }, item.crop), stroke.r);
    };
    const end = () => {
      if(drawing) paintThumb(item);
      drawing = false; stroke = null;
    };

    canvas.addEventListener('mousedown', e => {
      if(!active) return; e.preventDefault();
      start(e);
    }, sig);
    canvas.addEventListener('mousemove', e => {
      if(!active) return;
      moveCursor(e);
      if(drawing) extend(e);
    }, sig);
    canvas.addEventListener('mouseup', end, sig);
    canvas.addEventListener('mouseleave', () => { end(); cursorEl.style.display = 'none'; }, sig);
    canvas.addEventListener('mouseenter', () => { if(active) cursorEl.style.display = 'block'; }, sig);
    canvas.addEventListener('touchstart', e => {
      if(!active) return; e.preventDefault();
      start(e);
    }, { passive: false, signal: ac.signal });
    canvas.addEventListener('touchmove', e => {
      if(!active || !drawing) return; e.preventDefault();
      extend(e);
    }, { passive: false, signal: ac.signal });
    canvas.addEventListener('touchend', end, sig);

    toggleBtn.onclick = () => {
      active = !active;
      if(active){
        setText(toggleBtn, '✕ Stop erasing');
        toggleBtn.classList.add('btn-danger');
        updateCursorSize();
        cursorEl.style.display = 'block';
      } else {
        setText(toggleBtn, '✎ Eraser');
        toggleBtn.classList.remove('btn-danger');
        canvas.style.cursor = '';
        cursorEl.style.display = 'none';
      }
    };
    undoBtn.onclick = () => undoErase(item);
  }

  /* Undo one stroke. A snapshot from this processing generation is put back
     as it was, canvas size included; one taken before a reprocess (a slider
     moved since) would bring the old settings back, so the strokes are cut
     to what they were and the item is reprocessed instead. */
  function undoErase(item){
    const snap = item.undo.pop();
    if(!snap){ syncUndo(); return; }
    item.strokes.length = Math.min(item.strokes.length, snap.n);
    if(snap.gen === item.gen){
      item.canvas.width = snap.w;
      item.canvas.height = snap.h;
      item.canvas.getContext('2d').putImageData(snap.data, 0, 0);
      paintThumb(item);
    } else reprocess(item);
    syncUndo();
  }

  /* ---- UI: one preview + thumbnail strip + one shared control panel ---- */
  const stage = $('sig-stage'), emptyHint = $('sig-emptyhint'), strip = $('sig-strip');
  const addBtn = $('sig-add'), input = $('sig-input');
  const statline = $('sig-statline');
  const autoChk = $('sig-auto'), thrSlider = $('sig-thr'), thrVal = $('sig-thrv');
  const flatChk = $('sig-flat'), softChk = $('sig-soft');
  const spkSlider = $('sig-spk'), spkVal = $('sig-spkv');
  const padSlider = $('sig-pad'), padVal = $('sig-padv');
  const customColor = $('sig-inkc');
  const eraserSize = $('sig-esize'), eraserSzVal = $('sig-esv');
  const etgl = $('sig-etgl'), eundo = $('sig-eundo');
  const dlBtn = $('sig-dl'), dlAllBtn = $('sig-dlall');

  const items = [];
  let current = null, seq = 0;

  const defaults = () => ({ auto: true, thr: 160, flatten: true, soft: true, polarity: 'auto', minBlob: 30, pad: 8, ink: '#000000', custom: '#14532d' });

  function uiToSettings(s){
    s.auto = autoChk.checked;
    s.thr = parseInt(thrSlider.value, 10);
    s.flatten = flatChk.checked;
    s.soft = softChk.checked;
    s.polarity = document.querySelector('input[name="sig-pol"]:checked').value;
    s.minBlob = parseInt(spkSlider.value, 10);
    s.pad = parseInt(padSlider.value, 10);
    s.ink = document.querySelector('input[name="sig-ink"]:checked').value;
    s.custom = customColor.value;
  }
  function settingsToUI(s){
    autoChk.checked = s.auto;
    thrSlider.value = s.thr;
    thrSlider.disabled = s.auto;
    flatChk.checked = s.flatten;
    softChk.checked = s.soft;
    document.querySelector(`input[name="sig-pol"][value="${s.polarity}"]`).checked = true;
    spkSlider.value = s.minBlob; spkVal.textContent = s.minBlob;
    padSlider.value = s.pad; padVal.textContent = s.pad;
    (document.querySelector(`input[name="sig-ink"][value="${s.ink}"]`) || $('sig-ink-custom')).checked = true;
    customColor.value = s.custom;
  }

  function paintThumb(item){
    const t = item.thumbCanvas;
    const s = Math.min(44 / item.canvas.width, 44 / item.canvas.height);
    t.width = Math.max(1, Math.round(item.canvas.width * s));
    t.height = Math.max(1, Math.round(item.canvas.height * s));
    t.getContext('2d').drawImage(item.canvas, 0, 0, t.width, t.height);
  }

  /* By key and vars (setText), so the line re-renders in a new language: the
     words are { t: key } vars inside a key with no words of its own. */
  function syncStatline(){
    if(!current){ setText(statline, 'No image loaded.'); return; }
    const st = current.stats;
    const m = String(st.threshold).match(/^(.*) auto$/);
    const vars = {
      name: current.name, in: st.in, out: st.out,
      thrL: { t: 'thr' }, thr: m ? { t: '{n} auto', v: { n: m[1] } } : String(st.threshold),
      inkL: { t: 'ink' }, pct: st.inkPct, ink: { t: st.ink },
      blobsL: { t: 'blobs' }, blobs: { t: '{kept} kept / {dropped} dropped', v: { kept: st.kept, dropped: st.dropped } },
      warn: st.warning ? { t: st.warning } : '',
    };
    if(st.warning) setText(statline, '{name} · {in} → {out} · {thrL} {thr} · {inkL} {pct} ({ink}) · {blobsL} {blobs} · ⚠ {warn}', vars);
    else setText(statline, '{name} · {in} → {out} · {thrL} {thr} · {inkL} {pct} ({ink}) · {blobsL} {blobs}', vars);
  }

  function reprocess(item){
    const s = item.settings;
    const r = processSignature(item.img, {
      autoThreshold: s.auto, threshold: s.thr, flatten: s.flatten,
      polarity: s.polarity, minBlob: s.minBlob, pad: s.pad, softEdges: s.soft,
      inkColor: hexToRgb(s.ink === 'custom' ? s.custom : s.ink),
    });
    item.stats = r.stats;
    item.threshold = r.threshold;
    item.crop = r.crop;
    item.gen++;
    item.canvas.width = r.canvas.width;
    item.canvas.height = r.canvas.height;
    const ctx = item.canvas.getContext('2d');
    ctx.drawImage(r.canvas, 0, 0);
    // The eraser strokes, in image coordinates, go back on after thresholding.
    for(const st of item.strokes) eraseAlong(ctx, eraserReplay(st, item.crop), st.r);
    paintThumb(item);
    if(item === current){
      if(s.auto) thrSlider.value = r.threshold;
      thrVal.textContent = r.threshold;
      syncStatline();
    }
  }

  function resetEraserUI(){
    setText(etgl, '✎ Eraser');
    etgl.classList.remove('btn-danger');
    const cur = stage.querySelector('.eraser-cursor');
    if(cur) cur.style.display = 'none';
  }

  function activate(item){
    current = item;
    setWsFile(item.name);
    items.forEach(it => {
      it.thumbBtn.classList.toggle('active', it === item);
      it.canvas.classList.toggle('hidden', it !== item);
    });
    emptyHint.classList.add('hidden');
    settingsToUI(item.settings);
    thrVal.textContent = item.threshold;
    if(item.settings.auto) thrSlider.value = item.threshold;
    syncStatline();
    dlBtn.disabled = false;
    resetEraserUI();
    item.canvas.style.cursor = '';
    setupEraser(item, stage, eraserSize, etgl, eundo);
    syncUndo();
  }
  function syncUndo(){ eundo.disabled = !current || !current.undo.length; }

  function removeItem(item){
    const i = items.indexOf(item);
    if(i < 0) return;
    items.splice(i, 1);
    item.thumbBtn.remove();
    item.canvas.remove();
    if(current === item){
      current = null;
      if(items.length) activate(items[Math.min(i, items.length - 1)]);
      else {
        emptyHint.classList.remove('hidden');
        dlBtn.disabled = true;
        thrVal.textContent = '–';
        resetEraserUI();
        syncStatline();
        syncUndo();
      }
    }
    syncExport();
  }
  // The Export ▾ menu holds "All as ZIP ({n})", shown with 2 images or more.
  const exportMenu = $('sig-export');
  function syncExport(){
    exportMenu.classList.toggle('hidden', items.length < 2);
    setText($('sig-dlall-lbl'), 'All as ZIP ({n})', { n: items.length });
  }

  /* Throws when the image cannot be processed (no pixels, a decode the
     canvas refuses); open() then shows a failed thumb instead. */
  function addItem(img, name){
    if(!(img.naturalWidth || img.width) || !(img.naturalHeight || img.height)) throw new Error('empty image');
    const item = {
      id: ++seq, img, name, settings: defaults(), stats: null, threshold: 0,
      crop: { x: 0, y: 0 }, strokes: [], undo: [], gen: 0,
      canvas: document.createElement('canvas'),
      thumbBtn: document.createElement('button'),
      thumbCanvas: document.createElement('canvas'),
    };
    item.canvas.className = 'sig-canvas hidden';
    stage.appendChild(item.canvas);
    item.thumbBtn.className = 'sig-thumb';
    item.thumbBtn.title = name;
    const x = document.createElement('span');
    x.className = 'tx'; x.textContent = '✕';
    item.thumbBtn.append(item.thumbCanvas, x);
    item.thumbBtn.addEventListener('click', e => {
      if(e.target === x){ removeItem(item); return; }
      activate(item);
    });
    try { reprocess(item); }
    catch(err){ item.canvas.remove(); throw err; }
    strip.insertBefore(item.thumbBtn, addBtn);
    items.push(item);
    activate(item);
    syncExport();
  }

  /* A file that could not be opened: a thumb in the error state, which names
     it again in the stat line when clicked, and ✕ removes it. */
  function addFailed(name){
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sig-thumb sig-thumb-err';
    btn.title = fmtT('Could not open {name}', { name });
    const mark = document.createElement('span');
    mark.className = 'sig-err-mark'; mark.textContent = '⚠'; mark.setAttribute('aria-hidden', 'true');
    const x = document.createElement('span');
    x.className = 'tx'; x.textContent = '✕';
    btn.append(mark, x);
    btn.addEventListener('click', e => {
      if(e.target === x){ btn.remove(); syncStatline(); return; }
      setText(statline, 'Could not open {name}', { name });
    });
    strip.insertBefore(btn, addBtn);
    setText(statline, 'Could not open {name}', { name });
  }

  /* Every file settles: a decode error, a 0×0 image (an SVG with no size)
     or a canvas that refuses it becomes a failed thumb and the batch goes on.
     The last failure is named in the stat line once the batch is done, so a
     good image opened after it does not hide it. */
  async function open(files){
    let failed = null;
    for(const f of files){
      if(!isImageLike(f)) continue;
      let ok = false;
      try {
        const file = await normalizeImageFile(f);
        const img = await new Promise((res, rej) => {
          const url = URL.createObjectURL(file);
          const im = new Image();
          im.onload = () => { URL.revokeObjectURL(url); res(im); };
          im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('decode')); };
          im.src = url;
        });
        addItem(img, f.name);
        ok = true;
      } catch(_){ /* named below */ }
      finally {
        if(!ok){ addFailed(f.name); failed = f.name; }
      }
    }
    if(failed) setText(statline, 'Could not open {name}', { name: failed });
  }

  /* stage is the dropzone; clicking it only browses while empty (else it is the eraser surface) */
  ['dragenter','dragover'].forEach(ev => stage.addEventListener(ev, e => { e.preventDefault(); stage.classList.add('dragover'); }));
  ['dragleave','drop'].forEach(ev => stage.addEventListener(ev, e => { e.preventDefault(); stage.classList.remove('dragover'); }));
  stage.addEventListener('drop', e => {
    const fs = e.dataTransfer && e.dataTransfer.files;
    if(fs && fs.length) open(Array.from(fs));
  });
  emptyHint.addEventListener('click', () => input.click());
  /* The rail's dropzone: the same input, so it works before the canvas is in view (phones). */
  const railDrop = $('sig-drop');
  railDrop.addEventListener('click', () => input.click());
  railDrop.addEventListener('keydown', e => { if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); input.click(); } });
  ['dragenter','dragover'].forEach(ev => railDrop.addEventListener(ev, e => { e.preventDefault(); railDrop.classList.add('dragover'); }));
  ['dragleave','drop'].forEach(ev => railDrop.addEventListener(ev, e => { e.preventDefault(); railDrop.classList.remove('dragover'); }));
  railDrop.addEventListener('drop', e => {
    const fs = e.dataTransfer && e.dataTransfer.files;
    if(fs && fs.length) open(Array.from(fs));
  });
  emptyHint.addEventListener('keydown', e => { if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); input.click(); } });
  addBtn.addEventListener('click', () => input.click());
  input.addEventListener('change', e => {
    if(e.target.files.length) open(Array.from(e.target.files));
    e.target.value = '';
  });
  window.addEventListener('paste', e => {
    if(!$('tool-signature').classList.contains('active')) return;
    const fs = e.clipboardData && e.clipboardData.files;
    if(fs && fs.length) open(Array.from(fs).filter(isImageLike));
  });

  const onControlChange = () => {
    thrSlider.disabled = autoChk.checked;
    if(!current) return;
    uiToSettings(current.settings);
    reprocess(current);
  };
  [autoChk, flatChk, softChk].forEach(c => c.addEventListener('change', onControlChange));
  [thrSlider, spkSlider, padSlider].forEach(s => s.addEventListener('change', onControlChange));
  thrSlider.addEventListener('input', () => thrVal.textContent = thrSlider.value);
  spkSlider.addEventListener('input', () => spkVal.textContent = spkSlider.value);
  padSlider.addEventListener('input', () => padVal.textContent = padSlider.value);
  eraserSize.addEventListener('input', () => eraserSzVal.textContent = eraserSize.value);
  document.querySelectorAll('input[name="sig-pol"], input[name="sig-ink"]').forEach(r => r.addEventListener('change', onControlChange));
  customColor.addEventListener('change', () => { $('sig-ink-custom').checked = true; onControlChange(); });

  dlBtn.addEventListener('click', () => {
    if(!current) return;
    const scale = document.querySelector('input[name="sig-scale"]:checked').value;
    downloadCanvas(current.canvas, scale, `Signature_${current.name.replace(/\.[^.]+$/, '')}.png`);
  });
  dlAllBtn.addEventListener('click', async () => {
    if(!items.length) return;
    const scale = parseInt(document.querySelector('input[name="sig-scale"]:checked').value, 10) || 1;
    const entries = [];
    for(const it of items){
      let src = it.canvas;
      if(scale !== 1){
        const c = document.createElement('canvas');
        c.width = src.width * scale; c.height = src.height * scale;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(src, 0, 0, c.width, c.height);
        src = c;
      }
      const blob = await new Promise(r => src.toBlob(r, 'image/png'));
      entries.push({ name: `Signature_${it.name.replace(/\.[^.]+$/, '')}_${it.id}.png`, blob });
    }
    downloadBlob(await makeZip(entries), 'signatures.zip');
  });

  return { processSignature, otsu, despeckle, estimateBackground, open };
})();

FilesApp.register({
  id: 'signature', route: 'signature', order: 10,
  accepts: (info) => info.kind === 'image' || info.kind === 'heic',
  // OCR and conversion live on the file screen itself, so neither gets a
  // card that only leads somewhere else. This is the one outcome the file
  // screen cannot do inline.
  outcomes: (info, files) => [
    { id: 'signature', rank: 50, icon: '✒️', title: T('Signature cleanup'), desc: T('Flatten lighting, threshold, despeckle, crop and recolor into a transparent PNG.'),
      run: () => { SigTool.open(files); showTool('signature'); } },
  ],
});
