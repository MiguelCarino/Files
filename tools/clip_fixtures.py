#!/usr/bin/env python3
"""Generate the Clip fixture set (docs/SCOPE-CLIP.md §8) with native ffmpeg.

Everything is synthetic (testsrc2, lavfi noise, sine), so the repo holds this
script, not the media. Outputs go to tests/clip/fixtures/ (git-ignored) with a
manifest.json the benchmark (tests/clip/bench.mjs) and the native reference
(tests/clip/native_ref.py) read.

    python3 -I tools/clip_fixtures.py               # build what is missing
    python3 -I tools/clip_fixtures.py --list        # what exists, what would be built
    python3 -I tools/clip_fixtures.py --list --json # the specs as manifest entries
    python3 -I tools/clip_fixtures.py --only easy-720p30-5s,vfr-720p-10s

Idempotent: a fixture whose file exists is skipped, and every file is written
under a temporary name and renamed at the end, so an interrupted run never
leaves a half-written fixture behind. manifest.json is rewritten every run
from the files that exist.

The machine is shared: each encode runs with -threads 6, and a run refuses to
start an encode when MemAvailable is under 3000 MB.

Kinds:
  easy   testsrc2: flat colour, a few small moving shapes.
  hard   testsrc2 scrolled fast with temporal grain (noise=alls=40): the encoder
         can't predict it, so it shows rate-control overshoot and blockiness.
  mixed  first half easy, second half hard, with a stereo Opus track.
Specials: VFR (with a burned-in source timestamp and an SRT sidecar), MKV with
ASS + an attached OFL font, HDR10 PQ (AV1 10-bit with mastering metadata), HLG
(VP9 profile 2), an iPhone-style HEVC MOV (main10 HLG, hvc1, portrait display
matrix, AAC), 1918x1080, and a phone clip rotated by its display matrix.

The source codec is H.264 (MP4) unless a fixture says otherwise: it is what
people's files are. The browser decodes it; if a browser can't (some Chromium
builds lack proprietary codecs), tests/smoke/codecs.html shows that, and the
bench reports the decode failure per fixture.
"""

import argparse
import json
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "clip" / "fixtures"
WORK = OUT / "_work"
FONT_WOFF2 = ROOT / "fonts" / "IBMPlexSans-400-latin.woff2"   # OFL (fonts/OFL.txt)
FONT_NAME = "IBM Plex Sans"
THREADS = "6"
MIN_AVAIL_MB = 3000

# H.264 ceilings per frame size: noise is incompressible, so without a cap the
# hard fixtures alone would be gigabytes (the whole set stays under ~300 MB).
# Short clips get the higher cap, because the bench's largest target for a 5 s
# clip is ~10 Mbps; longer clips are only asked for less (6 MiB / 30 s = 1.6 Mbps).
MAXRATE = {720: "8M", 1080: "16M", 2160: "40M"}
MAXRATE_LONG = {720: "4M", 1080: "8M", 2160: "20M"}


# ── content (lavfi graphs) ───────────────────────────────────────────────────

def easy_src(w, h, r, d):
    return f"testsrc2=size={w}x{h}:rate={r}:duration={d}"


def hard_src(w, h, r, d):
    # scroll moves the whole picture ~1.3% of the width per frame; noise adds
    # fresh grain every frame (allf=t: temporal, u: uniform).
    return (f"testsrc2=size={w}x{h}:rate={r}:duration={d},"
            f"scroll=horizontal=0.013:vertical=0.007,noise=alls=40:allf=t+u")


def audio_src(d):
    return (f"sine=frequency=440:sample_rate=48000:duration={d}[s0];"
            f"anoisesrc=color=pink:amplitude=0.05:sample_rate=48000:duration={d}[n0];"
            f"[s0][n0]amix=inputs=2:normalize=0,aformat=channel_layouts=stereo[a]")


def video_graph(kind, w, h, r, d):
    """A -filter_complex graph whose video output is [v]."""
    if kind == "easy":
        return easy_src(w, h, r, d) + ",format=yuv420p[v]"
    if kind == "hard":
        return hard_src(w, h, r, d) + ",format=yuv420p[v]"
    if kind == "mixed":
        a, b = d / 2, d - d / 2
        return (easy_src(w, h, r, a) + "[e];" + hard_src(w, h, r, b) + "[x];"
                "[e][x]concat=n=2:v=1:a=0,format=yuv420p[v]")
    raise ValueError(kind)


