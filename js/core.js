'use strict';
/* ════════════════════════════════════════════════════════════════
   Shared helpers: $, sizes, i18n bridge, downloads, dropzones and the
   lazy script loader. Every app script is a classic script sharing one
   top-level scope, so the names declared here are visible to all of them.

   Whole-file reads. Nothing reads a whole file it does not need; every
   arrayBuffer() in js/ is one of these (keep this list current):
   - headOf (here): the first 512 KiB only, for detection and header parsers.
   - hashOf (here): the whole file through crypto.subtle only up to 64 MiB;
     above that, 4 MiB slices (js/hash-worker.js, or hashOnMain here).
   - MetaTool c.full() (js/ws/metadata.js): read once, on demand, only by the
     parsers and writers that need the whole file: PDF, ZIP/Office (read by
     js/lib/unzip.js), fonts, JPEG EXIF write, MP3 ID3 write; a certificate
     file larger than the head.
   - MetaTool scrub (js/ws/metadata.js): the file being cleaned, only when a
     clean copy is asked for; the 4 KiB re-check reads a slice of the output.
   - PdfTool (js/ws/pdf.js): pdf.js needs the whole document.
   - ImgTool (js/ws/images.js) and js/heic.js: the image decoders. The
     source JPEG's EXIF carried onto a converted JPEG is not a whole-file
     read: it comes from the head, or from one slice up to the end of the
     APP1 Exif segment (jpegExifSpan, js/lib/scrub.js), 128 KiB past the
     head at most.
   - The WAV decode (js/ws/transcode.js): decodeAudioData needs it all.
   - makeZip (js/lib/zip.js): the outputs this page made (page images,
     converted files) being stored in a ZIP, never the file that came in.
   ════════════════════════════════════════════════════════════════ */

const $ = (id) => document.getElementById(id);
const fmtBytes = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n/1024).toFixed(1) + ' KB' : (n/1048576).toFixed(2) + ' MB';
/* i18n bridge: i18n.js loads (deferred) after these scripts, so resolve at call time */
const T = (s) => (window.CarinoI18N && window.CarinoI18N.t) ? window.CarinoI18N.t(s) : s;

/* ─── runtime labels and statuses (B-3) ───
   fmtT(key, vars): T(key) with its {name} placeholders filled from vars.
   A var may itself be translatable: { t: key, v: vars } is rendered with
   fmtT, and an array is each item rendered and joined with " · ". Anything
   else is shown as given (file names, sizes, a raw exception message).

   setText(el, key, vars): writes fmtT(key, vars) and remembers key and vars
   on the element (data-tk, data-tv), so a language switch re-renders it in
   the new language (the files:i18n listener below). Every label or status a
   script swaps at runtime goes through here, never textContent = T(…).
   A falsy key empties the element. setRaw(el, text): text that is not a key
   (OCR output, a digest), which also drops any remembered key, so a later
   language switch cannot bring an old status back over it. */
function fmtT(key, vars){
  const one = (v) => {
    if(v == null) return '';
    if(Array.isArray(v)) return v.map(one).filter(s => s !== '').join(' · ');
    if(typeof v === 'object' && typeof v.t === 'string') return fmtT(v.t, v.v);
    return String(v);
  };
  const s = T(String(key == null ? '' : key));
  if(!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => Object.prototype.hasOwnProperty.call(vars, k) ? one(vars[k]) : m);
}
function setText(el, key, vars){
  if(!el) return el;
  if(!key){ setRaw(el, ''); return el; }
  el.dataset.tk = key;
  if(vars) el.dataset.tv = JSON.stringify(vars); else delete el.dataset.tv;
  el.textContent = fmtT(key, vars);
  return el;
}
function setRaw(el, text){
  if(!el) return el;
  delete el.dataset.tk;
  delete el.dataset.tv;
  el.textContent = text == null ? '' : String(text);
  return el;
}
/* The phone breakpoint every layout rule here shares (css/responsive.css,
   640px): 3 outcome cards instead of 4, the rail panels folded. */
const PHONE_MQ = window.matchMedia ? window.matchMedia('(max-width: 640px)') : { matches: false, addEventListener(){} };
function onPhoneChange(fn){
  if(PHONE_MQ.addEventListener) PHONE_MQ.addEventListener('change', fn);
  else if(PHONE_MQ.addListener) PHONE_MQ.addListener(fn);   // older Safari
}
// Focus is somewhere a key types text: Esc, Backspace and the digit
// shortcuts leave it alone there.
function inTextField(el){
  if(!el || !el.closest) return false;
  if(el.closest('textarea, select, [contenteditable]:not([contenteditable="false"])')) return true;
  const inp = el.closest('input');
  return !!inp && !/^(checkbox|radio|range|button|submit|reset|file|color)$/i.test(inp.type || 'text');
}
// i18n.js fires files:i18n after every (re)application; static [data-i18n]
// text is already done by then, so a runtime label also on a data-i18n
// element (a button showing a transient state) ends up in its runtime text.
window.addEventListener('files:i18n', () => {
  document.querySelectorAll('[data-tk]').forEach(el => {
    let vars;
    try { vars = el.dataset.tv ? JSON.parse(el.dataset.tv) : undefined; } catch(_){ vars = undefined; }
    el.textContent = fmtT(el.dataset.tk, vars);
  });
});

