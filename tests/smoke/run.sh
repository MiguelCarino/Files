#!/usr/bin/env bash
# One headless-Chromium smoke run over the real page: ./tests/smoke/run.sh
#
# Served over HTTP from the repo root, never file:// (file:// treats every
# script as a foreign origin: errors collapse to "Script error." and the
# hash worker cannot start). One browser, one context, sequential steps.
#
# The machine is shared: below 3000 MB available memory the run is skipped
# (exit 0, with the reason), not attempted.
#
# Playwright: tests/smoke/node_modules when installed (cd tests/smoke &&
# npm install && npx playwright install chromium), else the copy in
# ../Topo/tests/node_modules beside this repo. Neither: skipped with a message.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PORT="${PORT:-8743}"
MIN_MB="${MIN_MB:-3000}"

avail=$(free -m | awk '/^Mem:/ {print $7}')
if [ -z "$avail" ] || [ "$avail" -lt "$MIN_MB" ]; then
    echo "SKIP smoke: ${avail:-?} MB available, needs ${MIN_MB} MB (shared machine)"
    exit 0
fi

if [ -d "$HERE/node_modules/playwright" ]; then
    :
elif [ -d "$ROOT/../Topo/tests/node_modules/playwright" ]; then
    export NODE_PATH="$(cd "$ROOT/../Topo/tests/node_modules" && pwd)${NODE_PATH:+:$NODE_PATH}"
else
    echo "SKIP smoke: no Playwright (tests/smoke/node_modules or ../Topo/tests/node_modules)"
    exit 0
fi

python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$ROOT" >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT

for _ in $(seq 50); do
    if (exec 3<>/dev/tcp/127.0.0.1/"$PORT") 2>/dev/null; then exec 3<&-; break; fi
    sleep 0.1
done
kill -0 $SERVER 2>/dev/null || { echo "could not start a server on :$PORT (set PORT=...)" >&2; exit 1; }

BASE="http://127.0.0.1:$PORT/" node "$HERE/smoke.mjs"
