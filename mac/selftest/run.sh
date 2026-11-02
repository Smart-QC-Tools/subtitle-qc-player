#!/bin/bash
# Runs the self-test build of the app against the test media and collects everything in $2.
set -uo pipefail
MEDIA="$1"; OUT="$2"; mkdir -p "$OUT"
BIN="$(pwd)/build/Subtitle QC Player.app/Contents/MacOS/SubtitleQC"
defaults delete com.danmurciano.subtitleqc >/dev/null 2>&1 || true
rm -rf "$HOME/Library/Logs/Subtitle QC Player"
{ sw_vers; sysctl -n machdep.cpu.brand_string hw.ncpu hw.memsize; system_profiler SPDisplaysDataType 2>/dev/null | head -20; } > "$OUT/system.txt" 2>&1
for f in "$MEDIA"/Videos/*; do echo "== $(basename "$f") $(stat -f%z "$f") bytes"; ffprobe -v error -show_entries stream=index,codec_name,profile,width,height,r_frame_rate,channels,pix_fmt:format=duration -of compact "$f"; done > "$OUT/media.txt" 2>&1
export SQC_SELFTEST="$(pwd)/mac/selftest/selftest.js" SQC_VIDEOS="$MEDIA/Videos" SQC_SUBS="$MEDIA/Subtitles" SQC_RESULT="$OUT/result.json"
"$BIN" > "$OUT/stdout.txt" 2>&1 &
PID=$!
START=$(date +%s)
i=0
while kill -0 $PID 2>/dev/null; do
  i=$((i+1))
  echo "$(( $(date +%s) - START ))s $(ps -o rss=,%cpu= -p $PID)" >> "$OUT/ps.txt"
  if (( i % 20 == 5 )); then screencapture -x "$OUT/shot_$(printf %03d $i).png" 2>/dev/null || true; fi
  if (( $(date +%s) - START > 1800 )); then echo "TIMEOUT" >> "$OUT/ps.txt"; kill $PID; break; fi
  sleep 2
done
wait $PID 2>/dev/null; echo "exit $?" >> "$OUT/ps.txt"
cp "$HOME/Library/Logs/Subtitle QC Player/app.log" "$OUT/" 2>/dev/null || true
# crash reports, if any
cp "$HOME"/Library/Logs/DiagnosticReports/SubtitleQC* "$OUT/" 2>/dev/null || true
[ -f "$OUT/result.json" ] && echo "result written" || echo "NO RESULT"
