'use strict';
/* ─── format detection (DOM-free) ───
   detectFormat(bytes, name, mime) → {
     id, label, icon, kind, mime, editable, route, detail,
     advisory: { level: 'info'|'warn'|'danger', key, vars?, link? } | null }

   bytes is the head of the file (headOf: the first 512 KiB, though any
   prefix works). Byte signatures decide first; the extension is consulted
   only after every magic check has failed, so a PNG renamed .dcm is still a
   PNG. The mime the browser guessed (from the name) is the last resort
   before "unknown binary".

   Labels and advisory keys are English: they are the i18n keys, translated
   where they are shown. route says which part of the file screen handles
   the file: image | heic | pdf | audio | video | dicom | unknown. */
const { detectFormat, extOf, extMismatch } = (() => {
  const extOf = (name) => { const m = /\.([^.\\/]+)$/.exec(name || ''); return m ? m[1].toLowerCase() : ''; };
  const asciiAt = (b, s, len) => {
    let o = '';
    for(let i = s; i < s + len && i < b.length; i++){ const c = b[i]; o += (c >= 32 && c < 127) ? String.fromCharCode(c) : '.'; }
    return o;
  };
  const starts = (b, sig, off = 0) => {
    if(off + sig.length > b.length) return false;
    for(let i = 0; i < sig.length; i++) if(b[off + i] !== sig[i]) return false;
    return true;
  };
  const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  // The first KB as text, BOM and leading whitespace gone: enough to tell an
  // SVG from any other XML.
  const textHead = (b) => {
    let s = '';
    try { s = new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(0, 1024)); } catch(_){ s = asciiAt(b, 0, 1024); }
    return s.replace(/^﻿/, '').trimStart();
  };

  const ROUTE = {
    jpeg: 'image', png: 'image', gif: 'image', bmp: 'image', webp: 'image', svg: 'image', avif: 'image',
    heic: 'heic', pdf: 'pdf',
    mp3: 'audio', flac: 'audio', ogg: 'audio', wav: 'audio', m4a: 'audio',
    mp4: 'video', mkv: 'video', avi: 'video',
    dicom: 'dicom',
    // Nothing in the bytes, but the browser's mime says what it is.
    'other-image': 'image', 'other-audio': 'audio', 'other-video': 'video',
  };
  const EDITABLE = ['jpeg', 'pdf', 'mp3'];

  const DICOM_ADV = 'This is a <b>DICOM</b> medical-imaging file. This tool reads it as a generic binary — for full tag editing and de-identification use the dedicated <a href="https://dcm.carino.systems/" target="_blank" rel="noopener">DICOM Tag Editor</a>.';

  function detectFormat(b, name, mime){
    b = b || new Uint8Array(0);
    const e = extOf(name);
    const A = (s, o = 0) => asciiAt(b, o, s.length) === s;
    const S = (arr, o) => starts(b, arr, o);
    const mk = (id, label, icon, kind, mimeType, advisory, detail) => ({
      id, label, icon, kind, mime: mimeType,
      editable: EDITABLE.includes(id),
      route: ROUTE[id] || 'unknown',
      detail: detail || null,
      advisory: advisory || null,
    });
    const adv = (level, key, extra) => Object.assign({ level, key }, extra || {});

    /* ── 1 · byte signatures ── */
    // DICOM — 'DICM' after the 128-byte preamble
    if(b.length >= 132 && A('DICM', 128))
      return mk('dicom', 'DICOM medical image', '🩻', 'medical', 'application/dicom', adv('info', DICOM_ADV, { link: 'https://dcm.carino.systems/' }));

    // Windows shortcut
    if(S([0x4C,0x00,0x00,0x00,0x01,0x14,0x02,0x00]))
      return mk('lnk', 'Windows shortcut', '🔗', 'system', 'application/x-ms-shortcut', adv('info', LNK_ADV));

    // Images
    if(S([0xFF,0xD8,0xFF])) return mk('jpeg', 'JPEG image', '🖼️', 'image', 'image/jpeg');
    if(S([0x89,0x50,0x4E,0x47])) return mk('png', 'PNG image', '🖼️', 'image', 'image/png');
    if(S([0x47,0x49,0x46,0x38])) return mk('gif', 'GIF image', '🖼️', 'image', 'image/gif');
    // 'BM' alone is two letters of any text file: the DIB header size that
    // follows the 14-byte file header must be one of the known ones.
    if(S([0x42,0x4D]) && b.length >= 18 && [12, 40, 52, 56, 64, 108, 124].includes(u32le(b, 14)))
      return mk('bmp', 'BMP image', '🖼️', 'image', 'image/bmp');
    if(S([0x49,0x49,0x2A,0x00]) || S([0x4D,0x4D,0x00,0x2A])) return mk('tiff', 'TIFF image', '🖼️', 'image', 'image/tiff');
    if(A('RIFF') && A('WEBP', 8)) return mk('webp', 'WebP image', '🖼️', 'image', 'image/webp');

    // ISO-BMFF: the brand after 'ftyp' says which family
    if(A('ftyp', 4)){
      const brand = asciiAt(b, 8, 4);
      const low = brand.trim().toLowerCase();
      if(/^(heic|heix|heim|heis|hevc|hevm|hevs|mif1|msf1)$/.test(low)) return mk('heic', 'HEIC/HEIF image', '🖼️', 'image', 'image/heic', null, brand.trim());
      if(low === 'avif' || low === 'avis') return mk('avif', 'AVIF image', '🖼️', 'image', 'image/avif', null, brand.trim());
      if(brand === 'M4A ' || brand === 'M4B ' || brand === 'M4P ') return mk('m4a', 'M4A/AAC audio', '🎵', 'audio', 'audio/mp4', null, brand.trim());
      return mk('mp4', 'MP4/MOV video', '🎬', 'video', 'video/mp4', null, brand.trim());
    }

    // PDF
    if(A('%PDF')) return mk('pdf', 'PDF document', '📕', 'document', 'application/pdf');

    // Audio
    if(A('ID3') || (b[0] === 0xFF && (b[1] & 0xE6) === 0xE2)) return mk('mp3', 'MP3 audio', '🎵', 'audio', 'audio/mpeg');
    if(A('fLaC')) return mk('flac', 'FLAC audio', '🎵', 'audio', 'audio/flac');
    if(A('OggS')) return mk('ogg', 'Ogg audio', '🎵', 'audio', 'audio/ogg');
    if(A('RIFF') && A('WAVE', 8)) return mk('wav', 'WAV audio', '🎵', 'audio', 'audio/wav');

    // Video containers
    if(S([0x1A,0x45,0xDF,0xA3])) return mk('mkv', 'Matroska / WebM', '🎬', 'video', 'video/x-matroska');
    if(A('RIFF') && A('AVI ', 8)) return mk('avi', 'AVI video', '🎬', 'video', 'video/x-msvideo');

    // Fonts
    if(A('OTTO')) return mk('font', 'OpenType font (CFF)', '🔤', 'font', 'font/otf');
    if(A('wOFF')) return mk('font', 'WOFF web font', '🔤', 'font', 'font/woff');
    if(A('wOF2')) return mk('font', 'WOFF2 web font', '🔤', 'font', 'font/woff2');
    if(S([0x00,0x01,0x00,0x00]) && (e === 'ttf' || e === 'otf' || e === '')) return mk('font', 'TrueType font', '🔤', 'font', 'font/ttf');
    if(A('true') || A('ttcf')) return mk('font', 'TrueType font', '🔤', 'font', 'font/ttf');

    // Archives / Office (ZIP-based)
    if(S([0x50,0x4B,0x03,0x04]) || S([0x50,0x4B,0x05,0x06]) || S([0x50,0x4B,0x07,0x08])){
      const office = { docx: 'Word document', xlsx: 'Excel spreadsheet', pptx: 'PowerPoint presentation', odt: 'OpenDocument text', ods: 'OpenDocument spreadsheet', epub: 'EPUB book', jar: 'Java archive', apk: 'Android package' };
      return mk('zip', office[e] || 'ZIP archive', '🗜️', 'archive', 'application/zip');
    }
    if(S([0x1F,0x8B])) return mk('gz', 'GZIP archive', '🗜️', 'archive', 'application/gzip', adv('info', GZ_ADV));
    if(S([0x37,0x7A,0xBC,0xAF,0x27,0x1C])) return mk('7z', '7-Zip archive', '🗜️', 'archive', 'application/x-7z-compressed');
    if(S([0x52,0x61,0x72,0x21,0x1A,0x07])) return mk('rar', 'RAR archive', '🗜️', 'archive', 'application/vnd.rar');
    if(A('ustar', 257)) return mk('tar', 'TAR archive', '🗜️', 'archive', 'application/x-tar');

    // Executables & binaries. 'MZ' is two letters too: when e_lfanew points
    // inside what we have, the 'PE\0\0' signature must be there. Pointing
    // past the head only counts when the head was cut short (there is more
    // file); past the end of a file read whole, it points at nothing.
    if(A('MZ') && b.length >= 0x40){
      const pe = u32le(b, 0x3C);
      const inside = pe + 4 <= b.length;
      if(inside ? S([0x50,0x45,0x00,0x00], pe) : b.length >= 524288)
        return mk('pe', 'Windows executable (PE)', '⚙️', 'binary', 'application/vnd.microsoft.portable-executable', adv('warn', PE_ADV));
    }
    if(S([0x7F,0x45,0x4C,0x46])) return mk('elf', 'ELF binary (Linux)', '⚙️', 'binary', 'application/x-elf', adv('warn', ELF_ADV));
    if(S([0xCA,0xFE,0xBA,0xBE])) return mk('class', 'Java class / Mach-O fat binary', '⚙️', 'binary', 'application/java-vm');
    if(S([0xFE,0xED,0xFA,0xCE]) || S([0xFE,0xED,0xFA,0xCF]) || S([0xCF,0xFA,0xED,0xFE]))
      return mk('macho', 'Mach-O binary (macOS)', '⚙️', 'binary', 'application/x-mach-binary', adv('warn', MACHO_ADV));
    if(S([0x00,0x61,0x73,0x6D])) return mk('wasm', 'WebAssembly module', '⚙️', 'binary', 'application/wasm');

    // PEM blocks (text, but with an unmistakable first line)
    const head = asciiAt(b, 0, 40);
    if(head.indexOf('-----BEGIN') === 0){
      if(/PRIVATE KEY/.test(head) || e === 'key')
        return mk('key', 'Private key (PEM)', '🔑', 'crypto', 'application/x-pem-file', adv('danger', KEY_ADV));
      if(/CERTIFICATE/.test(head)) return mk('cert', 'X.509 certificate (PEM)', '📜', 'crypto', 'application/x-pem-file');
      return mk('pem', 'PEM block', '🔑', 'crypto', 'application/x-pem-file');
    }

    // KeePass password database
    if(S([0x03,0xD9,0xA2,0x9A])) return mk('kdbx', 'KeePass password database', '🔐', 'crypto', 'application/x-keepass2', adv('info', KDBX_ADV));

    // SQLite
    if(A('SQLite format 3')) return mk('sqlite', 'SQLite database', '🗃️', 'data', 'application/vnd.sqlite3');

    // SVG: text that opens with <svg, or an XML prolog followed by <svg
    const txt = textHead(b);
    if(/^<svg[\s>]/i.test(txt) || (/^<\?xml/i.test(txt) && /<svg[\s>]/i.test(txt)))
      return mk('svg', 'SVG image', '🖼️', 'image', 'image/svg+xml');

    /* ── 2 · the name, only now ── */
    if(e === 'dcm' || e === 'dicom')
      // Plenty of DICOM comes without the preamble.
      return mk('dicom', 'DICOM medical image', '🩻', 'medical', 'application/dicom', adv('info', DICOM_ADV, { link: 'https://dcm.carino.systems/' }));
    if(e === 'lnk') return mk('lnk', 'Windows shortcut', '🔗', 'system', 'application/x-ms-shortcut', adv('info', LNK_ADV));
    if(e === 'mp3') return mk('mp3', 'MP3 audio', '🎵', 'audio', 'audio/mpeg');
    if(e === 'svg' && /<svg[\s>]/i.test(txt)) return mk('svg', 'SVG image', '🖼️', 'image', 'image/svg+xml');
    if(e === 'kdbx') return mk('kdbx', 'KeePass password database', '🔐', 'crypto', 'application/x-keepass2', adv('info', KDBX_ADV));
    if(['crt', 'cer', 'der'].includes(e) || (S([0x30,0x82]) && e === 'p7b'))
      return mk('cert', 'X.509 certificate (DER)', '📜', 'crypto', 'application/x-x509-ca-cert');
    if(e === 'key') return mk('key', 'Private key (PEM)', '🔑', 'crypto', 'application/x-pem-file', adv('danger', KEY_ADV));
    if(['p12', 'pfx'].includes(e))
      return mk('key', 'PKCS#12 keystore', '🔑', 'crypto', 'application/x-pkcs12', adv('danger', P12_ADV));
    if(['gpg', 'pgp', 'asc'].includes(e))
      return mk('pgp', 'PGP / GPG data', '🔑', 'crypto', 'application/pgp', adv('warn', PGP_ADV));
    if(['txt','md','csv','log','json','xml','yaml','yml','html','css','js','ts','py','sh','ini','conf','toml'].includes(e))
      return mk('text', 'Text / source file', '📃', 'text', 'text/plain');

    /* ── 3 · the browser's mime guess ── */
    const m = String(mime || '').toLowerCase();
    if(/^image\//.test(m)) return mk('other-image', m, '🖼️', 'image', m);
    if(/^audio\//.test(m)) return mk('other-audio', m, '🎵', 'audio', m);
    if(/^video\//.test(m)) return mk('other-video', m, '🎬', 'video', m);

    return mk('bin', 'unknown binary', '❔', 'binary', 'application/octet-stream', adv('info', BIN_ADV));
  }

  const LNK_ADV = 'This is a <b>Windows shortcut (.lnk)</b> — a pointer to another file or program, not a document. Its "metadata" is mostly the target path and icon reference.';
  const GZ_ADV = 'GZIP stream — contains one compressed file. Only the outer header is readable here.';
  const PE_ADV = '<b>Executable binary.</b> Metadata is read from the PE header only — never run executables from untrusted sources.';
  const ELF_ADV = '<b>ELF executable / library.</b> Header metadata only — treat untrusted binaries with caution.';
  const MACHO_ADV = '<b>Mach-O executable.</b> Header metadata only.';
  const KEY_ADV = '<b>Private key material.</b> Kept entirely local — never share this file. Only non-secret properties (type, size) are shown; the secret is not extracted.';
  const P12_ADV = '<b>PKCS#12 keystore</b> — usually holds a private key. Handle with care; parsed locally only.';
  const PGP_ADV = 'PGP/GPG data — may contain keys or an encrypted message. Parsed locally.';
  const KDBX_ADV = 'Encrypted <b>KeePass</b> database — its entries are protected by your master key and cannot be read here. Open it in a password manager.';
  const BIN_ADV = 'Unrecognized format — showing generic file information and a byte signature. The magic number below may help identify it.';

  /* What an extension promises, for the "named .png, but…" note. Only the
     extensions with a byte signature we can check are listed. */
  const EXT_IDS = {
    jpg: ['jpeg'], jpeg: ['jpeg'], jpe: ['jpeg'], jfif: ['jpeg'], png: ['png'], gif: ['gif'], bmp: ['bmp'],
    tif: ['tiff'], tiff: ['tiff'], webp: ['webp'], heic: ['heic'], heif: ['heic'], avif: ['avif'], svg: ['svg'],
    pdf: ['pdf'], mp3: ['mp3'], flac: ['flac'], ogg: ['ogg'], oga: ['ogg'], opus: ['ogg'], wav: ['wav'],
    m4a: ['m4a', 'mp4'], m4b: ['m4a', 'mp4'], mp4: ['mp4', 'm4a'], m4v: ['mp4'], mov: ['mp4'], mkv: ['mkv'], webm: ['mkv'], avi: ['avi'],
    zip: ['zip'], docx: ['zip'], xlsx: ['zip'], pptx: ['zip'], odt: ['zip'], ods: ['zip'], odp: ['zip'], epub: ['zip'], jar: ['zip'], apk: ['zip'],
    gz: ['gz'], tgz: ['gz'], '7z': ['7z'], rar: ['rar'], tar: ['tar'],
    exe: ['pe'], dll: ['pe'], ttf: ['font'], otf: ['font'], woff: ['font'], woff2: ['font'],
    wasm: ['wasm'], sqlite: ['sqlite'], sqlite3: ['sqlite'],
  };
  // The extension this file's name claims, when the bytes say otherwise;
  // null when they agree or when the bytes decided nothing.
  function extMismatch(det, name){
    const e = extOf(name);
    const want = EXT_IDS[e];
    if(!want || !det || /^other-/.test(det.id) || want.includes(det.id)) return null;
    return e;
  }

  return { detectFormat, extOf, extMismatch };
})();

if(typeof module === 'object' && module && module.exports) module.exports = { detectFormat, extOf, extMismatch };
