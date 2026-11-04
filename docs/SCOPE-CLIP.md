# Clip: scope for a size-exact video clip maker

Rev 3 · 4 November 2026 · status: **approved; all §10 decisions settled by
the owner on 4 November 2026; P0 measurements in §12**. The Clip engine is also planned as part of a
standalone imageboard client, CloverEye (`~/Github/CloverEye/docs/SCOPE.md`), so the
pure parts (`fit.js`, presets, plan) are written to be shared.

Clip turns part of a video into a small, good-looking file that fits a size
limit: a 4 MB WebM for an imageboard, a 10 MB MP4 for a chat app, a 2 MB loop.
It runs entirely in the browser, like the rest of Files. Nothing is uploaded.

This scope comes from a review of what people use today, their complaints
(a /g/ thread from 2 November 2026 with about 150 posts), and what Files
already ships (`js/lib/convert.js`, `js/ws/transcode.js`, Mediabunny 1.61.6).

---

## 1. Why a new tool

People use several tools and each one fails somewhere:

| Tool | Kept for | Fails at |
|---|---|---|
| WebM for Retards / Bakas / Lazys | A small editor: crop, speed, overlays, subtitles | Windows only (.NET 4.8). Slow to index large files. Drops the last seconds. Subtitle timing drifts on older anime. |
| mpv-webm (and forks) | Marking in/out and crop while watching | Slow VP9, no SVT-AV1, hard to set up |
| CRF brute-force fork | Fits the limit | Re-encodes until it fits, so it's slow |
| webm-for-4chan (Python) | Board presets, one command | Leaves part of the size budget unused |
| Shutter Encoder, FFmpeg-Converter-GTK | Linux, have a size limiter | Slow when fitting a file to a size |
| HandBrake / VidCoder | Familiar | No file-size target |
| ffmpeg by hand | No extra tool | Fine for a trim; slow for pixel-accurate crops and frame-accurate cuts |

No tool does all of these at once: hit the size, look as good as that size
allows, and let you pick the clip by watching it.

## 2. What "best" means (the requirements)

| # | Requirement | Measured by |
|---|---|---|
| R1 | **Fill the size limit without going over.** Land at 96–99.5% of the limit, never above it. | Fixture suite (§8): no output over the limit, median ≥ 97% |
| R2 | **Hit the size quickly.** One full encode in most cases, two at most. | Count of full encodes per job in the fixture suite |
| R3 | **Warn before the result looks bad.** If the bitrate is too low for the resolution and length, say so before encoding and offer a fix (smaller size, lower fps, shorter clip). | Bits-per-pixel check (§4.3) |
| R4 | **Pick by watching.** Frame-accurate in/out, frame stepping, a drag-to-crop box with exact numbers. | Manual pass plus smoke tests |
| R5 | **Burned-in subtitles stay in sync**, including variable-frame-rate sources and older ASS releases. | Subtitle fixtures (§8) |
| R6 | **HDR sources come out normal**, not grey or washed out. This matters for iPhone footage, which records HDR by default. | HDR fixtures, compared by eye and histogram |
| R7 | **Works in Chrome, Firefox and Safari** on desktop and phone, with no install. | Capability matrix (§6) |
| R8 | **Show the equivalent ffmpeg command** for every job, so a CLI user can reproduce or batch it. | Reuses `buildFfmpegCommand` |
| R9 | **Never truncates the end.** The output's duration matches the selection to within one frame. | Fixture duration check |
| R10 | **Opens large files instantly.** A 2 GB source shows its first frame in under 2 s, with no full read and no indexing pass. | Smoke timing on a large fixture |

Out of scope: downloading from URLs (yt-dlp). It would break the fleet's
no-outside-requests rule. Drop a local file instead.

## 3. Where it lives

Clip is a **mode under File** (`#file/clip`), like Pages, Compare and Redact.
It is not a new subdomain (see the fleet merge rule). It opens from:

- a **Make a clip** card, first among the cards for any video;
- the existing **Convert in this browser** panel, which gains a size target
  and hands off to Clip when the job needs editing.

`#transcode` stays as the "change the format of the whole file" tool. Clip
is for "make a small piece of it". Both share one engine (§4).

## 4. The engine

### 4.1 Pipeline

```
File (Blob, read lazily) ─► Mediabunny Input (MP4/MOV/MKV/WebM)
   ─► decode (WebCodecs VideoDecoder, via Mediabunny sinks)
   ─► per frame, on a WebGL2 OffscreenCanvas in a worker:
        crop ─► HDR→SDR tone map ─► scale ─► subtitles ─► text overlay
   ─► VideoEncoder (VP9 / AV1 / H.264, per browser, §6)
   ─► Mediabunny muxer (WebM or MP4) ─► counted bytes ─► file
audio: decode ─► trim/speed ─► AudioEncoder (Opus / AAC) or dropped
```

Mediabunny 1.61.6 already does trims, crops, a per-frame `process` hook,
`bitrateMode`, reading MKV attachments (needed for subtitle fonts) and
detecting HDR sources. Clip adds the frame stage, the size-fit
controller, and the editor UI.

