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

### Refined focus: opening credits vs subtitle placement (discussed 2026-11-05)
User's main concern: subtitles overlapping / nearly overlapping opening-credit text. Credits: 1–6 min,
sometimes in several runs, start anywhere in roughly the first 2–15 min, almost always end with
"Directed by"; neatly aligned text (italic at most). Raised subtitles within ~30 s of credits are fine.
Proposed search (not built):
1. Coarse scan of the first ~20 min every ~4 s, text boxes only (fast). Keep "credit-like" hits:
   horizontal, aligned, few short lines, and static (same boxes 0.5 s later; scene text moves).
2. Group hits into runs (gaps <= 30 s join). Densify inside runs to 1 s to catch short cards.
3. Read text only a few frames per run: confirm credit vocabulary, find "Directed by" (end of credits).
   If nothing found in 20 min, extend to 30 min.
4. Card in/out by bisection (~7 frame checks per edge), only where a subtitle event is nearby.
5. Compare credit boxes with the rendered subtitle box (from the player): overlap or within ~5% of
   picture height -> red / amber. Raised subtitles more than 30 s from any credit -> amber.
Estimate (unmeasured): ~1,000 frames looked at, ~20–60 s on SSD, ~1–2 min on network storage.

### Revisions after user feedback (2026-11-05)
- Window: 10 min covers ~92%, 20 min ~99.9%. Search for "Directed by" first: coarse scan from 0, read
  text only on credit-like hits, stop once "Directed by" is found (+ ~1 min forward for stragglers),
  then collect the whole credits sequence back to the start. Not found by 10 min -> continue to 20;
  still not found -> report credit-like runs as "unconfirmed". Consider other-language forms
  (Réalisé par, Regie, Dirigido por, Diretto da …).
- Static test: check +0.5 s; if empty there, check -0.5 s (landed near the end of a card).
- Margin: fixed default; optional Advanced setting later. Very-top credits rare; still compare top subs.
- Raised-for-no-reason window: 20 s (Advanced setting candidate).
- Stage 1 is video-only: every card found with exact in/out frames and text boxes, regardless of
  subtitles (subs may be 1–2 s out of sync). Stage 2 (instant, any number of subtitle files) compares.
  Consider a time margin too (subtitle a few frames before / after a card counts).
- Results saved as a shareable sidecar file, e.g. "<video>.credits.json", next to the video when the
  folder is writable, else saved where the user chooses. Contents: app version, settings, video
  fingerprint (size + duration + fps + hash of a few sampled chunks; matched by fingerprint, not name),
  start timecode, cards {in/out frames + TC, boxes normalised, text, confidence}, runs, Directed-by card.
  Auto-loaded when the video opens; the web version can read it too (check without analysing).

### Further notes (2026-11-05)
- Main-title-sequence credits (before the opening credits) are picked up as their own run; harmless,
  few subtitles there. Animated/stylised title text may be partly missed: acceptable.
- One search, 0 -> "Directed by" (+ ~1 min), hard limit 20 min. Start-in-the-middle (e.g. 6 min,
  alternating) considered: finds "Directed by" sooner, but the whole stretch before it must be scanned
  anyway to collect every card, so total work is the same or more. Scan from 0, show results as found.
- Non-English credits: rare (some features). English "Directed by" + a short list of other forms;
  otherwise the "unconfirmed" fallback.
- Results files go in a dedicated, visible folder inside the selected video folder, e.g.
  "Subtitle QC Data/<video>.credits.json" (copies along with the videos); ask for a location if the
  folder is read-only.
