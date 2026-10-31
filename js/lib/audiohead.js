'use strict';
/* ─── Audio header sniffing (B-2) ───
   DOM-free, so node tests can load it. sniffAudioRate(bytes) reads the
   source sample rate and channel count from the first bytes of a file, so
   the WAV export can decode at that rate (decodeAudioData resamples to its
   context's rate, and a plain AudioContext runs at the device's rate).

   sniffAudioRate(Uint8Array) → { rate, channels } | null
     WAV     the fmt chunk
     FLAC    STREAMINFO (native, or the first packet of an Ogg FLAC stream)
     MP3     the first frame header (MPEG 1, 2 and 2.5, layers I–III)
     Ogg     the Vorbis id header; Opus always decodes at 48 kHz
     M4A     AAC-LC from the esds AudioSpecificConfig. HE-AAC (SBR/PS)
             decodes at twice its core rate: explicit HE-AAC (AOT 5) and
             an AAC-LC core of 24 kHz or less (implicit SBR cannot be ruled
             out) give null unless a sync extension (0x2B7) settles it.
             ALAC and the rest are left alone, and a moov after the first
             bytes is not seen: null.
   null means "not known from the header": the caller decodes once to learn it. */
function sniffAudioRate(bytes){
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  const n = b.length;
  const str = (o, len) => { let s = ''; for(let i = o; i < o + len && i < n; i++) s += String.fromCharCode(b[i]); return s; };
  const u16le = o => b[o] | (b[o + 1] << 8);
  const u32le = o => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const u16be = o => (b[o] << 8) | b[o + 1];
  const u32be = o => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const ok = (rate, channels) => (rate >= 1000 && rate <= 768000 && channels >= 1 && channels <= 32) ? { rate, channels } : null;

  // FLAC STREAMINFO body at o: 20-bit rate, 3-bit channels − 1.
  const streaminfo = o => o + 13 <= n ? ok((b[o + 10] << 12) | (b[o + 11] << 4) | (b[o + 12] >> 4), ((b[o + 12] >> 1) & 7) + 1) : null;

  /* WAV / RF64 / W64 is out of scope: RIFF…WAVE with a fmt chunk. */
  if(str(0, 4) === 'RIFF' && str(8, 4) === 'WAVE'){
    for(let o = 12; o + 8 <= n;){
      const id = str(o, 4), size = u32le(o + 4);
      if(id === 'fmt ') return o + 16 <= n ? ok(u32le(o + 12), u16le(o + 10)) : null;
      o += 8 + size + (size & 1);
    }
    return null;
  }

  /* Ogg: the first packet of the first page. */
  if(str(0, 4) === 'OggS' && n >= 27){
    const segs = b[26];
    const p = 27 + segs;
    if(p >= n) return null;
    if(b[p] === 1 && str(p + 1, 6) === 'vorbis') return p + 16 <= n ? ok(u32le(p + 12), b[p + 11]) : null;
    if(str(p, 8) === 'OpusHead') return p + 10 <= n ? ok(48000, b[p + 9]) : null;
    if(b[p] === 0x7F && str(p + 1, 4) === 'FLAC' && str(p + 9, 4) === 'fLaC') return streaminfo(p + 17);
    return null;
  }

  /* An ID3v2 tag may sit in front of FLAC or MP3. */
  let start = 0;
  while(str(start, 3) === 'ID3' && start + 10 <= n){
    const size = ((b[start + 6] & 127) << 21) | ((b[start + 7] & 127) << 14) | ((b[start + 8] & 127) << 7) | (b[start + 9] & 127);
    start += 10 + size + ((b[start + 5] & 0x10) ? 10 : 0);
  }

  if(str(start, 4) === 'fLaC'){
    // The first metadata block is STREAMINFO (type 0).
    return (b[start + 4] & 0x7F) === 0 ? streaminfo(start + 8) : null;
  }

  /* MP4 / M4A: walk moov → trak → mdia → minf → stbl → stsd → mp4a → esds. */
  if(str(4, 4) === 'ftyp'){
    const ASC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    const CONTAINERS = { moov: 1, trak: 1, mdia: 1, minf: 1, stbl: 1 };
    const walk = (from, to) => {
      for(let o = from; o + 8 <= to;){
        let size = u32be(o);
        const type = str(o + 4, 4);
        let head = 8;
        if(size === 1){ if(o + 16 > to) return null; size = u32be(o + 8) * 4294967296 + u32be(o + 12); head = 16; }
        else if(size === 0) size = to - o;
        if(size < head) return null;
        const end = Math.min(to, o + size);
        if(CONTAINERS[type]){ const r = walk(o + head, end); if(r) return r; }
        else if(type === 'stsd'){
          // version/flags 4, entry count 4, then the first sample entry
          // (a video track's entry is skipped: the audio track may follow)
          const e = o + head + 8;
          if(str(e + 4, 4) === 'mp4a' && e + 36 <= end){
            const r = esds(e + 36, Math.min(end, e + u32be(e)), u16be(e + 24));
            if(r) return r;
          }
        }
        o += size;
      }
      return null;
    };
    const esds = (from, to, chCount) => {
      for(let o = from; o + 8 <= to;){
        const size = u32be(o);
        if(size < 8) return null;
        if(str(o + 4, 4) === 'esds') return asc(o + 12, Math.min(to, o + size), chCount);
        o += size;
      }
      return null;
    };
    // Descriptors: 0x03 ES, 0x04 DecoderConfig, 0x05 DecoderSpecificInfo.
    const asc = (o, to, chCount) => {
      const desc = p => {
        if(p >= to) return null;
        const tag = b[p++];
        let len = 0;
        for(let i = 0; i < 4 && p < to; i++){ const c = b[p++]; len = (len << 7) | (c & 127); if(!(c & 128)) break; }
        return { tag, len, body: p };
      };
      let d = desc(o);
      if(!d || d.tag !== 3) return null;
      let p = d.body + 2;                     // ES_ID
      const flags = b[p++];
      if(flags & 0x80) p += 2;                // dependsOn_ES_ID
      if(flags & 0x40) p += 1 + b[p];         // URL
      if(flags & 0x20) p += 2;                // OCR_ES_ID
      d = desc(p);
      if(!d || d.tag !== 4) return null;
      d = desc(d.body + 13);
      if(!d || d.tag !== 5 || d.body + 2 > to) return null;
      const aot = b[d.body] >> 3;
      const sfi = ((b[d.body] & 7) << 1) | (b[d.body + 1] >> 7);
      const cfg = (b[d.body + 1] >> 3) & 15;
      if(aot !== 2 || sfi >= ASC_RATES.length) return null;   // AAC-LC only
      const core = ASC_RATES[sfi], ch = cfg >= 1 && cfg <= 2 ? cfg : chCount;
      /* HE-AAC with implicit SBR looks exactly like AAC-LC at half its rate.
         The backward-compatible sync extension (0x2B7), when present after
         the 16 bits of AOT 2 + rate + channels + GASpecificConfig, says
         which it is; without it a core rate of 24 kHz or less may be
         doubled by the decoder, so it is left to the decoder (null). */
      if(cfg !== 0 && d.len >= 5 && d.body + d.len <= to){
        let bit = 16;
        const read = k => { let v = 0; for(let i = 0; i < k; i++, bit++) v = (v << 1) | ((b[d.body + (bit >> 3)] >> (7 - (bit & 7))) & 1); return v; };
        if(bit + 17 <= d.len * 8 && read(11) === 0x2B7 && read(5) === 5){
          if(!read(1)) return ok(core, ch);                     // explicitly no SBR
          if(bit + 4 > d.len * 8) return null;
          const ext = read(4);
          return ext < ASC_RATES.length ? ok(ASC_RATES[ext], ch) : null;
        }
      }
      if(core <= 24000) return null;
      return ok(core, ch);
    };
    return walk(0, n);
  }

  /* MPEG audio: the first frame header after the tag. When the frame after
     it is inside the bytes it must start with a matching header too, so a
     stray FF Ex in other data is not taken for a frame. */
  const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  const KBPS = {
    '3-3': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],     // MPEG1 layer I
    '3-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],        // MPEG1 layer II
    '3-1': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],         // MPEG1 layer III
    '2-3': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],        // MPEG2/2.5 layer I
    '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],             // MPEG2/2.5 layers II, III
  };
  for(let o = start, lim = Math.min(n - 4, start + 65536); o <= lim; o++){
    if(b[o] !== 0xFF || (b[o + 1] & 0xE0) !== 0xE0) continue;
    const ver = (b[o + 1] >> 3) & 3, layer = (b[o + 1] >> 1) & 3;
    const br = b[o + 2] >> 4, sr = (b[o + 2] >> 2) & 3;
    if(ver === 1 || layer === 0 || br === 0 || br === 15 || sr === 3) continue;
    const rate = RATES[ver][sr], padding = (b[o + 2] >> 1) & 1;
    const kbps = KBPS[(ver === 3 ? '3-' : '2-') + (ver !== 3 && layer === 1 ? 2 : layer)][br] * 1000;
    const len = layer === 3 ? (Math.floor(12 * kbps / rate) + padding) * 4
      : Math.floor((layer === 1 && ver !== 3 ? 72 : 144) * kbps / rate) + padding;
    const next = o + len;
    if(next + 2 <= n && !(b[next] === 0xFF && (b[next + 1] & 0xFE) === (b[o + 1] & 0xFE))) continue;
    return ok(rate, (b[o + 3] >> 6) === 3 ? 1 : 2);
  }
  return null;
}