/* ─── Export menus: the arrow keys ───
   carino-ui.js (initMenu) opens and closes every .cs-menu, and Esc closes it
   and returns focus to its button; it has no arrow keys, so they are added
   here: ↓/↑ on the button open it on the first/last item, and inside it
   ↓/↑/Home/End move between the enabled items. Tab leaves and closes it. */
function menuKeys(btn, panel){
  if(!btn || !panel) return;
  const items = () => Array.from(panel.querySelectorAll('.cs-menu-item:not([disabled])'));
  btn.addEventListener('keydown', e => {
    if(e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if(btn.disabled) return;
    e.preventDefault();
    if(panel.hidden) btn.click();
    const list = items();
    if(list.length) list[e.key === 'ArrowDown' ? 0 : list.length - 1].focus();
  });
  panel.addEventListener('keydown', e => {
    const list = items();
    if(!list.length) return;
    const i = list.indexOf(document.activeElement);
    let n = -1;
    if(e.key === 'ArrowDown') n = (i + 1) % list.length;
    else if(e.key === 'ArrowUp') n = (i - 1 + list.length) % list.length;
    else if(e.key === 'Home') n = 0;
    else if(e.key === 'End') n = list.length - 1;
    else if(e.key === 'Tab'){ btn.click(); return; }   // leaving the menu closes it
    if(n < 0) return;
    e.preventDefault();
    list[n].focus();
  });
}

/* ─── download helper (replaces file-saver) ─── */
function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ─── generic dropzone wiring ─── */
function wireDrop(dropEl, inputEl, onFiles, { multiple = false } = {}){
  dropEl.addEventListener('click', () => inputEl.click());
  dropEl.addEventListener('keydown', e => { if(e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputEl.click(); } });
  ['dragenter','dragover'].forEach(ev => dropEl.addEventListener(ev, e => { e.preventDefault(); dropEl.classList.add('dragover'); }));
  ['dragleave','drop'].forEach(ev => dropEl.addEventListener(ev, e => { e.preventDefault(); dropEl.classList.remove('dragover'); }));
  dropEl.addEventListener('drop', e => {
    const fs = e.dataTransfer && e.dataTransfer.files;
    if(fs && fs.length) onFiles(multiple ? Array.from(fs) : [fs[0]]);
  });
  inputEl.addEventListener('change', e => {
    const fs = e.target.files;
    if(fs && fs.length) onFiles(multiple ? Array.from(fs) : [fs[0]]);
    e.target.value = '';
  });
}

/* ─── lazy script loader ───
   One cached Promise per src. A failed load forgets its entry, so the next
   call tries again instead of replaying the failure (the reset heicModule
   always did, generalised). */
const _scripts = new Map();
function loadScript(src){
  if(_scripts.has(src)) return _scripts.get(src);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => { _scripts.delete(src); s.remove(); reject(new Error('Could not load ' + src)); };
    document.head.appendChild(s);
  });
  _scripts.set(src, p);
  return p;
}
/* Vendored globals, by the name they define on window. Paths are relative to
   index.html, next to which vendor/ lives. */
const VENDOR = {
  Tesseract:   'vendor/tesseract/tesseract.min.js',
  // The metadata workspace's parsers and writers, one per format family.
  exifr:       'vendor/metadata/exifr-full.umd.js',
  piexif:      'vendor/metadata/piexif.js',
  PDFLib:      'vendor/metadata/pdf-lib.min.js',
  jsmediatags: 'vendor/metadata/jsmediatags.min.js',
  ID3Writer:   'vendor/metadata/browser-id3-writer.min.js',
  opentype:    'vendor/metadata/opentype.min.js',
};
function needLib(name){
  if(!VENDOR[name]) return Promise.reject(new Error('Unknown library ' + name));
  return loadScript(VENDOR[name]).then(() => window[name] || Promise.reject(new Error(name + ' did not load')));
}

/* ─── reading a file once ───
   headOf: the first 512 KiB, which is all detection and every header parser
   needs. hashOf (below): the SHA-256 of the whole file. Both are cached per File
   object, so the file screen and the metadata workspace share one read. A
   failed read forgets its entry, so the next call tries again. */
