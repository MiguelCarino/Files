'use strict';
/* ════════════════════════════════════════════════════════════════
   SHA-256 of a whole file, off the page's thread. A classic worker:
   started by hashOf() in js/core.js for files over the crypto.subtle fast
   path. It reads the File a chunk at a time (FileReaderSync on a slice), so
   only one chunk is ever in memory, and tells the page how far it got.
     in:  { file: File, chunk?: bytes (default 4 MiB) }
     out: { progress: 0..1 } at most ~10 times a second, then { hex },
          or { error } if a read fails.
   importScripts resolves against this file's URL (js/), so 'lib/sha256.js'
   is js/lib/sha256.js, the same file index.html loads.
   ════════════════════════════════════════════════════════════════ */
importScripts('lib/sha256.js');

self.onmessage = (e) => {
  const d = e.data || {};
  const file = d.file;
  const chunk = Math.max(65536, +d.chunk || 4194304);
  try {
    const reader = new FileReaderSync();
    const st = sha256Init();
    const size = file.size;
    let done = 0, last = 0;
    while(done < size){
      const end = Math.min(size, done + chunk);
      sha256Update(st, new Uint8Array(reader.readAsArrayBuffer(file.slice(done, end))));
      done = end;
      const now = Date.now();
      if(now - last >= 100){ last = now; self.postMessage({ progress: done / size }); }
    }
    self.postMessage({ hex: sha256Digest(st) });
  } catch(err){
    self.postMessage({ error: (err && err.message) || String(err) });
  }
};
