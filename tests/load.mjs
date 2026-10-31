// Loads the DOM-free js/lib/*.js modules the way the page does, for node --test.
//
// index.html lists them as classic, non-deferred <script src> tags. Here they
// are concatenated in that order and run once with node:vm, so their
// top-level const/let share one scope exactly as classic scripts share the
// page's global lexical scope (a duplicate name would throw here as it would
// there). A final expression hands back the functions the tests need.
//
// Node supplies the browser globals the modules use (TextDecoder, TextEncoder,
// Blob, typed arrays), so the bytes a module returns are ordinary Uint8Arrays.
//
//   import { lib, need } from './load.mjs';
//   test('…', need('crc32'), () => { lib.crc32(…) });
//
// need(...names) returns test options that skip the test, with a message,
// when a module did not declare one of those names.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const read = (rel) => readFileSync(ROOT + rel, 'utf8');

// The non-deferred <script src> list, in document order.
export function classicScripts(html = read('index.html')) {
  const out = [];
  for (const m of html.matchAll(/<script\b([^>]*)>/g)) {
    const attrs = m[1];
    const src = (attrs.match(/\bsrc="([^"]+)"/) || [])[1];
    if (!src || /\bdefer\b|\basync\b|type="module"/.test(attrs)) continue;
    out.push(src);
  }
  return out;
}

export const LIB_FILES = classicScripts().filter((s) => /^js\/lib\/[^/]+\.js$/.test(s));

const NAMES = [
  'detectFormat', 'extOf', 'extMismatch', 'recommendFor',
  'makeZip', 'crc32', 'parsePageRange',
  'pagesInit', 'pagesApply', 'pagesUndo', 'pagesPlan', 'splitPlan', 'pdfCopyPagesSeeded', 'pagesBuildPdf',
  'pdfScrubReport', 'scrubTruncate', 'pdfRewriteClean', 'SCRUB_REPORT_MAX',
  'zipEntries', 'zipRead', 'UNZIP_MAX_BYTES',
  'asn1Parse', 'asn1Oid', 'asn1IntHex', 'asn1IntBig', 'asn1IntBits', 'asn1Time', 'asn1String', 'asn1Bits', 'asn1Is', 'asn1Ctx', 'asn1Body',
  'pemToDer', 'parseCertificate', 'x509Certificates', 'pkcs7Certificates',
  'jpegExifSpan',
  'buildFfmpegCommand', 'ffmpegQualityMax', 'shQuote', 'FFMPEG_HW_QMAX',
  'encodeWav', 'csvCell',
  'jpegStrip', 'jpegRemoveXmpGps', 'xmpDropGps', 'xmpHasGps', 'xmpGpsLeft', 'pngStrip', 'webpStrip', 'mp3Strip',
  'SCRUB_LABELS', '_jpegSegments', '_exifOrientation', '_jpegPrimaryEnd',
  'sha256Init', 'sha256Update', 'sha256Digest',
  'detectHashAlgo', 'md5Init', 'md5Update', 'md5Digest',
  'diffRows', 'countDiffs', 'compareCsv',
  'id3CarryPlan', 'id3YearFallback',
  'fullRoute', 'resolveRoute',
  'outcomeRank', 'rankOutcomes', 'layoutOutcomes',
  'kindBadge', 'setSummary', 'flattenMeta', 'unionColumns', 'rowsToCsv', 'rowsToJson', 'sameFile',
  'sniffAudioRate', 'eraserPoint', 'eraserRadius', 'eraserReplay',
  'canStore', 'writableFields', 'EXIF_TEXT_FIELDS', 'ID3_TEXT_FRAMES',
  'normRect', 'clampRect', 'toImageRect', 'padRect', 'matchWords', 'redactWordsOf', 'redactOutType', 'redactClean',
  'wordsToPdfOps', 'ocrWordsOf', 'ocrPdfSafeText', 'ocrImagePageSize', 'ocrRenderPx', 'OCRPDF_MAX_PT',
];

function load() {
  let src = '';
  for (const f of LIB_FILES) src += '\n;// ---- ' + f + '\n' + read(f);
  // One function body: its top-level const/let are one scope, as the page's
  // classic scripts share one global lexical scope, and a name declared twice
  // is a SyntaxError here as it is there. It runs in this realm (not a fresh
  // vm context), so the arrays and typed arrays it returns compare equal to
  // the tests' own with assert.deepEqual. Nothing leaks onto globalThis.
  const body = "'use strict';" + src + '\n;return {'
    + NAMES.map((n) => `${n}: typeof ${n} === 'undefined' ? undefined : ${n}`).join(', ') + '};';
  return vm.runInThisContext('(function () {' + body + '\n})', { filename: 'js/lib (concatenated)' })();
}

export const lib = load();

export function need(...names) {
  const missing = names.filter((n) => lib[n] === undefined);
  return missing.length ? { skip: 'not declared by js/lib: ' + missing.join(', ') } : {};
}
