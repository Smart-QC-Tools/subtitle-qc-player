# Subtitle QC Player: notes for Claude sessions

Subtitle conform + QC tool for QC operators. Two builds from one codebase:
a single-file **web version** (Chrome) and a **Mac app** (WKWebView page + native AVFoundation video).
Replaces Rouge Gorge / Annotation Edit for *checking* (no subtitle editing yet; fixing stays in Rouge Gorge).

- Repo: github.com/Smart-QC-Tools/subtitle-qc-player (moved from danmurciano/…; no one had the old links).
- Download page: https://smart-qc-tools.github.io/subtitle-qc-player/ (pinned to stable v1.0.0);
  `preview.html` = latest `analysis-preview` test build, deliberately not linked from the main page
  (it links back to stable). Pages served from `main` `/docs`.
  `labs.html` = download page for the test pages in `web/labs/` (video-analysis branch; `labs.yml` builds them into
  the `labs` pre-release on every push there). Not linked from the other pages.
- Intro slide deck (Claude artifact, Slides type): https://claude.ai/artifact/855rermCmJDWnomiRFh5ay
  10 slides: 5 pitch + quick start (install, Conform, QC, keyboard) + "Good to know". Download page link on
  slides 6 (Install) and 10 (Good to know). Screenshots are from v1.0.0 with a made-up show "Harbor Lights".
- Ideas discussed but not built: `IDEAS.md` (commercial blacks, opening-credits detection, etc.).

