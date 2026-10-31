'use strict';
/* expose internals for testing / power users. MediaTools is the name this
   had before Media became Files; it stays as an alias. The pure helpers
   (parsePageRange, buildFfmpegCommand, encodeWav) are the js/lib ones and
   take plain arguments, not the page's controls. */
window.FilesTools = {
  makeZip, crc32, downloadBlob, sniffFile, normalizeImageFile,
  detectFormat, extMismatch, recommendFor, headOf, hashOf, cancelHashes,
  digestOf, verifyDigest, detectHashAlgo,
  metadata: MetaTool,
  compare: CompareTool,
  processSignature: SigTool.processSignature,
  estimateBackground: SigTool.estimateBackground,
  buildFfmpegCommand,
  encodeWav,
  parsePageRange,
  scrub: { jpegStrip, jpegRemoveXmpGps, pngStrip, webpStrip, mp3Strip },
  tesseractOptions: OcrTool.TESS_OPTS,
  detect: AutoTool.receive,
};
window.MediaTools = window.FilesTools;

/* The offline service worker (sw.js, built by tools/build_sw.py): over https,
   or on the loopback host for local runs; never on file://. Registered after
   load, so its install never competes with the page's own first requests. */
if('serviceWorker' in navigator && (location.protocol === 'https:'
    || location.hostname === '127.0.0.1' || location.hostname === 'localhost')){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
