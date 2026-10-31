'use strict';
/* ════════════════════════════════════════════════════════════════
   0 · DETECT  (unified entry: identify a file, offer the outcomes)
   ════════════════════════════════════════════════════════════════ */
const AutoTool = (() => {
  const drop = $('auto-drop'), result = $('auto-result'), outcomes = $('auto-outcomes');
  const stage = document.querySelector('.auto-stage');
  const preview = $('auto-preview'), thumb = $('auto-thumb');
  const ocrBox = $('auto-ocr');
  const convBox = $('auto-conv'), convState = $('ac-state');
  const pdfBox = $('auto-pdf'), viewActs = $('auto-view-acts');
  let previewURL = null, convFiles = [], hasPdf = false;
  // The PDF page on screen, and a ticket so only the latest request paints.
  let pdfPage = 1, pdfPages = 1, pageTicket = 0, pdfName = '';
  // One per receive(): an older receive still awaiting stops painting.
  let recvTicket = 0;

  /* DICOM is the one outcome this screen hands to another site: the fleet's
     editor reads studies and nothing here does. The file goes with the click,
     over the Carino Bridge (carino-bridge.js): the editor answers when its
     listener exists and the File is posted to it, structured clone and all,
     so nothing is uploaded and nothing is re-encoded. The editor lives on
     dcm.; the PACS page has no bridge receiver. */
  const DICOM_URL = 'https://dcm.carino.systems/';
  function sendTo(url, file){
    if(!window.CarinoBridge){ window.open(url, '_blank', 'noopener'); return; }
    CarinoBridge.send(url, file, { timeout: 30000 })
      .catch(() => toast(T('Could not hand the file to the DICOM editor'), 'err'));
  }

  FilesApp.register({
    id: 'handoff', order: 90,
    accepts: (info) => info.kind === 'dicom',
    // A study lands here often enough — dragged out of a burned CD, or saved
    // from a viewer — so the file goes to the editor with the click rather
    // than the user being pointed at a link and an empty dropzone.
    outcomes: (info, files) => [
      { id: 'dicom', rank: 100, icon: '🩻', title: T('Edit DICOM tags'), desc: T('Send this file to dcm.carino.systems — tag editing, de-identification and a look at the image.'),
        run: () => sendTo(DICOM_URL, files[0]) },
    ],
  });

  /* ─── privacy: a clean copy to share ───
     The bytes work is js/lib/scrub.js, the per-format choices MetaTool.scrub().
     The copy downloads; the original is never changed. What came out is
     listed in #auto-scrub, under the summary card. */
  const scrubBox = $('auto-scrub');
  let scrubReport = null, scrubBusy = false;
  // The detection the file screen already has for f: the single file, or its
  // row in the set. null: MetaTool.scrub detects it from its bytes.
  function detOf(f){
    const s = FilesApp.state;
    if(f === s.file && s.info) return s.info.det;
    const it = s.set && s.set.find(x => x.file === f);
    return it && it.info ? it.info.det : null;
  }

  /* Report lines are English labels or { key, vars } (a PDF's counted
     categories, pdfScrubReport); both re-render by key on files:i18n. A
     file's list longer than SCRUB_REPORT_MAX shows that many, then a
     "+{k} more" chip that opens the rest in place (it.open). */
  const scrubLine = (l) => typeof l === 'string' ? T(l) : fmtT(l.key, l.vars || undefined);
  function renderScrub(){
    scrubBox.innerHTML = '';
    const r = scrubReport;
    if(!r) return;
    const head = mkEl('div', 'fd-head');
    head.append(mkEl('span', 'fd-ico', r.mode === 'gps' ? '📍' : '🧹'), mkEl('span', 'fd-type', T(r.title)));
    if(r.items.length > 1) head.append(mkEl('span', 'fd-detail', String(r.items.length)));
    scrubBox.append(head);
    for(const it of r.items){
      scrubBox.append(mkEl('p', 'scrub-file', it.name));
      if(it.error){ scrubBox.append(mkEl('p', 'fd-note', it.error)); continue; }
      if(it.removed.length){
        const ul = mkEl('ul', 'scrub-list');
        const { shown, more } = scrubTruncate(it.removed, SCRUB_REPORT_MAX, it.open);
        shown.forEach(l => ul.append(mkEl('li', '', scrubLine(l))));
        scrubBox.append(ul);
        if(more){
          const b = mkEl('button', 'chip-tag scrub-more', fmtT('+{k} more', { k: more }));
          b.type = 'button';
          b.setAttribute('aria-expanded', 'false');
          b.addEventListener('click', () => {
            it.open = true;
            renderScrub();
            // Focus lands on the first line that was folded away.
            const li = scrubBox.querySelectorAll('.scrub-list')[r.items.filter(x => !x.error && x.removed.length).indexOf(it)];
            const first = li && li.children[shown.length];
            if(first){ first.tabIndex = -1; first.focus(); }
          });
          scrubBox.append(b);
        }
      } else scrubBox.append(mkEl('p', 'scrub-ok', T('Nothing to remove')));
      [].concat(it.note || []).forEach(n => scrubBox.append(mkEl('p', 'scrub-ok', T(n))));
      if(it.gpsLeft === true) scrubBox.append(mkEl('p', 'fd-note', T('The copy still reports a location.')));
      else if(it.gpsLeft === false) scrubBox.append(mkEl('p', 'scrub-ok', T('Checked: no location left in the copy.')));
    }
  }
  function clearScrub(){ scrubReport = null; scrubBox.innerHTML = ''; }

  /* → the report ({ mode, items, title }; items keep the file each came
     from), or null when a clean copy is already being made. The report is
     drawn only if no other file has landed meanwhile; the download happens
     either way, since it was asked for. */
  async function runScrub(files, mode, asZip){
    if(scrubBusy) return null;
    scrubBusy = true;
    const my = recvTicket;
    toast(T('Making a clean copy…'), 'info');
    const items = [], outs = [];
    try {
      for(const f of files){
        try {
          const r = await MetaTool.scrub(f, detOf(f), mode);
          outs.push(r);
          items.push({ file: f, name: r.name, removed: r.removed, note: r.note, gpsLeft: r.gpsLeft });
        } catch(e){ items.push({ file: f, name: f.name, error: e && e.message || String(e) }); }
      }
      // Asked for, so it downloads even if another file has landed meanwhile.
      if(outs.length === 1 && !asZip) downloadBlob(outs[0].blob, outs[0].name);
      else if(outs.length){
        const seen = new Map();
        const zip = await makeZip(outs.map(o => {
          const n = seen.get(o.name) || 0;
          seen.set(o.name, n + 1);
          return { name: n ? o.name.replace(/(\.[^.]+)?$/, `-${n}$1`) : o.name, blob: o.blob };
        }));
        downloadBlob(zip, 'clean-copies.zip');
      }
      const report = {
        mode, items,
        title: !outs.length ? 'No clean copy was made'
          : mode === 'gps' ? 'Location removed'
          : asZip ? 'Clean copies saved'
          : outs[0].rewritten ? 'Clean copy saved · rewritten' : 'Clean copy saved',
      };
      if(my === recvTicket){
        scrubReport = report;
        renderScrub();
        scrubBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
      return report;
    } finally { scrubBusy = false; }
  }

  FilesApp.register({
    id: 'privacy', order: 850,
    accepts: (info) => MetaTool.canScrub(info.det),
    // Ranks (spec §6.7): the clean copy leads for a photo, follows the page
    // tools for a PDF and the converters for an MP3. Remove location only
    // leads once the photo is known to carry a position, else it waits in More.
    outcomes: (info, files) => {
      const id = info.det.id, out = [];
      const rank = (info.kind === 'image' || info.kind === 'heic') ? 80 : info.kind === 'pdf' ? 70 : 50;
      out.push({ id: 'clean', rank, icon: '🧹', title: T('Clean copy for sharing'),
        desc: (id === 'heic' || id === 'avif')
          ? T('Saves a JPEG copy without location, camera or dates. HEIC and AVIF cannot be cleaned without converting.')
          : T('Downloads a copy without location, camera, author or hidden text. The original is untouched.'),
        run: () => runScrub([files[0]], 'clean') });
      if(id === 'jpeg'){
        const hasGps = !!gpsFound.get(files[0]);
        out.push(Object.assign(hasGps ? { rank: 95 } : { more: true }, { id: 'gps', icon: '📍', title: T('Remove location only'),
          desc: hasGps ? T('This photo says where it was taken: download a copy without the position, everything else kept.')
                       : T('Downloads a copy without any GPS position, everything else kept.'),
          run: () => runScrub([files[0]], 'gps') }));
      }
      return out;
    },
    // The set view (spec §6.8): every file that can be cleaned, as one ZIP.
    setOutcomes: (set) => {
      const k = set.filter(x => x.info && x.info.det && MetaTool.canScrub(x.info.det)).length;
      if(!k) return [];
      return [{ id: 'clean-all', rank: 80, icon: '🧹', title: T('Clean all'),
        desc: T('Every file cleaned the same way, in one ZIP. The originals are untouched.') + ' ' + fmtT('{k} of {n} files', { k, n: set.length }),
        run: () => cleanAll() }];
    },
  });
  // The other set cards live with their workspaces: Convert images in
  // js/ws/images.js; Merge PDFs (rank 70, 2+ PDFs, enters #file/pages) and
  // Compare (rank 100, exactly 2 files, enters #file/compare) come with the
  // Pages and Compare modes, each through its own setOutcomes(set).

  /* Clean all: the rows still being detected are waited for, then every
     file that can be cleaned goes through runScrub as one ZIP
     (clean-copies.zip), and each of those rows says how it went. */
  async function cleanAll(){
    if(scrubBusy) return;
    await detectSet();
    const set = FilesApp.state.set;
    if(!set) return;
    const sub = set.filter(x => x.info && x.info.det && MetaTool.canScrub(x.info.det));
    if(!sub.length) return;
    const report = await runScrub(sub.map(x => x.file), 'clean', true);
    if(!report || FilesApp.state.set !== set) return;
    report.items.forEach(r => {
      const it = set.find(x => x.file === r.file);
      if(!it) return;
      it.status = r.error ? { ok: false, reason: r.error } : { ok: true };
      paintRow(it);
    });
    setReport = report;
    if(view === 'set' && scrubReport !== report){ scrubReport = report; renderScrub(); }
  }

  /* ─── the detection summary card ───
     What the bytes say the file is, and everything the metadata workspace
     would tell you before you open it: type, size, MIME, a name that lies,
     the signature, SHA-256, advisories and the software that opens it. */
  const details = $('auto-details');
  const GPS_IDS = ['jpeg', 'png', 'webp', 'heic', 'avif', 'tiff'];
  const gpsFound = new WeakMap();   // file → { latitude, longitude } | null
  let detTicket = 0;
  const hex12 = (b) => Array.from(b.subarray(0, 12), x => x.toString(16).padStart(2, '0')).join(' ').toUpperCase();
  function mkEl(tag, cls, text){
    const el = document.createElement(tag);
    if(cls) el.className = cls;
    if(text != null) el.textContent = text;
    return el;
  }
  async function renderDetails(file, info){
    const my = ++detTicket;
    const det = info.det || {};
    let bytes = null;
    try { bytes = await headOf(file); } catch(_){}
    if(my !== detTicket) return;
    details.innerHTML = '';
    clearAlert();
    const head = mkEl('div', 'fd-head');
    head.append(mkEl('span', 'fd-ico', det.icon || '❔'), mkEl('span', 'fd-type', T(det.label || info.label)));
    if(det.detail) head.append(mkEl('span', 'fd-detail', det.detail));
    details.append(head);

    const grid = mkEl('dl', 'fd-grid');
    const item = (k, v) => { grid.append(mkEl('dt', '', T(k))); const dd = mkEl('dd', '', v); grid.append(dd); return dd; };
    item('Size', fmtBytes(file.size));
    item('MIME (guess)', det.mime || file.type || '');
    if(bytes) item('File signature (hex)', hex12(bytes));
    const sha = item('SHA-256', '');
    sha.classList.add('fd-sha');
    details.append(grid);
    // Verify (spec §8): one row under the grid, collapsed until asked for.
    const vrow = verifyRow(file);
    details.append(vrow);

    // A name that lies goes to the alert line above the preview, not here.
    const ext = extMismatch(det, file.name);
    if(ext) addAlert('ext', 'Named .{ext}, but the contents are {type}', { ext, type: { t: det.label || info.label } });

    const adv = mkEl('div', 'fd-adv'), reco = mkEl('div', 'fd-reco');
    details.append(adv, reco);
    MetaTool.renderAdvisory(det, adv);
    MetaTool.renderReco(det, file.name, reco, 'Open it with');

    // SHA-256 after the card is on screen; on demand above HASH_AUTO_MAX
    // (512 MiB). Past the crypto.subtle fast path it streams in a worker and
    // shows a progress bar. asked: the button was pressed, so the result is
    // announced (toast).
    const fillSha = (asked) => {
      sha.textContent = '';
      sha.append(mkEl('span', 'hint', T('Hashing…')));
      let fill = null;
      if(file.size > HASH_FAST_MAX){
        const bar = mkEl('div', 'bar fd-sha-bar');
        bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', '100');
        bar.setAttribute('aria-valuenow', '0');
        bar.setAttribute('aria-label', T('SHA-256 progress'));
        fill = mkEl('div');
        bar.append(fill);
        sha.append(bar);
      }
      hashOf(file, p => { if(my === detTicket) setBar(fill, p * 100); })
        .then(hex => {
          if(my !== detTicket) return;
          sha.textContent = '';
          sha.append(mkEl('span', 'fd-sha-hex', hex), ' ', verifyChip());
          if(asked === true) toast(T('SHA-256 computed'));
        }, () => { if(my === detTicket) sha.textContent = '—'; });
    };
    shaFill = () => { if(my === detTicket && !hashKnown(file)) fillSha(false); };
    if(file.size <= HASH_AUTO_MAX || hashKnown(file)) fillSha(false);
    else {
      const b = mkEl('button', 'cs-btn', `${T('Compute SHA-256')} — ${fmtBytes(file.size)}`);
      b.type = 'button';
      b.addEventListener('click', () => fillSha(true));
      sha.append(b);
    }
    // An open Verify row, drawn again (a language switch), checks again.
    if(verify.open && verify.text) runVerify();

    // A photo that says where it was taken: the alert line says so, and
    // "Remove location only" moves up to lead the cards. Quietly nothing if
    // the reader cannot load or the file has no position.
    const showGps = (g, fresh) => {
      if(my !== detTicket || !g) return;
      addAlert('gps', 'This photo contains its GPS location');
      if(fresh && FilesApp.state.file === file) rerankOutcomes();
    };
    if(GPS_IDS.includes(det.id)){
      if(gpsFound.has(file)) showGps(gpsFound.get(file), false);
      else needLib('exifr').then(() => exifr.gps(file)).then(g => {
        const hit = g && isFinite(g.latitude) && isFinite(g.longitude) ? g : null;
        gpsFound.set(file, hit);
        showGps(hit, true);
      }).catch(() => {});
    }

    // The library the likely next step needs, fetched while nothing happens.
    const want = (info.kind === 'image' || info.kind === 'heic') ? 'exifr' : info.kind === 'pdf' ? 'PDFLib' : null;
    if(want){
      const idle = window.requestIdleCallback || (fn => setTimeout(fn, 1500));
      idle(() => needLib(want).catch(() => {}));
    }
  }
  /* ─── Verify (spec §8) ───
     The Verify chip follows the SHA-256 once it is shown; it opens one row
     under the grid: a field for the expected hash and the result. The
     algorithm comes from the length (detectHashAlgo, js/lib/hashes.js) and
     only that digest is computed (digestOf / verifyDigest, js/core.js):
     SHA-256 is the one already on screen; SHA-1 and SHA-512 need the file
     within HASH_FAST_MAX; MD5 streams with a small bar. The result is drawn
     by key (setText), and the row (open, text) survives the card being
     drawn again, for a language switch. Esc closes it. A paste of a bare
     digest on this screen opens it (the paste handler below). */
  let verify = { file: null, open: false, text: '' };
  let verifyTicket = 0;
  let verifyEls = null;     // { row, input, out } of the card on screen
  let shaFill = null;       // starts the SHA-256 of the card on screen when it waits for a button
  function verifyChip(){
    const b = mkEl('button', 'chip-tag fd-verify-chip');
    b.type = 'button';
    setText(b, 'Verify');
    b.setAttribute('aria-expanded', verify.open ? 'true' : 'false');
    b.setAttribute('aria-controls', 'fd-verify');
    b.addEventListener('click', () => { if(verify.open) closeVerify(); else openVerify(null); });
    return b;
  }
  function verifyRow(file){
    if(verify.file !== file) verify = { file, open: false, text: '' };
    verifyTicket++;
    const row = mkEl('div', 'fd-verify' + (verify.open ? '' : ' hidden'));
    row.id = 'fd-verify';
    const input = mkEl('input', 'input');
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('autocapitalize', 'off');
    input.placeholder = T('Paste the expected hash');
    input.setAttribute('aria-label', T('Paste the expected hash'));
    input.value = verify.text;
    const out = mkEl('div', 'fd-verify-out');
    out.setAttribute('aria-live', 'polite');
    row.append(input, out);
    input.addEventListener('input', () => { verify.text = input.value; runVerify(); });
    input.addEventListener('keydown', e => {
      if(e.key !== 'Escape' || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      closeVerify(true);
    });
    verifyEls = { row, input, out, file };
    return row;
  }
  function syncVerifyChip(){
    const c = details.querySelector('.fd-verify-chip');
    if(c) c.setAttribute('aria-expanded', verify.open ? 'true' : 'false');
  }
  // text: a digest to fill in (a paste), or null to keep what is there.
  function openVerify(text){
    const s = FilesApp.state;
    if(!verifyEls || !s.file || verifyEls.file !== s.file) return false;
    verify.open = true;
    if(text != null){ verify.text = String(text).trim(); verifyEls.input.value = verify.text; }
    verifyEls.row.classList.remove('hidden');
    syncVerifyChip();
    verifyEls.input.focus({ preventScroll: true });
    verifyEls.row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    runVerify();
    return true;
  }
  function closeVerify(refocus){
    verify.open = false;
    verifyTicket++;
    if(verifyEls) verifyEls.row.classList.add('hidden');
    syncVerifyChip();
    if(refocus){
      const c = details.querySelector('.fd-verify-chip');
      if(c) c.focus({ preventScroll: true });
    }
  }
  function runVerify(){
    if(!verifyEls) return;
    const { out, file } = verifyEls;
    const my = ++verifyTicket;
    out.innerHTML = '';
    const text = verify.text;
    if(!text.trim()) return;
    const d = detectHashAlgo(text);
    if(!d){ out.append(setText(mkEl('span', 'hint'), 'Not a hash we know')); return; }
    if(digestTooLarge(file, d.algo)){ out.append(setText(mkEl('span', 'hint'), 'Too large to check here')); return; }
    // The SHA-256 row waits for its button above HASH_AUTO_MAX: checking
    // against it is asking for it.
    if(d.algo === 'SHA-256' && shaFill) shaFill();
    out.append(setText(mkEl('span', 'hint'), 'Hashing…'));
    let fill = null;
    if(file.size > HASH_CHUNK){
      const bar = mkEl('div', 'bar fd-verify-bar');
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', '100');
      bar.setAttribute('aria-valuenow', '0');
      bar.setAttribute('aria-label', d.algo);
      fill = mkEl('div');
      bar.append(fill);
      out.append(bar);
    }
    verifyDigest(file, d.algo, d.hex, p => { if(my === verifyTicket) setBar(fill, p * 100); }).then(r => {
      if(my !== verifyTicket) return;
      out.innerHTML = '';
      out.append(setText(mkEl('span', 'badge ' + (r.match ? 'ok' : 'err')), r.match ? 'Match · {algo}' : 'No match · {algo}', { algo: r.algo }));
    }, e => {
      if(my !== verifyTicket) return;
      out.innerHTML = '';
      if(e && e.code === 'too-large') out.append(setText(mkEl('span', 'hint'), 'Too large to check here'));
      else out.append(setText(mkEl('span', 'hint'), 'Error: {msg}', { msg: String(e && e.message || e) }));
    });
  }

  // Advisories, labels and cards are translated as they render: re-render on a language change.
  window.addEventListener('files:i18n', () => {
    const s = FilesApp.state;
    if(view === 'set'){ renderTray(); renderOutcomes(); }
    else if(s.file && !result.classList.contains('hidden')){
      renderDetails(s.file, s.info);
      rerankOutcomes();
    }
    renderScrub();
  });

  /* ─── the alert line (#auto-alert, spec §5.1) ───
     Above the preview, only when needed: a name that lies about the contents
     and a photo that carries its position, one <p> each, by key, so a
     language switch re-renders them. */
  const alertBox = $('auto-alert');
  function clearAlert(){ alertBox.innerHTML = ''; alertBox.classList.add('hidden'); }
  function addAlert(id, key, vars){
    let p = alertBox.querySelector('p[data-alert="' + id + '"]');
    if(!p){ p = mkEl('p'); p.dataset.alert = id; alertBox.append(p); }
    setText(p, key, vars);
    alertBox.classList.remove('hidden');
  }

  /* ─── outcome cards: ranked, capped, the rest behind More (spec §6) ───
     FilesApp.outcomes() ranks them; layoutOutcomes() (js/lib/outcomes.js)
     splits them at the cap, 4 cards above 640px and 3 at 640px and below,
     the pinned "Inspect / edit metadata" last among them. The rest wait
     behind a last .oc-more tile that opens them in place and then reads
     Less. Ordinals 1–9 number the cards as drawn, the tile included, and
     the digit keys follow the same order. A card's run() gets the card,
     so a mode it opens can give focus back to it. */
  let ocMoreOpen = false;
  function outcomeBtn(o){
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'oc-card';
    if(o.id) b.dataset.oc = o.id;
    b.innerHTML = '<div class="oc-t"><span></span><span></span><span class="oc-n"></span></div><div class="oc-d"></div>';
    const [i, t] = b.querySelectorAll('.oc-t span');
    i.textContent = o.icon || ''; t.textContent = o.title || '';
    b.querySelector('.oc-d').textContent = o.desc || '';
    b.addEventListener('click', () => { if(typeof o.run === 'function') o.run(b); });
    return b;
  }
  function moreTile(k){
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'oc-card oc-more';
    b.dataset.oc = 'more';
    b.setAttribute('aria-expanded', ocMoreOpen ? 'true' : 'false');
    b.innerHTML = '<div class="oc-t"><span></span><span class="oc-n"></span></div>';
    const label = b.querySelector('.oc-t span');
    if(ocMoreOpen) setText(label, 'Less'); else setText(label, 'More ({k})', { k });
    b.addEventListener('click', () => { ocMoreOpen = !ocMoreOpen; renderOutcomes(); });
    return b;
  }
  function renderOutcomes(){
    const s = FilesApp.state;
    // Focus stays on the same card (by id) through a re-render.
    const ae = document.activeElement;
    const had = ae && outcomes.contains(ae) && ae.dataset ? ae.dataset.oc : null;
    outcomes.innerHTML = '';
    // The set view's cards come from setOutcomes (spec §6.8), same rules.
    let list;
    if(view === 'set' && s.set) list = FilesApp.setOutcomes(s.set);
    else if(s.file && s.info) list = FilesApp.outcomes(s.info, s.files);
    else return;
    const { visible, more } = layoutOutcomes(list, PHONE_MQ.matches ? 3 : 4);
    if(!more.length) ocMoreOpen = false;
    visible.forEach(o => outcomes.append(outcomeBtn(o)));
    if(more.length){
      if(ocMoreOpen) more.forEach(o => outcomes.append(outcomeBtn(o)));
      outcomes.append(moreTile(more.length));
    }
    outcomes.querySelectorAll('.oc-card').forEach((c, i) => { c.querySelector('.oc-n').textContent = i < 9 ? String(i + 1) : ''; });
    if(had){
      const again = outcomes.querySelector('.oc-card[data-oc="' + CSS.escape(had) + '"]');
      if(again) again.focus({ preventScroll: true });
    }
  }
  // After an async signal (GPS found, a text layer known): the same cards,
  // ranked again, drawn in place.
  function rerankOutcomes(){ if(FilesApp.state.file) renderOutcomes(); }
  onPhoneChange(() => { if(!result.classList.contains('hidden')) renderOutcomes(); });

  function clearPreview(){
    if(previewURL){ URL.revokeObjectURL(previewURL); previewURL = null; }
    thumb.removeAttribute('src');
    thumb.classList.remove('inverted');
    preview.classList.add('hidden');
  }
  /* The one place thumb.src is assigned. Everything shown on this screen — a
     pasted image, a rendered PDF page, a page picked out of the grid — arrives
     here as a blob and leaves as exactly one object URL, revoked when the next
     one replaces it. */
  function showBlob(blob, alt){
    if(previewURL) URL.revokeObjectURL(previewURL);
    previewURL = URL.createObjectURL(blob);
    thumb.src = previewURL;
    thumb.alt = alt || '';
    thumb.classList.remove('inverted');
    preview.classList.remove('hidden');
  }

  // Files out sit in the pane's top bar, shown with the panel they belong to.
  function syncOut(){
    $('ac-go').classList.toggle('hidden', convBox.classList.contains('hidden'));
    $('pdf-zip').classList.toggle('hidden', pdfBox.classList.contains('hidden'));
  }

  // Every panel off; receive() turns back on only the ones the file type earns.
  function resetPanels(){
    OcrTool.reset();
    ocrBox.classList.add('hidden');
    convBox.classList.add('hidden');
    setText(convState, '');
    convFiles = [];
    pdfBox.classList.add('hidden');
    syncOut();
    // Through the renderer rather than by emptying the grid here: the cards
    // hold an object URL each, and only the renderer knows to give them back.
    PdfTool.reset();
    clearScrub();
    viewActs.classList.add('hidden');
    $('pdf-pager').classList.add('hidden');
    hasPdf = false;
    shownFile = null;
    pageTicket++;
  }

  /* The pager. The number moves at once; the render follows, and a slow
     render that has been overtaken by a newer request is dropped. */
  function syncPager(){
    $('pp-range').max = pdfPages;
    $('pp-range').value = pdfPage;
    $('pp-n').textContent = `${pdfPage} / ${pdfPages}`;
    $('pp-prev').disabled = pdfPage <= 1;
    $('pp-next').disabled = pdfPage >= pdfPages;
    [['pp-prev', 'Previous page'], ['pp-next', 'Next page'], ['pp-range', 'Page']].forEach(([id, k]) => {
      $(id).setAttribute('aria-label', T(k)); $(id).title = T(k);
    });
  }
  let pageTimer = 0;
  function goPage(num, delay = 0){
    if(!hasPdf) return;
    num = Math.max(1, Math.min(pdfPages, num | 0));
    pdfPage = num;
    syncPager();
    const ticket = ++pageTicket;
    clearTimeout(pageTimer);
    pageTimer = setTimeout(async () => {
      try {
        const r = await PdfTool.previewPage(num);
        if(r && ticket === pageTicket) showBlob(r.blob, `${pdfName} — ${T('Page')} ${num}`);
      } catch(e){ console.error(e); }
    }, delay);
  }

  /* OCR waits for a click (spec §7.1, O-1). An image is on screen the moment
     it lands, but the recogniser — Tesseract and its model, megabytes — is
     only fetched when Extract text is pressed. That press opens #auto-ocr
     and reads the image, or the PDF page on screen rendered at OCR
     resolution. Once the panel has been opened in this page session, the
     next image or PDF to land lets the engine load while the page is idle.

     shownFile: the image as displayed (a HEIC decoded to PNG), or the promise
     of it while libheif still works. */
  let shownFile = null;
  function openOcrPanel(){
    const first = ocrBox.classList.contains('hidden');
    ocrBox.classList.remove('hidden');
    OcrTool.markOpened();
    // Its first appearance brings it into view (spec §5.1).
    if(first) ocrBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  async function ocrImage(ticket = recvTicket){
    openOcrPanel();
    // A decode that failed is tried again by load(), which says why in the panel.
    const file = (await shownFile) || FilesApp.state.file;
    if(!file || ticket !== recvTicket) return;
    const armed = await OcrTool.load(file);
    if(!armed || ticket !== recvTicket) return;   // failure is already in the panel
    OcrTool.run().catch(() => {});
  }

  /* A PDF page, handed to the recogniser without leaving the screen. The page
     is rendered again for this rather than reusing what is on the card: that
     one was rendered for export, possibly at 72 DPI, and OCR needs ~300. */
  async function ocrPage(num){
    const my = recvTicket;
    openOcrPanel();
    OcrTool.clear();
    setText($('ao-state'), 'Rendering page');
    let file;
    try { file = await PdfTool.renderForOcr(num); }
    catch(e){ if(my === recvTicket) setText($('ao-text'), 'Error: {msg}', { msg: String(e && e.message || e) }); return; }
    if(!file || my !== recvTicket) return;
    const armed = await OcrTool.load(file);
    if(!armed || my !== recvTicket) return;
    OcrTool.run().catch(() => {});
  }

  // The Make searchable card: the panel opens and every page is read.
  function makeSearchable(){
    if(!hasPdf) return;
    openOcrPanel();
    OcrTool.searchableDoc();
  }

  /* ─── the set: several files at once (spec §9) ───
     Two or more files arriving together (a drop, a paste, a pick, the
     bridge) open the set view: the rail keeps the dropzone, now "Add files",
     and one summary chip; the pane has the set cards, the tray (one row per
     file) and the bulk report. While a set is held, whatever lands on this
     screen joins it, even with one of its files open in single view; with
     one file held, a new file replaces it as before. FilesApp.state.set is
     [{ file, info }]; info stays null until the row is detected, from the
     head only (sniffFile), never hashed. Removing rows down to one file
     shows that file; down to none, the hero. Clear (the chip's ✕) empties
     everything. */
  const tray = $('auto-tray'), setCount = $('set-count'), setBack = $('set-back'), setExport = $('set-export');
  const dropTitle = drop.querySelector('.d-title');
  const DROP_KEY = 'Drop any file here — or paste with Ctrl+V';
  let view = null;          // what the file screen shows: 'single' | 'set' | null (the hero)
  let setReport = null;     // the set's last bulk report, drawn again on the way back to it
  let trayFocus = 0;        // the row whose button is in the tab order (roving tabindex)
  let detecting = null;     // the detection pass under way, if any
  const inSet = (it) => !!FilesApp.state.set && FilesApp.state.set.includes(it);

  // The rail, pane-bar and tray for the view on screen.
  function setChrome(isSet){
    const held = !!FilesApp.state.set;
    stage.classList.toggle('set', isSet);
    tray.classList.toggle('hidden', !isSet);
    setCount.classList.toggle('hidden', !isSet);
    setExport.classList.toggle('hidden', !isSet);
    setBack.classList.toggle('hidden', isSet || !held);
    if(!isSet) tray.innerHTML = '';
    setText(dropTitle, held ? 'Add files' : DROP_KEY);
  }
  // Files join the set once each (the same name, size and date count as one).
  function addToSet(files){
    const s = FilesApp.state;
    const set = s.set || [];
    files.forEach(f => { if(!set.some(x => sameFile(x.file, f))) set.push({ file: f, info: null }); });
    s.set = set;
    return set;
  }
  function endSet(){
    FilesApp.state.set = null;
    setReport = null;
    trayFocus = 0;
  }

  // One pass over the rows not detected yet, each row and the cards drawn
  // again as it resolves. Rows removed meanwhile are skipped; a row that
  // cannot be read says why.
  function detectSet(){
    if(detecting) return detecting;
    detecting = (async () => {
      for(;;){
        const set = FilesApp.state.set;
        const it = set && set.find(x => !x.info && !x.error);
        if(!it) break;
        try { it.info = await sniffFile(it.file); }
        catch(e){ it.error = String(e && e.message || e); }
        if(!inSet(it)) continue;
        paintRow(it);
        paintSetChip();
        if(view === 'set') renderOutcomes();
      }
    })().finally(() => { detecting = null; });
    return detecting;
  }

  // The rail chip: SET, "{n} files", "{mix} · {size}"; the pane-bar's count
  // and the way back read the same number.
  function paintSetChip(){
    const set = FilesApp.state.set;
    if(!set) return;
    const sum = setSummary(set);
    setRaw($('auto-ico'), 'SET');
    $('auto-ico').className = 'f-ico';
    setText($('auto-name'), '{n} files', { n: sum.n });
    setText($('auto-meta'), '{mix} · {size}', { mix: sum.mix, size: fmtBytes(sum.size) });
    setText(setCount, '{n} files', { n: sum.n });
    setText(setBack, '← {n} files', { n: sum.n });
  }

  /* A tray row: a .file-chip whose body is a button (opens the file) and
     whose ✕ removes it. .f-meta reads "{type} · {size}", then the last bulk
     run's ✓ Done / ✕ {reason}, then a name that lies, in the warn colour. */
  function rowEl(it, i){
    const row = mkEl('div', 'file-chip');
    row.setAttribute('role', 'listitem');
    row.dataset.i = String(i);
    const open = mkEl('button', 'tray-open');
    open.type = 'button';
    open.tabIndex = i === trayFocus ? 0 : -1;
    open.setAttribute('aria-keyshortcuts', 'Delete');
    const info = mkEl('span', 'f-info');
    const name = mkEl('span', 'f-name', it.file.name);
    name.title = it.file.name;
    info.append(name, mkEl('span', 'f-meta'));
    open.append(mkEl('span', 'f-ico'), info);
    const x = mkEl('button', 'f-x', '✕');
    x.type = 'button';
    x.tabIndex = -1;
    x.setAttribute('aria-label', T('Remove'));
    x.title = T('Remove');
    row.append(open, x);
    it.el = row;
    paintRow(it);
    return row;
  }
  function paintRow(it){
    const row = it.el;
    if(!row) return;
    const b = kindBadge(it.error ? { kind: 'unknown' } : it.info);
    const ico = row.querySelector('.f-ico');
    ico.textContent = b.code;
    ico.className = 'f-ico ct-cat-' + b.cat;
    const meta = row.querySelector('.f-meta');
    meta.innerHTML = '';
    const size = fmtBytes(it.file.size);
    if(it.error){ meta.append(setText(mkEl('span', 'tray-err'), '✕ {reason}', { reason: it.error })); return; }
    if(!it.info){ meta.textContent = '… · ' + size; return; }
    meta.append(setText(mkEl('span'), '{label} · {size}', { label: { t: it.info.label }, size }));
    if(it.status) meta.append(' ', setText(mkEl('span', it.status.ok ? 'tray-ok' : 'tray-err'), '· {s}',
      { s: it.status.ok ? { t: '✓ Done' } : { t: '✕ {reason}', v: { reason: it.status.reason } } }));
    const ext = it.info.det && extMismatch(it.info.det, it.file.name);
    if(ext) meta.append(' ', setText(mkEl('span', 'tray-warn'), '· {msg}',
      { msg: { t: 'Named .{ext}, but the contents are {type}', v: { ext, type: { t: it.info.label } } } }));
  }
  function renderTray(){
    const set = FilesApp.state.set || [];
    const ae = document.activeElement;
    const hadFocus = !!ae && tray.contains(ae);
    tray.innerHTML = '';
    trayFocus = Math.max(0, Math.min(trayFocus, set.length - 1));
    set.forEach((it, i) => tray.append(rowEl(it, i)));
    if(hadFocus) focusRow(trayFocus);
  }
  // ↑/↓ move the one tab stop between the rows (spec §19).
  function focusRow(i){
    const btns = tray.querySelectorAll('.tray-open');
    if(!btns.length) return;
    trayFocus = Math.max(0, Math.min(i, btns.length - 1));
    btns.forEach((b, j) => { b.tabIndex = j === trayFocus ? 0 : -1; });
    btns[trayFocus].focus({ preventScroll: false });
  }

  /* The set view. opts.quiet: the files are going to Metadata (the bridge),
     so focus stays put; opts.row: back from a file opened from the tray,
     whose row gets focus again. Nothing is detected twice. */
  function showSetView(opts){
    opts = opts || {};
    view = 'set';
    recvTicket++;   // a single file still loading stops painting here
    detTicket++;
    details.innerHTML = '';
    clearAlert();
    clearPreview();
    resetPanels();
    outcomes.innerHTML = '';
    ocMoreOpen = false;
    cancelHashes(null);
    Object.assign(FilesApp.state, { files: [], file: null, info: null });
    setWsFile('');
    renderSameFile();
    result.classList.remove('hidden');
    stage.classList.add('loaded');
    $('auto-rail').prepend(drop);
    setChrome(true);
    paintSetChip();
    renderTray();
    renderOutcomes();
    scrubReport = setReport;
    renderScrub();
    if(opts.row) focusRow(trayFocus);
    else if(!opts.quiet && (!document.activeElement || document.activeElement === document.body))
      result.querySelector('.pane-title').focus({ preventScroll: true });
    detectSet();
  }
  function openFromSet(i){
    const it = FilesApp.state.set && FilesApp.state.set[i];
    if(!it) return;
    trayFocus = i;
    showSingle(it.file, {}, it.info);
  }
  function backToSet(){
    if(FilesApp.state.set && view === 'single') showSetView({ row: true });
  }
  function removeFromSet(i){
    const set = FilesApp.state.set;
    if(!set || !set[i]) return;
    set.splice(i, 1);
    if(!set.length){ clearAll(); return; }
    if(set.length === 1){
      const last = set[0];
      endSet();
      showSingle(last.file, {}, last.info);
      return;
    }
    trayFocus = Math.min(i, set.length - 1);
    paintSetChip();
    renderTray();
    renderOutcomes();
  }

  tray.addEventListener('click', e => {
    const row = e.target.closest && e.target.closest('.file-chip[data-i]');
    if(!row) return;
    const i = +row.dataset.i;
    if(e.target.closest('.f-x')) removeFromSet(i);
    else if(e.target.closest('.tray-open')) openFromSet(i);
  });
  tray.addEventListener('keydown', e => {
    const row = e.target.closest && e.target.closest('.file-chip[data-i]');
    if(!row || e.ctrlKey || e.metaKey || e.altKey) return;
    const i = +row.dataset.i, n = tray.querySelectorAll('.tray-open').length;
    let to = -1;
    if(e.key === 'ArrowDown') to = Math.min(n - 1, i + 1);
    else if(e.key === 'ArrowUp') to = Math.max(0, i - 1);
    else if(e.key === 'Home') to = 0;
    else if(e.key === 'End') to = n - 1;
    else if(e.key === 'Delete'){ e.preventDefault(); removeFromSet(i); return; }
    if(to < 0) return;
    e.preventDefault();
    focusRow(to);
  });
  setBack.addEventListener('click', backToSet);
  // Backspace or Esc in a file opened from the tray goes back to the tray.
  // Capture phase, as the modes' Esc (js/router.js): an open menu or modal
  // keeps its Esc, and a text field keeps both keys.
  window.addEventListener('keydown', e => {
    if(e.key !== 'Backspace' && e.key !== 'Escape') return;
    if(view !== 'single' || !FilesApp.state.set) return;
    if(e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if(!$('tool-auto').classList.contains('active')) return;
    if(inTextField(document.activeElement)) return;
    if(window.CarinoUI && CarinoUI.modal && CarinoUI.modal.top()) return;
    if(document.querySelector('.cs-menu-panel:not([hidden])')) return;
    e.preventDefault();
    backToSet();
  }, true);

  /* Export ▾ → Metadata as CSV / JSON: one row (one object) per file, read
     through the metadata workspace's own parsers (MetaTool.extract), one
     file at a time with its count in a toast. Columns: file, type, size,
     MIME, then every "Group: Key" any file has (js/lib/tray.js). */
  let exporting = false;
  async function exportSet(kind){
    if(exporting || !FilesApp.state.set) return;
    exporting = true;
    const btn = $('set-export-btn');
    btn.disabled = true;
    try {
      await detectSet();
      const list = (FilesApp.state.set || []).slice();
      const rows = [];
      for(let i = 0; i < list.length; i++){
        const it = list[i];
        toast(fmtT('Reading metadata {i} / {n}…', { i: i + 1, n: list.length }), 'info');
        let c = null, err = null;
        try { c = await MetaTool.extract(it.file, it.info); }
        catch(e){ err = String(e && e.message || e); }
        const det = (c && c.det) || (it.info && it.info.det) || {};
        rows.push({ file: it.file.name, type: det.label || '', size: it.file.size, mime: det.mime || it.file.type || '',
          meta: c ? flattenMeta(c.groups) : [{ group: 'Parser', key: 'Note', value: err || '' }] });
      }
      if(!rows.length) return;
      const name = kind === 'json' ? 'files-metadata.json' : 'files-metadata.csv';
      const blob = kind === 'json'
        ? new Blob([JSON.stringify(rowsToJson(rows), null, 2)], { type: 'application/json' })
        : new Blob([rowsToCsv(rows)], { type: 'text/csv' });
      downloadBlob(blob, name);
      toast(T('Downloaded') + ' ' + name);
    } finally {
      exporting = false;
      btn.disabled = false;
    }
  }
  $('set-export-csv').addEventListener('click', () => exportSet('csv'));
  $('set-export-json').addEventListener('click', () => exportSet('json'));
  menuKeys($('set-export-btn'), $('set-export-menu'));

  /* Every way in. Two or more files, or any file while a set is held, go to
     the set (above). opts.open: 'metadata' (the metadata dropzone, a paste
     there, the bridge to #metadata): one file fills this screen as usual
     and opens in the metadata workspace; with a set, the set stays on this
     screen and its first new file opens in Metadata (spec §9.9). */
  async function receive(files, opts){
    files = Array.from(files || []);
    if(!files.length) return;
    opts = opts || {};
    const toMeta = opts.open === 'metadata';
    if(files.length > 1 || FilesApp.state.set){
      const set = addToSet(files);
      if(set.length > 1){
        if(!toMeta) showTool('auto');
        showSetView({ quiet: toMeta });
        if(toMeta){
          const it = set.find(x => sameFile(x.file, files[0]));
          MetaTool.open(it.file, it.info);
          showTool('metadata');
        }
        return;
      }
      // The same file twice: just the one.
      endSet();
      files = [set[0].file];
    }
    return showSingle(files[0], opts);
  }

  /* One file on the file screen. known: its detection, when the tray has it
     already. A receive overtaken by a newer one stops at its next await
     (recvTicket, above). */
  async function showSingle(first, opts, known){
    opts = opts || {};
    const my = ++recvTicket;
    const toMeta = opts.open === 'metadata';
    if(!toMeta) showTool('auto');
    let info = known || null;
    if(!info){
      try { info = await sniffFile(first); }
      catch(e){ if(my === recvTicket) toast(T('Failed to read file:') + ' ' + (e && e.message || e), 'err'); return; }
      if(my !== recvTicket) return;
    }
    const files = [first];
    view = 'single';
    setChrome(false);
    setRaw($('auto-name'), first.name);
    setWsFile(first.name);
    setText($('auto-meta'), '{label}{detail} · {size}', { label: { t: info.label }, detail: info.detail ? ' (' + info.detail + ')' : '',
      size: fmtBytes(first.size) });
    const badge = kindBadge(info);
    setRaw($('auto-ico'), badge.code);
    $('auto-ico').className = 'f-ico ct-cat-' + badge.cat;
    outcomes.innerHTML = '';
    ocMoreOpen = false;
    resetPanels();

    const isImage = info.kind === 'image' || info.kind === 'heic';
    clearPreview();
    Object.assign(FilesApp.state, { files, file: first, info });
    // A hash still streaming for the previous file stops here.
    cancelHashes(first);
    renderSameFile();
    renderDetails(first, info);

    if(info.kind === 'pdf'){
      // The page renderer's own controls, on this screen. Nothing to link to.
      pdfBox.classList.remove('hidden');
      syncOut();
    }
    // The cards come from the workspace registry (js/router.js), ranked.
    renderOutcomes();
    result.classList.remove('hidden');
    stage.classList.add('loaded');
    $('auto-rail').prepend(drop);
    // Moving the dropzone into the rail drops its focus: give it to the
    // screen's title, so keyboard and screen-reader users stay on this screen.
    if(!toMeta && my === recvTicket && (!document.activeElement || document.activeElement === document.body))
      result.querySelector('.pane-title').focus({ preventScroll: true });
    if(toMeta){
      MetaTool.open(first, info);
      showTool('metadata');
    }
    if(isImage){
      convBox.classList.remove('hidden');
      syncOut();
      setText(convState, '');
      syncSummaries();
      // Extract text sits under the picture (spec §5.1); nothing is read
      // until it is pressed.
      viewActs.classList.remove('hidden');
      // Usable the moment the panel appears, then upgraded: a HEIC is decoded
      // once (js/heic.js), and the PNG that comes back is what is displayed,
      // what gets converted and what OCR reads. Anything else is shown as is.
      convFiles = files;
      shownFile = normalizeImageFile(first).catch(e => {
        if(my === recvTicket) toast(fmtT('Error: {msg}', { msg: String(e && e.message || e) }), 'err');
        return null;
      });
      let shown = await shownFile;
      if(my !== recvTicket) return;
      // Identified as an image by its bytes but given no image type (a PNG
      // named "scan"): typed from the detection, so OCR and Convert take it.
      const mime = info.det && info.det.mime || '';
      if(shown && !/^image\//.test(shown.type || '') && /^image\//.test(mime)){
        shown = new File([shown], shown.name, { type: mime });
        shownFile = Promise.resolve(shown);
      }
      if(shown){
        showBlob(shown, shown.name);
        convFiles = [shown];
      }
      OcrTool.prefetch();
    } else if(info.kind === 'pdf'){
      // Page 1 renders immediately so the screen shows the document, not just
      // its name. It is only the picture: the button below re-renders the page
      // at OCR resolution rather than reading this one.
      const loaded = await PdfTool.open(first);
      if(my !== recvTicket) return;
      if(loaded && loaded.preview){
        showBlob(loaded.preview.blob, first.name);
        hasPdf = true;
        pdfName = first.name;
        pdfPage = 1; pdfPages = loaded.pageCount;
        syncPager();
        $('pdf-pager').classList.toggle('hidden', pdfPages < 2);
        viewActs.classList.remove('hidden');
        OcrTool.setDoc({ name: first.name, eachPage: PdfTool.eachOcrPage });
        OcrTool.prefetch();
        // A scan (no text on page 1) moves Make searchable up the cards.
        if(!pdfTextLayer.has(first)){
          const has = await PdfTool.hasTextLayer();
          if(my !== recvTicket) return;
          pdfTextLayer.set(first, has);
          rerankOutcomes();
        }
      }
    }
  }

  wireDrop(drop, $('auto-input'), receive, { multiple: true });
  // Clear: the file, or the whole set, gone; back to the hero.
  function clearAll(){
    endSet();
    view = null;
    setChrome(false);
    result.classList.add('hidden');
    stage.classList.remove('loaded');
    $('auto-hero-input').appendChild(drop);
    outcomes.innerHTML = '';
    ocMoreOpen = false;
    details.innerHTML = '';
    clearAlert();
    detTicket++;
    clearPreview();
    resetPanels();
    setWsFile('');
    // Cleared means gone: no workspace offers it as "Same file" any more.
    recvTicket++;
    Object.assign(FilesApp.state, { files: [], file: null, info: null, set: null });
    renderSameFile();
    drop.focus({ preventScroll: true });
  }
  $('auto-clear').addEventListener('click', clearAll);

  /* The outcomes answer to their ordinals — 1, 2, 3 — while the chooser is up. */
  window.addEventListener('keydown', e => {
    if(e.target && e.target.closest && e.target.closest('input,textarea,select,[contenteditable]')) return;
    if(e.ctrlKey || e.metaKey || e.altKey) return;
    if(!$('tool-auto').classList.contains('active') || result.classList.contains('hidden')) return;
    const ae = document.activeElement;
    if(ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
    const n = /^[1-9]$/.test(e.key) ? +e.key : 0;
    if(!n) return;
    const cards = outcomes.querySelectorAll('.oc-card');
    if(n > cards.length) return;
    e.preventDefault();
    cards[n - 1].click();
  });

  // Extract text: the image on screen, or the PDF page on screen re-rendered
  // at OCR resolution. The first press is what loads the recogniser.
  $('av-ocr').addEventListener('click', () => {
    if(hasPdf) ocrPage(pdfPage);
    else if(shownFile) ocrImage();
  });
  $('pp-prev').addEventListener('click', () => goPage(pdfPage - 1));
  $('pp-next').addEventListener('click', () => goPage(pdfPage + 1));
  // Dragging repaints the number live and renders once the thumb rests.
  $('pp-range').addEventListener('input', () => goPage(+$('pp-range').value, 120));
  // ← / → leaf through the PDF while the file screen is up.
  window.addEventListener('keydown', e => {
    if(e.target && e.target.closest && e.target.closest('input,textarea,select,[contenteditable]')) return;
    if(!hasPdf || e.ctrlKey || e.metaKey || e.altKey) return;
    if(!$('tool-auto').classList.contains('active') || result.classList.contains('hidden')) return;
    const ae = document.activeElement;
    // Includes the slider, which handles its own arrows.
    if(ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
    if(e.key === 'ArrowLeft'){ e.preventDefault(); goPage(pdfPage - 1); }
    else if(e.key === 'ArrowRight'){ e.preventDefault(); goPage(pdfPage + 1); }
  });
  $('ac-more').addEventListener('click', () => { ImgTool.open(convFiles); showTool('images'); });

  const acFmt = () => document.querySelector('input[name="ac-fmt"]:checked').value;
  document.querySelectorAll('input[name="ac-fmt"]').forEach(r => r.addEventListener('change', () =>
    $('ac-quality-group').classList.toggle('hidden', acFmt() === 'image/png')));
  $('ac-quality').addEventListener('input', () => $('ac-quality-val').textContent = $('ac-quality').value + '%');

  /* ─── the rail panels on a phone (spec §5.2) ───
     Convert and Pages to images are <details>: open above 640px, where their
     head looks and acts as it always did (no toggle), and closed at 640px and
     below, where the head is a button reading the panel's title and its
     current values ("Convert · WebP · 85% · Strip"). Set once when the page
     starts; after that the user's own opening and closing is left alone,
     except that a panel always opens again on the way back above 640px,
     where it has no head to open it with. */
  const FOLDS = [convBox, pdfBox].map(box => box.querySelector('details.rail-fold')).filter(Boolean);
  const radioVal = (name) => { const r = document.querySelector('input[name="' + name + '"]:checked'); return r ? r.value : ''; };
  const fmtName = (mime) => ({ 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WebP' })[mime] || '';
  function syncSummaries(){
    const acF = acFmt(), acV = [fmtName(acF)];
    if(acF !== 'image/png') acV.push($('ac-quality').value + '%');
    const maxDim = parseInt($('ac-maxdim').value, 10);
    if(maxDim > 0) acV.push('≤ ' + maxDim + ' px');
    acV.push({ t: radioVal('ac-meta') === 'keep' ? 'Keep' : 'Strip' });
    setText($('ac-sum'), '· {v}', { v: acV });
    const pdfF = radioVal('pdf-fmt'), range = $('pdf-range').value.trim();
    const dpi = parseInt($('pdf-scale').value, 10) || 150;
    setText($('pdf-sum'), '· {v}', { v: [fmtName(pdfF), dpi + ' DPI', range ? range : { t: 'all' }] });
  }
  function foldFor(wide){
    FOLDS.forEach(d => {
      const head = d.querySelector('summary');
      if(head) head.tabIndex = wide ? -1 : 0;
      if(wide) d.open = true;
    });
  }
  FOLDS.forEach(d => {
    d.open = !PHONE_MQ.matches;
    // Above 640px the head is only a heading: a click there toggles nothing.
    d.querySelector('summary').addEventListener('click', e => { if(!PHONE_MQ.matches) e.preventDefault(); });
    d.addEventListener('input', syncSummaries);
    d.addEventListener('change', syncSummaries);
  });
  foldFor(!PHONE_MQ.matches);
  onPhoneChange(() => foldFor(!PHONE_MQ.matches));
  syncSummaries();

  $('ac-go').addEventListener('click', async () => {
    if(!convFiles.length) return;
    const btn = $('ac-go');
    btn.disabled = true;
    const format = acFmt();
    const quality = (parseInt($('ac-quality').value, 10) || 85) / 100;
    const maxDim = parseInt($('ac-maxdim').value, 10) || 0;
    const meta = ImgTool.metaOpts('ac');
    // convFiles[0] may be the decoded copy (HEIC → PNG); its EXIF source is the file received.
    const sources = FilesApp.state.files;
    try {
      const out = [];
      for(let i = 0; i < convFiles.length; i++){
        const f = convFiles[i];
        setText(convState, 'Converting {name}…', { name: f.name });
        out.push(await ImgTool.encodeFile(f, format, quality, maxDim, Object.assign({ source: sources[i] || f }, meta)));
      }
      // The metadata badges by key, so a language switch re-renders them.
      const seenBadge = new Set(), badges = [];
      out.forEach(o => { const b = ImgTool.metaBadgeKey(o), k = JSON.stringify(b); if(!seenBadge.has(k)){ seenBadge.add(k); badges.push(b); } });
      // One file downloads as itself; a batch downloads as one archive rather
      // than firing a download per image.
      if(out.length === 1){
        downloadBlob(out[0].blob, out[0].name);
        setText(convState, '{fmt} {w}×{h} · {size} · {badges}',
          { fmt: out[0].ext.toUpperCase(), w: out[0].w, h: out[0].h, size: fmtBytes(out[0].blob.size), badges });
      } else {
        const seen = new Map();
        const zip = await makeZip(out.map(o => {
          const n = seen.get(o.name) || 0;
          seen.set(o.name, n + 1);
          return { name: n ? o.name.replace(/\.([^.]+)$/, `-${n}.$1`) : o.name, blob: o.blob };
        }));
        downloadBlob(zip, 'converted-images.zip');
        setText(convState, '{zip} · {badges}', { zip: { t: 'ZIP ready ({size})', v: { size: fmtBytes(zip.size) } }, badges });
      }
    } catch(e){
      setText(convState, 'Error: {msg}', { msg: String(e && e.message || e) });
    } finally { btn.disabled = false; }
  });

  $('ao-copy').addEventListener('click', async () => {
    const text = OcrTool.text();
    if(!text.trim()) return;
    const btn = $('ao-copy');
    try {
      if(navigator.clipboard && window.isSecureContext){
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      setText(btn, 'Copied ✅');
    } catch(_){ setText(btn, 'Copy failed ❌'); }
    clearTimeout(btn._back);
    btn._back = setTimeout(() => setText(btn, 'Copy'), 1200);
  });

  /* Global paste. Signature is the only workspace left with its own handler;
     a paste while the metadata workspace is up opens there. */
  window.addEventListener('paste', e => {
    const fs = e.clipboardData && e.clipboardData.files;
    if(!fs || !fs.length){
      // Text, not files: a bare digest pasted while this screen holds one
      // file opens Verify with it (spec §8.4). Never inside a text field.
      if(!e.clipboardData || inTextField(document.activeElement)) return;
      if(view !== 'single' || !FilesApp.state.file || !$('tool-auto').classList.contains('active')) return;
      const text = e.clipboardData.getData('text/plain') || e.clipboardData.getData('text') || '';
      if(text.length > 4096 || !detectHashAlgo(text)) return;
      if(openVerify(text)) e.preventDefault();
      return;
    }
    const files = Array.from(fs);
    if($('tool-signature').classList.contains('active') && files.every(isImageLike)) return;
    if($('tool-metadata').classList.contains('active')){
      // Several at once go to the set view on the file screen (spec §9.9).
      if(files.length > 1){ toast(T('Metadata opens one file at a time.'), 'info'); receive(files); return; }
      receive(files, { open: 'metadata' });
      return;
    }
    receive(files);
  });

  return { receive, ocrPage, makeSearchable, showPage: goPage, rerankOutcomes, addAlert, clearAlert, openVerify };
})();

/* ─── Carino Bridge receiver ───
   Fleet pages hand files to this one at https://files.carino.systems/#carino-bridge
   (the file screen) or …/#metadata&carino-bridge (straight into the metadata
   workspace). Only the origins below may deliver; anyone else gets silence.
   carino-bridge.js is deferred, so it has run by DOMContentLoaded. The bridge
   strips the marker from the URL (history.replaceState) before onFiles runs,
   so where the files go is read from the hash now, not then. */
document.addEventListener('DOMContentLoaded', () => {
  if(!window.CarinoBridge) return;
  const open = /^#metadata(?:&|$)/.test(location.hash) ? 'metadata' : null;
  CarinoBridge.receive({
    allow: ['https://desk.carino.systems', 'https://quote.carino.systems', 'https://fiscal.carino.systems',
            'https://dcm.carino.systems', 'same-origin'],
    otherwise: 'deny',
    onFiles: (files, from) => {
      files = Array.from(files || []);
      if(!files.length) return false;
      // Labelled by the origin it actually came from, never by trust.
      let host = from && from.origin || '';
      try { host = new URL(host).host || host; } catch(_){}
      toast(T('Received {n} file(s) from {origin}').replace('{n}', files.length).replace('{origin}', host), 'info');
      FilesApp.intake(files, open ? { open } : undefined);
    },
  });
});
