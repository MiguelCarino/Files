#!/usr/bin/env python3
"""Add SSIM to a browser bench run and write its tables.

    python3 -I tests/clip/score.py --browser chromium [--force] [--max-seconds N]

Reads tests/clip/results/<browser>/raw.json (written by tests/clip/bench.mjs),
computes SSIM (ffmpeg ssim filter, Y channel) of each saved output against its
source fixture scaled to the output's size, and writes
tests/clip/results/<browser>.json and tests/clip/results/<browser>.md.

SSIM already in a previous <browser>.json for the same output file (same size)
is reused unless --force. HDR fixtures get no SSIM: the source is PQ/HLG and
the output is whatever the browser made of it, so the number would mean nothing.
"""

import argparse
import json
import pathlib
import sys

sys.dont_write_bytecode = True   # no __pycache__ beside the tests
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import cliplib as C  # noqa: E402


def mx(xs):
    v = [x for x in xs if isinstance(x, (int, float))]
    return max(v) if v else None


def summarize(rows):
    ok = [r for r in rows if r.get("ok")]
    per_codec = []
    for codec in sorted({r["codec"] for r in ok}):
        rs = [r for r in ok if r["codec"] == codec]
        per_codec.append({
            "codec": codec, "n": len(rs),
            "overshootMedian": C.median([r.get("overshoot") for r in rs]),
            "overshootMax": mx(r.get("overshoot") for r in rs),
            "overheadPctMedian": C.median([r.get("overheadPct") for r in rs]),
            "overheadPctMax": mx(r.get("overheadPct") for r in rs),
            "fillPctMax": mx(r.get("fillPct") for r in rs),
            "overLimit": sum(1 for r in rs if (r.get("fileBytes") or 0) > r["limitBytes"]),
        })
    speed = []
    for key in sorted({(r["codec"], f'{r["srcH"]}p{r["srcFps"] or "vfr"}') for r in ok}):
        rs = [r for r in ok if (r["codec"], f'{r["srcH"]}p{r["srcFps"] or "vfr"}') == key]
        speed.append({"codec": key[0], "format": key[1], "n": len(rs),
                      "fpsMedian": C.median([r.get("encodeFps") for r in rs]),
                      "realtimeMedian": C.median([r.get("realtime") for r in rs])})
    return {"perCodec": per_codec, "speed": speed, "ceiling": C.ceiling_lines(ok)}