def x264(height, fps, duration=5):
    table = MAXRATE if duration <= 10 else MAXRATE_LONG
    rate = table[min(table, key=lambda k: abs(k - height))]
    if duration > 60:
        rate = str(int(rate[:-1]) * 5 // 8) + "M"     # the 120 s clip: 2.5M at 720p
    buf = str(int(rate[:-1]) * 2) + "M"
    return ["-c:v", "libx264", "-preset", "fast", "-crf", "20", "-maxrate", rate,
            "-bufsize", buf, "-g", str(int(round(fps * 2))), "-pix_fmt", "yuv420p"]


# ── the fixture specs ───────────────────────────────────────────────────────

def spec(name, ext, w, h, fps, duration, kind, notes, build, *, audio=False, bench=True,
         codec="h264", container="mp4", **extra):
    return dict(name=name, path=f"{name}.{ext}", w=w, h=h, fps=fps, duration=duration,
                kind=kind, notes=notes, audio=audio, bench=bench, codec=codec,
                container=container, build=build, **extra)


def content(kind, w, h, fps, d, audio):
    def build(dst):
        graph = video_graph(kind, w, h, fps, d)
        maps = ["-map", "[v]"]
        if audio:
            graph += ";" + audio_src(d)
            maps += ["-map", "[a]", "-c:a", "libopus", "-b:a", "128k"]
        run(["-filter_complex", graph, *maps, *x264(h, fps, d), "-movflags", "+faststart", dst])
    return build


def content_specs():
    out = []
    notes = {
        "easy": "testsrc2: flat colour, small moving shapes",
        "hard": "testsrc2 scrolled fast + temporal grain (noise=40)",
        "mixed": "first half easy, second half hard; stereo Opus 128k",
    }
    for (w, h, fps, tag) in ((1280, 720, 30, "720p30"), (1920, 1080, 60, "1080p60")):
        for d in (5, 30):
            for kind in ("easy", "hard", "mixed"):
                audio = kind == "mixed"
                out.append(spec(f"{kind}-{tag}-{d}s", "mp4", w, h, fps, d, kind, notes[kind],
                                content(kind, w, h, fps, d, audio), audio=audio))
    out.append(spec("mixed-720p30-120s", "mp4", 1280, 720, 30, 120, "mixed",
                    notes["mixed"] + "; the long clip (low bits per pixel at every target)",
                    content("mixed", 1280, 720, 30, 120, True), audio=True))
    out.append(spec("mixed-2160p24-5s", "mp4", 3840, 2160, 24, 5, "mixed",
                    notes["mixed"] + "; 4K: exercises the max-side cap",
                    content("mixed", 3840, 2160, 24, 5, True), audio=True))
    return out


def build_odd(dst):
    graph = video_graph("mixed", 1918, 1080, 30, 5)
    run(["-filter_complex", graph, "-map", "[v]", *x264(1080, 30), "-movflags", "+faststart", dst])


def build_rotated(dst):
    graph = (f"testsrc2=size=1920x1080:rate=30:duration=5,"
             f"drawbox=x=0:y=0:w=320:h=180:color=red@1:t=fill,format=yuv420p[v]")
    tmp = intermediate("rotated-src.mp4",
                       lambda part: run(["-filter_complex", graph, "-map", "[v]", *x264(1080, 30), part]))
    # Stored landscape, shown portrait: the display matrix says "rotate 90°",
    # which is how phones store portrait video. The red box marks the stored
    # top-left corner, so a wrong rotation is visible at a glance.
    run(["-display_rotation:v:0", "90", "-i", tmp, "-map", "0", "-c", "copy",
         "-movflags", "+faststart", dst])


def intermediate(name, build):
    """A work file under _work/, built once, written under a temporary name."""
    dst = WORK / name
    if not (dst.exists() and dst.stat().st_size > 0):
        part = dst.with_name(dst.stem + ".part" + dst.suffix)
        try:
            build(str(part))
        except BaseException:
            part.unlink(missing_ok=True)
            raise
        part.replace(dst)
    return str(dst)


def font_ttf():
    """The repo's OFL IBM Plex Sans as a .ttf (MKV attachments and libass want
    TrueType/OpenType; the repo ships only WOFF2)."""
    ttf = WORK / "IBMPlexSans-Regular.ttf"
    if not ttf.exists():
        from fontTools.ttLib import TTFont   # needs brotli for WOFF2
        f = TTFont(str(FONT_WOFF2))
        f.flavor = None
        part = ttf.with_name(ttf.stem + ".part.ttf")
        f.save(str(part))
        part.replace(ttf)
    return ttf


def timestamp_text(fontfile):
    # The source timestamp, burned in: subtitle drift is read straight off the frame.
    ff = str(fontfile).replace("\\", "/").replace(":", r"\:")
    return (f"drawtext=fontfile='{ff}':text='%{{pts\\:hms}}  n=%{{n}}':x=24:y=24:"
            f"fontsize=40:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=8")


def build_vfr(dst):
    # 60 fps source; keep every 2nd frame for 0-3 s (30 fps), all of 3-6 s (60
    # fps), every 5th after 6 s (12 fps). -fps_mode vfr keeps the gaps.
    sel = r"select='if(lt(t\,3)\,not(mod(n\,2))\,if(lt(t\,6)\,1\,not(mod(n\,5))))'"
    graph = (f"testsrc2=size=1280x720:rate=60:duration=10,{sel},"
             f"{timestamp_text(font_ttf())},format=yuv420p[v]")
    run(["-filter_complex", graph, "-map", "[v]", "-fps_mode", "vfr",
         "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p",
         "-movflags", "+faststart", dst])
    srt = pathlib.Path(dst).with_name(pathlib.Path(dst).name.replace(".part", "")).with_suffix(".srt")
    srt.write_text(srt_text(10), encoding="utf-8")


def srt_time(t):
    ms = int(round(t * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def srt_text(seconds):
    cues = []
    for i in range(seconds):
        a, b = i + 0.0, i + 0.9
        cues.append(f"{i + 1}\n{srt_time(a)} --> {srt_time(b)}\nCue {i + 1}: {i}.000 s to {i}.900 s\n")
    return "\n".join(cues)


def ass_time(t):
    cs = int(round(t * 100))
    return f"{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}"


def ass_text(seconds):
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{FONT_NAME},48,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,1,2,40,40,40,1
Style: Sign,{FONT_NAME},36,&H0000FFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,8,40,40,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    ev = []
    for i in range(seconds):
        ev.append(f"Dialogue: 0,{ass_time(i)},{ass_time(i + 0.9)},Default,,0,0,0,,"
                  f"Line {i + 1}: {i}.00 s to {i}.90 s")
    ev.append(f"Dialogue: 1,{ass_time(1)},{ass_time(4)},Sign,,0,0,0,,"
              r"{\move(100,120,1180,120)}Moving sign 1-4 s")
    ev.append(f"Dialogue: 1,{ass_time(5)},{ass_time(8)},Sign,,0,0,0,,"
              r"{\k50}Ka{\k50}ra{\k50}o{\k50}ke {\k100}5-8 s")
    return head + "\n".join(ev) + "\n"


def build_mkv_ass(dst):
    ttf = font_ttf()
    ass = WORK / "mkv-ass.ass"
    ass.write_text(ass_text(10), encoding="utf-8")
    graph = (f"testsrc2=size=1280x720:rate=30:duration=10,{timestamp_text(ttf)},format=yuv420p[v];"
             + audio_src(10))
    run(["-filter_complex", graph, "-i", str(ass), "-map", "[v]", "-map", "[a]", "-map", "0:s",
         *x264(720, 30), "-c:a", "libopus", "-b:a", "128k", "-c:s", "ass",
         "-attach", str(ttf), "-metadata:s:t:0", "mimetype=application/x-truetype-font",
         "-metadata:s:t:0", "filename=IBMPlexSans-Regular.ttf",
         "-metadata:s:s:0", "language=eng", "-f", "matroska", dst])


# HDR: the picture is SDR testsrc2 placed at BT.2408 reference white (203 nits),
# plus a ramp along the bottom sixth written straight in signal space (code 64
# to 940, i.e. 0 to 10000 nits in PQ, 0 to peak in HLG). The ramp is what a
# tone mapper has to roll off; a washed-out or clipped result shows there.
RAMP = ("geq=lum='if(gt(Y\\,H*5/6)\\,64+876*X/W\\,lum(X\\,Y))'"
        ":cb='if(gt(Y\\,H*5/6)\\,512\\,cb(X\\,Y))'"
        ":cr='if(gt(Y\\,H*5/6)\\,512\\,cr(X\\,Y))'")


def hdr_graph(w, h, r, d, transfer):
    return (f"testsrc2=size={w}x{h}:rate={r}:duration={d},"
            f"format=gbrp,zscale=tin=bt709:pin=bt709:min=gbr:rin=full:t={transfer}:p=bt2020:m=bt2020nc:r=tv:npl=203,"
            f"format=yuv420p10le,{RAMP}[v]")


HDR_TAGS = ["-color_primaries", "bt2020", "-colorspace", "bt2020nc", "-color_range", "tv"]


def build_pq(dst):
    run(["-filter_complex", hdr_graph(1920, 1080, 30, 5, "smpte2084"), "-map", "[v]",
         "-c:v", "libsvtav1", "-preset", "8", "-crf", "24", "-pix_fmt", "yuv420p10le",
         "-svtav1-params",
         "mastering-display=G(0.17,0.797)B(0.131,0.046)R(0.708,0.292)WP(0.3127,0.329)L(1000,0.0001)"
         ":content-light=1000,400",
         *HDR_TAGS, "-color_trc", "smpte2084", "-movflags", "+faststart", dst])


def build_hlg(dst):
    run(["-filter_complex", hdr_graph(1920, 1080, 30, 5, "arib-std-b67"), "-map", "[v]",
         "-c:v", "libvpx-vp9", "-profile:v", "2", "-pix_fmt", "yuv420p10le", "-b:v", "0",
         "-crf", "28", "-deadline", "good", "-cpu-used", "5", "-row-mt", "1",
         *HDR_TAGS, "-color_trc", "arib-std-b67", "-f", "webm", dst])


def build_iphone(dst):
    graph = hdr_graph(1920, 1080, 30, 5, "arib-std-b67") + ";" + audio_src(5)
    tmp = intermediate("iphone-src.mov", lambda part: run([
        "-filter_complex", graph, "-map", "[v]", "-map", "[a]",
        "-c:v", "libx265", "-preset", "fast", "-crf", "22", "-pix_fmt", "yuv420p10le",
        "-profile:v", "main10", "-tag:v", "hvc1",
        "-x265-params", "colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:range=limited:log-level=error",
        *HDR_TAGS, "-color_trc", "arib-std-b67",
        "-c:a", "aac", "-b:a", "160k", "-ac", "2", "-f", "mov", part]))
    # Portrait, as an iPhone stores it: landscape pixels + a 90° display matrix.
    run(["-display_rotation:v:0", "90", "-i", tmp, "-map", "0", "-c", "copy",
         "-tag:v", "hvc1", "-movflags", "+faststart", "-f", "mov", dst])


def have_encoder(name):
    try:
        r = subprocess.run(["ffmpeg", "-hide_banner", "-h", "encoder=" + name],
                           capture_output=True, text=True)
    except OSError:          # no ffmpeg at all (CI): --list still works
        return False
    return r.returncode == 0 and "is not recognized" not in (r.stdout + r.stderr)


def special_specs():
    out = [
        spec("vfr-720p-10s", "mp4", 1280, 720, 0, 10, "vfr",
             "variable frame rate: 30 fps 0-3 s, 60 fps 3-6 s, 12 fps 6-10 s; burned-in source "
             "timestamp; SRT sidecar vfr-720p-10s.srt (cue i at i.000-i.900 s)",
             build_vfr, sidecar="vfr-720p-10s.srt"),
        spec("mkv-ass-720p30-10s", "mkv", 1280, 720, 30, 10, "subtitles",
             "Matroska: H.264 + Opus + ASS track (line i at i.00-i.90 s, a \\move sign, karaoke) "
             "+ attached OFL font IBM Plex Sans (from fonts/); burned-in source timestamp",
             build_mkv_ass, audio=True, container="mkv", bench=False, subtitles="ass"),
        spec("hdr10-pq-1080p30-5s", "mp4", 1920, 1080, 30, 5, "hdr",
             "HDR10: AV1 10-bit, BT.2020 / PQ (smpte2084), mastering display 1000 nits + "
             "MaxCLL 1000/MaxFALL 400; SDR picture at 203 nits + 0-10000 nit ramp along the bottom",
             build_pq, bench=False, codec="av1", hdr="pq"),
        spec("hlg-1080p30-5s", "webm", 1920, 1080, 30, 5, "hdr",
             "HLG: VP9 profile 2 10-bit, BT.2020 / arib-std-b67; SDR picture at reference white "
             "+ full-range signal ramp along the bottom",
             build_hlg, bench=False, codec="vp9", container="webm", hdr="hlg"),
        spec("odd-1918x1080-5s", "mp4", 1918, 1080, 30, 5, "odd",
             "1918x1080 (not a multiple of 16 or 4 in width): mixed content",
             build_odd),
        spec("rotated-phone-1080p30-5s", "mp4", 1920, 1080, 30, 5, "rotated",
             "stored 1920x1080, display matrix rotation 90 (shows as 1080x1920); red box marks "
             "the stored top-left corner",
             build_rotated, rotation=90),
    ]
    if have_encoder("libx265"):
        out.append(spec("iphone-hevc-hlg-1080p30-5s", "mov", 1920, 1080, 30, 5, "hdr",
                        "iPhone-style: QuickTime MOV, HEVC main10 (hvc1), BT.2020 / HLG, display "
                        "matrix rotation 90 (portrait), AAC 160k stereo",
                        build_iphone, audio=True, bench=False, codec="hevc", container="mov",
                        hdr="hlg", rotation=90))
    return out


def all_specs():
    return content_specs() + special_specs()


# ── running ─────────────────────────────────────────────────────────────────

def avail_mb():
    try:
        for line in open("/proc/meminfo", encoding="ascii"):
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) // 1024
    except OSError:
        pass
    return None


def run(args):
    a = avail_mb()
    if a is not None and a < MIN_AVAIL_MB:
        raise SystemExit(f"refusing to encode: {a} MB available, needs {MIN_AVAIL_MB} MB (shared machine)")
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
           "-threads", THREADS, "-filter_threads", THREADS, *args]
    # -threads before the inputs sets decoder threads; repeat it for the encoder.
    cmd.insert(-1, "-threads")
    cmd.insert(-1, THREADS)
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("ffmpeg failed (" + str(r.returncode) + "):\n" + " ".join(cmd)
                           + "\n" + r.stderr[-2000:])


def probe(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration,size",
                        "-of", "json", str(path)], capture_output=True, text=True)
    try:
        f = json.loads(r.stdout)["format"]
        return float(f.get("duration") or 0), int(f.get("size") or 0)
    except (ValueError, KeyError):
        return 0.0, path.stat().st_size