Every frame keeps its **source timestamp** until the muxer. Subtitles are
drawn at source time, never at output time. This is what fixes R5 (§4.5).

### 4.2 The size-fit controller (`js/lib/fit.js`, DOM-free)

The budget, in bytes:

```
budget = limit × 0.99                    safety margin
       − container overhead              per packet, not a %: 1 KB + 12 B × (frames + audio packets) (§12.2)
       − audio bytes                     audio bitrate × duration (Opus is near-constant)
video bitrate = budget × 8 / duration
```

Then:

1. **Probe.** Encode 3 short samples (2 s each, spread across the selection)
   at the computed bitrate. Compare the bytes each sample produced with the
   bytes requested. This measures how far *this* encoder overshoots or
   undershoots on *this* content. Hardware H.264 and software VP9 behave very
   differently, which is why one fixed formula fails.
2. **Correct and encode.** Scale the bitrate by the measured factor and run
   the full encode. Always pass the frame rate to the encoder (§12.3).
   Chromium and Firefox: `bitrateMode: 'constant'` (tighter, same quality;
   in Firefox it only changes VP9, §12.3); other browsers: `'variable'`
   until measured otherwise.
3. **Watch it live.** Count muxed bytes as they arrive. Project the final size
   from bytes so far and time encoded so far. If the projection is more than
   3% over the budget past the 25% mark, abort and restart lower. This costs
   one partial encode, not a full one.
4. **Top up (optional).** If the result is below 95% of the limit and the clip
   is short (estimated time under 30 s), offer one more encode at the
   corrected bitrate to use the rest. The default is on for clips of 60 s or
   less.
5. **Never ship over the limit.** A file over the limit is not offered for
   download; the tool re-encodes it at 97% of the previous bitrate.

Two modes:
- **Fill the limit** (default): R1.
- **Smallest good file**: stop at a bits-per-pixel ceiling, so a 3 s clip
  doesn't come out at 4 MB for no visible gain.

Unit tests: the controller is pure (inputs: limit, duration, probe results,
byte stream; outputs: bitrates and decisions), so node tests can feed it
recorded probe data from the fixture suite.

### 4.3 The quality warning

`bpp = video bitrate / (width × height × fps)`. Thresholds tuned in P0
(§12.5) for the browsers' WebCodecs encoders. The "floor" is the bpp below
which the encoder stops honouring the bitrate at all, so the file can't hit
the size: below it, Clip must change the plan, not warn.

**Which bitrate.** The planner only knows the *requested* bitrate, so every
line here is in **requested bpp**, for the encoder settings of §4.2 step 2
(constant mode). In constant mode the encoders spend what they are asked
for above the floor (actual ÷ requested 0.97–1.04 in Chromium, §12.3), so
the lines, tuned on actual bpp in §12.5, carry over unchanged. In variable
mode they don't for VP9: Chromium VP9 spends only 0.6–0.7× of the request
on easy content, so a variable-mode VP9 plan needs **≥ 0.10** requested for
"good" (sweep: easy 720p30 is within 0.01 of its ceiling from requested
0.12, actual 0.086). AV1 and VP8 track the request within about 10% above
the floor in either mode. The floor columns are the *actual* bpp the
encoder bottoms out at, which is what a request can be compared with
directly: ask for less and the encoder overshoots.

| Codec | Good (requested bpp) | Visibly blocky below | Encoder floor, Chromium | Encoder floor, Firefox |
|---|---|---|---|---|
| AV1 | ≥ 0.05 | 0.015 | 0.005–0.02 | ~0.06–0.08 |
| VP9 | ≥ 0.07 | 0.025 | 0.013–0.037 | ~0.08–0.10 |
| VP8 | ≥ 0.12 | 0.06 | 0.025–0.047 | ~0.11 |
| H.264 | ≥ 0.08 | 0.05 | not measured (Clip is WebM only, D4) | |

The planner treats the higher of "blocky" and the browser's floor as the
line. In Firefox that means the floor decides (§12.3).

When the plan falls below the "blocky" line, the tool shows one line before
encoding, e.g. "45 s at 1080p in 4 MB will look blocky. 720p looks better at
this size." It offers a pick: **720p** · **24 fps** · **Trim to 30 s** ·
**Encode anyway**. The suggestion walks a ladder (1080 → 720 → 540 → 480 →
360, then 60 → 30 → 24 fps) and picks the largest size that clears the line.

### 4.4 Picture

- **Crop**: Mediabunny's crop, with even dimensions enforced.
- **Scale**: a WebGL2 shader (bicubic, or Lanczos where the GPU allows it),
  not canvas bilinear, because downscaling quality decides how small files
  look. Maximum side capped by the preset (e.g. 2048).
- **HDR → SDR**: if the source is PQ or HLG (Mediabunny reports transfer and
  primaries), tone map in the same shader (BT.2390 EETF, then BT.2020 →
  BT.709 primaries) to an SDR output. Don't rely on the browser's canvas
  tone mapping; it differs between engines.
- **Frame rate**: keep, or drop to 30/24 by picking frames by timestamp.
- **Speed**: 0.25–4×. Video by retiming timestamps. Audio: mute, or a
  WSOLA time-stretch (pitch kept), in P3.
