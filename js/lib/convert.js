'use strict';
/* ─── in-browser conversion plan ───
   DOM-free, so node tests can load it. Takes the same rail state as
   buildFfmpegCommand (js/lib/ffmpeg.js) plus the source video's display size,
   and returns what js/ws/transcode.js hands to Mediabunny:
     { container: mp4|webm, mime, videoCodec: avc|hevc|av1|vp9,
       quality: VERY_HIGH|HIGH|MEDIUM|LOW|VERY_LOW, width, height (null = keep),
       audio: Mediabunny audio options, output (file name), notes: [text] }
   The browser picks its own encoder (hardware when it has one), so the GPU,
   two-pass and subtitle settings only shape the ffmpeg command; notes say so
   when one of them is set away from its default. */
const _convT = (s) => (typeof T === 'function') ? T(s) : s;
const _convF = (s, vars) => _convT(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

// Rail codec → Mediabunny codec and the container it goes in. MP4 for
// H.264/H.265/AV1 because every browser previews it; WebM for VP9.
const CONVERT_CODECS = {
  h264: { codec: 'avc',  container: 'mp4',  label: 'H.264' },
  hevc: { codec: 'hevc', container: 'mp4',  label: 'H.265' },
  av1:  { codec: 'av1',  container: 'mp4',  label: 'AV1' },
  vp9:  { codec: 'vp9',  container: 'webm', label: 'VP9' },
};
const CONVERT_MIME = { mp4: 'video/mp4', webm: 'video/webm' };

/* The CRF slider → one of Mediabunny's five quality steps. The slider's top
   end depends on codec + GPU (51 or 63), so the value is first put on the
   0–51 scale x264 uses; 23 (the default) lands on HIGH, as CRF 23 is
   x264's "visually good" default. */
function convertQuality(q, max){
  const m = max > 0 ? max : 51;
  const n = Math.max(0, Math.min(51, (Number(q) || 0) * 51 / m));
  if(n <= 18) return 'VERY_HIGH';
  if(n <= 25) return 'HIGH';
  if(n <= 30) return 'MEDIUM';
  if(n <= 38) return 'LOW';
  return 'VERY_LOW';
}

/* Downscale only: a 720p source asked for 1080p keeps its size. The width
   follows the aspect ratio and is rounded to an even number, which every
   encoder needs (the command's scale=-2 does the same). */
function convertSize(res, src){
  const target = parseInt(res, 10);
  const w = src && src.width, h = src && src.height;
  if(!target || !(w > 0) || !(h > 0) || h <= target) return { width: null, height: null, kept: !!target };
  const width = Math.max(2, Math.round(w * target / h / 2) * 2);
  return { width, height: target, kept: false };
}

function convertPlan(state, src){
  const s = state || {};
  const c = CONVERT_CODECS[s.codec] || CONVERT_CODECS.h264;
  const notes = [];
  const max = (typeof ffmpegQualityMax === 'function') ? ffmpegQualityMax(s.codec || 'h264', s.gpu || 'none') : 51;
  const quality = convertQuality(s.q == null ? 23 : s.q, max);
  const size = convertSize(s.res || 'original', src);
  if(size.kept) notes.push(_convF('The video is already {res}p or smaller, so it keeps its size.', { res: parseInt(s.res, 10) }));

  let audio = {};
  const a = s.audio || 'copy';
  if(a === 'none') audio = { discard: true };
  else if(a === 'opus') audio = { codec: 'opus', bitrate: 128000, numberOfChannels: 2 };
  else if(a === 'aac'){
    if(c.container === 'webm'){
      audio = { codec: 'opus', bitrate: 128000 };
      notes.push(_convT('WebM cannot hold AAC, so the audio becomes Opus 128k.'));
    } else audio = { codec: 'aac', bitrate: 192000 };
  }
  // 'copy' stays {}: Mediabunny copies the track when the container takes its
  // codec and re-encodes it otherwise.

  if(s.gpu && s.gpu !== 'none') notes.push(_convT('The browser chooses its own encoder; the hardware setting only changes the command.'));
  if(s.twopass) notes.push(_convT('Two-pass encoding is only in the command.'));

  const input = String(s.input == null ? '' : s.input).trim() || 'input.mkv';
  const base = input.replace(/\.[^.\/\\]+$/, '').replace(/^.*[\/\\]/, '') || 'video';
  return {
    container: c.container, mime: CONVERT_MIME[c.container], videoCodec: c.codec, label: c.label,
    quality, width: size.width, height: size.height, audio,
    output: base + '_encoded.' + c.container, notes,
  };
}
