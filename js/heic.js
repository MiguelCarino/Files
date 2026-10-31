'use strict';
/* ─── HEIC decoding (vendored libheif, loaded only when needed) ─── */
const isHeicName = n => /\.(heic|heif)$/i.test(n || '');
let heicModPromise = null;
function heicModule(){
  if(!heicModPromise){
    heicModPromise = loadScript('vendor/libheif/libheif-bundle.js')
      .catch(() => { heicModPromise = null; throw new Error(T('Could not load the HEIC decoder.')); })
      .then(() => window.libheif());
  }
  return heicModPromise;
}
async function heicToCanvas(file){
  const mod = await heicModule();
  const decoder = new mod.HeifDecoder();
  const images = decoder.decode(await file.arrayBuffer());
  if(!images.length) throw new Error(T('No image found inside this HEIC file.'));
  const image = images[0];
  const w = image.get_width(), h = image.get_height();
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const id = ctx.createImageData(w, h);
  await new Promise((res, rej) => image.display(id, d => d ? res() : rej(new Error(T('HEIC decode failed.')))));
  images.forEach(i => { try { i.free(); } catch(_){} });
  ctx.putImageData(id, 0, 0);
  return canvas;
}
/* Any tool that eats raster images calls this first: HEIC → PNG File, everything else untouched. */
async function normalizeImageFile(file){
  let heic = isHeicName(file.name) || /hei[cf]/.test(file.type || '');
  // The name and type are not decisive: an iPhone export or a messenger
  // download is often HEIC bytes named photo.jpg / typed image/jpeg. The
  // bytes decide (headOf is cached, so this is one 512 KiB read at most).
  if(!heic) heic = (await sniffFile(file)).kind === 'heic';
  if(!heic) return file;
  const canvas = await heicToCanvas(file);
  const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
  if(!blob) throw new Error(T('Could not re-encode HEIC as PNG.'));
  return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.png', { type: 'image/png' });
}
const isImageLike = f => (f.type && f.type.startsWith('image/')) || isHeicName(f.name);