- **Text caption**: top/bottom text, outlined. Images as overlays come later.

### 4.5 Subtitles (P4)

The drift bug in other tools has a known cause: seeking (`-ss`) before the
input resets timestamps to zero, and the subtitles filter then reads the
wrong times. Variable-frame-rate sources make it worse. Clip avoids both by
design: every frame keeps its source timestamp, and subtitles render at that
time.

- Sources: subtitle tracks inside MKV (ASS/SSA, SRT), with fonts from MKV
  attachments, or a dropped `.ass`/`.srt`/`.vtt` file.
- Renderer: full libass compiled to WASM (JASSUB, MIT), vendored and loaded
  only when a job has subtitles (D5). SRT and VTT are converted to ASS and go
  through the same renderer, so there is one code path.
- A **±offset** control (in ms) for releases that really are off.

### 4.6 Presets (`data/targets.json`)

Presets are data, not code. Each entry has a `checked` date and a `source`
URL, so they can be re-verified like Law's country files:

```json
{ "id": "board-4mb", "label": "Imageboard · 4 MB · no sound",
  "maxBytes": 4194304, "audio": false, "maxSide": 2048,
  "maxSeconds": 120, "checked": "2026-11-04", "source": "…/boards.json" }
```

Starting set (values to verify before shipping): 2 MB and 4 MB with no
sound, a larger limit with sound, a chat app's free upload limit, and
**Custom** (any size, MB or MiB shown explicitly). A validator in `tests/`
fails when an entry has no `checked` or `source`.

## 5. The editor (P2)

- **Player**: `<video>` when the browser can play the source; otherwise
  frames are decoded with WebCodecs onto a canvas (needed for MKV, and for
  WebM on some Safari versions).
- **Timeline**: a thumbnail strip (keyframes decoded on demand), in/out
  handles, the playhead, and the selected length plus estimated size shown
  live.
- **Keys** (listed in the About popup's keyboard grid like the rest of Files):
  Space play/pause · `,` `.` one frame · Shift+`,` `.` one second ·
  `I` / `O` set in/out · `J` `K` `L` shuttle · `C` crop · Esc back to `#file`.
- **Crop box**: drag handles over the picture, aspect locks (free, 1:1, 16:9,
  9:16, 4:3), numeric x/y/w/h fields, snaps to even pixels.
- **Several segments**: add more in/out ranges; they're joined in order
  (cut-list). The size budget covers the total length.
- **Frame accuracy**: in/out are stored as source timestamps of real frames
  (from `requestVideoFrameCallback` metadata or decoded samples), never as
  `currentTime` guesses. The encoder decodes from the keyframe before the
  in-point and discards frames before it, so the cut is exact and costs only
  the extra decode (the "seek fast but stay exact" answer to the thread's
  `-ss` argument).

## 6. Browser support, including WebKit

### 6.1 Measured on this machine (4 November 2026)

Playwright's bundled engines on a localhost page, `VideoEncoder.isConfigSupported`
at 1280×720, 1 Mbps:

| | VP8 | VP9 | AV1 | H.264 | HEVC | Opus | AAC | Save picker | OPFS |
|---|---|---|---|---|---|---|---|---|---|
| Chromium 149 | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ | ✓ | ✓ |
| Firefox 151 | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | ✓ |
| WebKit | not run: Playwright's WebKit build needs Ubuntu libraries (libicu74, libjpeg-turbo8) and installing them needs sudo |

All three support `requestVideoFrameCallback`. "Supported" means the
config is accepted, not that the encoder is fast. Speed is measured in P0.

**P0 matrix (4 November 2026).** `tests/smoke/codecs.html` opened through
Playwright on `127.0.0.1`, Chromium 149.0.7827.55 and Firefox 151.0
(headless, Linux, no GPU video). Both rows saved as JSON in
`tests/clip/results/codecs-<browser>.json`. Encoder configs were tried at
1280×720 and 1920×1080, 2 Mbps, 30 fps, both bitrate modes, with
`prefer-hardware` and `prefer-software`:

| | Chromium 149 | Firefox 151 |
|---|---|---|
| VP8 / VP9 / AV1 / H.264 encode, 720p and 1080p, variable and constant | software ✓, hardware ✗ | software ✓, hardware ✗ |
| HEVC encode | ✗ | ✗ |
| Opus / AAC encode | ✓ / ✗ | ✓ / ✗ |
| Decode VP8, VP9, VP9 10-bit, AV1, AV1 10-bit, H.264 | ✓ | ✓ |
| Decode HEVC, HEVC main10 | ✗ | ✗ (but `canPlayType` mp4 HEVC says "probably") |
| `canPlayType` WebM VP8/VP9/AV1, VP9+Opus | probably | probably |
| `canPlayType` Matroska | maybe | maybe |
| rVFC, OPFS, Wake Lock, OffscreenCanvas + WebGL2, VideoFrame | ✓ | ✓ |
| `showSaveFilePicker` | ✓ | ✗ |
| Canvas `display-p3` / `float16` | ✓ / ✓ | ✗ / ✗ |
| HDR display (`dynamic-range: high`), P3 gamut | ✗ (headless) | ✗ (headless) |

Encode speed, WebM through the vendored Mediabunny, frames per second of
wall time (median over the fixture runs in §12; 1080p30 is the odd-size and
rotated fixtures, which take a slower path):

| Browser | Codec | 720p30 | 1080p30 | 1080p60 | 2160p24 |
|---|---|---|---|---|---|
| Chromium 149 | VP9 | 294 | 71 | 167 | 38 |
| Chromium 149 | AV1 | 216 | 47 | 117 | 28 |
| Chromium 149 | VP8 | 432 | 90 | 212 | 48 |
| Firefox 151 | VP9 | 12 | 7.0 | 6.0 | not run |
| Firefox 151 | AV1 | 13 | 10 | 6.2 | not run |
| Firefox 151 | VP8 | 51 | 40 | 31 | not run |

The two browsers' medians cover different fixture sets (Firefox ran the
§12.1 subset), so the rows aren't like for like: Chromium's 1080p30 is the
odd-size and rotated clips, Firefox's only the rotated one; Chromium's
1080p60 and 720p30 include the 30 s and 120 s clips. On the same outputs
(the 14 jobs per codec both browsers ran), Chromium is 18–27× faster for
VP9 and 10–18× for AV1 on the 720p and 1080p60 clips, but only 5.5–6× (VP9)
and 4× (AV1) on the rotated 1080p30 phone clip, where Chromium itself
slows to about 41 fps. VP8: 4–8×, and 1× on the rotated clip.

