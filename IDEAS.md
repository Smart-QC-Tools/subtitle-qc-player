# Ideas (discussed, not built)

## Commercial black detection (discussed 2026-11-05)
- Optional "Analyze blacks" button; runs in the background with progress.
- Black frame = ~98% of pixels below ~10% luma (ffmpeg blackdetect defaults), on a downscaled frame.
- Coarse pass ~4 frames/s, then frame-exact refinement around candidates (finds blacks > ~0.25 s).
- Optional: confirm with audio silence (reuse the waveform pass) to tell breaks from dark scenes.
- Output: list of blacks (In / Out / Duration, clickable), markers on the waveform bar.
- QC tie-in: flag subtitle events spanning a black, or starting/ending within a few frames of one.
- Estimates for 45 min (unmeasured): H.264/HEVC or ProRes 1080p on SSD ~30–60 s; ProRes 1080p on
  network storage ~2–4 min; ProRes 4K ~1–2 min SSD / 5–10 min network.
- Mac first (AVAssetReader). Web: H.264 only, hidden fast playback sampling, ~3–6 min.
- Benchmark on the selftest runner with 45-min files before building.

## On-screen text detection, lower third (discussed 2026-11-05)
- Mac only: Apple Vision (VNDetectTextRectanglesRequest for boxes; VNRecognizeTextRequest to read).
- Sample ~2 frames/s, lower third crop (optionally full frame); recognise text only where boxes found.
- QC: bottom subtitles colliding with burned-in text (should be raised); raised subtitles with no text
  under them; on-screen text with no subtitle (possible missing forced narrative).
- Estimate 45 min (unmeasured): ~2–4 min on SSD.
- Could share one "Analyze video" pass with black detection.