const HEAD_BYTES = 524288;
const _heads = new WeakMap();
function headOf(file){
  let p = _heads.get(file);
  if(!p){
    p = file.slice(0, HEAD_BYTES).arrayBuffer().then(b => new Uint8Array(b));
    p.catch(() => _heads.delete(file));
    _heads.set(file, p);
  }
  return p;
}
/* hashOf(file, onProgress?): the SHA-256 of the whole file, hex.
   - Up to HASH_FAST_MAX: crypto.subtle over one read of the file (fast).
   - Above: js/hash-worker.js streams it a 4 MiB slice at a time, so the page
     never freezes and the file is never in memory whole. If no worker can
     start (file:// in some browsers, a blocked script), the same incremental
     hash (js/lib/sha256.js) runs here, a slice at a time with an await
     between slices.
   onProgress(0..1) is called as the stream advances (and with 1 at the end);
   several callers of the same File share one job and all hear its progress.
   cancelHashes(keep) stops every streaming job whose file is not keep: the
   file screen calls it when a new file comes in. A cancelled job rejects
   with an AbortError and, like a failed one, forgets its cache entry, so the
   next hashOf() starts over. */
const HASH_FAST_MAX = 64 * 1048576;    // crypto.subtle up to here
const HASH_AUTO_MAX = 512 * 1048576;   // SHA-256 rows start by themselves up to here; above, a button
const HASH_CHUNK = 4194304;
const _hashes = new WeakMap();         // File → job { p, fns, progress, cancel, file }
const _hashJobs = new Set();           // streaming jobs still running
const hashAbort = () => new DOMException('Hashing cancelled', 'AbortError');
function hashOf(file, onProgress){
  let job = _hashes.get(file);
  if(!job){
    job = { file, fns: new Set(), progress: 0, cancel: null };
    job.report = (x) => { job.progress = x; job.fns.forEach(fn => { try { fn(x); } catch(_){} }); };
    if(file.size <= HASH_FAST_MAX && window.crypto && crypto.subtle){
      job.p = file.arrayBuffer()
        .then(buf => crypto.subtle.digest('SHA-256', buf))
        .then(h => Array.from(new Uint8Array(h), x => x.toString(16).padStart(2, '0')).join(''));
    } else {
      job.p = hashStream(file, job);
      _hashJobs.add(job);
    }
    const settle = (ok) => {
      _hashJobs.delete(job);
      job.cancel = null;
      if(ok) job.report(1);
      else if(_hashes.get(file) === job) _hashes.delete(file);
      job.fns.clear();
    };
    job.p.then(() => settle(true), () => settle(false));
    _hashes.set(file, job);
  }
  if(typeof onProgress === 'function'){
    if(job.progress >= 1) onProgress(1);
    else { job.fns.add(onProgress); if(job.progress) onProgress(job.progress); }
  }
  return job.p;
}
// True once hashOf() has been asked for this file (running or done), so a
// re-render shows the hash instead of offering the button again.
function hashKnown(file){ return _hashes.has(file); }
function cancelHashes(keep){
  Array.from(_hashJobs).forEach(job => { if(job.file !== keep && job.cancel) job.cancel(); });
}
function hashStream(file, job){
  return new Promise((resolve, reject) => {
    let settled = false, heard = false, w = null;
    const stop = () => { if(w){ w.onmessage = w.onerror = null; w.terminate(); w = null; } };
    const ok = (hex) => { if(settled) return; settled = true; stop(); resolve(hex); };
    const fail = (err) => { if(settled) return; settled = true; stop(); reject(err); };
    job.cancel = () => fail(hashAbort());
    const onMain = () => { stop(); hashOnMain(file, job, () => settled).then(ok, fail); };
    try { w = new Worker('js/hash-worker.js'); } catch(_){ w = null; }
    if(!w) return onMain();
    w.onmessage = (e) => {
      heard = true;
      const d = e.data || {};
      if(typeof d.progress === 'number') job.report(d.progress);
      else if(typeof d.hex === 'string') ok(d.hex);
      else fail(new Error(d.error || 'Hash worker failed'));
    };
    // An error before the worker said anything is most likely its script not
    // loading: hash here instead. After that it is a real failure.
    w.onerror = (e) => {
      if(e && e.preventDefault) e.preventDefault();
      if(!heard) onMain(); else fail(new Error((e && e.message) || 'Hash worker failed'));
    };
    w.postMessage({ file, chunk: HASH_CHUNK });
  });
}
async function hashOnMain(file, job, stopped){
  const st = sha256Init(), size = file.size;
  let done = 0, last = 0;
  while(done < size){
    if(stopped()) throw hashAbort();
    const end = Math.min(size, done + HASH_CHUNK);
    sha256Update(st, new Uint8Array(await file.slice(done, end).arrayBuffer()));
    done = end;
    const now = Date.now();
    if(now - last >= 100){ last = now; job.report(done / size); }
  }
  if(stopped()) throw hashAbort();
  return sha256Digest(st);
}