Chromium encodes VP9 at about 10× real time at 720p30 and 2.8× at
1080p60. Firefox encodes VP9 and AV1 at 0.4× real time at 720p30 and 0.1×
at 1080p60: a 30 s 1080p60 clip takes about 5 minutes. VP8 is the only
codec Firefox encodes near real time.

### 6.2 What to expect from Safari (to verify; not measured yet)

From Safari's public release history, as far as known at writing:

- **WebCodecs video** (VideoEncoder/VideoDecoder) shipped in Safari 16.4.
  H.264 and HEVC encode through the hardware; VP9 encode is uncertain;
  **AV1 encode is not expected**.
- **WebCodecs audio** (AudioEncoder) arrived later than video. Whether it
  encodes Opus is not confirmed. AAC is likely.
- **No `showSaveFilePicker`**: output is a normal download. That's fine:
  Clip's outputs are a few MB, so building them in memory is cheap.
- **WebM playback** varies by version and platform, hence the canvas
  fallback player (§5).
- **iOS**: picks from Photos arrive as HEVC, often HDR (R6 matters most
  here). Background tabs get suspended (keep the screen on with the Wake
  Lock API, and warn that switching apps pauses the encode). Tab memory is
  tight, so the source is read lazily as a Blob, never loaded whole.

### 6.3 Rules that make WebKit work

1. **Probe, never sniff.** Pick codecs from `isConfigSupported` (already done
   through Mediabunny `canEncodeVideo` in `transcode.js`), never from the user
   agent.
2. **WebM or nothing (D4).** Codec ladder: VP9 → AV1 → VP8, always in WebM.
   A browser that can encode none of them (Safari, if the Mac test shows
   that) doesn't get Clip: the mode opens with one line saying this browser
   can't make WebM, the browsers that can, and the ffmpeg command for the
   job (R8). There is no MP4 fallback.
