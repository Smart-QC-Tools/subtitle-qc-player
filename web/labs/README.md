# Labs

Experiments, not part of the app. Nothing here is built into the web version or the Mac app.

- `analysis-feasibility.src.html`: can the video analysis run in Chrome without the Mac app? Reads a video from a
  picked folder by byte range (MP4 / MOV sample tables), decodes single frames (WebCodecs for H.264 / HEVC, a
  ProRes-only FFmpeg decoder in WebAssembly for ProRes), times every step and estimates a 45-minute episode.
  Build the one-file page: `python3 web/labs/build_lab.py` → `web/labs/dist/analysis-feasibility.html`.
- `prores/`: the ProRes decoder (`prores.wasm`, 346 KB, ~130 KB compressed) and how to rebuild it (`build.sh`).
