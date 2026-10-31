'use strict';
/* ════════════════════════════════════════════════════════════════
   METADATA (#metadata) — read, edit and export what a file says about
   itself. Ported from the Metadata site (the former metadata subdomain, now
   folded in here). Detection is js/lib/detect.js, recommendations are
   js/lib/reco.js; every parser and writer library loads on first use.

   current: { file, bytes (head, Uint8Array), det, groups, edits, full() }
   full() is the whole file as an ArrayBuffer, read once and only by the
   parsers and writers that cannot work from the head (PDF, ZIP, fonts and
   the three writers). Video is never read whole.
   ════════════════════════════════════════════════════════════════ */
const MetaTool = (() => {
  'use strict';
  const q = s => document.querySelector(s);
  const t = k => T(k);
  const root = $('tool-metadata');

  let current = null;
  let ticket = 0;            // one per open(): a slow parse that was overtaken is dropped
  let wanted = null;         // the file the latest open() is working on

  // SHA-256 starts by itself up to HASH_AUTO_MAX (js/core.js); above, a button.
  const PARSE_FULL_LIMIT = 256 * 1024 * 1024;   // above this the whole file is never pulled into RAM
  const XML_MAX = 16 * 1024 * 1024;             // one Office/ODF XML part, unpacked

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function fmtSize(n){ if(n < 1024) return n + ' B'; const u = ['KB','MB','GB','TB']; let i = -1; do { n /= 1024; i++; } while(n >= 1024 && i < u.length - 1); return n.toFixed(n < 10 ? 2 : 1) + ' ' + u[i]; }
  function ascii(b, s, len){ let o = ''; for(let i = s; i < s + len && i < b.length; i++){ const c = b[i]; o += (c >= 32 && c < 127) ? String.fromCharCode(c) : '.'; } return o; }
  function hexdump(b, n){ let o = ''; for(let i = 0; i < n && i < b.length; i++) o += b[i].toString(16).padStart(2, '0') + ' '; return o.trim().toUpperCase(); }
  const dv = b => new DataView(b.buffer, b.byteOffset, b.byteLength);

  function row(k, v, opts){ return Object.assign({ k, v: v == null ? '' : String(v), editable: false, key: null }, opts || {}); }
  // A row whose value is the app's own message, not file data: v keeps the
  // English (exports stay English); the viewer shows t(tpl) with {vars} filled.
  const fillVars = (s, vars) => s.replace(/\{(\w+)\}/g, (m, n) => (vars && n in vars ? vars[n] : m));
  function rowT(k, tpl, vars){ return row(k, fillVars(tpl, vars), { tr: tpl, trv: vars || {} }); }
  // A vendored library, or the "not loaded (offline?)" note in its group.
  async function lib(name, c, group, note){
    try { await needLib(name); return true; }
    catch(e){ c.groups.push({ name: group, rows: [rowT('Note', note)] }); return false; }
  }

  /* ---------- OPEN ---------- */
  async function open(file, d){
    if(!file) return;
    const my = ++ticket;
    wanted = file;
    let c;
    try { c = await extract(file, d); }
    catch(err){ if(my === ticket) toast(t('Failed to read file:') + ' ' + (err && err.message || err), 'err'); return; }
    if(my !== ticket) return;

    current = c;
    renderAll();
    if(file.size <= HASH_AUTO_MAX || hashKnown(file)) fillSha(c);
  }

  /* What open() shows, without showing it: the head read, the detection and
     every parser, into { file, bytes, det, groups, edits, full() }. The set
     export (the file screen's batch tray) reads each file through here.
     Rejects only when the head cannot be read; a parser that fails leaves a
     note in a Parser group instead. */
  async function extract(file, d){
    const bytes = await headOf(file);
    let det = d && d.det ? d.det : d;
    if(!det || !det.id) det = detectFormat(bytes, file.name, file.type);
    // Parsers add advisories (GPS, encryption, expiry): to this copy only.
    det = Object.assign({}, det);
    let fullP = null;
    const c = {
      file, bytes, det, groups: [], edits: {},
      full: () => fullP || (fullP = file.arrayBuffer().catch(e => { fullP = null; throw e; })),
    };

    // Universal "File" group. SHA-256 fills in after the first render.
    c.groups.push({ name: 'File', rows: [
      row('Name', file.name), rowT('Size', '{size} ({n} bytes)', { size: fmtSize(file.size), n: file.size.toLocaleString() }),
      rowT('Detected type', det.label || ''), row('MIME (guess)', det.mime),
      (extOf(file.name) ? row('Extension', extOf(file.name)) : rowT('Extension', '(none)')),
      file.lastModified ? row('Last modified', new Date(file.lastModified).toLocaleString()) : rowT('Last modified', '(unknown)'),
      row('SHA-256', '', { key: '__sha', sha: true, pending: file.size <= HASH_AUTO_MAX || hashKnown(file) }),
      row('File signature (hex)', hexdump(bytes, 12)),
    ]});

    try { await parseByFormat(c); }
    catch(err){ console.warn('parser error', err); c.groups.push({ name: 'Parser', rows: [rowT('Note', 'Could not fully parse this format: {err}', { err: err && err.message || String(err) })] }); }
    return c;
  }

  /* hashOf streams anything over its fast path in a worker; the row shows a
     progress bar meanwhile, moved in place (no re-render, so an input being
     typed in keeps its focus). Never file.arrayBuffer() here: hashOf decides
     how the file is read. A hash cancelled because another file came in
     puts the button back. */
  function fillSha(c){
    const r = c.groups[0].rows.find(x => x.key === '__sha');
    if(!r) return Promise.resolve(false);
    r.pending = true;
    r.progress = 0;
    if(current === c) renderGroups();
    const onProgress = (x) => {
      r.progress = x;
      if(current !== c) return;
      const fill = q('#md-groups .md-sha-bar > div');
      if(fill) setBar(fill, x * 100);
    };
    return hashOf(c.file, onProgress).then(hex => { r.v = hex; r.key = null; return true; },
        e => {
          if(e && e.name === 'AbortError') return false;
          r.v = '(failed: ' + (e && e.message || e) + ')'; r.key = null; return false;
        })
      .then(ok => {
        r.pending = false;
        if(current !== c) return ok;
        // In place, like the progress: no re-render, so a field being typed
        // in keeps its focus and caret. If the row is not on screen (a search
        // hides it), the next render shows the value.
        const cell = q('#md-groups td.v[data-sha]');
        if(cell) cell.textContent = r.v;
        return ok;
      });
  }
  // On demand, for files over the auto limit.
  function computeSha(){
    const c = current;
    if(!c) return;
    fillSha(c).then(ok => { if(ok && current === c) toast(t('SHA-256 computed')); });
  }

  /* ---------- FORMAT PARSERS ---------- */
  async function parseByFormat(c){
    switch(c.det.id){
      case 'jpeg': case 'png': case 'gif': case 'tiff': case 'webp': case 'heic': case 'bmp': case 'avif': case 'svg': return parseImage(c);
      case 'pdf': return parsePDF(c);
      case 'mp3': return parseMP3(c);
      case 'zip': return parseZip(c);
      case 'font': return parseFont(c);
      case 'cert': case 'pem': return parseCert(c);
      case 'key': return parseKeyInfo(c);
      case 'pe': return parsePE(c);
      case 'elf': return parseELF(c);
      case 'mp4': case 'avi': case 'mkv': return parseVideo(c);
      case 'text': return parseText(c);
      default: return;
    }
  }

  // Images — read via exifr (rich); the editable subset for JPEG is written with piexif
  async function parseImage(c){
    // intrinsic dimensions
    await new Promise(res => {
      const img = new Image(); const u = URL.createObjectURL(c.file);
      img.onload = () => { c.groups.push({ name: 'Image', rows: [row('Width', img.naturalWidth + ' px'), row('Height', img.naturalHeight + ' px'), row('Megapixels', ((img.naturalWidth * img.naturalHeight) / 1e6).toFixed(1))] }); URL.revokeObjectURL(u); res(); };
      img.onerror = () => { URL.revokeObjectURL(u); res(); };
      img.src = u;
    });
    if(c.det.id === 'svg') return;   // text, not EXIF

    if(!(await lib('exifr', c, 'EXIF', 'EXIF library not loaded (offline?).'))) return;
    let data = null;
    try { data = await exifr.parse(c.file, { tiff: true, ifd0: true, exif: true, gps: true, xmp: true, iptc: true, icc: true, interop: true }); } catch(e){}
    if(!data || !Object.keys(data).length){ c.groups.push({ name: 'EXIF / XMP', rows: [rowT('Note', 'No embedded EXIF/XMP/IPTC metadata found.')] }); }
    else {
      const rows = Object.entries(data).map(([k, v]) => {
        if(v instanceof Date) v = v.toISOString();
        else if(Array.isArray(v)) v = v.join(', ');
        else if(v && typeof v === 'object') v = JSON.stringify(v);
        return row(k, v);
      });
      c.groups.push({ name: 'EXIF / XMP / IPTC', rows });
      if(data.latitude != null && data.longitude != null)
        c.det.advisory = c.det.advisory || { level: 'warn', key: 'This image embeds <b>GPS coordinates</b>', more: [
          { text: ` (${(+data.latitude).toFixed(5)}, ${(+data.longitude).toFixed(5)}). ` },
          { key: 'Use "Strip GPS" below before sharing to protect location privacy.' },
        ] };
    }

    // Editable EXIF fields (JPEG only, via piexif on save)
    if(c.det.id === 'jpeg'){
      const cur = data || {};
      const ed = [
        ['ImageDescription', cur.ImageDescription], ['Artist', cur.Artist], ['Copyright', cur.Copyright],
        ['Software', cur.Software], ['Make', cur.Make], ['Model', cur.Model],
        ['DateTimeOriginal', cur.DateTimeOriginal instanceof Date ? fmtExifDate(cur.DateTimeOriginal) : (cur.DateTimeOriginal || '')],
      ].map(([k, v]) => row(k, v == null ? '' : v, { editable: true, key: k }));
      c.hasGps = (cur.latitude != null);
      // A real yes/no switch: a free-text field only stripped on exactly 'yes'.
      if(c.hasGps) ed.push(row('Strip GPS', 'no', { editable: true, key: 'StripGPS', type: 'bool' }));
      c.groups.push({ name: 'Editable EXIF (JPEG)', rows: ed });
    }
  }
  function fmtExifDate(d){ const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }

  async function parsePDF(c){
    if(c.file.size > PARSE_FULL_LIMIT){ c.groups.push({ name: 'PDF', rows: [rowT('Note', 'File too large to parse in-browser (over {size}).', { size: fmtSize(PARSE_FULL_LIMIT) })] }); return; }
    if(!(await lib('PDFLib', c, 'PDF', 'PDF library not loaded (offline?).'))) return;
    let doc;
    try { doc = await PDFLib.PDFDocument.load(await c.full(), { updateMetadata: false }); }
    catch(e){
      c.groups.push({ name: 'PDF', rows: [rowT('Note', 'Could not open (encrypted or damaged): {err}', { err: e.message })] });
      if(/encrypt/i.test(e.message)) c.det.advisory = { level: 'warn', key: 'This PDF appears to be <b>encrypted / password-protected</b>; metadata cannot be edited without the password.' };
      return;
    }
    c.pdfDoc = doc;
    const g = v => { try { return v(); } catch(e){ return null; } };
    const d2s = d => d ? d.toISOString() : '';
    const rows = [
      ['Title', g(() => doc.getTitle())], ['Author', g(() => doc.getAuthor())], ['Subject', g(() => doc.getSubject())],
      ['Keywords', g(() => doc.getKeywords())], ['Creator', g(() => doc.getCreator())], ['Producer', g(() => doc.getProducer())],
    ].map(([k, v]) => row(k, v || '', { editable: true, key: k }));
    // Custom Info keys (B-4): written by the add-field row, read back here.
    rows.push(...pdfCustomInfo(doc).map(([k, v]) => row(k, v, { editable: true, key: k, pdfCustom: true })));
    c.groups.push({ name: 'Document Info', rows });
    c.groups.push({ name: 'PDF', rows: [
      row('Page count', doc.getPageCount()),
      row('Created', d2s(g(() => doc.getCreationDate()))),
      row('Modified', d2s(g(() => doc.getModificationDate()))),
    ]});
  }

  // [name, text] for every Info entry that is not a standard field (or a date
  // or the Trapped flag) and holds a string.
  const PDF_INFO_SKIP = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate', 'Trapped'];
  function pdfCustomInfo(doc){
    const out = [];
    let info = null;
    try { info = doc.getInfoDict(); } catch(e){ return out; }
    if(!info || !info.entries) return out;
    for(const [k, v] of info.entries()){
      let name; try { name = k.decodeText(); } catch(e){ continue; }
      if(PDF_INFO_SKIP.indexOf(name) >= 0 || !v || typeof v.decodeText !== 'function') continue;
      try { out.push([name, v.decodeText()]); } catch(e){}
    }
    return out;
  }

  async function parseMP3(c){
    if(!(await lib('jsmediatags', c, 'ID3', 'ID3 library not loaded (offline?).'))) return;
    return new Promise(resolve => {
      jsmediatags.read(c.file, {
        onSuccess: ({ tags }) => {
          const tg = tags || {};
          c.id3Tags = tg;   // every raw frame, for writeMP3 to carry over
          const ed = [
            ['title', tg.title], ['artist', tg.artist], ['album', tg.album], ['year', tg.year || id3YearFallback(tg)],
            ['genre', tg.genre], ['track', tg.track], ['comment', tg.comment && tg.comment.text],
          ].map(([k, v]) => row(k, v == null ? '' : v, { editable: true, key: k }));
          c.groups.push({ name: 'ID3 Tags', rows: ed });
          if(tg.picture) c.groups.push({ name: 'Artwork', rows: [rowT('Embedded image', '{format}, {n} bytes', { format: tg.picture.format, n: tg.picture.data.length.toLocaleString() })] });
          resolve();
        },
        onError: (e) => { c.groups.push({ name: 'ID3', rows: [rowT('Note', 'No readable ID3 tags: {err}', { err: e.info || e.type })] }); resolve(); },
      });
    });
  }

  async function parseZip(c){
    if(c.file.size > PARSE_FULL_LIMIT){ c.groups.push({ name: 'Archive', rows: [rowT('Note', 'Archive too large to open in-browser (over {size}).', { size: fmtSize(PARSE_FULL_LIMIT) })] }); return; }
    // js/lib/unzip.js: the central directory, then only the entries read below.
    const buf = new Uint8Array(await c.full());
    const entries = zipEntries(buf);
    const names = entries.map(e => e.name);
    const byName = new Map(entries.map(e => [e.name, e]));
    const text = async (name) => {
      const e = byName.get(name);
      return e ? new TextDecoder().decode(await zipRead(buf, e, { max: XML_MAX })) : null;
    };
    c.groups.push({ name: 'Archive', rows: [
      row('Entries', names.length),
      row('First entries', names.slice(0, 8).join(', ') + (names.length > 8 ? ' …' : '')),
    ]});
    // Values are XML text: decode the entities so 'R&amp;D' reads 'R&D'.
    const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    const unxml = s => s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi, (m, hx, dc, nm) => {
      if(nm) return ENT[nm.toLowerCase()];
      const cp = hx ? parseInt(hx, 16) : parseInt(dc, 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    });
    const pickIn = xml => tag => { const m = new RegExp('<' + tag + '[^>]*>([^<]*)</' + tag + '>').exec(xml); return m ? unxml(m[1]) : ''; };
    // Office core properties
    const core = await text('docProps/core.xml');
    if(core != null){
      const pick = pickIn(core);
      c.groups.push({ name: 'Office Properties', rows: [
        row('Title', pick('dc:title')), row('Creator', pick('dc:creator')), row('Subject', pick('dc:subject')),
        row('Keywords', pick('cp:keywords')), row('Last modified by', pick('cp:lastModifiedBy')),
        row('Revision', pick('cp:revision')), row('Created', pick('dcterms:created')), row('Modified', pick('dcterms:modified')),
      ]});
    }
    // OpenDocument (ODT/ODS/ODP) keeps the same facts in meta.xml.
    const odf = core == null ? await text('meta.xml') : null;
    if(odf != null && /<office:document-meta\b/.test(odf)){
      const pick = pickIn(odf);
      c.groups.push({ name: 'Office Properties', rows: [
        row('Title', pick('dc:title')), row('Creator', pick('meta:initial-creator')), row('Subject', pick('dc:subject')),
        row('Keywords', pick('meta:keyword')), row('Last modified by', pick('dc:creator')),
        row('Revision', pick('meta:editing-cycles')), row('Created', pick('meta:creation-date')), row('Modified', pick('dc:date')),
      ]});
    }
    const appx = await text('docProps/app.xml');
    if(appx != null){
      const pick = pickIn(appx);
      c.groups.push({ name: 'Application', rows: [row('Application', pick('Application')), row('Company', pick('Company')), row('Page count', pick('Pages')), row('Words', pick('Words'))].filter(r => r.v) });
    }
  }

  async function parseFont(c){
    if(c.file.size > PARSE_FULL_LIMIT){ c.groups.push({ name: 'Font', rows: [rowT('Note', 'Font too large to parse in-browser.')] }); return; }
    if(!(await lib('opentype', c, 'Font', 'Font library not loaded (offline?).'))) return;
    let f;
    try { f = opentype.parse(await c.full()); }
    catch(e){ c.groups.push({ name: 'Font', rows: [rowT('Note', 'Could not parse font: {err}', { err: e.message })] }); return; }
    const n = f.names || {}; const en = o => o ? (o.en || Object.values(o)[0] || '') : '';
    c.groups.push({ name: 'Font Names', rows: [
      row('Family', en(n.fontFamily)), row('Subfamily', en(n.fontSubfamily)), row('Full name', en(n.fullName)),
      row('Version', en(n.version)), row('PostScript name', en(n.postScriptName)),
      row('Designer', en(n.designer)), row('Manufacturer', en(n.manufacturer)),
      row('Copyright', en(n.copyright)), row('License', en(n.license)), row('License URL', en(n.licenseURL)),
    ].filter(r => r.v) });
    c.groups.push({ name: 'Font Technical', rows: [row('Units/em', f.unitsPerEm), row('Glyphs', f.glyphs && f.glyphs.length), row('Ascender', f.ascender), row('Descender', f.descender)] });
  }

  // js/lib/x509.js: the first certificate of a PEM file, a DER certificate
  // or a PKCS#7 bundle (.p7b). Described, never verified.
  async function parseCert(c){
    try {
      const all = c.file.size > c.bytes.length && c.file.size <= PARSE_FULL_LIMIT ? new Uint8Array(await c.full()) : c.bytes;
      const ders = x509Certificates(all);
      if(!ders.length) throw new Error('no certificate in this file');
      const cert = parseCertificate(ders[0]);
      c.groups.push({ name: 'Certificate', rows: [
        row('Subject', cert.subject.text), row('Issuer', cert.issuer.text),
        row('Serial', cert.serial), row('Valid from', cert.notBefore.toISOString()),
        row('Valid to', cert.notAfter.toISOString()),
        row('Key algorithm', cert.spki.label), row('Signature algorithm', cert.sigAlg.name),
        row('Version', 'v' + cert.version),
      ]});
      if(cert.notAfter < new Date())
        c.det.advisory = { level: 'warn', key: 'This certificate is <b>expired</b>', more: [
          { text: ' (' }, { key: 'valid until' }, { text: ' ' + cert.notAfter.toISOString().slice(0, 10) + ').' },
        ] };
    } catch(e){ c.groups.push({ name: 'Certificate', rows: [rowT('Note', 'Could not parse certificate: {err}', { err: e.message })] }); }
  }

  function parseKeyInfo(c){
    // Never extract secret material — describe only.
    const txt = ascii(c.bytes, 0, 60);
    const m = /-----BEGIN ([A-Z0-9 ]+)-----/.exec(txt);
    c.groups.push({ name: 'Key', rows: [
      m ? row('Block type', m[1].trim()) : rowT('Block type', '(binary keystore)'),
      row('Encoding', txt.indexOf('-----') === 0 ? 'PEM (base64 text)' : 'DER / PKCS#12 (binary)'),
      rowT('Security', 'Secret contents intentionally not displayed'),
    ]});
  }

  function parsePE(c){
    const b = c.bytes, d = dv(b);
    try {
      const peOff = d.getUint32(0x3C, true);
      if(!(b[peOff] === 0x50 && b[peOff + 1] === 0x45 && b[peOff + 2] === 0 && b[peOff + 3] === 0)) throw new Error('no PE header');
      const machine = d.getUint16(peOff + 4, true);
      const numSec = d.getUint16(peOff + 6, true);
      const ts = d.getUint32(peOff + 8, true);
      const optMagic = d.getUint16(peOff + 24, true);
      const machines = { 0x14c: 'x86 (i386)', 0x8664: 'x64 (AMD64)', 0xaa64: 'ARM64', 0x1c0: 'ARM', 0x200: 'IA64' };
      c.groups.push({ name: 'PE Header', rows: [
        row('Architecture', machines[machine] || ('0x' + machine.toString(16))),
        row('Executable format', optMagic === 0x20b ? 'PE32+ (64-bit)' : optMagic === 0x10b ? 'PE32 (32-bit)' : 'unknown'),
        row('Sections', numSec),
        row('Compiled (timestamp)', ts ? new Date(ts * 1000).toISOString() : '(zeroed)'),
      ]});
    } catch(e){ c.groups.push({ name: 'PE Header', rows: [rowT('Note', 'Could not parse PE header: {err}', { err: e.message })] }); }
  }

  function parseELF(c){
    const b = c.bytes;
    if(b.length < 20) return;
    const cls = b[4] === 1 ? '32-bit' : b[4] === 2 ? '64-bit' : '?';
    const endian = b[5] === 1 ? 'little-endian' : 'big-endian';
    const types = { 1: 'Relocatable', 2: 'Executable', 3: 'Shared object (.so)', 4: 'Core dump' };
    const le = b[5] === 1; const d = dv(b);
    const etype = d.getUint16(16, le); const machine = d.getUint16(18, le);
    const machs = { 0x3e: 'x86-64', 0x03: 'x86', 0xb7: 'AArch64', 0x28: 'ARM', 0xf3: 'RISC-V' };
    c.groups.push({ name: 'ELF Header', rows: [
      row('Class', cls), row('Endianness', endian), row('Type', types[etype] || etype),
      row('Architecture', machs[machine] || ('0x' + machine.toString(16))),
    ]});
  }

  function parseVideo(c){
    // Top-level MP4/MOV atoms (best effort) from the head only.
    const b = c.bytes, d = dv(b); const atoms = [];
    if(ascii(b, 4, 4) === 'ftyp'){
      let off = 0;
      for(let i = 0; i < 20 && off + 8 <= b.length; i++){
        const size = d.getUint32(off, false); const type = ascii(b, off + 4, 4);
        if(size < 8) break; atoms.push(type); off += size;
      }
      c.groups.push({ name: 'Container', rows: [row('Major brand', ascii(b, 8, 4)), row('Top-level atoms', atoms.join(', '))] });
    }
    // Duration and size from the browser's own demuxer: it streams from the
    // object URL, so nothing reads the file whole. Some codecs never answer;
    // the timeout keeps the panel from waiting on them.
    return new Promise(res => {
      const v = document.createElement('video'); const u = URL.createObjectURL(c.file);
      let done = false;
      const end = () => { if(done) return; done = true; clearTimeout(timer); URL.revokeObjectURL(u); v.removeAttribute('src'); res(); };
      const timer = setTimeout(end, 5000);
      v.preload = 'metadata';
      v.onloadedmetadata = () => { c.groups.push({ name: 'Video', rows: [row('Duration', v.duration && isFinite(v.duration) ? v.duration.toFixed(1) + ' s' : '?'), row('Resolution', (v.videoWidth || '?') + ' × ' + (v.videoHeight || '?'))] }); end(); };
      v.onerror = end;
      v.src = u;
    });
  }

  function parseText(c){
    const txt = new TextDecoder().decode(c.bytes.slice(0, 100000));
    const lines = txt.split(/\r\n|\r|\n/).length;
    c.groups.push({ name: 'Text', rows: [row('Lines (first 100 KB)', lines.toLocaleString()), row('Characters', txt.length.toLocaleString()), row('Encoding (assumed)', 'UTF-8')] });
  }

  /* ---------- RENDER ---------- */
  function renderAll(){
    if(!current) return;
    q('#md-empty').hidden = true;
    q('#md-viewer').hidden = false;
    q('#md-replace').hidden = false;
    q('#md-edit').hidden = false;
    ['#md-export-json', '#md-export-csv', '#md-print'].forEach(id => { q(id).disabled = false; });
    q('#md-export-btn').disabled = false;

    const editable = current.det.editable;
    q('#md-add-field').disabled = !editable;
    q('#md-download').disabled = !editable;
    q('#md-download').classList.toggle('hidden', !editable);
    const hint = q('#md-write-hint');
    if(editable) hint.textContent = current.hasGps
      ? t('Edit fields below or add new ones, then download. JPEG: turn on Strip GPS to remove the location.')
      : t('Edit fields below or add new ones, then download the rewritten file.');
    else hint.textContent = t('This format is extract-only in the browser — export JSON/CSV to save the metadata.');

    renderAdvisory(current.det, q('#md-advisory'));
    renderReco(current.det, current.file.name, q('#md-reco'));
    renderGroups();
  }

  // An advisory is { level, key, vars?, link?, more?: [{ key, vars } | { text }] }:
  // English keys translated here, so a language change re-renders it.
  function advisoryHTML(a){
    const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, n) => (vars && n in vars ? esc(vars[n]) : m));
    return fill(t(a.key), a.vars) + (a.more || []).map(p => p.key ? fill(t(p.key), p.vars) : esc(p.text)).join('');
  }
  function renderAdvisory(det, el){
    if(!el) return;
    const list = [].concat(det && det.advisory || []).filter(Boolean);
    el.innerHTML = list.map(a => {
      const ico = a.level === 'danger' ? '⛔' : a.level === 'warn' ? '⚠️' : 'ℹ️';
      const tone = a.level === 'danger' ? 'err' : a.level;   // Branding .alert tones: ok / warn / err / info
      return `<div class="alert ad ${esc(tone)}"><span class="ad-ico">${ico}</span><div>${advisoryHTML(a)}</div></div>`;
    }).join('');
  }

  function renderReco(det, name, el, label){
    if(!el) return;
    const apps = recommendFor(det || {}, name || '');
    if(!apps.length){ el.innerHTML = ''; return; }
    el.innerHTML = `<div class="reco"><span class="reco-lbl">${esc(t(label || 'Open / edit with'))}</span>`
      + apps.map(a => `<a class="reco-chip" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.name)} ↗</a>`).join('')
      + `</div>`;
  }

  function stageKey(gi, ri){ return gi + ':' + ri; }

  function renderGroups(){
    if(!current) return;
    const query = (q('#md-search').value || '').toLowerCase();
    const host = q('#md-groups');
    // The rows are rebuilt from scratch, so the control that has focus (a
    // field being typed in, a switch just toggled, the add-field inputs) is
    // found again afterwards by its id or data-g/data-r, caret included.
    const was = document.activeElement && host.contains(document.activeElement) ? focusKey(document.activeElement) : null;
    host.innerHTML = '';
    let shown = 0;
    const formAt = current.adding && current.groups.length ? addGroupIndex() : -1;
    current.groups.forEach((g, gi) => {
      const rows = g.rows.filter(r => !query || (r.k + ' ' + r.v).toLowerCase().includes(query));
      if(!rows.length && gi !== formAt) return;
      const wrap = document.createElement('div'); wrap.className = 'meta-group';
      wrap.innerHTML = `<h3>${esc(t(g.name))} <span class="gcount">${rows.length}</span></h3>`;
      const tbl = document.createElement('table'); tbl.className = 'meta';
      rows.forEach(r => {
        const ri = g.rows.indexOf(r); shown++;
        const tr = document.createElement('tr');
        const staged = current.edits[stageKey(gi, ri)];
        const val = staged != null ? staged : r.v;
        if(r.editable && r.type === 'bool'){
          tr.innerHTML = `<td class="k">${esc(t(r.k))}${staged != null ? '<span class="edit-flag">' + esc(t('edited')) + '</span>' : ''}</td>
            <td class="v"><label class="switch"><input type="checkbox"${val === 'yes' ? ' checked' : ''} data-g="${gi}" data-r="${ri}" aria-label="${esc(t(r.k))}"><span class="track"></span></label></td>
            <td class="row-actions"></td>`;
        } else if(r.editable){
          tr.innerHTML = `<td class="k">${esc(t(r.k))}${staged != null ? '<span class="edit-flag">' + esc(t('edited')) + '</span>' : ''}</td>
            <td class="v"><input value="${esc(val)}" data-g="${gi}" data-r="${ri}" aria-label="${esc(t(r.k))}"></td>
            <td class="row-actions"><button type="button" class="icon-x" title="${esc(t('Clear'))}" aria-label="${esc(t('Clear'))}" data-act="clear" data-g="${gi}" data-r="${ri}">⌫</button></td>`;
        } else {
          let cell;
          if(r.key === '__sha' && !r.v){
            const pct = Math.round((r.progress || 0) * 100);
            cell = r.pending
              ? '<span class="hint">' + esc(t('Hashing…')) + '</span>' + (current.file.size > HASH_FAST_MAX
                ? `<div class="bar md-sha-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${esc(t('SHA-256 progress'))}"><div style="width:${pct}%"></div></div>`
                : '')
              : `<button type="button" class="cs-btn" data-act="sha">${esc(t('Compute SHA-256'))} — ${esc(fmtSize(current.file.size))}</button>`;
          }
          else cell = esc(r.tr ? fillVars(t(r.tr), r.trv) : val);
          tr.innerHTML = `<td class="k">${esc(t(r.k))}</td><td class="v"${r.sha ? ' data-sha' : ''}>${cell}</td><td class="row-actions"></td>`;
        }
        tbl.appendChild(tr);
      });
      wrap.appendChild(tbl);
      if(gi === formAt){ wrap.appendChild(addFieldForm()); shown++; }
      host.appendChild(wrap);
    });
    if(!shown) host.innerHTML = '<p class="hint">' + esc(t('No fields match your search.')) + '</p>';
    if(was) restoreFocus(host, was);
    updateDirty();
  }
  function focusKey(el){
    const d = el.dataset || {};
    const k = { id: el.id || null, g: d.g, r: d.r, act: d.act, start: null, end: null };
    try { if(typeof el.selectionStart === 'number'){ k.start = el.selectionStart; k.end = el.selectionEnd; } } catch(_){}
    return k;
  }
  function restoreFocus(host, k){
    let el = null;
    if(k.id) el = host.querySelector('#' + CSS.escape(k.id));
    else if(k.g != null && k.r != null){
      const at = '[data-g="' + k.g + '"][data-r="' + k.r + '"]';
      el = host.querySelector(k.act ? '[data-act="' + k.act + '"]' + at : 'input' + at);
    }
    if(!el || !el.focus) return;
    el.focus({ preventScroll: true });
    if(k.start != null){ try { el.setSelectionRange(k.start, k.end); } catch(_){} }
  }

  function stageEdit(input){
    const gi = +input.dataset.g, ri = +input.dataset.r;
    const orig = current.groups[gi].rows[ri].v;
    const value = input.type === 'checkbox' ? (input.checked ? 'yes' : 'no') : input.value;
    if(value === orig) delete current.edits[stageKey(gi, ri)];
    else current.edits[stageKey(gi, ri)] = value;
    current.lossWarn = null;   // what gets dropped may have changed: warn again on save
    current.writeErr = null;
    if(input.type === 'checkbox') renderGroups(); else updateDirty();
  }
  function clearField(gi, ri){ current.edits[stageKey(gi, ri)] = ''; current.lossWarn = null; renderGroups(); }

  /* ＋ Add / Create Field: an inline row (name, value, Add, Cancel) at the
     foot of the editable group, the first one with editable rows. It lives in
     current.adding as { key, val }, so a re-render (a language change, a
     toggled switch, a search) keeps what was typed. */
  function addGroupIndex(){
    let gi = current.groups.findIndex(g => g.rows.some(r => r.editable));
    if(gi < 0) gi = current.groups.length - 1;
    return gi;
  }
  // The names the writer for this format can store (js/lib/fieldnames.js).
  function knownFields(){ return writableFields(current.det.id); }
  function addFieldForm(){
    const f = document.createElement('div');
    f.className = 'add-field';
    f.setAttribute('role', 'group');
    f.setAttribute('aria-label', t('Add field'));
    f.innerHTML = `<input class="input" id="md-add-key" list="md-add-known" autocomplete="off" spellcheck="false"
        placeholder="${esc(t('Field name'))}" aria-label="${esc(t('Field name'))}" value="${esc(current.adding.key)}">
      <datalist id="md-add-known">${knownFields().map(k => `<option value="${esc(k)}">`).join('')}</datalist>
      <input class="input" id="md-add-val" autocomplete="off"
        placeholder="${esc(t('Value'))}" aria-label="${esc(t('Value'))}" value="${esc(current.adding.val)}">
      <button type="button" class="btn btn-primary btn-sm" id="md-add-ok" data-act="add-field-ok">${esc(t('Add'))}</button>
      <button type="button" class="btn btn-sm" data-act="add-field-cancel">${esc(t('Cancel'))}</button>
      <p class="hint" id="md-add-hint" aria-live="polite" hidden></p>`;
    syncAddHint(f);
    return f;
  }
  /* Under the name input, as it is typed (spec §14.1): a name this format
     cannot store disables Add and says why; a custom PDF name says where it
     goes. Nothing is ever dropped silently. */
  function syncAddHint(host){
    host = host || root;
    const hint = host.querySelector('#md-add-hint'), ok = host.querySelector('#md-add-ok');
    if(!hint || !ok || !current || !current.adding) return;
    const r = canStore(current.det.id, current.adding.key);
    ok.disabled = !r.ok && !!r.reason;
    const key = r.ok ? r.note : r.reason;
    if(key) setText(hint, key, { name: r.name }); else setText(hint, '');
    hint.hidden = !key;
    hint.classList.toggle('hint-warn', !r.ok && !!r.reason);
  }
  function addCustomField(){
    if(!current || !current.det.editable) return;
    if(!current.adding) current.adding = { key: '', val: '' };
    renderGroups();
    const k = $('md-add-key');
    if(k){ k.focus(); k.scrollIntoView({ block: 'nearest' }); }
  }
  function commitCustomField(){
    if(!current || !current.adding) return;
    const r = canStore(current.det.id, current.adding.key);
    const key = r.name, val = current.adding.val;
    if(!r.ok){ syncAddHint(); const k = $('md-add-key'); if(k) k.focus(); return; }
    const gi = addGroupIndex();
    const rows = current.groups[gi].rows;
    // A name that already has a row edits that row instead of adding a twin.
    const at = rows.findIndex(x => x.editable && x.key === key);
    if(at >= 0){
      current.adding = null;
      current.lossWarn = null; current.writeErr = null;
      if(val !== rows[at].v) current.edits[stageKey(gi, at)] = val;
      q('#md-search').value = '';
      renderGroups();
      const input = q(`#md-groups input[data-g="${gi}"][data-r="${at}"]`);
      if(input) input.focus(); else q('#md-add-field').focus();
      return;
    }
    rows.push(row(key, val, { editable: true, key, custom: true, pdfCustom: current.det.id === 'pdf' && PDF_INFO_FIELDS.indexOf(key) < 0 }));
    current.adding = null;
    current.lossWarn = null; current.writeErr = null;
    // The new row may not match a search: clear it so the row is seen.
    q('#md-search').value = '';
    renderGroups(); toast(t('Field added — download to write it'));
    const input = q(`#md-groups input[data-g="${gi}"][data-r="${rows.length - 1}"]`);
    if(input) input.focus(); else q('#md-add-field').focus();
  }
  function cancelCustomField(){
    if(!current) return;
    current.adding = null;
    renderGroups();
    q('#md-add-field').focus();
  }

  /* The bar under the table: how many edits are staged and, after a first
     Save that would drop tags the writer cannot keep (MP3), which ones, with
     the button turned into "Save anyway" for the second click. */
  function updateDirty(){
    const n = Object.keys((current && current.edits) || {}).length;
    const lost = current && current.lossWarn;
    const err = current && current.writeErr;   // { tk, tv }: the last save's error, by key
    const bar = q('#md-dirty'), warn = q('#md-dirty-warn'), btn = q('#md-dirty-save');
    bar.classList.toggle('show', n > 0 || !!lost || !!err);
    q('#md-dirty-text').textContent = n > 0 ? `${n} ${t(n > 1 ? 'unsaved edits' : 'unsaved edit')}` : '';
    warn.hidden = !lost && !err;
    if(err) setText(warn, err.tk, err.tv);
    else if(lost) setText(warn, 'These tags will be removed when saving: {list}', { list: lost.join(', ') });
    else setText(warn, '');
    btn.children[0].hidden = !!lost;
    btn.children[1].hidden = !lost;
  }

  // current editable values keyed by their `key`. A yes/no row comes back
  // as a boolean; `edited` holds the keys the user changed or added.
  function collectEdits(){
    const out = {}, edited = new Set();
    current.groups.forEach((g, gi) => g.rows.forEach((r, ri) => {
      if(!r.editable || !r.key) return;
      const staged = current.edits[stageKey(gi, ri)];
      const val = staged != null ? staged : r.v;
      out[r.key] = r.type === 'bool' ? val === 'yes' : val;
      if(staged != null || r.custom) edited.add(r.key);
    }));
    Object.defineProperty(out, 'edited', { value: edited });
    return out;
  }

  /* ---------- WRITE / DOWNLOAD ---------- */
  // `anyway`: the click came from the dirty bar's button while it reads
  // "Save anyway", which is the confirmation writeMP3 asked for.
  async function downloadModified(anyway){
    if(!current || !current.det.editable) return;
    const c = current;
    c.writeErr = null;
    try {
      const id = c.det.id;
      if(id === 'pdf') await writePDF();
      else if(id === 'jpeg') await writeJPEG();
      else if(id === 'mp3') await writeMP3(!!anyway && !!c.lossWarn);
    } catch(e){
      // Shown in the dirty bar by key (a name the writer cannot store), or
      // as 'Error: {msg}' with the raw message.
      c.writeErr = e && e.tk ? { tk: e.tk, tv: e.tv } : { tk: 'Error: {msg}', tv: { msg: String(e && e.message || e) } };
      console.error(e);
    }
    if(current === c) updateDirty();
  }
  // A writer refusing a field it cannot store (never a silent drop).
  function refuseField(format, key){
    const r = canStore(format, key);
    const tk = r.reason || 'Error: {msg}', tv = r.reason ? { name: r.name } : { msg: key };
    const e = new Error(fmtT(tk, tv));
    e.tk = tk; e.tv = tv;
    throw e;
  }

  async function writePDF(){
    try { await needLib('PDFLib'); } catch(e){ throw new Error(t('PDF library not loaded (offline?).')); }
    if(!current.pdfDoc) throw new Error(t('PDF library not loaded (offline?).'));
    const doc = current.pdfDoc; const v = collectEdits();
    const set = (fn, val) => { try { fn(val || ''); } catch(e){} };
    set(doc.setTitle.bind(doc), v.Title); set(doc.setAuthor.bind(doc), v.Author);
    set(doc.setSubject.bind(doc), v.Subject);
    set(doc.setKeywords.bind(doc), (v.Keywords || '').split(/[,;]\s*/).filter(Boolean));
    set(doc.setCreator.bind(doc), v.Creator); set(doc.setProducer.bind(doc), v.Producer);
    // Custom Info keys: any name, stored as text; a cleared one is removed.
    const { PDFName, PDFHexString } = PDFLib;
    const info = doc.getInfoDict();
    current.groups.forEach(g => g.rows.forEach(r => {
      if(!r.editable || !r.pdfCustom) return;
      const val = v[r.key];
      if(val != null && val !== '') info.set(PDFName.of(r.key), PDFHexString.fromText(String(val)));
      else info.delete(PDFName.of(r.key));
    }));
    const bytes = await doc.save();
    save(new Blob([bytes], { type: 'application/pdf' }), rename(current.file.name, '-meta'));
  }

  /* piexif keeps every tag it loaded as the file's own bytes, so only the
     fields the user changed (or added) are written back: rewriting the rest
     from exifr's decoded strings used to cut non-ASCII values (José, 東京)
     to their low byte even when nobody touched them. EXIF text is ASCII by
     the spec; an edited value with other characters is stored as UTF-8
     bytes (what most readers expect) and the user is warned first. */
  async function writeJPEG(){
    try { await needLib('piexif'); } catch(e){ throw new Error(t('EXIF library not loaded (offline?).')); }
    const v = collectEdits(), edited = v.edited;
    for(const k of edited) if(k !== 'StripGPS' && !canStore('jpeg', k).ok) refuseField('jpeg', k);
    const TEXT_KEYS = EXIF_TEXT_FIELDS.map(f => f[0]);
    const nonAscii = TEXT_KEYS.some(k => edited.has(k) && /[^\x00-\x7f]/.test(v[k] || ''));
    const utf8 = s => uint8ToBinary(new TextEncoder().encode(String(s)));   // UTF-8 bytes as a binary string
    const c = current;
    let bin = uint8ToBinary(new Uint8Array(await c.full()));
    let exifObj; try { exifObj = piexif.load(bin); } catch(e){ exifObj = { '0th': {}, 'Exif': {}, 'GPS': {} }; }
    const Z = exifObj['0th'] = exifObj['0th'] || {}, E = exifObj['Exif'] = exifObj['Exif'] || {};
    const setIn = (ifd, key, tag) => {
      if(!edited.has(key)) return;
      const val = v[key];
      if(val != null && val !== '') ifd[tag] = utf8(val); else delete ifd[tag];
    };
    // Every writable text tag (js/lib/fieldnames.js); a cleared one is removed.
    for(const [key, ifd] of EXIF_TEXT_FIELDS){
      const tag = (ifd === '0th' ? piexif.ImageIFD : piexif.ExifIFD)[key];
      if(tag == null){ if(edited.has(key)) refuseField('jpeg', key); continue; }
      setIn(ifd === '0th' ? Z : E, key, tag);
    }
    if(v.StripGPS === true) exifObj['GPS'] = {};   // dump() then drops the GPS pointer too
    const exifStr = piexif.dump(exifObj);
    exifObj = null;
    let newBin = piexif.insert(exifStr, bin);
    bin = null;                                    // the source copy is not needed past here
    let out = binaryToUint8(newBin);
    newBin = null;
    // The XMP packet can carry the position too (exif:GPSLatitude…).
    if(v.StripGPS === true) out = jpegRemoveXmpGps(out).bytes;
    const name = rename(c.file.name, '-meta');
    if(!nonAscii) return save(new Blob([out], { type: 'image/jpeg' }), name);
    // One toast at a time: the warning replaces "Downloaded" here.
    downloadBlob(new Blob([out], { type: 'image/jpeg' }), name);
    toast(t('EXIF text is ASCII: accents and other non-ASCII characters are saved as UTF-8 and some apps may show them wrong.'), 'warn');
  }

  /* browser-id3-writer rebuilds the ID3v2 tag from nothing (addTag() calls
     removeTag()), so the frames read at open are put back (js/lib/id3carry.js)
     and any it cannot write are named in the dirty bar first; the file is only
     written on the second click, "Save anyway". */
  async function writeMP3(confirmed){
    try { await needLib('ID3Writer'); } catch(e){ throw new Error(t('ID3 library not loaded (offline?).')); }
    const c = current;
    const v = collectEdits();
    const plan = id3CarryPlan(c.id3Tags);
    const lost = plan.lost.slice();
    // Added frames (TPE2, TPOS…): refused if the writer cannot store them,
    // never dropped; they replace the file's own frame of that id.
    const custom = [];
    c.groups.forEach(g => g.rows.forEach(r => {
      if(!r.editable || !r.custom || ID3_FRIENDLY.indexOf(r.key) >= 0) return;
      if(!canStore('mp3', r.key).ok || !ID3_TEXT_FRAMES[r.key]) refuseField('mp3', r.key);
      const val = String(v[r.key] == null ? '' : v[r.key]).trim();
      if(!val) return;
      const kind = ID3_TEXT_FRAMES[r.key];
      if(kind === 'int'){
        const n = parseInt(val, 10);
        if(isNaN(n)){ const e = new Error(r.key + ': ' + val); e.tk = 'Error: {msg}'; e.tv = { msg: r.key + ': ' + val }; throw e; }
        custom.push([r.key, n]);
      } else custom.push([r.key, kind === 'list' ? val.split(/\s*[\/;]\s*/).filter(Boolean) : val]);
    }));
    const customIds = custom.map(f => f[0]);
    const w = new ID3Writer(await c.full());
    if(current !== c) return;
    const S = (frame, val) => { if(val != null && val !== '') try { w.setFrame(frame, val); } catch(e){} };
    S('TIT2', v.title); S('TPE1', v.artist ? [v.artist] : null); S('TALB', v.album);
    if(v.year && !isNaN(+v.year)) S('TYER', +v.year);
    S('TCON', v.genre ? [v.genre] : null);
    if(v.track) S('TRCK', String(v.track));
    if(v.comment) S('COMM', { description: '', text: v.comment, language: 'eng' });
    // Everything else the file had: artwork, album artist, disc, lyrics…
    for(const [id, val] of custom) w.setFrame(id, val);
    for(const [id, val] of plan.frames){
      if(customIds.indexOf(id) >= 0) continue;
      try { w.setFrame(id, val); }
      catch(e){ if(lost.indexOf(id) < 0) lost.push(id); }   // e.g. artwork in a format the writer cannot type
    }
    if(lost.length && !confirmed){
      c.lossWarn = lost;
      updateDirty();
      const btn = q('#md-dirty-save');
      if(btn && btn.focus) btn.focus();
      return;
    }
    c.lossWarn = null;
    w.addTag();
    save(w.getBlob(), rename(c.file.name, '-meta'));
    updateDirty();
  }

  /* ---------- CLEAN COPY ----------
     scrub(file, det, mode) → { blob, name, removed: [English label | { key, vars }],
                               note?: key | [key], gpsLeft, rewritten? }
     mode 'clean': everything that says who, where, when or with what
     (js/lib/scrub.js does the byte work); 'gps': only the location (JPEG).
     The original File is never touched. Throws with a message the page can
     show (encrypted PDF, a library that did not load, a format with no path). */
  const SCRUB_IDS = ['jpeg', 'png', 'webp', 'heic', 'avif', 'pdf', 'mp3'];
  const canScrub = (det) => !!det && SCRUB_IDS.indexOf(det.id) >= 0;
  async function scrub(file, det, mode){
    if(!det || !det.id) det = detectFormat(await headOf(file), file.name, file.type);
    if(!canScrub(det)) throw new Error(t('This file type has no clean-copy path.'));
    if(mode === 'gps' && det.id !== 'jpeg') throw new Error(t('Remove location only works on JPEG photos.'));
    const id = det.id;
    let bytes, removed = [], note = null, type = det.mime || file.type || 'application/octet-stream', name = null;
    if(id === 'heic' || id === 'avif'){
      // No lossless path: the picture is decoded and saved again as JPEG,
      // which carries nothing over (the canvas has no metadata to write).
      const out = await ImgTool.encodeFile(file, 'image/jpeg', 0.92, 0, { meta: 'strip' });
      return finishScrub(file, out.blob, rename(out.name, '-clean'), ['All metadata (converted to JPEG)'], 'Converted to JPEG: HEIC and AVIF have no lossless way to remove metadata.');
    }
    const src = new Uint8Array(await file.arrayBuffer());
    if(id === 'jpeg' && mode === 'gps'){
      bytes = src;
      try { await needLib('piexif'); } catch(e){ throw new Error(t('EXIF library not loaded (offline?).')); }
      let bin = uint8ToBinary(src), exifObj = null;
      try { exifObj = piexif.load(bin); } catch(e){}
      if(exifObj && exifObj.GPS && Object.keys(exifObj.GPS).length){
        exifObj.GPS = {};                        // dump() drops the GPS pointer too
        bytes = binaryToUint8(piexif.insert(piexif.dump(exifObj), bin));
        removed.push('Location in EXIF');
      }
      bin = null;
      const x = jpegRemoveXmpGps(bytes);
      bytes = x.bytes; removed = removed.concat(x.removed);
    } else if(id === 'jpeg'){
      ({ bytes, removed } = jpegStrip(src, { keep: 'orientation' }));
    } else if(id === 'png'){
      ({ bytes, removed } = pngStrip(src));
    } else if(id === 'webp'){
      ({ bytes, removed } = webpStrip(src));
    } else if(id === 'pdf'){
      let rewritten;
      ({ bytes, removed, note, rewritten } = await scrubPdf(src));
      const out = await finishScrub(file, new Blob([bytes], { type }), rename(file.name, '-clean'), removed, note);
      out.rewritten = !!rewritten;
      return out;
    } else if(id === 'mp3'){
      ({ bytes, removed, note } = await scrubMp3(file, src));
    }
    return finishScrub(file, new Blob([bytes], { type }), name || rename(file.name, '-clean'), removed, note);
  }

  /* A PDF is rewritten, not patched (spec §13, B-6): pdfRewriteClean
     (js/lib/scrub.js) copies the pages into a new document and counts what
     it left behind; pdfScrubReport turns the counts into report lines
     ({ key, vars }), which #auto-scrub renders and re-renders by key. */
  async function scrubPdf(src){
    try { await needLib('PDFLib'); } catch(e){ throw new Error(t('PDF library not loaded (offline?).')); }
    let r;
    try { r = await pdfRewriteClean(PDFLib, src); }
    catch(e){
      if(e && e.code === 'encrypted') throw new Error(t('This PDF is encrypted: remove the password first, then make a clean copy.'));
      throw e;
    }
    return { bytes: r.bytes, removed: pdfScrubReport(r.counts), note: r.notes.length ? r.notes : null, rewritten: true };
  }

  /* The tag goes; title, artist and album come back in a fresh ID3v2 tag so
     the song still shows its name. Artwork, comments, lyrics, encoder and
     every other frame stay out. */
  async function scrubMp3(file, src){
    const { bytes, removed } = mp3Strip(src);
    if(!removed.length) return { bytes, removed };
    let basic = null;
    try {
      await needLib('jsmediatags');
      basic = await new Promise(res => jsmediatags.read(file, {
        onSuccess: ({ tags }) => res(tags || {}), onError: () => res(null),
      }));
    } catch(e){}
    const keep = basic ? [['TIT2', basic.title], ['TPE1', basic.artist], ['TALB', basic.album]].filter(([, v]) => v) : [];
    if(!keep.length) return { bytes, removed };
    try {
      await needLib('ID3Writer');
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const w = new ID3Writer(buf);
      keep.forEach(([id, v]) => w.setFrame(id, id === 'TPE1' ? [String(v)] : String(v)));
      w.addTag();
      return { bytes: new Uint8Array(w.arrayBuffer), removed, note: 'Title, artist and album were kept.' };
    } catch(e){
      return { bytes, removed, note: 'Title, artist and album could not be re-added.' };
    }
  }

  /* Checks the copy the way a reader would: it is still the same kind of file,
     and (images) exifr finds no position in it. */
  async function finishScrub(file, blob, name, removed, note){
    const head = new Uint8Array(await blob.slice(0, 4096).arrayBuffer());
    const det = detectFormat(head, name, blob.type);
    let gps = null;
    if(['jpeg', 'png', 'webp'].indexOf(det.id) >= 0){
      // exifr.gps reads only the EXIF GPS IFD; location can also sit in
      // the XMP under other names (DJI, IPTC Extension), so that is read too.
      let xmpGps = null;
      try { xmpGps = xmpGpsLeft(new Uint8Array(await blob.arrayBuffer())); } catch(e){}
      try {
        await needLib('exifr');
        const g = await exifr.gps(blob);
        gps = !!(g && isFinite(g.latitude) && isFinite(g.longitude)) || xmpGps === true;
      } catch(e){ gps = xmpGps === true ? true : null; }
      if(gps === false && xmpGps == null) gps = null;
    }
    return { blob, name, removed, note: note || null, det, gpsLeft: gps };
  }

  function uint8ToBinary(u8){ let s = ''; const CH = 0x8000; for(let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return s; }
  function binaryToUint8(bin){ const u = new Uint8Array(bin.length); for(let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i) & 0xff; return u; }
  function rename(name, suffix){ const i = name.lastIndexOf('.'); return i < 0 ? name + suffix : name.slice(0, i) + suffix + name.slice(i); }
  function save(blob, filename){ downloadBlob(blob, filename); toast(t('Downloaded') + ' ' + filename); }

  /* ---------- EXPORT ---------- */
  function exportMeta(kind){
    if(!current) return;
    const flat = [];
    current.groups.forEach((g, gi) => g.rows.forEach((r, ri) => {
      const staged = current.edits[stageKey(gi, ri)];
      flat.push({ group: g.name, key: r.k, value: staged != null ? staged : r.v });
    }));
    let blob, fn;
    if(kind === 'json'){
      const obj = { file: current.file.name, type: current.det.label, extracted: {} };
      current.groups.forEach((g, gi) => {
        obj.extracted[g.name] = obj.extracted[g.name] || {};
        g.rows.forEach((r, ri) => { const st = current.edits[stageKey(gi, ri)]; obj.extracted[g.name][r.k] = st != null ? st : r.v; });
      });
      blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }); fn = rename(current.file.name, '-metadata') + '.json';
    } else {
      // csvCell (js/lib/csv.js) quotes and defuses = + - @ formulas from the file.
      const csv = 'Group,Key,Value\n' + flat.map(r => [r.group, r.key, r.value].map(csvCell).join(',')).join('\n');
      blob = new Blob([csv], { type: 'text/csv' }); fn = rename(current.file.name, '-metadata') + '.csv';
    }
    save(blob, fn);
  }

  /* ---------- PRINT / PDF ----------
     The overview (every metadata group, staged edits applied) as a branded
     report, through the browser's print dialog (→ Save as PDF). The light
     "paper" palette and logo header are the Quote document's, so every
     Carino export looks like one family. The logo is fetched on the first
     print, not with the page. */
  let logoURI = '';
  async function logoDataURI(){
    if(logoURI) return logoURI;
    try {
      const r = await fetch('logo.webp');
      if(!r.ok) return '';
      const b = await r.blob();
      logoURI = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(''); fr.readAsDataURL(b); });
    } catch(e){}
    return logoURI;
  }

  function carinoBrandedPrint(opts){
    const logo = opts.logo ? `<img class="ph-logo" src="${esc(opts.logo)}" alt="Carino Systems">` : '';
    const metaHtml = opts.meta ? `<div class="ph-meta">${esc(opts.meta)}</div>` : '';
    const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(opts.title)}</title><style>
      :root{ --primary:#b45309; --ink:#1f2937; --muted:#6b7280; --rule:#e5e7eb; }
      html{-webkit-print-color-adjust:exact;print-color-adjust:exact;}
      *{box-sizing:border-box;} body{font:12px/1.5 'IBM Plex Sans',-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:var(--ink);margin:24px;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
      .ph{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;border-bottom:2px solid var(--primary);padding-bottom:16px;margin-bottom:20px;}
      .ph h1{font-family:'Red Hat Display','IBM Plex Sans',sans-serif;font-weight:900;font-size:20px;margin:0;color:var(--primary);}
      .ph-date{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:var(--muted);margin:6px 0 0;}
      .ph-fmt{display:inline-block;margin-top:6px;font-size:11px;color:var(--primary);font-weight:600;}
      .ph-r{text-align:right;flex-shrink:0;} .ph-logo{height:52px;width:auto;display:inline-block;}
      .ph-meta{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;color:var(--muted);margin-top:8px;line-height:1.5;}
      .adv{border:1px solid var(--rule);border-left-width:4px;padding:8px 12px;margin:0 0 16px;font-size:11px;border-radius:4px;}
      .adv-info{border-left-color:#2b8fce;background:#eff8ff;} .adv-warn{border-left-color:#d99000;background:#fff8e8;} .adv-danger{border-left-color:#cc2b2b;background:#fdeeee;}
      section{margin-bottom:16px;break-inside:avoid;}
      h2{font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--primary);border-bottom:1px solid var(--rule);padding-bottom:5px;margin:0 0 8px;}
      table{width:100%;border-collapse:collapse;}
      th{text-align:left;font-weight:600;color:#374151;width:34%;vertical-align:top;padding:3px 10px 3px 0;font-size:11px;word-break:break-word;}
      td{vertical-align:top;padding:3px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;word-break:break-word;color:var(--ink);}
      td.empty{color:#b8bcc4;} .ed{font-family:sans-serif;font-size:9px;color:#127a2f;border:1px solid #9ad3aa;border-radius:3px;padding:0 4px;margin-left:4px;}
      footer{margin-top:22px;padding-top:8px;border-top:1px solid var(--rule);font-size:10px;color:#9aa0a8;}
      @media print{body{margin:0;} @page{margin:15mm;}}
    </style></head><body>
      <header class="ph"><div class="ph-l"><h1>${esc(opts.title)}</h1>${opts.subtitle ? `<p class="ph-date">${esc(opts.subtitle)}</p>` : ''}${opts.fmt ? `<div class="ph-fmt">${esc(opts.fmt)}</div>` : ''}</div>
        <div class="ph-r">${logo}${metaHtml}</div></header>
      ${opts.body}
      <footer>${esc(t('Generated locally by Carino Systems — nothing left this device.'))}</footer>
    </body></html>`;

    const ifr = document.createElement('iframe');
    ifr.setAttribute('aria-hidden', 'true');
    ifr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    document.body.appendChild(ifr);
    const w = ifr.contentWindow, dd = w.document;
    dd.open(); dd.write(doc); dd.close();
    const cleanup = () => setTimeout(() => { try { ifr.remove(); } catch(e){} }, 500);
    w.onafterprint = cleanup;
    setTimeout(() => { try { w.focus(); w.print(); } catch(e){ cleanup(); } }, 60);
  }

  async function printMeta(){
    if(!current){ toast(t('Open a file first'), 'err'); return; }
    const c = current, d = c.det, f = c.file;
    const logo = await logoDataURI();
    if(current !== c) return;
    const now = new Date();
    const p2 = n => String(n).padStart(2, '0');
    const stamp = now.getFullYear() + '-' + p2(now.getMonth() + 1) + '-' + p2(now.getDate()) + ' ' + p2(now.getHours()) + ':' + p2(now.getMinutes());

    const sections = c.groups.map((g, gi) => {
      const rows = g.rows.map((r, ri) => {
        const staged = c.edits[stageKey(gi, ri)];
        const val = staged != null ? staged : (r.tr ? fillVars(t(r.tr), r.trv) : r.v);
        const edited = staged != null ? '<span class="ed">' + esc(t('edited')) + '</span>' : '';
        return `<tr><th>${esc(t(r.k))}</th><td${val ? '' : ' class="empty"'}>${val ? esc(val) : '—'}${edited}</td></tr>`;
      }).join('');
      if(!rows) return '';
      return `<section><h2>${esc(t(g.name))}</h2><table>${rows}</table></section>`;
    }).join('');

    const advisory = d.advisory
      ? `<div class="adv adv-${esc(d.advisory.level)}">${advisoryHTML(d.advisory)}</div>` : '';

    carinoBrandedPrint({
      title: t('File Metadata Overview'),
      subtitle: `${f.name} · ${fmtSize(f.size)} · ${t('generated')} ${stamp}`,
      fmt: `${d.icon} ${t(d.label)} — ${t(d.editable ? 'editable' : 'read-only')}`,
      meta: 'Carino Files — Metadata',
      logo,
      body: advisory + sections,
    });
  }

  /* ---------- WIRING ---------- */
  function initLegend(){
    const kinds = ['JPEG','PNG','TIFF','HEIC','PDF','MP3','MP4','MKV','ZIP','DOCX','XLSX','TTF/OTF','WOFF','X.509 cert','PEM key','EXE (PE)','ELF','Mach-O','WASM','SQLite','DICOM→', '+ any binary'];
    // The last chip is a phrase, not a format: data-i18n lets i18n.js translate it.
    q('#md-legend').innerHTML = kinds.map(k => k[0] === '+' ? `<span data-i18n>${esc(k)}</span>` : `<span>${esc(k)}</span>`).join('');
  }
  initLegend();

  // Every way in hands the file to the file screen first (it identifies it
  // and becomes FilesApp.state), which opens it back here.
  const intake = (files) => FilesApp.intake(files, { open: 'metadata' });
  wireDrop($('md-drop'), $('md-input'), intake);
  /* #md-drop hides once a file is open, so the whole workspace takes a
     dropped file too (it replaces the open one, as on the old Metadata page).
     Without this the browser would navigate to the dropped file. Only file
     drags are claimed: dragging text into an input still works. A drop on
     #md-drop itself was already handled there (defaultPrevented). */
  const hasFiles = e => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') >= 0);
  ['dragenter', 'dragover'].forEach(ev => root.addEventListener(ev, e => {
    if(e.defaultPrevented || !hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }));
  root.addEventListener('drop', e => {
    if(e.defaultPrevented || !hasFiles(e)) return;
    e.preventDefault();
    const fs = e.dataTransfer.files;
    if(fs && fs.length) intake([fs[0]]);
  });

  // Example chips: a file shipped with this site, opened the way a dropped one is.
  root.querySelectorAll('[data-sample]').forEach(b => b.addEventListener('click', async () => {
    try {
      const name = b.dataset.sample;
      const r = await fetch(name);
      if(!r.ok) throw new Error(r.status);
      const blob = await r.blob();
      toast(t('Sample file opened'));
      intake([new File([blob], 'sample-' + name, { type: blob.type })]);
    } catch(e){ toast(t('Could not open the sample file'), 'err'); }
  }));

  // One delegated listener per event for everything the workspace generates.
  root.addEventListener('click', e => {
    const el = e.target.closest && e.target.closest('[data-act]');
    if(!el || !root.contains(el) || el.disabled) return;
    switch(el.dataset.act){
      case 'replace':     $('md-input').click(); break;
      case 'add-field':   addCustomField(); break;
      case 'add-field-ok':     commitCustomField(); break;
      case 'add-field-cancel': cancelCustomField(); break;
      case 'download':    downloadModified(el.id === 'md-dirty-save'); break;
      case 'export-json': exportMeta('json'); break;
      case 'export-csv':  exportMeta('csv'); break;
      case 'print':       printMeta(); break;
      case 'sha':         computeSha(); break;
      case 'clear':       clearField(+el.dataset.g, +el.dataset.r); break;
    }
  });
  root.addEventListener('input', e => {
    const el = e.target;
    if(el.id === 'md-search') renderGroups();
    else if((el.id === 'md-add-key' || el.id === 'md-add-val') && current && current.adding){
      current.adding[el.id === 'md-add-key' ? 'key' : 'val'] = el.value;
      if(el.id === 'md-add-key') syncAddHint();
    }
    else if(el.matches && el.matches('input[data-g][data-r]') && current) stageEdit(el);
  });
  // The add-field row: Enter adds, Esc cancels.
  root.addEventListener('keydown', e => {
    const el = e.target;
    if(!el || (el.id !== 'md-add-key' && el.id !== 'md-add-val')) return;
    if(e.key === 'Enter'){ e.preventDefault(); commitCustomField(); }
    else if(e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); cancelCustomField(); }
  });

  // The Export menu: carino-ui.js opens and closes it; the arrow keys are
  // menuKeys (js/core.js).
  menuKeys($('md-export-btn'), $('md-export-menu'));

  // i18n.js fires this after every (re)application: re-render in the new language.
  window.addEventListener('files:i18n', () => { if(current) renderAll(); });

  FilesApp.register({
    id: 'metadata', route: 'metadata', order: 900,
    accepts: () => true,
    // Always the last visible card (spec §6.1), whatever else ranks higher.
    outcomes: (info) => [{
      id: 'metadata', pin: 'last', icon: '🔎', title: T('Inspect / edit metadata'),
      desc: T(info.det && info.det.editable ? 'See, edit or strip the hidden details' : 'See everything this file carries'),
      run: () => FilesApp.openIn('metadata'),
    }],
    open: (file, info) => open(file, info),
    // Visiting #metadata (the slice, a link, Back) shows the file on the file
    // screen, unless this workspace already has it.
    onShow(){
      const s = FilesApp.state;
      if(s.file && wanted !== s.file && (!current || current.file !== s.file)) open(s.file, s.info);
    },
  });

  return {
    open, extract, rerender: renderAll, renderAdvisory, renderReco, exportMeta, scrub, canScrub,
    current: () => current,
  };
})();