3. **Audio fallback**: WebCodecs Opus → a WASM Opus encoder registered as a
   Mediabunny custom encoder (only if the Mac test shows Safari encodes WebM
   video but not Opus; adds about 300 KB) → no sound, with a notice. (WebM
   can't carry AAC.)
4. **The size controller doesn't assume an encoder.** The probe step (§4.2)
   measures VideoToolbox's rate control like any other, so Safari's
   hardware H.264 is handled without special cases.
5. **Same UI everywhere**: features that a browser can't do are disabled
   with a reason, never hidden.

### 6.4 How WebKit gets tested

Playwright WebKit on Linux is WebKitGTK with GStreamer codecs, **not
Safari**: it tests layout, keys and the fallback paths, not Apple's encoders.
So there are three layers, and §10 D3 picks which ones to set up:

| Layer | What it proves | Cost |
|---|---|---|
| a. GitHub Actions job, `ubuntu-latest`, `npx playwright install --with-deps webkit` | Smoke suite runs in WebKit; fallbacks work | Free; CI has sudo. Adds a job to `tests.yml` |
| b. Local rootless podman with the official Playwright image | Same as (a), on this machine | One ~2 GB image pull (an outside download) |
| c. Real Safari on a Mac and an iPhone, manual checklist | The actual encoders, iOS memory, Photos HDR input | Needs Apple hardware; the release gate for "works in Safari" |

The capability matrix (§6.1) becomes a test page, `tests/smoke/codecs.html`,
that any browser can open, including a phone, to print its row.

## 7. Phases

| Phase | Delivers | Done when |
|---|---|---|
| **P0 · Gates** | Fixture suite (§8); codec matrix page; encoder speed per browser; container overhead per muxer; the bpp thresholds tuned; WebKit test layer(s) per D3 | Matrix rows for Chromium, Firefox, WebKit (and Safari if available) recorded in this doc |
| **P1 · Fit** | `js/lib/fit.js` + tests; presets file + validator; quality warning; the size target added to the existing Convert panel | R1, R2, R3, R9 pass on the fixture suite in Chromium and Firefox |
| **P2 · Editor** | `#file/clip` mode: player with canvas fallback, timeline, in/out, frame step, crop box, several segments, keys | R4, R10; smoke at 360/390/1280, both themes, no horizontal scroll |
| **P3 · Picture** | WebGL2 frame stage in a worker: scale, HDR→SDR, fps, speed (WSOLA audio), text caption | R6 on HDR fixtures; no frame-time regression over 10% vs. P1 |
| **P4 · Subtitles** | Embedded and dropped subtitles, MKV fonts, offset control | R5 on subtitle fixtures, including a VFR one |
| **P5 · Finish** | ffmpeg command parity for every Clip option (R8); i18n (en, es, pt-BR, ja, ru); About popup legend; `sw.js` rebuild; README section | `check.py` passes; full test run reported |

P1 is useful on its own: the Convert panel gets "fit to N MB" before the editor exists.

## 8. Fixtures

Kept small and generated where possible (ffmpeg `testsrc2`/`smptehdbars`,
lavfi noise for "hard to compress"), so the repo doesn't grow by hundreds
of MB:

- easy (static, flat), hard (grain/noise, fast motion), mixed;
- 5 s, 30 s, 120 s; 720p30, 1080p60, 2160p24;
- VFR source; MKV with ASS + embedded font; SRT sidecar;
- HDR10 (PQ) and HLG samples; an iPhone-style HEVC MOV;
- odd sizes (1918×1080, rotated phone video).

The fit suite records per job: final size / limit, number of full encodes,
duration error, wall time. It runs headless in Chromium and Firefox (and
WebKit per D3) and prints a table; it doesn't run under node.

## 9. Not doing

- URL download (yt-dlp): outside requests.
- A general video editor (multi-track, transitions, keyframed effects).
  Shotcut exists.
- Server-side or ffmpeg.wasm encoding as the main path: slower than
  WebCodecs and much larger to ship. Possibly a fallback per D4.
- GIF output in P1–P4 (could come later as a preset; small and easy).

## 10. Decisions (settled 4 November 2026)

| # | Question | Decision |
|---|---|---|
| D1 | Where Clip lives | A mode in Files, `#file/clip` |
| D2 | Preset labels | Generic ("Imageboard · 4 MB · no sound"); the site goes in the preset's `source` |
| D3 | WebKit testing | The owner tests on a Mac once P0–P2 are built. Add the CI WebKit job (§6.4 a) as well; no local podman image |
| D4 | Safari without WebM encoding | Clip is not offered in Safari (§6.3 rule 2). No MP4 fallback, no WASM VP9 |
| D5 | Subtitle renderer | Full libass (JASSUB WASM), lazy-loaded |

---

## 12. P0 results (4 November 2026)

Measured on this machine (Fedora 44, 31 GB, no hardware video encode in the
headless browsers) with the P0 tooling: `tools/clip_fixtures.py` (§8),
`tests/clip/bench.mjs` + `bench.html` (browser encodes through the vendored
Mediabunny 1.61.6), `tests/clip/score.py` (SSIM) and
`tests/clip/native_ref.py` (ffmpeg 8.1.3). Raw tables are in
`tests/clip/results/*.md` (not committed; rerun to regenerate).

### 12.1 What ran

| Run | Fixtures | Codecs × targets | Encodes |
|---|---|---|---|
| Chromium 149, full | all 17 bench fixtures (every §8 clip except the HDR, MKV+ASS and iPhone ones, which are for P3/P4) | VP9, AV1, VP8 × 2, 4, 6 MiB | 153, all ok |
| Firefox 151, subset | easy/hard/mixed 720p30 5 s, mixed 1080p60 5 s, rotated, VFR, mixed 720p30 30 s | VP9, AV1, VP8 × 2, 6 MiB | 42, all ok |
| Chromium bitrate sweep | easy/hard/mixed 720p30 5 s, mixed 1080p60 5 s | × 0.25, 0.5, 1, 2, 4, 8 MiB | 72, all ok |
| Constant-bitrate check, both browsers | easy 720p30 5 s, mixed 1080p60 5 s, mixed 720p30 30 s | × 2, 6 MiB | 18 + 18, all ok |
| Native reference | the 12 fixtures at 720p and 1080p (no 1080p60 30 s, 120 s or 2160p) | libvpx-vp9 two-pass, libsvtav1 one-pass VBR × 2, 4, 6 MiB | 72, all ok |
| Chromium, no frame-rate hint (§12.3 cause 2) | mixed 1080p60 5 s | VP9, AV1, VP8 × 2, 4, 6 MiB | 9, all ok |

The exact commands, from the repo root. `bench.mjs` without flags is *not*
any of these runs (it passes no frame rate), and it refuses to overwrite a
results folder made with other `--frame-rate`/`--mode` settings:

| Run | Command | Results |
|---|---|---|
| Chromium full | `node tests/clip/bench.mjs --browser chromium --frame-rate source` | `chromium.*` |
| Firefox subset | `node tests/clip/bench.mjs --browser firefox --frame-rate source --budgets 2,6 --fixtures easy-720p30-5s,hard-720p30-5s,mixed-720p30-5s,mixed-1080p60-5s,rotated-phone-1080p30-5s,vfr-720p-10s,mixed-720p30-30s` | `firefox.*` |
| Chromium sweep | `node tests/clip/bench.mjs --browser chromium --frame-rate source --budgets 0.25,0.5,1,2,4,8 --fixtures easy-720p30-5s,hard-720p30-5s,mixed-720p30-5s,mixed-1080p60-5s --out-tag sweep` | `chromiumsweep.*` |
| Constant mode (per browser) | `node tests/clip/bench.mjs --browser chromium --frame-rate source --mode constant --budgets 2,6 --fixtures easy-720p30-5s,mixed-1080p60-5s,mixed-720p30-30s --out-tag cbr` (and `--browser firefox`) | `chromiumcbr.*`, `firefoxcbr.*` |
| No frame-rate hint | `node tests/clip/bench.mjs --browser chromium --fixtures mixed-1080p60-5s --out-tag nofps` | `chromiumnofps.*` |
| Native | `python3 -I tests/clip/native_ref.py` | `native.*` |

Every `bench.mjs` run ends by calling `score.py --browser <browser><tag>`,
which can be rerun on its own (SSIM already measured is reused). Each
`results/*.md` header states the run's bitrate mode and frame-rate setting.

Firefox was cut to a subset because it encodes VP9 and AV1 at 6–15 fps
(§6.1): the full matrix would take about 5 hours. Skipped in Firefox: the
30 s 1080p60 clips, easy and hard 30 s 720p, the 120 s clip, 2160p24 and the
odd-size clip, plus the 4 MiB rung. Every run had 0 console errors and 0
outside requests. No output dropped a frame, and every output's duration
was within one frame of the source (0.016 s at worst), which is a first
look at R9.

The 21 fixtures total 267 MiB. libx265 is present, so the iPhone HEVC
fixture was built. Neither browser can decode it (§6.1), so it waits for
the Mac test.

### 12.2 Container overhead per muxer

Overhead = file bytes − Σ packet bytes. It's a fixed cost per packet, not a
percentage of the file:

| Muxer | Fixed | Per packet | Median of file | Worst seen |
|---|---|---|---|---|
| Mediabunny WebM (both browsers) | ~350 B | 9.4 B (11.5 B per video frame without audio) | 0.11% | 1.32% |
| ffmpeg WebM (native) | ~750 B | 7.0 B | 0.08% | 0.89% |

So the percentage grows with length and frame rate and shrinks with the
limit. A 120 s 30 fps clip with Opus (20 ms packets) has 3600 + 6000 packets,
about 90 KB, which is 4.3% of a 2 MiB limit. The scope's flat "0.3–1%" is
wrong for long clips at small limits. §4.2 now budgets
`1 KB + 12 B × (video frames + audio packets)`. The largest overhead seen
in any run was 90% of that.

### 12.3 Rate control: overshoot per browser and codec

Overshoot = video packet bytes ÷ (requested bitrate × duration). One encode,
no probe or correction. Bitrate mode variable unless noted, frame rate passed
to the encoder.

| Browser | Codec | Median | Worst | Outputs over the limit |
|---|---|---|---|---|
| Chromium 149 | VP9 | 1.01 | 10.6 | 25 of 51 |
| Chromium 149 | AV1 | 1.00 | 5.52 | 23 of 51 |
| Chromium 149 | VP8 | 1.11 | 15.5 | 42 of 51 |
| Firefox 151 | VP9 | 1.27 | 6.20 | 8 of 14 |
| Firefox 151 | AV1 | 1.51 | 4.90 | 12 of 14 |
| Firefox 151 | VP8 | 1.45 | 6.82 | 8 of 14 |
| ffmpeg VP9 two-pass | | 1.00 | 1.01 | 0 of 36 |
| ffmpeg SVT-AV1 one-pass VBR | | 1.18 | 1.84 | 33 of 36 |

The worst cases are not noise. They come from three causes:

1. **The encoder floor.** Below a certain bpp the browser encoders stop
   lowering quality (they hit their maximum quantizer) and the output stops
   shrinking. Example: Chromium VP9 on the mixed 1080p60 30 s clip makes
   about 2.2 Mbps whether asked for 0.45 or 1.5 Mbps. The floors are in the
   §4.3 table. Split by requested bpp, Chromium is accurate above the floor:

   | Chromium, requested bpp | VP9 | AV1 | VP8 |
   |---|---|---|---|
   | ≥ 0.05 | median 0.88, range 0.61–1.14 | 0.94, 0.74–1.14 | 1.04, 1.00–1.16 |
   | 0.02–0.05 | 1.11, 0.90–1.22 | 1.00, 0.90–1.06 | 1.16, 1.03–1.54 |
   | < 0.02 | 2.08, up to 10.6 | 1.32, up to 5.52 | 3.10, up to 15.5 |

   Firefox's floor is 3–5× higher (0.06–0.11 bpp at 720p30). The mixed 30 s
   720p30 clip can't be made smaller than about 8–11 MiB there, at any
   requested bitrate, in either bitrate mode.
2. **No frame rate.** Mediabunny only hands the encoder a frame rate when
   the conversion sets `frameRate`. Without it, Chromium's VP9 and VP8 budget
   as if the clip were 30 fps: on the mixed 1080p60 5 s clip at 4 MiB, VP9
   overshot 1.67× and VP8 2.22×; with the rate passed, 0.88× and 1.09×. AV1
   was unaffected (0.95× both ways). At 2 and 6 MiB: VP9 1.91/1.54 without,
   1.03/0.84 with; VP8 2.16/2.24 without, 1.29/1.11 with (`chromiumnofps.*`
   against `chromium.*`, §12.1). All the other runs pass it (CFR sources
   only; the VFR clip goes without, since `frameRate` would resample it).
3. **Variable mode undershoots easy content** (Chromium VP9 0.6–0.7× on the
   easy clips, Firefox 0.55× at 6 MiB) and overshoots hard content. That
   wastes size but is safe.

**Constant bitrate mode** in Chromium hits the target much more tightly,
and its SSIM sits on the same bpp curve as variable mode: VP9 1.00–1.03
(1.14 near the floor), AV1 0.97–1.04 (0.74 on one easy clip at 6 MiB, an
undershoot), VP8 0.99–1.00 (1.35 near the floor), with no dropped frames.
At the floor it fails like variable mode (VP9 1.87, VP8 2.46). That was 6 encodes per codec; P1 confirms
it on the full set. In Firefox, AV1 and VP8 don't change with the mode
(within 1%, except VP8 easy 2 MiB at 0.91×), but VP9 does on 3 of the 6
jobs, by 15–33%, with the same SSIM: easy 720p30 2 MiB 0.72 → 0.95 (closer
to the target), mixed 720p30 30 s 6 MiB 1.97 → 1.60 and 2 MiB
6.20 → 5.29 (less over). So §4.2 uses constant mode in Firefox too.

### 12.4 Native two-pass size accuracy

libvpx-vp9 two-pass (pass 1 cpu-used 4, pass 2 cpu-used 2) at the same
targets: file ÷ limit median 0.986, range 0.951–0.994, never over the limit
(36 encodes). Video overshoot 0.976–1.009. It needs no probe and a 1% margin
is enough. It's slow: 15 fps at 720p30 and 7.5 fps at 1080p60 with
6 threads, both passes included. SVT-AV1 one-pass VBR (preset 8) is fast
(190 fps at 720p30) but overshoots CFR clips by up to 1.84× (median 1.18).
That is the reason it isn't usable for a size target without two passes or
a probe. (A first run showed 0.58–0.62× on the VFR clip. That was the input,
not the encoder: ffmpeg hands SVT the stream's r_frame_rate, 60 for that
clip, whose average is 31.8 fps, and 31.8/60 = 0.53. Given the average rate
through `-svtav1-params fps-num=1908:fps-denom=59`, which `native_ref.py` now
does for VFR sources, it lands at 1.17–1.22×, like the CFR clips. A desktop
engine must pass the average rate for VFR input.) This is the baseline for
CloverEye's desktop engine.

### 12.5 Quality: SSIM vs bits per pixel, and the §4.3 lines

SSIM is the Y plane, against the source scaled (bicubic) to the output size.
Two bpps: *requested* = the bitrate asked for ÷ (width × height × fps),
which is all the planner can know; *actual* = the video bits the encoder
spent per second ÷ the same. The result files carry both (`bppRequested`,
`bppActual`); the tables below give both. The lines were first tuned on
actual bpp; §4.3 states them in requested bpp for constant mode, where the
two agree above the floor, and gives the variable-mode VP9 correction.

An absolute SSIM line (e.g. good ≥ 0.95, blocky < 0.90) doesn't work on
these fixtures. Each fixture × encoder has its own ceiling, and SSIM moves
only 0.02–0.03 across a 30× range of bitrate. Chromium's VP9 tops out at 0.953
on the easy clip (native VP9: 0.98), because it doesn't reproduce the noise
patch in `testsrc2` at any bitrate. The hard clips top out at 0.80–0.82
because grain can't be reproduced. An absolute line would sort by fixture,
not by bitrate.

So the criterion used is **distance from the fixture's own ceiling** (its
SSIM at the 8 MiB rung, same browser and codec):

