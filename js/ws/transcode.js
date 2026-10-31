'use strict';
/* ════════════════════════════════════════════════════════════════
   5 · TRANSCODE  (ffmpeg command builder + in-browser audio → WAV)
   ════════════════════════════════════════════════════════════════ */
const TranscodeTool = (() => {
  /* The builder lives in js/lib/ffmpeg.js; this reads the rail into the plain
     state object it takes. build() keeps its old no-argument call shape. */
  function gather(){
    return {
      input: ($('tc-input').value.trim() || 'input.mkv'),
      codec: document.querySelector('input[name="tc-codec"]:checked').value,
      gpu: $('tc-gpu').value,
      q: parseInt($('tc-crf').value, 10),
      res: document.querySelector('input[name="tc-res"]:checked').value,
      audio: $('tc-audio').value,
      subs: $('tc-subs').value,
      twopass: $('tc-twopass').checked,
    };
  }
  const build = () => buildFfmpegCommand(gather());

  function render(){
    const codec = document.querySelector('input[name="tc-codec"]:checked').value;
    const crf = $('tc-crf');
    // Hardware encoders (NVENC/QSV/AMF) stop at 51 even for VP9/AV1; the
    // builder clamps too, this keeps the slider honest and says why.
    const gpu = $('tc-gpu').value;
    const max = ffmpegQualityMax(codec, gpu);
    if(parseInt(crf.max, 10) !== max){
      crf.max = max;
      if(parseInt(crf.value, 10) > max) crf.value = max;
    }
    $('tc-crf-note').hidden = !(gpu !== 'none' && FFMPEG_ENCODERS[codec][gpu]);
    $('tc-crf-val').textContent = crf.value;
    const { cmd, explain } = build();
    $('tc-cmd').textContent = cmd;
    const ex = $('tc-explain');
    ex.innerHTML = '';
    for(const [flag, why] of explain){
      const div = document.createElement('div');
      div.className = 'explain-line';
      const c = document.createElement('code');
      c.textContent = flag;
      const s = document.createElement('span');
      s.textContent = why;
      div.append(c, s);
      ex.appendChild(div);
    }
  }

  ['tc-input','tc-gpu','tc-audio','tc-subs','tc-twopass','tc-crf'].forEach(id => {
    $(id).addEventListener('input', render);
    $(id).addEventListener('change', render);
  });
  document.querySelectorAll('input[name="tc-codec"], input[name="tc-res"]').forEach(r => r.addEventListener('change', render));

  $('tc-copy').addEventListener('click', async () => {
    const btn = $('tc-copy');
    try {
      if(navigator.clipboard && window.isSecureContext){
        await navigator.clipboard.writeText($('tc-cmd').textContent);
      } else {
        const ta = document.createElement('textarea');
        ta.value = $('tc-cmd').textContent;
        ta.style.position = 'fixed'; ta.style.left = '-9999px';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      setText(btn, 'Copied ✅');
    } catch(_){ setText(btn, 'Failed ❌'); }
    clearTimeout(btn._back);
    btn._back = setTimeout(() => setText(btn, 'Copy'), 1200);
  });

  render();
  // The first render runs before i18n.js has loaded: redo it once the locale
  // is set (after every DOMContentLoaded handler) and on each language switch.
  document.addEventListener('DOMContentLoaded', () => setTimeout(render, 0));
  // Defer past i18n.js's own langchange handler, which sets the new locale.
  window.addEventListener('carino:langchange', () => setTimeout(render, 0));

  /* ---- audio → WAV (in-browser) ---- */
  let audioBuffer = null, audioName = 'audio';
  const wavState = $('wav-state'), wavInfo = $('wav-info'), wavExport = $('wav-export');

  // The encoder lives in js/lib/wav.js; this keeps the old (buf, mono) shape.
  const encodeWavMono = (buf, mono) => encodeWav(buf, { mono: !!mono });

  /* Decode at the source's own sample rate (B-2). decodeAudioData resamples
     to its context's rate, and a plain AudioContext runs at the device's
     rate (often 48 kHz), so a 44.1 kHz file would come out 48 kHz. The rate
     is read from the header (js/lib/audiohead.js) and the decode runs in an
     OfflineAudioContext at that rate. When the header does not say, one
     decode in a plain AudioContext gives buffer.sampleRate, which may be the
     device's rate rather than the file's: the best this browser can tell. */
  async function decodeAtSourceRate(file){
    const arr = await file.arrayBuffer();
    let head = null;
    try { head = sniffAudioRate(new Uint8Array(arr, 0, Math.min(arr.byteLength, 512 * 1024))); } catch(_){}
    let ctx = null;
    try {
      if(head && window.OfflineAudioContext){
        try { ctx = new OfflineAudioContext(head.channels, 1, head.rate); }
        catch(_){ ctx = null; }                     // a rate this browser cannot run
      }
      if(!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      return await ctx.decodeAudioData(arr);
    } finally {
      // An OfflineAudioContext has no close(); a plain one always gets closed,
      // on a decode error too.
      if(ctx && typeof ctx.close === 'function') ctx.close().catch(() => {});
    }
  }
  const kHz = rate => String(+(rate / 1000).toFixed(3));
  const chLabel = n => n === 1 ? { t: 'mono' } : n === 2 ? { t: 'stereo' } : { t: '{n} ch', v: { n } };

  let loadSeq = 0;
  async function loadAudio(file){
    const my = ++loadSeq;
    setText(wavState, 'Decoding…');
    setText(wavInfo, '');
    wavExport.disabled = true;
    audioBuffer = null;
    try {
      const buf = await decodeAtSourceRate(file);
      if(my !== loadSeq) return;                    // a newer file took over
      audioBuffer = buf;
      audioName = file.name.replace(/\.[^.]+$/, '');
      setText(wavInfo, '{rate} kHz · {channels}', { rate: kHz(buf.sampleRate), channels: chLabel(buf.numberOfChannels) });
      setText(wavState, 'Idle');
      wavExport.disabled = false;
      setWsFile(file.name);
    } catch(e){
      if(my !== loadSeq) return;
      setText(wavState, 'Error');
      setText(wavInfo, 'Error: {msg}', { msg: String(e && e.message || e) });
    }
  }

  wireDrop($('wav-drop'), $('wav-input'), files => loadAudio(files[0]));
  wavExport.addEventListener('click', () => {
    if(!audioBuffer) return;
    setText(wavState, 'Encoding…');
    setTimeout(() => {
      try {
        const blob = encodeWavMono(audioBuffer, $('wav-mono').checked);
        downloadBlob(blob, audioName + '.wav');
        setText(wavState, 'Done');
      } catch(e){
        setText(wavState, 'Error');
        setText(wavInfo, 'Error: {msg}', { msg: String(e && e.message || e) });
      }
    }, 30);
  });

  return {
    build, encodeWav: encodeWavMono,
    openAudio: loadAudio,
    setVideoName(name){ $('tc-input').value = name; setWsFile(name); render(); },
  };
})();

FilesApp.register({
  id: 'transcode', route: 'transcode', order: 20,
  accepts: (info) => info.kind === 'audio' || info.kind === 'video',
  outcomes: (info, files) => {
    const first = files[0];
    if(info.kind === 'audio') return [
      { id: 'wav', rank: 80, icon: '🎵', title: T('Convert to WAV'), desc: T('Decode in this browser and export 16-bit PCM WAV — no upload.'),
        run: () => { TranscodeTool.openAudio(first); showTool('transcode'); } },
      { id: 'ffmpeg', rank: 60, icon: '⚙️', title: T('Build ffmpeg command'), desc: T('Generate the exact ffmpeg line for this file name.'),
        run: () => { TranscodeTool.setVideoName(first.name); showTool('transcode'); } },
    ];
    return [
      { id: 'ffmpeg', rank: 80, icon: '⚙️', title: T('Build ffmpeg command'), desc: T('H.264 / H.265 / AV1 / VP9, hardware encoders, quality, scaling, audio and subtitles.'),
        run: () => { TranscodeTool.setVideoName(first.name); showTool('transcode'); } },
      { id: 'extract-wav', rank: 60, icon: '🎵', title: T('Extract audio → WAV'), desc: T('Decode the audio track in-browser and export it as WAV.'),
        run: () => { TranscodeTool.openAudio(first); showTool('transcode'); } },
    ];
  },
});
