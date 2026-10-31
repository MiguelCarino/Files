# Third-party code bundled here

Everything this suite needs is vendored: it loads no script, style, font, map or
module from anywhere but its own origin — no CDN, no network, no account. That
is the point of the tool (a PDF, an image or an audio file never leaves the
machine), and it makes the licences below *this project's* responsibility rather
than a package manager's.

**Every licence text is present in this tree.** Each row points at the file.

## What is here, and under what licence

| Path | Package | Licence | Text |
| --- | --- | --- | --- |
| `pdfjs/pdf.min.mjs`, `pdf.worker.min.mjs` | [PDF.js](https://mozilla.github.io/pdf.js/) | Apache-2.0 | `pdfjs/LICENSE` |
| `tesseract/tesseract.min.js`, `worker.min.js` | [Tesseract.js](https://github.com/naptha/tesseract.js) | Apache-2.0 | `tesseract/LICENSE.md` |
| `tesseract/tesseract-core*.wasm.js` | [Tesseract OCR](https://github.com/tesseract-ocr/tesseract) engine, compiled to WASM | Apache-2.0 | `tesseract/LICENSE-core` |
| `tessdata/*.traineddata.gz` | [tessdata](https://github.com/tesseract-ocr/tessdata) models (eng, spa, por), the OCR panel's **Best** model | Apache-2.0 | `tessdata/LICENSE` |
| `tessdata/fast/*.traineddata.gz` | [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast) models (eng, spa, por; raw files from the `main` branch, gzipped with `gzip -9`), the OCR panel's **Fast** model (default) | Apache-2.0 | `tessdata/fast/LICENSE` |
| `libheif/libheif-bundle.js` | [libheif](https://github.com/strukturag/libheif) + libde265, compiled to WASM | **LGPL-3.0** | `libheif/LICENSE` |
| `mediabunny/mediabunny.min.mjs` | [Mediabunny](https://mediabunny.dev) 1.61.6 (unmodified npm bundle), the Transcode workspace's in-browser video conversion | MPL-2.0 | `mediabunny/LICENSE` |
| `metadata/browser-id3-writer.min.js` | [browser-id3-writer](https://github.com/egoroof/browser-id3-writer) 4.4.0 | MIT | [`metadata/LICENSE-browser-id3-writer.txt`](metadata/LICENSE-browser-id3-writer.txt) |
| `metadata/exifr-full.umd.js` | [exifr](https://github.com/MikeKovarik/exifr) | MIT | [`metadata/LICENSE-exifr.txt`](metadata/LICENSE-exifr.txt) |
| `metadata/jsmediatags.min.js` | [jsmediatags](https://github.com/aadsm/jsmediatags) | BSD-3-Clause | [`metadata/LICENSE-jsmediatags.txt`](metadata/LICENSE-jsmediatags.txt) |
| `metadata/opentype.min.js` | [opentype.js](https://github.com/opentypejs/opentype.js) | MIT | [`metadata/LICENSE-opentype.js.txt`](metadata/LICENSE-opentype.js.txt) |
| `metadata/pdf-lib.min.js` | [pdf-lib](https://pdf-lib.js.org/) | MIT | **Inline** — full MIT text in the bundle; also embeds the Apache-2.0 tslib runtime, credited inline |
| `metadata/piexif.js` | [piexifjs](https://github.com/hMatoba/piexifjs) | MIT | **Inline** — full MIT text in the file header |

Every file here loads on demand (`js/core.js` `loadScript` / `needLib`), never
with the page.

### The metadata libraries

`metadata/` holds the six parsers and writers of the metadata workspace
(#metadata), one per format family, copied unmodified from the Metadata site
when it was folded into Files. MIT and BSD both require the permission text
itself to travel with a copy, and most minified bundles drop it, so each has
its licence file beside it; where a bundle carries the full text inline the
row says so.

None is dual-licensed any more: JSZip (MIT or GPL-3.0) and node-forge
(BSD-3-Clause or GPL-2.0) were removed when this project gained its own ZIP
reader (`js/lib/unzip.js`) and X.509 reader (`js/lib/asn1.js`,
`js/lib/x509.js`).

Four of those licence texts carry a bracketed note: the copyright holder was
transcribed from the upstream project because the minified bundle names no
one. Confirm them against the exact release vendored before a distribution
someone else relies on.

## The one entry that needs thought before you redistribute

**`libheif` is LGPL-3.0**, and its bundle carries `libde265` with it. LGPL-3.0 is
compatible with this project's AGPL-3.0, so there is no conflict — but the LGPL
asks that a user be able to replace the library. For a WebAssembly bundle that
means shipping it unmodified (as here) and saying so (this file).

If a build of `libheif` that includes an **x265 encoder** is ever substituted,
that component is GPL-licensed and the analysis changes. Check before swapping
the bundle.

## The rule

Adding a file to this directory means adding a row here, and its licence text
beside it, **in the same commit**. A record kept from the first vendored file is
trivial; one reconstructed two years later is not.
