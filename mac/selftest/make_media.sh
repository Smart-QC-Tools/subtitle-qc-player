#!/bin/bash
# Test media for the self-test (needs ffmpeg). Three "episodes":
#   T2001  ProRes 422 HQ 1080p 23.976, 3 min, 8 mono audio tracks, timecode 01:00:00:00, index at the end (.mov)
#   T2002  H.264 1080p 23.976 long-GOP (B-frames), stereo AAC, 3 min (.mp4)
#   T2003  HEVC 10-bit 4K 23.976, 70 s, one 8-channel audio track (.mov)
# plus subtitles for each, and one with 1,500 events.
set -euo pipefail
OUT="$1"; mkdir -p "$OUT/Videos" "$OUT/Subtitles"
V="$OUT/Videos"
R=24000/1001
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=1920x1080:rate=$R:duration=180" \
  -filter_complex "sine=f=440:d=180:sample_rate=48000,asplit=8[a0][a1][a2][a3][a4][a5][a6][a7]" \
  -map 0:v -map "[a0]" -map "[a1]" -map "[a2]" -map "[a3]" -map "[a4]" -map "[a5]" -map "[a6]" -map "[a7]" \
  -c:v prores_ks -profile:v 3 -vendor apl0 -pix_fmt yuv422p10le -c:a pcm_s24le -timecode 01:00:00:00 \
  "$V/StressTest_S1_T2001_Hr0_HD_2398_ProResHQ_8trk_V1-R0.mov"
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=1920x1080:rate=$R:duration=180" -f lavfi -i "sine=f=330:d=180:sample_rate=48000" \
  -c:v libx264 -preset veryfast -crf 20 -g 96 -bf 3 -pix_fmt yuv420p -c:a aac -ac 2 -b:a 192k \
  -write_tmcd on -timecode 00:59:59:00 \
  "$V/StressTest_S1_T2002_Hr0_HD_2398_H264_V1-R0.mp4"
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=3840x2160:rate=$R:duration=70" -f lavfi -i "sine=f=550:d=70:sample_rate=48000" \
  -c:v libx265 -preset ultrafast -x265-params keyint=48:log-level=error -pix_fmt yuv420p10le -tag:v hvc1 \
  -filter_complex "[1:a]pan=7.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0|c6=c0|c7=c0[a]" -map 0:v -map "[a]" -c:a pcm_s24le \
  -timecode 01:00:00:00 \
  "$V/StressTest_S1_T2003_Hr0_UHD_2398_HEVC10_V1-R0.mov"
python3 "$(dirname "$0")/make_subs.py" "$OUT/Subtitles"
ls -la "$V" "$OUT/Subtitles"