def entry(s, with_probe=True):
    e = {k: v for k, v in s.items() if k != "build"}
    p = OUT / s["path"]
    if with_probe and p.exists():
        d, size = probe(p)
        e["probed_duration"] = round(d, 3)
        e["bytes"] = size
    return e


def write_manifest(specs):
    present = [entry(s) for s in specs if (OUT / s["path"]).exists()]
    doc = {"generator": "tools/clip_fixtures.py", "fixtures": present}
    tmp = OUT / "manifest.json.part"
    tmp.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    tmp.replace(OUT / "manifest.json")
    return present


def human(n):
    return f"{n / 1048576:.1f} MiB"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--only", help="comma-separated fixture names")
    ap.add_argument("--list", action="store_true", help="list the fixtures and whether each exists")
    ap.add_argument("--json", action="store_true", help="with --list: print the specs as JSON")
    a = ap.parse_args(argv)

    specs = all_specs()
    names = {s["name"] for s in specs}
    if a.only:
        want = [n.strip() for n in a.only.split(",") if n.strip()]
        bad = [n for n in want if n not in names]
        if bad:
            ap.error("unknown fixture(s): " + ", ".join(bad) + " (see --list)")
        chosen = [s for s in specs if s["name"] in want]
    else:
        chosen = specs

    if a.list:
        if a.json:
            print(json.dumps({"generator": "tools/clip_fixtures.py",
                              "fixtures": [entry(s, with_probe=False) for s in chosen]}, indent=2))
            return 0
        for s in chosen:
            p = OUT / s["path"]
            have = human(p.stat().st_size) if p.exists() else "missing"
            fps = s["fps"] or "vfr"
            print(f"{s['name']:28} {s['w']}x{s['h']}@{fps} {s['duration']:>4}s  {s['kind']:9} {have}")
        if not have_encoder("libx265"):
            print("note: no libx265 in this ffmpeg, so the iPhone-style HEVC fixture is skipped")
        return 0

    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        print("ffmpeg and ffprobe are needed", file=sys.stderr)
        return 2
    OUT.mkdir(parents=True, exist_ok=True)
    WORK.mkdir(exist_ok=True)
    if not have_encoder("libx265"):
        print("note: no libx265 in this ffmpeg, so the iPhone-style HEVC fixture is skipped")

    failed = 0
    for s in chosen:
        dst = OUT / s["path"]
        if dst.exists() and dst.stat().st_size > 0:
            print(f"skip  {s['name']} (exists)")
            continue
        part = dst.with_name(dst.stem + ".part" + dst.suffix)   # ffmpeg picks the muxer by extension
        print(f"make  {s['name']} ...", flush=True)
        try:
            s["build"](str(part))
            part.replace(dst)
            print(f"      {human(dst.stat().st_size)}")
        except (RuntimeError, OSError, ImportError) as e:
            failed += 1
            part.unlink(missing_ok=True)
            print(f"FAIL  {s['name']}: {e}", file=sys.stderr)

    present = write_manifest(specs)
    total = sum((OUT / e["path"]).stat().st_size for e in present)
    side = sum((OUT / e["sidecar"]).stat().st_size for e in present
               if e.get("sidecar") and (OUT / e["sidecar"]).exists())
    print(f"{len(present)} of {len(specs)} fixtures present, {human(total + side)} in {OUT.relative_to(ROOT)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
