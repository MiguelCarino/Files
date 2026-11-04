"""Shared helpers for the Clip P0 tools: tests/clip/score.py and tests/clip/native_ref.py.

The bitrate ladder here is the Python twin of tests/clip/benchlib.mjs's
bitrateLadder (same constants, same arithmetic order); tests/clipbench.test.mjs
checks they agree. SSIM is ffmpeg's ssim filter, luma (Y) only, of an output
against its source scaled to the output's size.
"""

import json
import math
import pathlib
import re
import statistics
import subprocess

HERE = pathlib.Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures"
RESULTS = HERE / "results"
THREADS = "6"
MIN_AVAIL_MB = 3000

MiB = 1048576
LADDER_MIB = [2, 4, 6]
SAFETY = 0.99
OVERHEAD_GUESS = 0.005
MIN_BPS = 64000
MAX_BPS = 25000000
AUDIO_BPS = 96000
QUICK_FIXTURES = ["easy-720p30-5s", "hard-720p30-5s"]

# §12.5's criterion for §4.3's two lines: distance from the fixture's own SSIM (Y)
# ceiling (its SSIM at the run's highest rung, same browser and codec), not an
# absolute SSIM. "good" = within GOOD_DROP of the ceiling (compared at 3 decimals),
# "visibly blocky" = more than BLOCKY_DROP below it. Above FLOOR_OVERSHOOT the
# encoder is at its floor and the row says so instead.
GOOD_DROP = 0.010
BLOCKY_DROP = 0.025
FLOOR_OVERSHOOT = 1.3


def video_bitrate_for(limit_bytes, duration_s, audio_bps=0):
    if not (limit_bytes > 0 and duration_s > 0):
        raise ValueError("limit and duration must be > 0")
    budget = limit_bytes * SAFETY - limit_bytes * OVERHEAD_GUESS - (audio_bps * duration_s) / 8
    if budget <= 0:
        return None
    bps = math.floor((budget * 8) / duration_s / 1000) * 1000
    return max(MIN_BPS, min(MAX_BPS, bps))


def bitrate_ladder(duration_s, budgets_mib=None, audio_bps=0):
    out, seen = [], set()
    for m in budgets_mib or LADDER_MIB:
        limit = int(math.floor(m * MiB + 0.5))
        bps = video_bitrate_for(limit, duration_s, audio_bps)
        if bps is None or bps in seen:
            continue
        seen.add(bps)
        out.append({"limitMiB": m, "limitBytes": limit, "videoBps": bps})
    return out


def job_file(fixture, codec, limit_mib):
    return f"{fixture}.{codec}.{str(limit_mib).replace('.', '_')}mib.webm"


def avail_mb():
    try:
        for line in open("/proc/meminfo", encoding="ascii"):
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) // 1024
    except OSError:
        pass
    return None


def need_memory():
    a = avail_mb()
    if a is not None and a < MIN_AVAIL_MB:
        raise SystemExit(f"stopping: {a} MB available, needs {MIN_AVAIL_MB} MB (shared machine)")


def load_manifest():
    p = FIXTURES / "manifest.json"
    if not p.exists():
        raise SystemExit("no fixtures: run python3 -I tools/clip_fixtures.py first")
    return json.loads(p.read_text(encoding="utf-8"))["fixtures"]


def select(fixtures, names=None, quick=False):
    by = {f["name"]: f for f in fixtures}
    if names:
        missing = [n for n in names if n not in by]
        if missing:
            raise SystemExit("not in the manifest: " + ", ".join(missing))
        return [by[n] for n in names]
    if quick:
        return select(fixtures, QUICK_FIXTURES)
    return [f for f in fixtures if f.get("bench", True)]


def ffprobe_json(path, *args):
    r = subprocess.run(["ffprobe", "-v", "error", *args, "-of", "json", str(path)],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"ffprobe {path}: {r.stderr.strip()[-300:]}")
    return json.loads(r.stdout or "{}")


def stream_bytes(path):
    """{'video': bytes, 'audio': bytes, 'frames': n} from the packet sizes."""
    info = ffprobe_json(path, "-show_entries", "stream=index,codec_type:packet=stream_index,size")
    types = {s["index"]: s["codec_type"] for s in info.get("streams", [])}
    out = {"video": 0, "audio": 0, "frames": 0}
    for p in info.get("packets", []):
        t = types.get(p.get("stream_index"))
        if t in ("video", "audio"):
            out[t] += int(p.get("size", 0))
            if t == "video":
                out["frames"] += 1
    return out


def display_size(path):
    """(width, height, duration) as shown, i.e. after any display-matrix rotation."""
    info = ffprobe_json(path, "-select_streams", "v:0", "-show_entries",
                        "stream=width,height:stream_side_data=rotation:format=duration")
    s = (info.get("streams") or [{}])[0]
    w, h = int(s.get("width", 0)), int(s.get("height", 0))
    rot = 0
    for sd in s.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = int(sd["rotation"])
    if abs(rot) % 180 == 90:
        w, h = h, w
    return w, h, float((info.get("format") or {}).get("duration") or 0)


SSIM_RE = re.compile(r"SSIM Y:([0-9.]+)")


