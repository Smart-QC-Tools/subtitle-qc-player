#!/bin/bash
# Runs the self-test build of the app against the test media and collects everything in $2.
set -uo pipefail
MEDIA="$1"; OUT="$2"; mkdir -p "$OUT"
BIN="$(pwd)/build/Subtitle QC Player.app/Contents/MacOS/SubtitleQC"
defaults delete com.smartqctools.subtitleqc >/dev/null 2>&1 || true
rm -rf "$HOME/Library/Logs/Subtitle QC Player"
{ sw_vers; sysctl -n machdep.cpu.brand_string hw.ncpu hw.memsize; system_profiler SPDisplaysDataType 2>/dev/null | head -20; } > "$OUT/system.txt" 2>&1
for f in "$MEDIA"/Videos/*; do echo "== $(basename "$f") $(stat -f%z "$f") bytes"; ffprobe -v error -show_entries stream=index,codec_name,profile,width,height,r_frame_rate,channels,pix_fmt:format=duration -of compact "$f"; done > "$OUT/media.txt" 2>&1
export SQC_SELFTEST="$(pwd)/mac/selftest/selftest.js" SQC_VIDEOS="$MEDIA/Videos" SQC_SUBS="$MEDIA/Subtitles" SQC_RESULT="$OUT/result.json"
# Video analysis test folder (the results files the app writes there are collected too). SQC_ONLY=analysis skips the playback tests.
export SQC_ANALYSIS="$MEDIA/Analysis" SQC_ONLY="${SQC_ONLY:-}"
rm -rf "$MEDIA/Analysis/Subtitle QC Data"
EVERY=20; [ -n "$SQC_ONLY" ] && EVERY=4
"$BIN" > "$OUT/stdout.txt" 2>&1 &
PID=$!
START=$(date +%s)
i=0
# Network: the app must never open a connection. Its own process and WebKit's helper processes are listed
# every 2 s (lsof), and at the end nettop shows any process of ours that ever sent or received anything.
netcheck() { for p in $PID $(pgrep -f "com.apple.WebKit" 2>/dev/null); do lsof -nP -i -a -p "$p" 2>/dev/null | tail -n +2; done; }
: > "$OUT/network.txt"
while kill -0 $PID 2>/dev/null; do
  i=$((i+1))
  N="$(netcheck)"; [ -n "$N" ] && { echo "== $(( $(date +%s) - START ))s"; echo "$N"; } >> "$OUT/network.txt"
  echo "$(( $(date +%s) - START ))s $(ps -o rss=,%cpu= -p $PID)" >> "$OUT/ps.txt"
  if (( i % EVERY == EVERY / 2 + 1 )); then screencapture -x "$OUT/shot_$(printf %03d $i).png" 2>/dev/null || true; fi
  if (( $(date +%s) - START > 1800 )); then echo "TIMEOUT" >> "$OUT/ps.txt"; kill $PID; break; fi
  sleep 2
done
wait $PID 2>/dev/null; echo "exit $?" >> "$OUT/ps.txt"
{ echo "== nettop (processes with any network traffic):"; nettop -P -L 1 -x -n 2>/dev/null | grep -iE "SubtitleQC|WebKit" || echo "(none of ours)"; } >> "$OUT/network.txt"
[ "$(grep -c '^== [0-9]' "$OUT/network.txt")" = "0" ] && grep -q "(none of ours)" "$OUT/network.txt" && echo "NETWORK: no connections" >> "$OUT/network.txt" || echo "NETWORK: SEE ABOVE" >> "$OUT/network.txt"
cp "$HOME/Library/Logs/Subtitle QC Player/app.log" "$OUT/" 2>/dev/null || true
cp -R "$MEDIA/Analysis/Subtitle QC Data" "$OUT/analysis-results" 2>/dev/null || true
cp "$MEDIA/Analysis/expected.json" "$OUT/analysis-expected.json" 2>/dev/null || true
# crash reports, if any
cp "$HOME"/Library/Logs/DiagnosticReports/SubtitleQC* "$OUT/" 2>/dev/null || true
[ -f "$OUT/result.json" ] && echo "result written" || echo "NO RESULT"
