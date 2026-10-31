// pdf-lib for node tests: the vendored UMD bundle (vendor/metadata/pdf-lib.min.js)
// run in this realm with a CommonJS-style exports object, so its classes are
// the ones the js/lib functions under test see (they take PDFLib as an
// argument). null when the bundle is missing or does not load.
import vm from 'node:vm';
import { read } from './load.mjs';

function load() {
  try {
    const exports = {};
    const module = { exports };
    const fn = vm.runInThisContext('(function (exports, module) {' + read('vendor/metadata/pdf-lib.min.js') + '\n})',
      { filename: 'vendor/metadata/pdf-lib.min.js' });
    fn(exports, module);
    const lib = module.exports && module.exports.PDFDocument ? module.exports : exports;
    return lib && lib.PDFDocument ? lib : null;
  } catch (e) {
    return null;
  }
}

export const PDFLib = load();
export const needPdfLib = () => (PDFLib ? {} : { skip: 'vendor/metadata/pdf-lib.min.js did not load under node' });
