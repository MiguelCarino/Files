'use strict';
/* ─── 16-bit PCM WAV encoder ───
   DOM-free, so node tests can load it. Takes anything shaped like an
   AudioBuffer ({ numberOfChannels, sampleRate, length, getChannelData(c) })
   and returns an audio/wav Blob; { mono: true } averages the channels. */
function encodeWav(buf, { mono = false } = {}){
  const chs = mono ? 1 : buf.numberOfChannels;
  const rate = buf.sampleRate, frames = buf.length;
  const dataLen = frames * chs * 2;
  const out = new DataView(new ArrayBuffer(44 + dataLen));
  const wstr = (o, s) => { for(let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, 'RIFF'); out.setUint32(4, 36 + dataLen, true); wstr(8, 'WAVE');
  wstr(12, 'fmt '); out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);                 // PCM
  out.setUint16(22, chs, true);
  out.setUint32(24, rate, true);
  out.setUint32(28, rate * chs * 2, true);    // byte rate
  out.setUint16(32, chs * 2, true);           // block align
  out.setUint16(34, 16, true);                // bits per sample
  wstr(36, 'data'); out.setUint32(40, dataLen, true);
  const srcChs = [];
  for(let c = 0; c < buf.numberOfChannels; c++) srcChs.push(buf.getChannelData(c));
  let o = 44;
  for(let i = 0; i < frames; i++){
    if(mono){
      let s = 0;
      for(let c = 0; c < srcChs.length; c++) s += srcChs[c][i];
      s = Math.max(-1, Math.min(1, s / srcChs.length));
      out.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      o += 2;
    } else {
      for(let c = 0; c < chs; c++){
        const s = Math.max(-1, Math.min(1, srcChs[c][i]));
        out.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        o += 2;
      }
    }
  }
  return new Blob([out.buffer], { type: 'audio/wav' });
}