- **good**: within 0.01 of the ceiling (compared at 3 decimals);
- **visibly blocky**: more than 0.025 below it, or the encoder at its floor
  (overshoot > 1.3; such rungs count for neither line).

`score.py` prints this per fixture in every `results/*.md`. From the
Chromium sweep (variable mode; 720p30 easy/mixed, 1080p60 mixed), each cell
requested / actual bpp:

| Codec | Within 0.01 of ceiling from | > 0.025 below at | Tuned good | Tuned blocky below |
|---|---|---|---|---|
| AV1 | 0.060 / 0.056 (easy), 0.056 / 0.064 (mixed 720p), 0.013 / 0.015 (1080p60, overshoot 1.23) | never above the floor (actual 0.011–0.015) | ≥ 0.05 | 0.015 |
| VP9 | 0.12 / 0.086 (easy), 0.116 / 0.117 (mixed 720p), 0.052 / 0.046 (1080p60) | none above the floor: easy 0.015 / 0.021 is already at it (1.37×); the others hit the floor first (actual 0.017–0.027) | ≥ 0.07 (variable mode: ≥ 0.10 requested) | 0.025 |
| VP8 | 0.12 / 0.122 (easy), above 0.24 / 0.26 (mixed 720p), 0.026 / 0.033 (1080p60) | 0.056 / 0.058 (mixed 720p) | ≥ 0.12 | 0.06 |

