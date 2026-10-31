'use strict';
/* ─── ffmpeg command builder (intent ported from SimpleTranscoding/transcode.sh) ───
   DOM-free, so node tests can load it. Takes a plain state object:
     { input, codec: h264|hevc|av1|vp9, gpu: none|nvidia|intel|amd, q (CRF/CQ),
       res: original|1080|720|480, audio: copy|opus|aac|none,
       subs: copy|none, twopass }
   and returns { cmd, explain: [[flag, why], …] }. The explanation lines go
   through T() (core.js) when it exists, with {name} placeholders filled after. */
const _ffmpegT = (s) => (typeof T === 'function') ? T(s) : s;
const FFMPEG_ENCODERS = {
  h264: { none: 'libx264',    nvidia: 'h264_nvenc', intel: 'h264_qsv', amd: 'h264_amf', container: 'mp4'  },
  hevc: { none: 'libx265',    nvidia: 'hevc_nvenc', intel: 'hevc_qsv', amd: 'hevc_amf', container: 'mkv'  },
  av1:  { none: 'libaom-av1', nvidia: 'av1_nvenc',  intel: 'av1_qsv',  amd: 'av1_amf',  container: 'mkv'  },
  vp9:  { none: 'libvpx-vp9', nvidia: null,          intel: 'vp9_qsv',  amd: null,       container: 'webm' },
};
/* The command is for a POSIX shell (it uses /dev/null and a backslash line
   continuation), so names go in single quotes, where nothing expands; a
   single quote inside is closed, escaped and reopened ('\''). A name like
   clip$(touch x).mkv or a".mkv used to run or break the pasted command. */