def ssim_y(dist, ref, max_seconds=None):
    """Mean SSIM of the luma plane: dist against ref scaled (bicubic) to dist's shown size."""
    w, h, _ = display_size(dist)
    graph = (f"[0:v]setpts=PTS-STARTPTS,format=yuv420p[d];"
             f"[1:v]scale={w}:{h}:flags=bicubic,setpts=PTS-STARTPTS,format=yuv420p[r];"
             f"[d][r]ssim")
    cmd = ["ffmpeg", "-hide_banner", "-nostdin", "-threads", THREADS, "-i", str(dist),
           "-threads", THREADS, "-i", str(ref), "-filter_threads", THREADS, "-lavfi", graph]
    if max_seconds:
        cmd += ["-t", str(max_seconds)]
    cmd += ["-an", "-f", "null", "-"]
    r = subprocess.run(cmd, capture_output=True, text=True)
    m = SSIM_RE.findall(r.stderr)
    if r.returncode != 0 or not m:
        raise RuntimeError("ssim failed: " + r.stderr.strip()[-400:])
    return float(m[-1])


def median(xs):
    v = [x for x in xs if isinstance(x, (int, float)) and math.isfinite(x)]
    return statistics.median(v) if v else None


def fmt(x, d=2):
    return "–" if x is None or (isinstance(x, float) and not math.isfinite(x)) else f"{x:.{d}f}"


def md_table(headers, rows):
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    out += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def bpp_fields(r):
    """Give a result row both bpp values (older rows have one `bpp`, which was the requested one).

    bppRequested = requested video bitrate / (w × h × fps): what the planner can compute.
    bppActual    = video packet bits per second / (w × h × fps): what the encoder spent.
    """
    if "bppRequested" not in r and "bpp" in r:
        r["bppRequested"] = r.pop("bpp")
    r.pop("bpp", None)
    fps = r.get("outFps")
    if not fps and r.get("frames") and r.get("outDuration"):
        fps = r["frames"] / r["outDuration"]
    px = (r.get("w") or 0) * (r.get("h") or 0) * (fps or 0)
    if r.get("bppRequested") is None and px and r.get("videoBps"):
        r["bppRequested"] = r["videoBps"] / px
    if r.get("bppActual") is None and px and r.get("actualVideoBps") is not None:
        r["bppActual"] = r["actualVideoBps"] / px
    return r


def ceiling_lines(rows):
    """§12.5's criterion, per codec and fixture: the ceiling is the SSIM at the highest rung;
    report the lowest bpp still within GOOD_DROP of it and the highest bpp more than
    BLOCKY_DROP below it, both as requested and as actual bpp. Rows at the encoder floor
    (overshoot > FLOOR_OVERSHOOT) count for neither line and are only counted.
    Inputs: dicts with codec, fixture, limitMiB, ssimY, overshoot, bppRequested, bppActual."""
    groups = {}
    for r in rows:
        if r.get("ssimY") is None or r.get("bppRequested") is None:
            continue
        groups.setdefault((r["codec"], r["fixture"]), []).append(r)
    out = []
    for (codec, fixture), rs in sorted(groups.items()):
        rs = sorted(rs, key=lambda r: r["limitMiB"])
        top = rs[-1]
        ceil = top["ssimY"]
        floor = [r for r in rs if (r.get("overshoot") or 0) > FLOOR_OVERSHOOT]
        live = [r for r in rs if r not in floor]   # at the floor the requested bpp means nothing
        good = [r for r in live if round(ceil - r["ssimY"], 3) <= GOOD_DROP]
        bad = [r for r in live if ceil - r["ssimY"] > BLOCKY_DROP]
        g = min(good, key=lambda r: r["bppRequested"]) if good else None
        b = max(bad, key=lambda r: r["bppRequested"]) if bad else None
        out.append({"codec": codec, "fixture": fixture, "n": len(rs),
                    "ceilingSsim": ceil, "ceilingMiB": top["limitMiB"],
                    "goodFromBppRequested": g and g["bppRequested"], "goodFromBppActual": g and g.get("bppActual"),
                    "blockyBelowBppRequested": b and b["bppRequested"],
                    "blockyBelowBppActual": b and b.get("bppActual"),
                    "floorRungs": len(floor)})
    return out


def ceiling_table(lines):
    """Markdown for ceiling_lines()."""
    head = (f"Per fixture: ceiling = SSIM at the highest rung. good = within {GOOD_DROP} of it; "
            f"blocky = more than {BLOCKY_DROP} below it; rungs at the encoder floor count for neither "
            f"(overshoot > {FLOOR_OVERSHOOT}). bpp is given both as requested (what the planner "
            "computes) and actual (what the encoder spent). With only 2, 4, 6 MiB rungs the ceiling "
            "is rough; the sweep run (0.25–8 MiB) is the one §12.5 uses.")
    return "\n".join([head, "", md_table(
        ["codec", "fixture", "n", "ceiling SSIM (MiB)", "good from bpp req", "act",
         "blocky below bpp req", "act", "rungs at floor"],
        [[x["codec"], x["fixture"], x["n"], f'{fmt(x["ceilingSsim"], 4)} ({x["ceilingMiB"]})',
          fmt(x["goodFromBppRequested"], 4), fmt(x["goodFromBppActual"], 4),
          fmt(x["blockyBelowBppRequested"], 4), fmt(x["blockyBelowBppActual"], 4), x["floorRungs"]]
         for x in lines])])