Requested and actual differ most for VP9 on easy content (variable mode
undershoots, so the request must be ~1.4× higher for the same SSIM). In
the constant-mode check (`chromiumcbr`) actual ÷ requested is 0.97–1.04
above the floor, and VP9 easy 720p30 at requested 0.12 reaches SSIM 0.947,
0.006 from its ceiling, on the variable-mode curve at the same actual bpp.

H.264 keeps its starting values; Clip doesn't encode it (D4).

1080p60 needs about half the bpp that 720p30 needs for the same
distance from the ceiling. bpp alone over-warns at high resolution and
frame rate. That's acceptable for a warning; P1 may scale the line by
`(1280×720×30 / (w×h×fps))^0.3` if real clips show the same.

By eye: at the lowest rungs the failure on these synthetic clips is
smoothing (grain wiped, gradients banded, slight blotches in flat areas),
not 8×8 blocks: VP9 at 0.027 bpp, AV1 at 0.015, VP8 at 0.058. `testsrc2` is
kind to encoders. The lines should be confirmed on one real clip (film
grain, dark scene) before P1 ships the warning text.

Firefox's SSIM ceilings are lower than Chromium's on every clip (easy VP9
0.905 vs 0.953). Firefox's encoders give lower quality at the same size.

### 12.6 What this means for §4.2

