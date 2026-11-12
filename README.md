# Subtitle QC Player

Subtitle conform and QC tool: language checks for subtitle folders (TTML, IMSC, iTT, DFXP, XML, WebVTT, SRT, SCC) and a
QC player with waveform, frame-accurate timecode and subtitle rendering.

- **Mac app** (`mac/`): the interface in a native window, with video played by AVFoundation (ProRes,
  H.264, HEVC), native waveforms and real folders. Universal (Apple Silicon + Intel), macOS 13 or later.
- **Web version** (`web/`): the same interface as a single offline HTML file for Chrome
  (also published with every build as `Subtitle_QC_Player.html`).

## Getting the app
Download page: **https://smart-qc-tools.github.io/subtitle-qc-player/** (the stable version).
Test builds of work in progress: `preview.html` on the same site, not linked from the main page.

Every push to `main` builds the app on GitHub (Actions tab) and publishes it under
**Releases → latest → Subtitle-QC-Player.zip**.

1. Download and unzip `Subtitle-QC-Player.zip`, move **Subtitle QC Player** to Applications.
2. First launch only: macOS blocks the app once because it isn't signed with an Apple Developer ID.
   Click **Done**, then **System Settings → Privacy & Security → Open Anyway** (on a work Mac this
   may need an administrator's password).

Problems are logged to `~/Library/Logs/Subtitle QC Player/app.log` (Help ▸ Show Log File).

## Building locally (optional)
On a Mac with the Xcode command-line tools: `bash mac/build.sh` → `build/Subtitle QC Player.app`.
The web version alone: `cd web && python3 build.py` → `web/dist/Subtitle_QC_Player.html`.