function shQuote(s){ return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
const FFMPEG_HW_QMAX = 51;   // NVENC -cq, QSV -global_quality and AMF -qp stop at 51
// The highest quality value the chosen codec + GPU accept: hardware encoders
// stop at 51; software VP9/AV1 go to 63 and x264/x265 to 51.
function ffmpegQualityMax(codec, gpu){
  const enc = FFMPEG_ENCODERS[codec] || FFMPEG_ENCODERS.h264;
  if(gpu && gpu !== 'none' && enc[gpu]) return FFMPEG_HW_QMAX;
  return (codec === 'vp9' || codec === 'av1') ? 63 : 51;
}
const _ffmpegF = (s, vars) => _ffmpegT(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

function _ffmpegQualityFlags(encoder, q){
  if(/nvenc$/.test(encoder))  return [`-rc vbr -cq ${q} -preset p6`, _ffmpegF('NVENC constant-quality VBR at CQ {q}, preset p6 (slower = better).', { q })];
  if(/qsv$/.test(encoder))    return [`-global_quality ${q} -preset slow`, _ffmpegF('QSV ICQ quality {q} with the slow preset.', { q })];
  if(/amf$/.test(encoder))    return [`-rc cqp -qp_p ${q} -qp_i ${q}`, _ffmpegF('AMF constant-QP mode at QP {q} for both I and P frames.', { q })];
  if(encoder === 'libvpx-vp9') return [`-crf ${q} -b:v 0 -deadline good -cpu-used 2`, _ffmpegF('VP9 constant quality: CRF {q} with -b:v 0 (required), good deadline, speed 2.', { q })];
  if(encoder === 'libaom-av1') return [`-crf ${q} -b:v 0 -cpu-used 4`, _ffmpegF('AOM AV1 constant quality: CRF {q}; -cpu-used 4 balances speed vs compression.', { q })];
  return [`-crf ${q} -preset slow`, _ffmpegF('Constant Rate Factor {q} with the slow preset (better compression, same quality).', { q })];
}

function buildFfmpegCommand(opts){
  const o = opts || {};
  const input = (String(o.input == null ? '' : o.input).trim() || 'input.mkv');
  const codec = o.codec || 'h264';
  const gpu = o.gpu || 'none';
  const q0 = o.q == null ? 23 : o.q;
  const q = Math.min(q0, ffmpegQualityMax(codec, gpu));
  const res = o.res || 'original';
  const audio = o.audio || 'copy';
  const subs = o.subs || 'copy';
  const twopass = !!o.twopass;

  const explain = [];
  let encoder = FFMPEG_ENCODERS[codec][gpu];
  if(!encoder){
    encoder = FFMPEG_ENCODERS[codec].none;
    explain.push([_ffmpegT('(fallback)'), _ffmpegF('No reliable {codec} hardware encoder for that GPU — using software {encoder} instead.', { codec: codec.toUpperCase(), encoder })]);
  }
  const container = FFMPEG_ENCODERS[codec].container;
  const base = input.replace(/\.[^.\/\\]+$/, '');
  const output = `${base}_encoded.${container}`;

  const qin = shQuote(input), qout = shQuote(output);
  const parts = [`ffmpeg -y -i ${qin}`];
  explain.push([`-i ${qin}`, _ffmpegF('Read the source file; -y overwrites {output} if it exists.', { output })]);

  parts.push(`-map 0:v:0`);
  explain.push(['-map 0:v:0', _ffmpegT('Take the first video stream.')]);

  if(audio !== 'none'){
    parts.push('-map 0:a?');
    explain.push(['-map 0:a?', _ffmpegT('Take all audio streams if any exist (? = don’t fail when there are none).')]);
  }
  if(subs !== 'none'){
    parts.push('-map 0:s?');
    explain.push(['-map 0:s?', _ffmpegT('Take all subtitle streams if any exist.')]);
  }

  parts.push(`-c:v ${encoder}`);
  explain.push([`-c:v ${encoder}`, gpu === 'none'
    ? _ffmpegF('Encode video with the software {codec} encoder — slowest but best quality per bit.', { codec: codec.toUpperCase() })
    : _ffmpegF('Encode video on the {gpu} hardware block — much faster, slightly larger files.', { gpu: gpu.toUpperCase() })]);

  if(res !== 'original'){
    parts.push(`-vf scale=-2:${res}`);
    explain.push([`-vf scale=-2:${res}`, _ffmpegF('Downscale to {res}p; -2 keeps the width even (required by most encoders) while preserving aspect ratio.', { res })]);
  }

  const [qf, qe] = _ffmpegQualityFlags(encoder, q);
  parts.push(qf);
  explain.push([qf, qe]);

  if(audio === 'copy'){
    if(container === 'webm'){
      parts.push('-c:a libopus -b:a 128k -af aformat=channel_layouts=stereo');
      explain.push(['-c:a libopus …', _ffmpegT('WebM can’t carry most source audio codecs — re-encode to Opus 128k, downmixed to stereo (avoids the libopus channel-layout error).')]);
    } else {
      parts.push('-c:a copy');
      explain.push(['-c:a copy', _ffmpegT('Pass audio through untouched — no quality loss, no time spent.')]);
    }
  } else if(audio === 'opus'){
    parts.push('-c:a libopus -b:a 128k -af aformat=channel_layouts=stereo');
    explain.push(['-c:a libopus -b:a 128k', _ffmpegT('Re-encode audio to Opus at 128 kb/s, stereo.')]);
  } else if(audio === 'aac'){
    parts.push('-c:a aac -b:a 192k');
    explain.push(['-c:a aac -b:a 192k', _ffmpegT('Re-encode audio to AAC at 192 kb/s.')]);
  } else {
    parts.push('-an');
    explain.push(['-an', _ffmpegT('Strip all audio.')]);
  }

  if(subs === 'copy'){
    if(container === 'mp4'){
      parts.push('-c:s mov_text');
      explain.push(['-c:s mov_text', _ffmpegT('MP4 only supports mov_text subtitles — text subs are converted, image subs will fail (use MKV for those).')]);
    } else if(container === 'webm'){
      parts.push('-c:s webvtt');
      explain.push(['-c:s webvtt', _ffmpegT('WebM only supports WebVTT subtitles — text subs are converted.')]);
    } else {
      parts.push('-c:s copy');
      explain.push(['-c:s copy', _ffmpegT('Pass subtitle streams through untouched (MKV accepts almost anything).')]);
    }
  } else if(subs === 'none'){
    parts.push('-sn');
    explain.push(['-sn', _ffmpegT('Strip all subtitles.')]);
  }

  let cmd;
  const canTwoPass = twopass && (encoder === 'libvpx-vp9' || encoder === 'libaom-av1');
  if(canTwoPass){
    const common = parts.slice(1).join(' ');
    cmd = `ffmpeg -y -i ${qin} ${common} -pass 1 -an -f null /dev/null && \\\nffmpeg -y -i ${qin} ${common} -pass 2 ${qout}`;
    explain.push(['-pass 1/2', _ffmpegT('Two-pass: the first pass analyses the video (output discarded), the second uses that data for smarter bit allocation.')]);
  } else {
    if(twopass) explain.push([_ffmpegT('(two-pass)'), _ffmpegT('Two-pass is only wired for software VP9/AV1 here — CRF single-pass is already optimal for the other encoders.')]);
    cmd = parts.join(' ') + ` ${qout}`;
  }
  explain.push([qout, _ffmpegF('{container} container — the natural home for {codec}.', { container: container.toUpperCase(), codec: codec.toUpperCase() })]);
  return { cmd, explain };
}