## Branches, versions, releases
- `main`: stable line (1.0.x). `APP_VERSION` in `web/src/config.js` (currently 1.0.0).
- `release/1.0.0`: permanent stable 1.0.0 → release `v1.0.0`; every push there rebuilds v1.0.0 in place (same links).
  Stable fix flow: commit on main, push main (no build), merge main into video-analysis (preview build), cherry-pick
  onto release/1.0.0 (drop CLAUDE.md, which that branch doesn't have) and push (v1.0.0 build). One build per version.
- `video-analysis`: work in progress → pre-release `analysis-preview` ("Video analysis 1.1.0 — test build N"; preview.html shows "VERSION 1.1.0 · BUILD N").
  When done: merge to main, release as 1.1.0, point the main download page at it.
- No "latest" release any more (the user wants only 1.0.0 and the 1.1.0 preview). Build: `.github/workflows/build.yml` (macos-15).
  `selftest.yml` (manual) runs the Mac app against generated ProRes/H.264/HEVC media.
- Mac bundle ID: `com.smartqctools.subtitleqc`. App is ad-hoc signed, not sandboxed. Never touches the network:
  web requests blocked (content rules), no CDN fallback for imscJS (bundled), no URLSession; Web Inspector only
  in self-test builds; the self-test logs any connection (`network.txt`, lsof + nettop).
  Every build has a GitHub build attestation (actions/attest-build-provenance) for the zip and the web .html:
  `gh attestation verify Subtitle-QC-Player.zip --repo Smart-QC-Tools/subtitle-qc-player`.
- Commits end with the attribution lines the session provides. Don't push to main without being asked
  for things the user is still deciding.

## Code layout (web)
- `web/build.py` concatenates `web/src/*` into `web/dist/Subtitle_QC_Player.html`. Order: imsc_bundle, native,
  util, config, detector, match, tctrack, vtt, sidecar, qc, player, ui, analysis (video-analysis branch).
- `web/tools_make_player.py` generates `src/player.js` from `ref/player_v2.5.html` via `rep()` replacements and
  inserts `cueinfo.js + player_api.js + events.js + timeline.js` inside the player IIFE. Edit the reps there,
  never `player.js` directly. Run `python3 tools_make_player.py && python3 build.py`.
- Key files: `qc.js` (conform checks, language detection, encoding damage), `ui.js` (tabs, folders, conform
  table, file lists), `cueinfo.js` (per-cue flags, FILTERS), `events.js` (events table, filters bar, limits,
  subtitle info panel), `timeline.js` (waveform bar, ruler, index bar, layout/scaling), `native.js` (bridge),
  `sidecar.js` (SRT/SCC/WebVTT → TTML), `template.html` (all CSS + markup, Help modal).
- Scaling: design size 1640×840, min zoom 0.8; web uses CSS zoom on <html>, Mac uses pageZoom.
- Mac: `mac/Sources/*.swift` (MainView, Bridge, VideoController, Waveform, AppDelegate, SelfTest, …), `mac/build.sh`.

## Testing habits
- Test in headless Chromium with Playwright (`require('playwright')`, no install needed): load the built HTML,
  `delete window.showDirectoryPicker`, `setInputFiles('#vidDirInput' / '#subDirInput', folder)`, click
  `.tab[data-tab=player]`, screenshot and inspect. Check several window sizes (1366×768 … 2560×1440):
  picture must stay 16:9, no scrollbars. Make test media with ffmpeg; test subs are iTT/TTML/SCC.
- Mac behaviour can only be checked via the selftest workflow; say so when something is web-tested only.

## Design decisions (user preferences; keep consistent)
- Dark UI. Colours: red = rule broken, amber = worth a look, grey = Top; `--val #7fb0ff` for values
  (timecode, limits); controls blue `--ctl #4f86e8`; selection colour "soft steel" `#42607a`
  (selected video/subtitle row, selected filter button, Help nav). No violet. No colour dots in QC file lists.
- QC page = the only layout ("expanded"): file panel 270px left, player centre, events table right
  (base width = measured columns; Text column 280px). Extra width shared proportionally.
- Events table: row tints 35% (60% when selected); selected row = 1px grey frame `#6b7079` replacing the row
  lines; unflagged selected row fill rgba(255,255,255,.06). Selection follows the playhead (one selection).
  Duration as `2:13s` / `1:05:12m`. Columns centred except Text.
  Table follows the playhead: playing or ↑/↓ = paging (row within ~3 rows of the edge it heads for → jumps to
  a quarter in; `evReveal` in events.js); paused seek / scrub / typed TC = centre the row if out of view; hand
  scrolling pauses following for 4 s. Sorted by anything but In/Out: the table doesn't follow (↑/↓, clicks do).
  Filter/search hiding the event at the playhead: a 2px playhead-blue line between the listed rows it falls
  between (`evMarkPos`), steady through hidden events and gaps; the table pages to keep it in view. In a gap the event that last began is selected. A click on the bar
  leaves the playhead where clicked; a click on a row seeks to the event's first whole frame.
- Filter bar: buttons only for checks with hits, no dots; selected = soft steel fill, same size as unselected;
  count as a badge; "All issues" (red + amber, not placement/top) first with a divider; zero-hit checks on a
  "✓ Clean: …" line. Mixed align is amber. No "Critical" filter.
- Limits (Lines 2–4, CPS 3–40 default 25 amber only, CPL 10–60): plain blue values, drag or click-to-type.
  Saved limits carry `v: 2`; older saved ones keep CPL / lines but CPS restarts at 25.
- Duration (seconds, same at any frame rate; `DUR` in cueinfo.js): amber under 0.65 s or over 7 s, red under 0.45 s or
  over 10 s. No "very short with a long line" flag any more. Filter buttons count red + amber; Duration is red when
  any hit is red.
- Text column: subtitle lines don't wrap; a row whose longest line doesn't fit shrinks just enough (down to 80%);
  longer still: normal size, wrapped (`evFitText` in events.js).
- Speeds (J / L): 2× → 4× → 8× both ways.
- Offset field: first click selects; typing replaces (colons optional). Digits: 1-2 = ss, 3-4 = mm:ss (0130 = 1 min
  30 s), 5-6 = mm:ss:ff, 7-8 = hh:mm:ss:ff (user's rule; the playhead go-to box still counts from the right).
  Enter, Tab or clicking away applies and remembers it for the video; Esc cancels; a bad entry keeps the old value and
  shows a red message under the field for 6 s ("seconds go up to 59").
- Keys: ←/→ frame, Shift + ←/→ ±5 min (no ±5 s any more), Shift + ↑/↓ start / end of the video (⌥ + arrows: nothing),
  ↑/↓ previous / next event. "Past end" (red, its own filter): event still on screen after the video's last frame
  (QC page only; `requalify()` re-checks when the video's length or the offset changes).
- Waveform bar: background `#1b4560`, blue-grey top/bottom lines `#4f7393`, light smoothing, no scanlines,
  no colour coding of events. Zoom 10 s – 1.5 min (default 1 min); playing pages the view at 97%, playhead lands at 5%; Ctrl/⌘+scroll anywhere over the player
  column zooms; browser zoom blocked elsewhere on the QC page.
- Index bar under it: 18px, `#101216`, subtitle coverage blocks (2px min, gaps <3px closed), view box with
  22%/34% fill, no playhead, no times, hover readout (also over the view box; the cursor there is a grab hand).
- Subtitle info under the player: off by default, toggled by a text button "Show subtitle info" (top right;
  grey, blue on hover / when on); hidden until an event is selected; space stays the same.
- Conform page: Checks (errors/warnings or ✓ OK) + Notes column (info); File 520px, Type/Label/Detected 170/Checks
  fixed px, Notes (last) takes the spare width. No ▶ / "Open in player" buttons (the Conform / QC tabs switch stages), no review-status dropdown; "No label" in amber (CC: a grey dash: CC usually has no label and is checked as English, amber
  "Content looks X" only with enough text; .scc counts as CC); Detected shows % only when it
  matters; title shown large without a "Title" label; one language filter at a time (All default);
  section titles in the detail view all blue. No sticky headers. Type label "CC" (not CC/SDH).
- Help button orange-tinted. Help modal has a left nav (Keyboard, Waveform & timing, Subtitle checks,
  Conform page, About).
- The user's monitors are mostly 1920×1080 (1x), often not full screen.
- The user iterates on fine details; show mock-ups when asked before changing code, keep answers concrete.

## Video analysis (video-analysis branch, in progress)
- Its own window ("Analyse videos" in the header; Mac: later a separate window + Window menu), not a tab.
  Lists every video in the folder (ignores "Matched only"), checkboxes, per-type status columns
  (Blacks, Opening credits, On-screen text = later), Start/Stop, time left, skip analysed, keep Mac awake.
- Web version = preview with a simulated engine (`web/src/analysis.js`), results in localStorage;
  real fingerprints (size + SHA-256 of 3×64 KB pieces). Results format `subtitle-qc-analysis` v1, one file per
  video in `Subtitle QC Data/<video>.analysis.json` next to the videos (Mac app writes; web can read).
- Credits design (IDEAS.md): scan from 0 every ~4 s for credit-like static aligned text, read text only on hits,
  stop at "Directed by" (+1 min), limit 20 min, card in/out by bisection, compare with rendered subtitle box;
  raised-with-no-credits window 20 s; margins as future "Advanced" settings.
- Next steps: (1) use results on the QC page (credits band + black ticks on the index bar, credit checks in
  the events table, status in the video info box); (2) Mac: separate window, write results files, real engine
  (AVAssetReader + Vision), keep-awake.
- Other open question from earlier: make playback follow the audio channel menu for multi-mono files (unanswered).
