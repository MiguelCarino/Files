#!/usr/bin/env python3
"""Native ffmpeg reference for the Clip bench: the same fixtures and targets as
tests/clip/bench.mjs, encoded by libvpx-vp9 (two-pass) and libsvtav1 (one-pass
VBR). It is the baseline for CloverEye's desktop engine and the yardstick the
browser numbers are read against.

    python3 -I tests/clip/native_ref.py [--fixtures a,b] [--codecs vp9,av1] [--budgets 2,4,6]
                                        [--quick] [--force] [--max-seconds N]
                                        [--vp9-cpu-used 2] [--svt-preset 8]
    python3 -I tests/clip/native_ref.py --print-ladder 5 30 120

Writes outputs to tests/clip/results/native/ and the results to
tests/clip/results/native.json + native.md: size accuracy (file / limit), video
overshoot (video packet bytes / requested), container overhead, encode speed
and SSIM (Y) against the source. Existing outputs are reused unless --force.
Every encode runs with -threads 6 and stops when available memory is under
3000 MB.
"""

import argparse
import json
import pathlib
import subprocess
import sys
import time

sys.dont_write_bytecode = True   # no __pycache__ beside the tests
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import cliplib as C  # noqa: E402

OUT = C.RESULTS / "native"
CODECS = ["vp9", "av1"]


def ffmpeg(args):
    C.need_memory()
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", *args]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(" ".join(cmd) + "\n" + r.stderr[-1500:])


def audio_args(fx):
    return ["-c:a", "libopus", "-b:a", str(C.AUDIO_BPS)] if fx.get("audio") else ["-an"]


def average_rate(path):
    """The video stream's avg_frame_rate as (num, den)."""
    s = (C.ffprobe_json(path, "-select_streams", "v:0", "-show_entries", "stream=avg_frame_rate")
         .get("streams") or [{}])[0]
    num, _, den = (s.get("avg_frame_rate") or "0/1").partition("/")
    if not (int(num) > 0 and int(den or 1) > 0):
        raise RuntimeError(f"{path}: no average frame rate")
    return int(num), int(den or 1)


def encode(fx, codec, bps, dst, a):
    src = str(C.FIXTURES / fx["path"])
    common = ["-threads", C.THREADS, "-i", src, "-map", "0:v:0"] + (["-map", "0:a:0"] if fx.get("audio") else [])
    if codec == "vp9":
        log = str(dst.with_suffix("")) + ".pass"
        vp9 = ["-c:v", "libvpx-vp9", "-b:v", str(bps), "-deadline", "good", "-row-mt", "1",
               "-threads", C.THREADS, "-passlogfile", log]
        ffmpeg(["-threads", C.THREADS, "-i", src, "-map", "0:v:0", *vp9, "-cpu-used", "4",
                "-pass", "1", "-an", "-f", "null", "-"])
        ffmpeg([*common, *vp9, "-cpu-used", str(a.vp9_cpu_used), "-pass", "2",
                *audio_args(fx), "-f", "webm", str(dst)])
        for p in dst.parent.glob(pathlib.Path(log).name + "*"):
            p.unlink(missing_ok=True)
    elif codec == "av1":
        # SVT-AV1 budgets bits per frame from the frame rate ffmpeg hands it, which is the
        # stream's r_frame_rate. For a VFR source that is the peak rate (60 for the VFR
        # fixture, whose average is 31.8), so it undershoots by avg/peak. Pass the average.
        params = "rc=1"
        if not fx.get("fps"):
            num, den = average_rate(src)
            params += f":fps-num={num}:fps-denom={den}"
        ffmpeg([*common, "-c:v", "libsvtav1", "-b:v", str(bps), "-preset", str(a.svt_preset),
                "-svtav1-params", params, "-threads", C.THREADS, *audio_args(fx), "-f", "webm", str(dst)])
    else:
        raise ValueError(codec)