/* ─── the other digests: Verify (spec §8) and Compare's hash rows ───
   digestOf(file, algo, onProgress?) → hex, for 'SHA-256' | 'SHA-1' |
   'SHA-512' | 'MD5'. SHA-256 is hashOf (one job, one cache). SHA-1 and
   SHA-512 go through crypto.subtle, which cannot stream: up to
   HASH_FAST_MAX only, else it rejects with code 'too-large' (the page says
   "Too large to check here"). MD5 is the pure one (js/lib/hashes.js), fed
   HASH_CHUNK slices with an await between them, so any size works and the
   page never freezes. Each result is cached per File and algorithm; a
   failed one forgets itself.
   verifyDigest(file, algo, expected, onProgress?) → { algo, hex, match }. */
const _digests = new WeakMap();   // File → Map(algo → job { p, fns, progress })
function digestTooLarge(file, algo){
  return (algo === 'SHA-1' || algo === 'SHA-512') && file.size > HASH_FAST_MAX;
}
function digestOf(file, algo, onProgress){
  if(algo === 'SHA-256') return hashOf(file, onProgress);
  if(digestTooLarge(file, algo))
    return Promise.reject(Object.assign(new Error('Too large to check here'), { code: 'too-large' }));
  let per = _digests.get(file);
  if(!per){ per = new Map(); _digests.set(file, per); }
  let job = per.get(algo);
  if(!job){
    job = { fns: new Set(), progress: 0 };
    job.report = (x) => { job.progress = x; job.fns.forEach(fn => { try { fn(x); } catch(_){} }); };
    if(algo === 'MD5') job.p = md5Stream(file, job.report);
    else if(algo === 'SHA-1' || algo === 'SHA-512'){
      if(!(window.crypto && crypto.subtle)) job.p = Promise.reject(new Error('Web Crypto is not available'));
      else job.p = file.arrayBuffer().then(buf => crypto.subtle.digest(algo, buf))
        .then(h => Array.from(new Uint8Array(h), x => x.toString(16).padStart(2, '0')).join(''));
    } else job.p = Promise.reject(new Error('Unknown digest ' + algo));
    job.p.then(() => { job.report(1); job.fns.clear(); },
               () => { if(per.get(algo) === job) per.delete(algo); job.fns.clear(); });
    per.set(algo, job);
  }
  if(typeof onProgress === 'function'){
    if(job.progress >= 1) onProgress(1);
    else { job.fns.add(onProgress); if(job.progress) onProgress(job.progress); }
  }
  return job.p;
}
async function md5Stream(file, report){
  const st = md5Init(), size = file.size;
  let done = 0, last = 0;
  while(done < size){
    const end = Math.min(size, done + HASH_CHUNK);
    md5Update(st, new Uint8Array(await file.slice(done, end).arrayBuffer()));
    done = end;
    const now = Date.now();
    if(now - last >= 100){ last = now; report(done / size); }
  }
  return md5Digest(st);
}
async function verifyDigest(file, algo, expected, onProgress){
  const hex = await digestOf(file, algo, onProgress);
  return { algo, hex, match: hex === String(expected == null ? '' : expected).trim().toLowerCase() };
}

/* ─── progress bars: .bar[role=progressbar] > div ───
   The fill's width and the track's aria-valuenow move together, so a screen
   reader hears the same number the bar shows. */
function setBar(fill, pct){
  if(!fill) return;
  pct = Math.max(0, Math.min(100, Math.round(+pct || 0)));
  fill.style.width = pct + '%';
  const track = fill.parentElement;
  if(track && track.getAttribute('role') === 'progressbar') track.setAttribute('aria-valuenow', String(pct));
}

/* ─── toast: one host (#toast in index.html), styled by carino-ui.css ───
   kind: 'ok' (default) | 'info' | 'warn' | 'err'; true means 'err'. */
function toast(msg, kind){
  const el = $('toast');
  if(!el) return;
  const tone = kind === true ? 'err' : (['ok', 'info', 'warn', 'err'].includes(kind) ? kind : 'ok');
  el.textContent = msg;
  el.className = 'toast show ' + tone;
  clearTimeout(el._to);
  el._to = setTimeout(() => { el.className = 'toast'; }, tone === 'err' ? 3200 : 1800);
}