def markdown(doc):
    s = doc["summary"]
    lines = [f"# Clip bench: {doc['browser']} {doc.get('version') or ''}".rstrip(), "",
             f"Run {doc.get('started', '?')} → {doc.get('finished', '?')}; encoder preference "
             f"`{doc.get('hw', 'no-preference')}`. Bitrate mode `{doc.get('bitrateMode') or 'variable'}`, frame rate "
             f"`{doc.get('frameRate') or 'unset'}` (`source` = the source's rate passed to the encoder, CFR "
             "sources only), WebM, Opus 96k when the source has sound. SSIM is Y only, against the source "
             "scaled (bicubic) to the output size.", ""]
    lines += ["## Per codec (rate control and container)", "", C.md_table(
        ["codec", "n", "overshoot median", "overshoot max", "overhead % median", "overhead % max",
         "fill % max", "over limit"],
        [[c["codec"], c["n"], C.fmt(c["overshootMedian"], 3), C.fmt(c["overshootMax"], 3),
          C.fmt(c["overheadPctMedian"]), C.fmt(c["overheadPctMax"]), C.fmt(c["fillPctMax"], 1),
          c["overLimit"]] for c in s["perCodec"]]), ""]
    lines += ["## Encode speed", "", C.md_table(
        ["codec", "source", "n", "fps median", "× real time median"],
        [[x["codec"], x["format"], x["n"], C.fmt(x["fpsMedian"], 1), C.fmt(x["realtimeMedian"])]
         for x in s["speed"]]), ""]
    lines += ["## Bits per pixel vs distance from the SSIM ceiling (§12.5)", "",
              C.ceiling_table(s["ceiling"]), ""]
    rows = []
    for r in doc["jobs"]:
        if not r.get("ok"):
            rows.append([r["fixture"], r["codec"], r["limitMiB"], C.fmt(r["videoBps"] / 1000, 0),
                         "FAIL: " + str(r.get("error", ""))[:80], "", "", "", "", "", "", ""])
            continue
        rows.append([r["fixture"], r["codec"], r["limitMiB"], C.fmt(r["videoBps"] / 1000, 0),
                     C.fmt(r["actualVideoBps"] / 1000 if r.get("actualVideoBps") is not None else None, 0), C.fmt(r.get("overshoot"), 3),
                     C.fmt(r.get("overheadPct")), C.fmt(r.get("fillPct"), 1), C.fmt(r.get("encodeFps"), 1),
                     C.fmt(r.get("bppRequested"), 4), C.fmt(r.get("bppActual"), 4), C.fmt(r.get("ssimY"), 4)])
    lines += ["## Every encode", "", C.md_table(
        ["fixture", "codec", "MiB", "req kbps", "got kbps", "overshoot", "overhead %", "fill %",
         "enc fps", "bpp req", "bpp act", "SSIM Y"], rows), ""]
    if doc.get("consoleErrors"):
        lines += ["Console errors: " + str(len(doc["consoleErrors"])), ""]
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description="SSIM + tables for a bench run")
    ap.add_argument("--browser", required=True)
    ap.add_argument("--force", action="store_true", help="recompute SSIM that was already measured")
    ap.add_argument("--max-seconds", type=float, help="SSIM over the first N seconds only")
    a = ap.parse_args(argv)
    raw_p = C.RESULTS / a.browser / "raw.json"
    if not raw_p.exists():
        print(f"no {raw_p.relative_to(C.HERE.parent.parent)}: run tests/clip/bench.mjs first", file=sys.stderr)
        return 2
    raw = json.loads(raw_p.read_text(encoding="utf-8"))
    fixtures = {f["name"]: f for f in C.load_manifest()}
    out_p = C.RESULTS / f"{a.browser}.json"
    prev = {}
    if out_p.exists() and not a.force:
        for r in json.loads(out_p.read_text(encoding="utf-8")).get("jobs", []):
            if r.get("ssimY") is not None:
                prev[(r["out"], r.get("fileBytes"))] = r["ssimY"]

    for r in raw["jobs"]:
        f = fixtures.get(r["fixture"], {})
        r["kind"], r["srcH"], r["srcFps"] = f.get("kind", "?"), f.get("h"), f.get("fps")
        if not r.get("ok"):
            continue
        C.bpp_fields(r)
        out = C.RESULTS / a.browser / r["out"]
        if f.get("hdr"):
            r["ssimY"], r["ssimNote"] = None, "HDR source: not comparable"
        elif not out.exists():
            r["ssimY"], r["ssimNote"] = None, "output not saved"
        elif (r["out"], r.get("fileBytes")) in prev:
            r["ssimY"] = prev[(r["out"], r.get("fileBytes"))]
        else:
            C.need_memory()
            try:
                r["ssimY"] = C.ssim_y(out, C.FIXTURES / f["path"], a.max_seconds)
                print(f"ssim {r['out']}: {r['ssimY']:.4f}", flush=True)
            except RuntimeError as e:
                r["ssimY"], r["ssimNote"] = None, str(e)[-200:]
                print(f"ssim {r['out']}: failed", file=sys.stderr)

    doc = dict(raw)
    doc["summary"] = summarize(raw["jobs"])
    out_p.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    (C.RESULTS / f"{a.browser}.md").write_text(markdown(doc), encoding="utf-8")
    print(f"wrote {out_p.relative_to(C.HERE.parent.parent)} and {a.browser}.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
