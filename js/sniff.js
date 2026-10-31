'use strict';
/* ─── file identification: an adapter over js/lib/detect.js ───
   The file screen routes on kind (image | heic | pdf | audio | video | dicom
   | unknown); the full detection result rides along as det, so the summary
   card and the metadata workspace never read or detect the file twice. */
async function sniffFile(file){
  const det = detectFormat(await headOf(file), file.name || '', file.type || '');
  return { kind: det.route, label: det.label, detail: det.detail, det };
}
