# Labs

Experiments, not part of the app. Nothing here is built into the web version or the Mac app.

- `analysis-feasibility.src.html`: can the video analysis run in Chrome without the Mac app? Reads a video from a
  picked folder by byte range (MP4 / MOV sample tables), decodes single frames (WebCodecs for H.264 / HEVC, a
  ProRes-only FFmpeg decoder in WebAssembly for ProRes), times every step and estimates a 45-minute episode.
  Build the one-file page: `python3 web/labs/build_lab.py` → `web/labs/dist/analysis-feasibility.html`.
- `text-detection.src.html`: finds on-screen text (credits, titles, captions) without reading it: a frame every 2 s,
  follows each piece of text across frames, drops anything on screen > 20 s (logos, BITC), then finds in / out to the
  frame by bisection. Two detectors: image checks (edges along a line; no download) and PaddleOCR's PP-OCRv4
  detector (ONNX Runtime Web, WebGPU if available, else WebAssembly). Checks itself against the Harbor Lights test
  episode (T1103 / T1104). Needs `web/labs/fetch_assets.sh` once (downloads onnxruntime-web 1.20.1 and the model
  into `web/labs/vendor/`, not committed); the built page is ~35 MB because everything is inside it.
- `lab-video.js`: shared by both pages (MP4 / MOV parsing, frame decoding), inlined at build time.
- `text-engine.js`: the text detector and the rules (`findText`, `TEXT_RULES`). The lab page and the app's Video Analysis
  (web/src/textdetect.js) both use it: a rule changed here changes the app too (rebuilds the preview).
- `prores/`: the ProRes decoder (`prores.wasm`, 346 KB, ~130 KB compressed) and how to rebuild it (`build.sh`).
