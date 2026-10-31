# Files — Carino Systems

**[files.carino.systems](https://files.carino.systems)** — a client-side file & media manipulation suite. Every tool runs entirely in your browser: no uploads, no servers, no CDNs. All engines (pdf.js, Tesseract WASM, language models, the metadata parsers, fonts) are vendored in this repository, and a service worker keeps the app working offline after the first visit.

![Files — Carino Systems](screenshot.webp)

Consolidates and supersedes three earlier apps — **pdf2img-gui**, **SimpleOCR** and **SignatureEditor** — and adds two new tools. It supersedes Media (media.carino.systems) and Metadata (metadata.carino.systems), 2026.

## Tools

### 0. The file is the interface
The site opens on the file screen, a single drop/paste surface (Ctrl+V works anywhere): the file is identified by its **magic bytes** — not its extension — and everything you can do with it is offered as a one-click outcome (keys 1–9 pick one). PDF → images and OCR run right there on the file screen; the other outcomes open their module (#metadata, #images, #signature, #transcode in the slice menu), and #file returns to the same detection result so you can run another task on it:

| Detected | Outcomes |
|---|---|
| PDF | convert pages to images · OCR via page render |
| PNG / JPEG / WebP / GIF / BMP / AVIF / SVG / **HEIC** | convert format & resize · OCR · signature cleanup |
| MP3 / FLAC / OGG / WAV / M4A | convert to WAV · ffmpeg command |
| MP4 / MOV / MKV / WebM | ffmpeg command · extract audio → WAV |
| DICOM | hand-off to the fleet's DICOM editor (dcm.carino.systems) over the Carino Bridge |
| anything | Metadata workspace (#metadata) |

The cards are ranked by what the file says (a photo that carries its GPS position puts **Remove location only** first): four show (three on a phone), **Inspect / edit metadata** always last among them, and the rest wait behind a last **More** tile that opens them in place.

The screen reads top to bottom: the alert line (only when a name lies about the contents, or a photo carries its position), the preview, the cards, then the results as they happen (OCR, the clean-copy report, rendered pages), and last the **detection summary** card: the type the bytes say (not the name), size, MIME, the first 12 bytes in hex, SHA-256, format advisories (private key material, executables …) and which software opens it. On a phone the Convert and Pages-to-images panels fold to one line that reads their settings, and the top bar stays on screen.

### Privacy: clean copies
Two outcome cards on the file screen, all in the browser (`js/lib/scrub.js` for the byte work, `MetaTool.scrub()` for the per-format choices). The copy downloads as `name-clean.ext`; the original is never changed, and a report under the summary card lists what came out.
- **Clean copy for sharing** — JPEG: drops APP1 EXIF and XMP (standard and extended), APP13 Photoshop/IPTC and COM, keeps JFIF, ICC and Adobe segments and copies the scan verbatim; a photo stored sideways gets a one-tag EXIF holding only its Orientation, so it does not turn. PNG: drops tEXt, iTXt, zTXt, eXIf and tIME (chunk CRCs untouched). WebP: drops the EXIF and XMP chunks, clears their VP8X flags and fixes the RIFF size. PDF: a full rewrite (pdf-lib, encrypted PDFs refused): every page is copied into a new document with no Info, no catalog XMP and no /ID, saved without object streams; per page /Metadata, /PieceInfo and /LastModified go, per annotation the author (/T, kept on form widgets where it is the field name), /M, /CreationDate and /RC; the form (AcroForm) is carried, bookmarks are not. Objects that earlier saves left unreferenced never reach the copy. The report counts each category (Document info, Document XMP, Page-level XMP, PieceInfo, Annotation authors, Old revisions) and folds past six lines behind **+k more**. MP3: removes ID3v2 and ID3v1 and writes back only title, artist and album. HEIC / AVIF have no lossless path: the copy is a JPEG and the card says so.
- **Remove location only** (JPEG) — empties the EXIF GPS block (piexif) and removes `exif:GPS*` from the XMP packet; everything else stays. The metadata workspace's Strip GPS switch does the same.
- Several files at once: **Clean all** in the set view (below) makes one `clean-copies.zip` and marks each row ✓ Done or ✕ with the reason.
- The copy is checked again after it is made (detection + an exifr GPS read).

### Several files at once: the set view
Two or more files dropped, pasted, picked or bridged in together open the **set view** (`js/lib/tray.js` for the pure parts). The rail keeps the dropzone, now **Add files** (anything dropped while a set is held joins it), and one summary chip: `SET`, *n files*, and the mix by kind plus the total size. The pane has the set cards (**Clean all**, **Convert images**; each says how many of the files it covers), then the tray: one row per file with its detected type (read from the first 512 KiB only, never hashed) and size, a warning when the name lies, and the last bulk run's result. A row opens that file in the single view, whose top bar gets **← n files** back (Backspace or Esc too); ✕ (or Delete) takes a row out, down to one file (the single view) or none (the start screen). ↑/↓ move between rows. **Export ▾** saves the metadata of every file as one CSV (`files-metadata.csv`: file, type, size, MIME, then every group:key any file has) or JSON (`files-metadata.json`), read with the metadata workspace's own parsers. Several files pasted while Metadata is open go to the set view, since Metadata opens one file at a time; a set bridged to `#metadata` opens its first file there and keeps the set.

Once a file is in, every module's top bar shows **Same file:** chips: one per other module that accepts the file, which runs that module's main outcome (or opens the file there) without dropping it again. Clear on the file screen forgets the file and the chips go.

### Verify a hash
Next to the SHA-256 on the summary card, **Verify** opens one field: paste the digest a download page publishes and it says **Match** or **No match**. The algorithm comes from the length (32 hex = MD5, 40 = SHA-1, 64 = SHA-256, 128 = SHA-512); an `sha256:` style prefix, a `sha256sum` line (`<hex>  name`) or a BSD line (`SHA256 (name) = <hex>`) all work, and only that one digest is computed (`js/lib/hashes.js` detects it and holds a streaming MD5; SHA-1 and SHA-512 use Web Crypto, up to 64 MiB). Pasting a bare digest anywhere on the file screen (not in a text field) opens it too. Esc closes it.

### Edit PDF pages (#file/pages)
A mode under File: **Edit pages** on a single PDF, **Merge PDFs** when the tray holds two or more (in tray order), or `#file/pages` directly. The rail lists the sources (A, B, C…, ✕ removes one) and a closed **Split** (Every page | Ranges, e.g. `1, 3-5`). The pane is a grid of lazily rendered thumbnails: click, Shift-click or Space to select; drag, **‹ Move / Move ›** or Shift+←/→ to reorder; **Rotate ⤾** (R), **Delete**, **Undo** (Ctrl/⌘+Z). Nothing is written until **Save PDF** (`<name>.pages.pdf`) or **Export ▾** Selected pages (`.selected.pdf`) / Split (`.split.zip`). The edits are an op list in `js/lib/pageops.js`; pdf-lib builds the output.

### Compare two files (#file/compare)
A mode under File: **Compare** leads the cards when exactly two files are held, every single file has **Compare with…** under More, and `#file/compare` opens two empty slots. The rail holds File A and File B (⇄ Swap between them); the pane says **Identical bytes** (the SHA-256s match) or **Different files · n differences**, then a table of Field | A | B: type, size, MIME, the first 12 bytes, SHA-256 (MD5 and SHA-1 on request), then every metadata row the metadata workspace reads, differences highlighted and **Differences | All** to filter. **Export ▾** saves the comparison as CSV or JSON. The diff is `js/lib/compare.js`; Done or Esc goes back to the file screen.

### Redact an image (#file/redact)
A mode under File: the **Redact** card on any image (JPEG, PNG, WebP, HEIC, AVIF…), or `#file/redact` directly. Drag on the picture to draw a black box; click a box to select it, Delete removes it, the arrow keys nudge it (Shift: 10 px), Ctrl/⌘+Z or **Undo** undoes. **Find text** reads the picture once with the OCR engine (the language and Fast/Best model chosen in the OCR panel), then finds words case- and accent-blind, phrases across words on one line; **Box all** covers every match. **Download redacted** draws the full-resolution picture, fills each box 100% black (burned in: the pixels underneath are gone, nothing is overlaid), re-encodes it (JPEG stays JPEG at q 0.92, PNG and WebP stay, anything else becomes PNG), checks the bytes carry no EXIF or XMP and saves `<name>.redacted.<ext>`. PDFs get no Redact card: Files does not claim true PDF redaction. The geometry and word search are `js/lib/redact.js`.

### 1. Metadata (#metadata)
Read, edit and export what a file says about itself — ported from the former Metadata site. Detection is by **magic bytes** (`js/lib/detect.js`, one detector for the whole suite), with format advisories and recommended software.

| Format | Read | Edit & write back |
|---|---|---|
| JPEG | EXIF / XMP / IPTC / GPS (exifr) | ✅ Description, Artist, Copyright, Software, Make, Model, DateTimeOriginal, **Strip GPS** (piexif) |
| PNG / TIFF / WebP / HEIC / AVIF / GIF / BMP | EXIF / XMP / dimensions | read-only |
| SVG | dimensions | read-only |
| PDF | Info dictionary, pages, dates (pdf-lib) | ✅ Title, Author, Subject, Keywords, Creator, Producer |
| MP3 | ID3 tags, artwork (jsmediatags) | ✅ title, artist, album, year, genre, track, comment (browser-id3-writer) |
| MP4 / MOV / MKV / AVI | brand, top-level atoms, duration, resolution | read-only |
| ZIP / DOCX / XLSX / PPTX / ODT / EPUB / JAR / APK | entries, Office core + app properties, OpenDocument meta.xml (own ZIP reader, `js/lib/unzip.js`) | read-only |
| TTF / OTF / WOFF / WOFF2 | names, licence, metrics (opentype.js) | read-only |
| X.509 certificates (PEM / DER / PKCS#7 .p7b) | subject, issuer, validity, key algorithm (RSA bits, ECDSA P-256/384/521, Ed25519, Ed448), signature algorithm, expiry warning (own ASN.1 + X.509 reader, `js/lib/asn1.js` + `js/lib/x509.js`) | read-only |
| Private keys, PKCS#12, PGP, KeePass | type only — **secrets are never extracted** | read-only |
| PE / ELF / Mach-O / WASM | header: architecture, format, sections, timestamp | read-only |
| GZIP / 7z / RAR / TAR / SQLite / text / anything else | generic file info, signature, SHA-256 | read-only |

- Every file gets name, size, MIME guess, extension, modified date, SHA-256 (automatic up to 50 MiB, a button above) and the first 12 bytes.
- Search across keys and values; staged edits are flagged until you **Save & download** a rewritten copy (`name-meta.ext`).
- Export the whole overview as **JSON**, **CSV** or a printable **report** (Save as PDF).
- Each library loads the first time a file needs it; nothing is fetched with the page, and only the head of the file (512 KiB) is read unless a parser or writer needs the whole of it. Video is never read whole.

### 2. PDF → Images
Render PDF pages to PNG, JPEG or WebP with [pdf.js](https://mozilla.github.io/pdf.js/) (vendored, v6).
- DPI presets (72 / 150 / 300) or any custom value from 36–600
- Page-range selection (`1, 3-5`), transparent or white background, quality slider for lossy formats
- Per-page download or a single ZIP of all pages

### 3. OCR — Text Recognition
Extract text from images with [Tesseract.js](https://tesseract.projectnaptha.com/) (vendored, v7 + core WASM v7), fully offline.
- Runs when you press **Extract text** under the image or PDF page: nothing OCR-related is downloaded when a file lands. After the first use in a visit, the engine preloads while the page is idle for the next file.
- Languages: **English, Español, Português** plus combined pairs. Two models per language, under **Options**: **Fast** (default, `vendor/tessdata/fast/`, from tessdata_fast) and **Best** (`vendor/tessdata/`, slower and a larger download). The choice is remembered on this device. Tesseract reads the gzipped models natively.
- Options also hold Invert view, Invert for OCR (white-on-dark text) and Rotate.
- Confidence badge, copy to clipboard, `.txt` download.
- **Searchable PDF**: the image as one page (1 px = 1 pt) with an invisible text layer from the OCR word boxes, so the PDF looks like the picture but can be searched and copied (`<name>.searchable.pdf`). For a PDF, **Searchable PDF (all pages)** (or the **Make searchable** card, which leads for a PDF with no text on page 1) renders every page at about 300 DPI, reads it and rebuilds the document page by page at the original sizes; it can be cancelled. The text layer uses the standard Helvetica, so nothing is embedded; characters it cannot encode read `?` in that invisible layer only.

### 4. Signature Cleanup
Turn a photo/scan of a signature into a clean transparent PNG — pure canvas/JS, no OpenCV, and the whole UI **fits on one screen** (preview + thumbnail strip + one compact control column, no scrolling):
1. Grayscale (Rec.601 luma)
2. **Auto polarity** — the border ring decides whether ink is dark-on-light or light-on-dark (manual override available)
3. **Lighting flattening** — a coarse background estimate (area-average downscale → 3×3 max filter → box blur → bilinear upsample) divides out shadows and uneven paper, so a phone photo with a shadow across it no longer thresholds into a black slab
4. **Otsu automatic threshold** on the flattened image, with a 35 % ink-coverage cap as a safety net, plus a manual slider override
5. Background → transparent alpha, with optional soft (feathered) edges
6. **Despeckle** — connected-component analysis drops ink blobs under N px
7. Auto-crop to ink bounds with adjustable padding; ink recolor (black / blue / custom)
8. Manual eraser brush with undo; export transparent PNG at 1× / 2× / 4× (nearest-neighbour), single file or all-as-ZIP

### 5. Image Converter
Batch-convert images to PNG / JPEG / WebP via canvas re-encode.
- **HEIC/HEIF input** is decoded locally with a vendored [libheif](https://github.com/strukturag/libheif) WASM bundle (`vendor/libheif/`, loaded lazily on first HEIC) — iPhone photos convert without any upload
- Quality slider for lossy formats, optional max-dimension downscale (aspect preserved, never upscales)
- Per-file download or one ZIP for the whole batch
- **Metadata: Strip · Keep** (here and in the file screen's Convert panel). The canvas writes no metadata, so Strip (the default) says what always happened: EXIF, location included, is gone. Keep carries the source EXIF into a JPEG made from a JPEG (Orientation and the old thumbnail dropped, GPS only with *incl. location*); any other pairing shows *metadata not carried*. Each result shows a badge saying which.

### 6. Transcode
Browsers can't transcode video offline without a ~30 MB WASM blob, so this is the honest tool:
- **ffmpeg command builder** — ports the intent of the old `transcode.sh`: H.264 / H.265 / AV1 / VP9, software or NVENC/QSV/AMF hardware encoders, CRF quality, resolution, audio/subtitle handling, two-pass for VP9/AV1 — and explains every flag it emits
- **Audio → WAV** — this one *does* run in-browser: anything your browser can decode (MP3, AAC, OGG, FLAC…) → 16-bit PCM WAV, with optional mono downmix

## Offline (service worker)

After one visit the app opens with no connection (the About popup says so; there is no other UI). `sw.js` precaches the **shell** on install: `index.html`, `css/`, `js/` (the hash worker included), `i18n.js`, the shared `carino-*` files, `fonts/carino-fonts.css` and the faces it names, and the logos. **`vendor/` is never precached**: each vendor file is cached the first time the app asks for it (pdf.js on the first PDF, Tesseract and one model on the first **Extract text**), so a visit that only cleans a JPEG downloads none of the tens of megabytes. Range requests and opaque responses are not stored.

The shell cannot go stale for good:
- HTML is network-first with a ~3 s timeout, falling back to the cached `index.html` (a `#carino-bridge` navigation is just `./`: the fragment never reaches the network).
- The other shell files are cache-first; when the network serves an `index.html` that differs from the cached one, they are fetched network-first until the new worker takes over, so a new page never runs old scripts.
- `VERSION` is the sha256 of every shipped file, `vendor/` included. A deploy changes `sw.js`, the browser installs the new worker, and on activate it deletes every `files-*` cache of another version (`files-shell-<VERSION>`, `files-vendor-<VERSION>`).

The generated block in `sw.js` (`VERSION` and the `SHELL` list) is written by `python3 -I tools/build_sw.py` and checked by `--check` (run by `tests/sw.test.mjs`); `Carino-Systems/propagate.sh` rebuilds it after copying the shared files in. The worker is registered from `js/expose.js` after `load`, over https or on `localhost`/`127.0.0.1` only, never on `file://`.

## Carino Bridge (receiving files from other fleet pages)

Files is a [Carino Bridge](carino-bridge.js) receiver: another Carino page can hand it files in memory, with nothing uploaded. The sender opens one of these URLs (without `noopener`, since the opener is the channel) and posts the files with `CarinoBridge.send(url, files)`:

| URL | Where the files land |
|---|---|
| `https://files.carino.systems/#carino-bridge` | the file screen: identified, with the usual outcome cards |
| `https://files.carino.systems/#metadata&carino-bridge` | straight into the metadata workspace |

Only these origins may deliver; any other origin gets no reply (`otherwise: 'deny'`):

- `https://desk.carino.systems`
- `https://quote.carino.systems`
- `https://fiscal.carino.systems`
- `https://dcm.carino.systems`
- Files itself (`same-origin`)

The toast names the origin the files actually came from. The receiver is wired in `js/file-screen.js`; `carino-bridge.js` is the fleet's shared copy and is not edited here. Files also *sends*: a DICOM file goes to the editor at dcm.carino.systems over the same bridge.

## Implementation notes

- **No frameworks, no build step, no runtime network calls.** Vanilla JS as classic scripts (no ES modules) that share one top-level scope: `js/core.js` (helpers + lazy `loadScript`/`needLib`), DOM-free `js/lib/` (ZIP writer and reader, ASN.1 / X.509 reader, page ranges, ffmpeg builder, WAV encoder, format detector, software recommendations, route resolution, outcome ranking), `js/router.js` (modules, modes under them such as `#file/pages`, and the `FilesApp` workspace registry the file screen builds its outcome cards from), one file per workspace in `js/ws/`, and `js/file-screen.js`. Styles are in `css/`.
- The ZIP downloads use a ~60-line **store-only ZIP writer** written for this project (local file headers + central directory + CRC-32). Archives are *read* by `js/lib/unzip.js` (end of central directory → central directory → local headers, Zip64 aware; deflate through the browser's `DecompressionStream('deflate-raw')`), with every offset bounded and the inflated size capped. Certificates are read by `js/lib/asn1.js` + `js/lib/x509.js`. JSZip and node-forge are no longer vendored.
- File saving is a plain blob + anchor helper — no FileSaver.js.
- `vendor/pdfjs/` — pdf.js build (`pdf.min.mjs` + worker), dynamically imported on first use.
- `vendor/tesseract/` — loaded on the first OCR run, not with the page: tesseract.js `tesseract.min.js` + `worker.min.js` and all `tesseract-core-*.wasm.js` variants (plain / SIMD / relaxed-SIMD, each with an LSTM-only build); the worker picks the best one for the CPU at runtime.
- `vendor/tessdata/` — `eng` / `spa` / `por` traineddata, kept gzipped (the **Best** model); `vendor/tessdata/fast/` — the same three from tessdata_fast (the default **Fast** model).
- `vendor/metadata/` — the metadata workspace's six libraries (exifr, piexif, pdf-lib, jsmediatags, browser-id3-writer, opentype.js), each loaded by `needLib` on first use; licences in `vendor/README.md`.
- `vendor/libheif/` — libheif WASM single-file bundle (wasm inlined as base64), injected only when a HEIC file is actually opened; HEIC is normalized to PNG at the door so OCR, Signature and the converter all accept it.
- The page is a **fixed-viewport layout**: the body never scrolls — long content scrolls inside its own panel.
- Fonts are self-hosted (`fonts/carino-fonts.css`); the shared fleet navbar is `carino-navbar.js` + `carino-clock.js`.
- Internals are exposed on `window.FilesTools` for testing (`window.MediaTools` is kept as an alias).

**Related tools:** [Vitae](https://vitae.carino.systems/) · [Quote](https://quote.carino.systems/)

## Tests

```sh
node --test --test-concurrency=1 tests/*.test.mjs   # the pure modules, i18n coverage, script wiring, sw.js
python3 -I tools/build_sw.py                       # after any change to a shipped file: rewrite sw.js VERSION + SHELL
./tests/smoke/run.sh                                # one headless-Chromium pass over the real page
```

- `tests/*.test.mjs` load the DOM-free `js/lib/` modules the way the page does (`tests/load.mjs` concatenates the classic `<script>` list from `index.html` and runs it once with `node:vm`) and test them with `node:test`: format detection, software recommendations, the ZIP writer and CRC-32, the ZIP reader (deflate, Zip64, truncated and hostile archives), the ASN.1 / X.509 reader (RSA, RSA-PSS, ECDSA P-256/384/521, Ed25519, Ed448 and PKCS#7 certificates, checked against `node:crypto`'s `X509Certificate`), the JPEG Exif span the converter reads, page ranges, the ffmpeg builder (shell quoting, quality caps), the WAV encoder, the metadata scrubbers, CSV cells, SHA-256 against `node:crypto`, route resolution (`#file/pages` and its fallbacks), the outcome cards' ranking, cap and More split, and the Redact geometry and OCR word search. Fixtures are byte builders in `tests/fixtures.mjs` (the certificates are PEM text made once with `openssl req -x509`); there are no binary files. `i18n.test.mjs` checks every UI string has `es`, `pt-BR`, `ja` and `ru` text; `scripts.test.mjs` compiles all app scripts as one scope (a duplicate top-level name fails), and checks the script order and that vendor code loads on demand only; `sw.test.mjs` runs `tools/build_sw.py --check`, checks every precached path exists, that no `vendor/` path is precached and that `sw.js` parses. The files are named explicitly (the shell expands the glob), so Node 20 and 22 run the same set; CI runs exactly this command on Node 20 (`.github/workflows/tests.yml`).
- `tests/smoke/run.sh` serves the repo over HTTP and drives one headless Chromium through the page with Playwright: no console errors, no vendor download before a file, a PNG through the file screen into the metadata workspace, `#metadata` direct, a JPEG with GPS showing the location advisory and "Clean copy for sharing" downloading a copy with no EXIF, and `#transcode`, then (in a fresh context) the service worker: the shell cache, nothing from `vendor/` in it, and the page and a PDF reopened offline. It uses `tests/smoke/node_modules` when installed (`cd tests/smoke && npm install && npx playwright install chromium`), else the Topo repository's `tests/node_modules` checked out beside this one. It is not run in CI.
- **Memory:** the smoke run starts a browser, so it checks `free -m` first and skips (exit 0, with the reason) below 3000 MB available. Run it alone, not alongside other browser test runs; the node suite runs its files one at a time (`--test-concurrency=1`).

## Licensing

**Mine — GNU Affero General Public License v3.0 or later.** Everything in this
repository *except* the paths listed below. Copyright © 2026 Miguel Carino.
Full terms in [LICENSE](LICENSE).

**Not mine.** The files below are third-party works redistributed here. This
project's licence does not cover them and could not: they are not mine to
relicense. Each keeps its own terms, and each carries its own notice.

| Path | What it is | Licence | Notice |
| --- | --- | --- | --- |
| [`fonts/`](fonts/) | IBM Plex Mono, IBM Plex Sans, Red Hat Display | SIL OFL 1.1 | [`fonts/OFL.txt`](fonts/OFL.txt) |
| [`vendor/`](vendor/) | third-party JavaScript | per package — see the notice | [`vendor/README.md`](vendor/README.md) |

Those files travel with any fork, mirror or repackaging of this repository, and
their notices must travel with them.

Part of the [carino.systems](https://carino.systems/) fleet.
