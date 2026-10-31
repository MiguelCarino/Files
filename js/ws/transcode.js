'use strict';
/* ════════════════════════════════════════════════════════════════
   5 · TRANSCODE  (in-browser video conversion, ffmpeg command builder,
                   in-browser audio → WAV)
   ════════════════════════════════════════════════════════════════ */
const TranscodeTool = (() => {
  // The in-browser converter's state, up here because render() (which the
  // first paint calls) refreshes the convert panel too.
  let videoFile = null, videoInfo = null, running = null, planSeq = 0;
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
    refreshPlan();
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

  /* ---- video → video (in-browser, Mediabunny over WebCodecs) ----
     The rail's codec, quality, resolution and audio settings drive both the
     command above and this converter (js/lib/convert.js maps them). The
     library is ~700 KB, so it loads when a video arrives, never before. */
  let mbP = null;
  function mediabunny(){
    if(!mbP) mbP = import(new URL('vendor/mediabunny/mediabunny.min.mjs', location.href).href)
      .catch(e => { mbP = null; throw e; });
    return mbP;
  }
  const cvState = $('cv-state'), cvInfo = $('cv-info'), cvNotes = $('cv-notes'),
        cvRun = $('cv-run'), cvCancel = $('cv-cancel'), cvProg = $('cv-progress'), cvBar = $('cv-bar');
  const canStream = () => typeof window.showSaveFilePicker === 'function';
  const BIG_IN_MEMORY = 1024 * 1048576;   // past this, a buffered result may not fit
  const DISCARD_WHY = {
    undecodable_source_codec: 'This browser cannot decode the {kind} in this file.',
    unknown_source_codec: 'The {kind} codec in this file is not one the browser knows.',
    no_encodable_target_codec: 'This browser cannot encode {codec} {kind} at this size.',
  };
  const fmtDur = (sec) => {
    if(!(sec > 0)) return '0:00';
    const t = Math.round(sec), h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, x = String(t % 60).padStart(2, '0');
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + x : m + ':' + x;
  };
  function setProgress(pct){
    const v = Math.max(0, Math.min(100, Math.round(pct)));
    cvBar.style.width = v + '%';
    cvProg.setAttribute('aria-valuenow', String(v));
  }
  function showNotes(list){
    cvNotes.innerHTML = '';
    for(const n of list){
      const li = document.createElement('li');
      setText(li, n.t, n.v);
      cvNotes.appendChild(li);
    }
    cvNotes.hidden = !list.length;
  }
  const isVideoish = (f) => /^video\//.test(f.type || '') || /\.(mp4|m4v|mov|mkv|webm|avi|3gp|ts|mts|m2ts|ogv)$/i.test(f.name || '');

  async function openVideo(file){
    if(running) return;
    const my = ++planSeq;
    videoFile = file; videoInfo = null;
    $('tc-input').value = file.name; setWsFile(file.name);
    cvRun.disabled = true; cvProg.hidden = true; showNotes([]);
    setText(cvState, 'Reading…'); setText(cvInfo, '');
    let input = null;
    try {
      const mb = await mediabunny();
      input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
      const track = await input.getPrimaryVideoTrack();
      if(my !== planSeq) return;
      if(!track){
        // An audio-only WebM/MP4: the WAV panel is what it wants.
        videoFile = null;
        setText(cvState, 'No video');
        setText(cvInfo, 'No video track in {name}; it went to the WAV export below.', { name: file.name });
        loadAudio(file);
        return;
      }
      const duration = await input.computeDuration().catch(() => 0);
      const decodable = await track.canDecode().catch(() => false);
      if(my !== planSeq) return;
      videoInfo = { width: track.displayWidth, height: track.displayHeight, codec: track.codec || '?', duration, decodable };
      setText(cvInfo, '{name} · {w}×{h} · {codec} · {dur} · {size}',
        { name: file.name, w: videoInfo.width, h: videoInfo.height, codec: videoInfo.codec, dur: fmtDur(duration), size: fmtBytes(file.size) });
      setText(cvState, 'Ready');
    } catch(e){
      if(my !== planSeq) return;
      videoFile = null;
      setText(cvState, 'Error');
      setText(cvInfo, 'Could not read this video: {msg}', { msg: String(e && e.message || e) });
    } finally {
      if(input) try { input.dispose(); } catch(_){}
    }
    render();
  }

  // Re-run on every rail change: the notes say what this browser will do
  // with the current settings, and Convert is off when it cannot.
  const encCache = new Map();
  async function refreshPlan(){
    if(!videoFile || !videoInfo || running) return;
    const my = ++planSeq;
    const plan = convertPlan(gather(), videoInfo);
    const notes = plan.notes.map(t => ({ t }));
    let ok = videoInfo.decodable;
    if(!ok) notes.unshift({ t: 'This browser cannot decode {codec} video. Use the command instead.', v: { codec: videoInfo.codec } });
    else {
      const w = plan.width || videoInfo.width, h = plan.height || videoInfo.height;
      const key = plan.videoCodec + ' ' + w + 'x' + h;
      try {
        if(!encCache.has(key)){
          const mb = await mediabunny();
          encCache.set(key, await mb.canEncodeVideo(plan.videoCodec, { width: w, height: h }).catch(() => false));
        }
      } catch(_){ encCache.set(key, false); }
      if(my !== planSeq) return;
      ok = encCache.get(key);
      if(!ok) notes.unshift({ t: 'This browser cannot encode {codec} at {w}×{h}. Pick another codec, or use the command.', v: { codec: plan.label, w, h } });
    }
    if(ok && !canStream() && videoFile.size > BIG_IN_MEMORY)
      notes.push({ t: 'This browser keeps the result in memory until it downloads; a file this large may not fit. Chrome or Edge save it straight to disk.' });
    if(ok) notes.push({ t: 'Saves as {file}.', v: { file: plan.output } });
    showNotes(notes);
    cvRun.disabled = !ok;
  }

  async function convert(){
    if(!videoFile || !videoInfo || running) return;
    const plan = convertPlan(gather(), videoInfo);
    let writable = null;
    if(canStream()){
      // Ask where to save first (needs this click), then write straight to
      // disk, so a long video never has to fit in memory.
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: plan.output,
          types: [{ description: plan.label, accept: { [plan.mime]: ['.' + plan.container] } }] });
        writable = await handle.createWritable();
      } catch(e){
        if(e && e.name === 'AbortError') return;     // the save dialog was closed
        writable = null;                             // no disk access: fall back to memory
      }
    }
    const mb = await mediabunny();
    const target = writable ? new mb.StreamTarget(writable, { chunked: true }) : new mb.BufferTarget();
    const format = plan.container === 'webm' ? new mb.WebMOutputFormat()
      : new mb.Mp4OutputFormat({ fastStart: writable ? false : 'in-memory' });
    const input = new mb.Input({ source: new mb.BlobSource(videoFile), formats: mb.ALL_FORMATS });
    const output = new mb.Output({ format, target });
    const video = { codec: plan.videoCodec, quality: mb['QUALITY_' + plan.quality] };
    if(plan.height){ video.width = plan.width; video.height = plan.height; video.fit = 'contain'; }
    const job = { cancelled: false, conversion: null };
    running = job;
    cvRun.hidden = true; cvCancel.hidden = false; cvCancel.disabled = false;
    cvProg.hidden = false; setProgress(0);
    setText(cvState, 'Starting…');
    const t0 = performance.now();
    try {
      const conversion = await mb.Conversion.init({ input, output, tracks: 'primary', video, audio: plan.audio, showWarnings: false });
      job.conversion = conversion;
      if(job.cancelled) throw new mb.ConversionCanceledError();
      const lost = conversion.discardedTracks.filter(d => d.reason !== 'discarded_by_user');
      if(!conversion.isValid || lost.some(d => d.track.type === 'video')){
        const d = lost.find(x => x.track.type === 'video') || lost[0];
        throw new Error(d ? fmtT(DISCARD_WHY[d.reason] || d.reason, { kind: d.track.type === 'video' ? T('video') : T('audio'), codec: plan.label }) : T('Nothing to convert.'));
      }
      conversion.onProgress = (p) => {
        setProgress(p * 100);
        setText(cvState, 'Converting… {pct}%', { pct: Math.floor(p * 100) });
      };
      await conversion.execute();
      setProgress(100);
      const size = writable ? null : target.buffer.byteLength;
      if(!writable) downloadBlob(new Blob([target.buffer], { type: plan.mime }), plan.output);
      const secs = Math.max(1, Math.round((performance.now() - t0) / 1000));
      setText(cvState, 'Done');
      const done = [{ t: size == null ? 'Saved {file} in {secs} s.' : 'Downloaded {file} ({size}) in {secs} s.', v: { file: plan.output, size: size == null ? '' : fmtBytes(size), secs } }];
      // An audio track the output could not hold is dropped, not fatal: say so.
      for(const d of lost.filter(x => x.track.type === 'audio'))
        done.push({ t: 'The audio was left out: {why}', v: { why: fmtT(DISCARD_WHY[d.reason] || d.reason, { kind: T('audio'), codec: plan.label }) } });
      showNotes(done);
    } catch(e){
      if(writable) try { await writable.abort(); } catch(_){}
      if(job.cancelled || (e && e.name === 'ConversionCanceledError')){
        setText(cvState, 'Cancelled'); showNotes([]);
      } else {
        setText(cvState, 'Error');
        showNotes([{ t: 'Conversion failed: {msg}', v: { msg: String(e && e.message || e) } }]);
      }
      cvProg.hidden = true;
    } finally {
      try { input.dispose(); } catch(_){}
      running = null;
      cvRun.hidden = false; cvCancel.hidden = true;
      cvRun.disabled = false;
    }
  }
  cvRun.addEventListener('click', convert);
  cvCancel.addEventListener('click', () => {
    if(!running) return;
    running.cancelled = true; cvCancel.disabled = true;
    setText(cvState, 'Cancelling…');
    if(running.conversion) running.conversion.cancel().catch(() => {});
  });

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

  wireDrop($('wav-drop'), $('wav-input'), files => { const f = files[0]; if(isVideoish(f)) openVideo(f); else loadAudio(f); });
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
    openAudio: loadAudio, openVideo,
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
      { id: 'convert', rank: 85, icon: '🎬', title: T('Convert in this browser'), desc: T('H.264, AV1 or VP9 with your quality, size and audio, on this device. Nothing is uploaded.'),
        run: () => { showTool('transcode'); TranscodeTool.openVideo(first); } },
      { id: 'ffmpeg', rank: 80, icon: '⚙️', title: T('Build ffmpeg command'), desc: T('H.264 / H.265 / AV1 / VP9, hardware encoders, quality, scaling, audio and subtitles.'),
        run: () => { TranscodeTool.setVideoName(first.name); showTool('transcode'); } },
      { id: 'extract-wav', rank: 60, icon: '🎵', title: T('Extract audio → WAV'), desc: T('Decode the audio track in-browser and export it as WAV.'),
        run: () => { TranscodeTool.openAudio(first); showTool('transcode'); } },
    ];
  },
});
