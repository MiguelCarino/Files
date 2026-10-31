'use strict';
/* ─── Signature eraser geometry ───
   DOM-free, so node tests can load it. The cleaned signature is the source
   image cropped to its ink (crop = { x, y } offset in image pixels, 1:1
   scale), shown scaled to fit the stage. An eraser stroke is stored in image
   coordinates, so it lands in the same place after a reprocess that crops
   differently (a pad or despeckle change), and is replayed onto the canvas.

   eraserPoint(clientX, clientY, rect, canvasW, canvasH, crop) → { x, y }
     a pointer position on the shown canvas (rect = its client rect) in image
     coordinates.
   eraserRadius(px, rect, canvasW) → the brush radius (px on screen) in image
     pixels.
   eraserReplay(stroke, crop) → [{ x, y }] the stroke's points on the canvas
     whose crop offset is `crop`. */
function eraserPoint(clientX, clientY, rect, canvasW, canvasH, crop){
  const sx = rect.width ? canvasW / rect.width : 1;
  const sy = rect.height ? canvasH / rect.height : 1;
  const c = crop || { x: 0, y: 0 };
  return { x: (clientX - rect.left) * sx + c.x, y: (clientY - rect.top) * sy + c.y };
}
function eraserRadius(px, rect, canvasW){
  return px * (rect.width ? canvasW / rect.width : 1);
}
function eraserReplay(stroke, crop){
  const c = crop || { x: 0, y: 0 };
  return (stroke.pts || []).map(p => ({ x: p.x - c.x, y: p.y - c.y }));
}