- **The 3-sample probe is needed in the browser.** The single-encode
  overshoot depends on browser, codec, content and length: from 0.55× to
  1.16× above the floor in Chromium, and 0.54× to 2.6× in Firefox. No
  fixed factor works. When the target is above the floor, overshoot is stable
  for a given clip, but how stable depends on the codec. Between two targets
  2× apart (Chromium variable mode; pairs with requested bpp ≥ 0.025 and
  overshoot < 1.3; full run / sweep): AV1 changed by a median 3% / 3.5%
  (worst 7% / 36%), VP8 by 2% / 2% (worst 16% / 23%), but **VP9 by 13% /
  10% (worst 18% / 17%)**. Pooled over codecs that reads as "3–4%", which
  hides VP9, the first codec on Clip's ladder (pooled: median 3.6% / 3.9%,
  90th percentile 15% / 17%, worst 18% / 36%). Constant mode wasn't
  measured for this (its check had only 2 and 6 MiB rungs); it's expected
  to be tighter, and P1's fit suite must measure it before relying on one
  factor for VP9. So one measured factor gets the full
  encode close, but not to within 1%.
- **The probe also has to detect the floor.** If a sample comes back more
  than ~1.3× over at a low bpp, scaling the bitrate down won't help. The
  controller must step the plan down (resolution, then fps, §4.3's ladder)
  and probe again. In Firefox this is the normal case for anything over a few
  seconds at 4 MiB.
- **Safety margin.** One `0.99` margin is fine for native two-pass, not for
  the browser. Proposed: aim the corrected full encode at **0.96 of the
  budget** (Chromium constant mode; 0.93 in variable mode or Firefox), keep
  the live watch (step 3) with its 3% abort, and keep "never ship over"
  (step 5). With the measured spread, that should land 90% of jobs at
  93–99.5% in one full encode and the rest in two (R1, R2). This is to be
  proven by the fit suite in P1. VP9 in variable mode will restart more
  often than that, given its 10–13% factor drift above.
- **Encoder settings.** Always pass the frame rate. In Chromium and
  Firefox use constant mode (in Firefox it only matters for VP9, §12.3). Budget the container overhead per packet (§12.2).
- **Browser choice.** On the same fixtures Chromium is 18–27× faster than
  Firefox for VP9 and 10–18× for AV1 (4–6× on the rotated 1080p30 phone
  clip, §6.1), and its rate control is usable. In Firefox, Clip still works, but the size
  controller leans on the floor check and VP8 is the only fast codec.
  Clip's codec ladder (VP9 → AV1 → VP8) should take encode time into
  account in Firefox: for clips over ~15 s, offer VP8.

### 12.7 Still open for P0

- WebKit row: the CI job (§6.4 a, D3) isn't added yet. No Safari row until
  the owner's Mac test.
- Firefox full matrix (the skipped fixtures above) and Firefox constant mode
  on more clips.
- The fixtures don't tag their colour (`testsrc2` YUV is BT.601, untagged);
  the browsers tag their output BT.709. Luma is identical, so SSIM Y is
  unaffected, but colours shift on playback. Tag the SDR fixtures (BT.709,
  limited range) before P3's colour work.
- The bpp lines are from synthetic clips and need one real-footage check by
  eye (above).