def run_job(fx, codec, rung, a, prev):
    name = C.job_file(fx["name"], codec, rung["limitMiB"])
    dst = OUT / name
    row = {"fixture": fx["name"], "kind": fx["kind"], "codec": codec, "out": name,
           "limitMiB": rung["limitMiB"], "limitBytes": rung["limitBytes"], "videoBps": rung["videoBps"],
           "srcH": fx["h"], "srcFps": fx["fps"]}
    if a.force or not dst.exists():
        part = dst.with_name(dst.stem + ".part.webm")
        t0 = time.monotonic()
        try:
            encode(fx, codec, rung["videoBps"], part, a)
        except RuntimeError as e:
            part.unlink(missing_ok=True)
            return {**row, "ok": False, "error": str(e)[-300:]}
        row["encodeMs"] = (time.monotonic() - t0) * 1000
        part.replace(dst)
    else:
        old = prev.get(name)
        row["encodeMs"] = old.get("encodeMs") if old else None
    pk = C.stream_bytes(dst)
    w, h, dur = C.display_size(dst)
    file_bytes = dst.stat().st_size
    src_dur = fx.get("probed_duration") or fx["duration"]
    fps = pk["frames"] / dur if dur else None
    want = rung["videoBps"] * src_dur / 8
    row.update({
        "ok": True, "fileBytes": file_bytes, "videoBytes": pk["video"], "audioBytes": pk["audio"],
        "frames": pk["frames"], "w": w, "h": h, "outDuration": dur,
        "sizeAccuracy": file_bytes / rung["limitBytes"], "fillPct": file_bytes / rung["limitBytes"] * 100,
        "overshoot": pk["video"] / want if want else None,
        "overheadBytes": file_bytes - pk["video"] - pk["audio"],
        "overheadPct": (file_bytes - pk["video"] - pk["audio"]) / file_bytes * 100,
        "actualVideoBps": pk["video"] * 8 / src_dur,
        "bppRequested": rung["videoBps"] / (w * h * fps) if w and h and fps else None,
        "bppActual": pk["video"] * 8 / src_dur / (w * h * fps) if w and h and fps else None,
    })
    if row["encodeMs"]:
        row["encodeFps"] = pk["frames"] * 1000 / row["encodeMs"]
        row["realtime"] = src_dur * 1000 / row["encodeMs"]
    old = prev.get(name)
    if old and old.get("ssimY") is not None and old.get("fileBytes") == file_bytes and not a.force:
        row["ssimY"] = old["ssimY"]
    elif fx.get("hdr"):
        row["ssimY"] = None
    else:
        try:
            row["ssimY"] = C.ssim_y(dst, C.FIXTURES / fx["path"], a.max_seconds)
        except RuntimeError as e:
            row["ssimY"], row["ssimNote"] = None, str(e)[-200:]
    return row


def markdown(doc):
    rows = []
    for r in doc["jobs"]:
        if not r.get("ok"):
            rows.append([r["fixture"], r["codec"], r["limitMiB"], C.fmt(r["videoBps"] / 1000, 0),
                         "FAIL", "", "", "", "", "", "", ""])
            continue
        rows.append([r["fixture"], r["codec"], r["limitMiB"], C.fmt(r["videoBps"] / 1000, 0),
                     C.fmt(r["actualVideoBps"] / 1000, 0), C.fmt(r["sizeAccuracy"], 3),
                     C.fmt(r["overshoot"], 3), C.fmt(r["overheadPct"]), C.fmt(r.get("encodeFps"), 1),
                     C.fmt(r.get("bppRequested"), 4), C.fmt(r.get("bppActual"), 4), C.fmt(r.get("ssimY"), 4)])
    ok = [r for r in doc["jobs"] if r.get("ok")]
    per = []
    for codec in sorted({r["codec"] for r in ok}):
        rs = [r for r in ok if r["codec"] == codec]
        acc = [r["sizeAccuracy"] for r in rs]
        per.append([codec, len(rs), C.fmt(C.median(acc), 3), C.fmt(max(acc), 3),
                    sum(1 for x in acc if x > 1), C.fmt(C.median([r["overheadPct"] for r in rs]))])
    return "\n".join([
        "# Clip native reference (ffmpeg)", "",
        f"{doc['ffmpeg']}. VP9: libvpx-vp9 two-pass (pass 1 cpu-used 4, pass 2 cpu-used "
        f"{doc['vp9CpuUsed']}); AV1: libsvtav1 one-pass VBR (rc=1), preset {doc['svtPreset']}, "
        "given the average frame rate for VFR sources. Size accuracy = file bytes / limit.", "",
        C.md_table(["codec", "n", "size accuracy median", "max", "over limit", "overhead % median"], per), "",
        C.ceiling_table(C.ceiling_lines(ok)), "",
        C.md_table(["fixture", "codec", "MiB", "req kbps", "got kbps", "size acc", "overshoot", "overhead %",
                    "enc fps", "bpp req", "bpp act", "SSIM Y"], rows), ""])


def merged(doc, prev):
    """This run's rows plus earlier rows for outputs this run didn't touch (a --fixtures run keeps the rest)."""
    seen = {r["out"] for r in doc["jobs"]}
    return {**doc, "jobs": doc["jobs"] + [r for name, r in prev.items() if name not in seen]}


def write(out_p, doc, prev):
    out_p.write_text(json.dumps(merged(doc, prev), indent=2) + "\n", encoding="utf-8")


def main(argv=None):
    ap = argparse.ArgumentParser(description="native ffmpeg reference for the Clip bench")
    ap.add_argument("--fixtures")
    ap.add_argument("--codecs", default=",".join(CODECS))
    ap.add_argument("--budgets", help="MiB, comma-separated (default 2,4,6)")
    ap.add_argument("--quick", action="store_true", help="the 2 quick fixtures, VP9 only")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--max-seconds", type=float)
    ap.add_argument("--vp9-cpu-used", type=int, default=2)
    ap.add_argument("--svt-preset", type=int, default=8)
    ap.add_argument("--print-ladder", nargs="+", type=float, metavar="SECONDS",
                    help="print the bitrate ladder for these durations (no audio, and with Opus) and exit")
    a = ap.parse_args(argv)

    budgets = [float(x) if "." in x else int(x) for x in a.budgets.split(",")] if a.budgets else None
    if a.print_ladder:
        print(json.dumps({str(d): {"silent": C.bitrate_ladder(d, budgets),
                                   "opus": C.bitrate_ladder(d, budgets, C.AUDIO_BPS)}
                          for d in a.print_ladder}))
        return 0

    codecs = ["vp9"] if a.quick and a.codecs == ",".join(CODECS) else [c for c in a.codecs.split(",") if c]
    bad = [c for c in codecs if c not in CODECS]
    if bad:
        ap.error("codecs: " + ", ".join(CODECS))
    names = [n for n in a.fixtures.split(",") if n] if a.fixtures else None
    fixtures = C.select(C.load_manifest(), names, a.quick)
    OUT.mkdir(parents=True, exist_ok=True)
    out_p = C.RESULTS / "native.json"
    prev = {}
    if out_p.exists():
        prev = {r["out"]: C.bpp_fields(r)   # older rows carry one `bpp` (requested)
                for r in json.loads(out_p.read_text(encoding="utf-8")).get("jobs", []) if r.get("ok")}
    version = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True).stdout.split("\n")[0]
    doc = {"ffmpeg": version, "vp9CpuUsed": a.vp9_cpu_used, "svtPreset": a.svt_preset, "jobs": []}
    for fx in fixtures:
        for codec in codecs:
            for rung in C.bitrate_ladder(fx["duration"], budgets, C.AUDIO_BPS if fx.get("audio") else 0):
                row = run_job(fx, codec, rung, a, prev)
                doc["jobs"].append(row)
                if row["ok"]:
                    print(f"ok   {row['out']}  size {row['sizeAccuracy']:.3f} of limit  overshoot "
                          f"{row['overshoot']:.3f}  ssim {C.fmt(row.get('ssimY'), 4)}", flush=True)
                else:
                    print(f"FAIL {row['out']}: {row['error']}", flush=True)
                write(out_p, doc, prev)
    write(out_p, doc, prev)
    (C.RESULTS / "native.md").write_text(markdown(merged(doc, prev)), encoding="utf-8")
    failed = sum(1 for r in doc["jobs"] if not r["ok"])
    print(f"{len(doc['jobs']) - failed} ok, {failed} failed; wrote tests/clip/results/native.json and native.md")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
