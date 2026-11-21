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
- `main`: stable line (1.0.x). `APP_VERSION` in `web/src/config.js` (1.0.0 on main / release, 1.1.0 on video-analysis).
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
  30 s), 5-6 = mm:ss:ff, 7-8 = hh:mm:ss:ff (user's rule, `parseTypedTC`; the playhead go-to box
  too: there, hours not typed = the hour the playhead is in).
  Enter, Tab or clicking away applies and remembers it for the video; Esc cancels. Bad entry + Enter: stays in the field in red,
  selected (type over it), with "Invalid value" just above it (`fieldTip`, `.field-tip`); Tab / clicking away with a bad
  entry: the old value comes back at once, no note. The playhead timecode (go-to box) behaves the same way.
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
- Mac app: its own window, **Window ▸ Video Analysis** (⇧⌘A; `AnalysisWindow` in `mac/Sources/Analysis.swift`): a second
  WKWebView with the same page in "window" mode (`window.__analysisWindow`, `html.ana-window`: only the panel).
  No header button in the app. Own folder (starts as the QC videos folder; Change… / drop a folder;
  setting `ana:folder`). Lists every video, checkboxes, per-type status columns, Start/Stop, time left, skip
  analysed, keep Mac awake (real: `analysisBusy`), short clips (<60 s) unticked. Closing mid-run asks first.
  A click on an analysed row lists the blacks. Web version: the same panel as a modal from the header button.
- Engines: **blacks are real in the Mac app** (`AnalysisJob.runBlacks`): every frame decoded once
  (AVAssetReader), black = 98% of sampled luma ≤ 10% (same as ffmpeg blackdetect, so the darkest frames of
  a fade count too), runs ≥ 0.25 s, frame-exact; sound RMS over the middle half of each black, ≤ −60 dBFS =
  silent. Items: in, out, frames, audio (silent | sound | none), level, kind (start | end | commercial |
  other = black with sound inside a scene). `SETTINGS.blacks.v` = 2.
  **Opening credits are real in the Mac app** (`mac/Sources/AnalysisCredits.swift`, `SETTINGS.credits.v` = 2):
  Vision fast text read every 1 s from 0 (AVAssetImageGenerator 1280×720), each frame read twice (as is +
  a "white text" version: dark where min(R,G,B) is high, for white credits on pale scenes); lines grouped
  into blocks; a block followed across frames (same place + similar letters) = a card; one missed frame
  forgiven; fragments joined; text staying > 20 s dropped (logos, BITC); "rr"-like noise dropped (needs a
  3+ letter word with a vowel). Stops 60 s after "Directed by" (other languages too) or at 20 min. Each card
  read with Vision accurate on an enlarged crop; kind = credit (role vocabulary, or names within 30 s of
  credits) | title (centred, tall) | text (captions: time words, digits). In/out by frame bisection.
  Cards < 0.5 s and pieces of a longer card (same place, same time) dropped. Runs = credits ≤ 30 s apart.
  Known: short role words ("With", "And") over very bright scenes can be missed (the name is read).
  Speed: CI Mac ~100 s per file for 3.5 min scanned; the user's Mac, 1080p H.264 test episode: blacks ~18 s,
  credits ~24 s. The user renamed that episode T1104 (their older T1103 is kept). On-screen text: later.
- Web version = preview with a simulated engine (`web/src/analysis.js`), results in localStorage, marked
  `simulated`. The Mac app never simulates and ignores localStorage.
- Results: format `subtitle-qc-analysis` v1, one file per video,
  `Subtitle QC Data/<video file name incl. extension>.analysis.json` next to the videos (Mac app writes via
  `analysisWrite`; the other window hears `analysisFile`; main window reads the folder's files on load; web
  can read them). Fingerprint = size + SHA-256 of 3×64 KB pieces.
- Testing: `selftest.yml` with input `only: basic` (one video's playback tests + network log; the quick check)
  or `only: analysis` (about 15 min, mostly queue + build) makes a test episode
  (`mac/selftest/make_analysis_media.py`: 3 commercial blacks, 2 blacks with sound, dark scene, credits,
  captions; H.264 and ProRes; Homebrew ffmpeg has no drawtext, so the cards come from
  `mac/selftest/cards/1280x720/*.png`, made with `--render-cards`), checks both engines against it, opens the real window, presses Start and
  collects its results files and screenshots on the `selftest-results` branch. The user has the 1080p
  version as "Harbor Lights T1103" (+ ENG .itt with events on / off the credits and blacks, + answer sheet).
- Credits design (IDEAS.md): scan from 0 every ~4 s for credit-like static aligned text, read text only on hits,
  stop at "Directed by" (+1 min), limit 20 min, card in/out by bisection, compare with rendered subtitle box;
  raised-with-no-credits window 20 s; margins as future "Advanced" settings.
- QC page: credits = soft yellow `#f2d675` solid 3 px line, along the top of the waveform bar and the bottom
  of the index bar (credits < 20 s apart joined, `Analysis.marks`); commercial blacks = red full height on both
  (index `#ff5c5c`, min 3 px; waveform see-through .78). Hover label on the index adds "Credits 0:50 – 2:31" /
  "Commercial black". Help explains the colours. `Player.setAnalysisMarks(Analysis.marks(r))` from ui.js
  renderLibrary (only for the video in the player; carries cards with boxes, blacks, scannedTo), re-checks events.
  Checks (cueinfo.js `analysisChecks`, only with analysis results): red "On credit/title/text" (estimated
  subtitle box, `subBox`, overlaps a card's box while both are on screen, ±0.2 s), red "Over black" (runs across
  a commercial black), amber "Near credits" (< 5% of picture height apart), amber "Raised, no credit"
  (raised or top, no credit/title within 20 s and no on-screen text at the time, inside the scanned range).
  Subtitle box estimate: region + lines × (100/rows × 1.25)% high, longest line × 0.5 cell × 9/16 wide.
  Blacks engine v3: silence = RMS ≤ −50 dBFS (a low noise floor counts); blacks with sound are dropped.
- Results folder stays visible ("Subtitle QC Data" next to the videos): sharing results is crucial to the user
  (not hidden, not in Application Support).
- **Built 2026-11-21 (1.1.0 / video-analysis):**
  - Start screen (`#home`, `Home` in analysis.js): QC / Conform or Video Analysis; Home button in the QC header
    (`#homeBtn`) and the analysis page (`#anaHome`). Web: Video Analysis is a full page (`html.ana-page`), keeps running
    while you QC (`#anaBtn` in the QC header = "Analysing 2 of 5…"). Mac: the button opens the analysis window; its Home
    posts `showHome` (main window to front, start screen). Self-test skips it (`window.__selftest`, `Home.hide()`).
  - Markers: `VideoMarkers/<video name>.markers.json`, format `video-markers` v1 (old Subtitle QC Data dropped: nothing
    to keep). Place: beside the topmost delivery folder (Encodes/_Encodes/QC_PASS/QC_FAIL, `DELIVERY`), else in the
    video's folder (`markersPlace` web handles / `markersPathFor` Mac paths). Web analysis takes any folder and lists
    videos 3 levels down (pick Digital or the season); a delivery folder chosen itself → notice "choose the folder above".
    QC page: by name, else by `Match.episodeKey` with length ±1 s ("from <proxy>"); web looks in the videos folder's
    VideoMarkers, the analysed folders remembered in IndexedDB (`markerRoots`, `resolve()`), links (`markerLinks`);
    Mac: Swift `markersRead {dirs, around}` (own + parent / grandparent and their subfolders), `markersWrite {dir}`,
    `Access.isMarkersAllowed` (VideoMarkers up to 3 levels above a chosen folder). Link markers folder… / Allow buttons.
  - Web engine: on-screen text only (`textdetect.js` wraps `web/labs/lab-video.js` + `web/labs/text-engine.js`, the
    lab's `findText` and `TEXT_RULES`: lab and app share the rules); blacks / credits are Mac-only (no simulation any
    more). Built with `TEXT_MODEL=1 python3 build.py` (needs `web/labs/fetch_assets.sh`; ~37 MB page); the Mac app's page
    is built without it (~0.7 MB). build.yml builds the web download with the model after the app.
  - QC checks with text markers: `m.allText` → filters "On text" / "Near text", any text counts for "Raised, no credit".
  - Headless testing: OPFS folders (http://localhost) + `Analysis._useFolder`; headless Chromium crashes storing OPFS
    handles in IndexedDB, so tests stub HandleStore (real Chrome is fine with picked folders).
- Version: this branch is 1.1.0 (`APP_VERSION`); main / release stay 1.0.0 until it's merged.
- Web text detection lab (`web/labs/text-detection.src.html`, download page `docs/labs.html`): find all on-screen text
  without reading it over the whole episode (a frame every 2 s, in/out by bisection). Findings: image checks (edges)
  rejected (6× extra hits on real footage); PP-OCRv4 det model on WebGPU ≈ 33 ms/frame, a 45-min episode ≈ 2–5 min.
  User decisions: all text matters (lower thirds, burnt-in subs), except small text, text moving with the camera
  (screens, maps, signs) and large centred main titles (line box ≥ 8%, centred), which are left out (listed separately).
  Status (2026-11-20, user testing at work): lab build 11. Rules: small = line box < 3%; moving = drifts > 1%
  (whole sightings only, extremes ignored); title = line box ≥ 8% in the middle both ways, or ≥ 14% anywhere.
  scene = part of the shot: the picture cuts (32×18 luma change outside the box ≥ 20) both at its in and its out, and it
  stays out of the bottom quarter (a full-screen news insert at the bottom is kept: the user wants it flagged).
  Scene exception needs the box ≥ 30% wide too (a POLICE badge on a vest is not kept). Build 9 adds: faint = contrast
  < 140 or sharpness < 30% (LAO credits/captions: 233–255 / 45–51%; scene text lower); end credits = walking back from the
  end, credit-like pieces (2+ lines over black, outside-box luma < 30) join while pauses stay ≤ 8 s; the first piece
  that isn't credit-like stops it ("To be continued…" just before the credits is common and may be subtitled: kept);
  anything after the run's start goes too (end logos); ≥ 3 credit-like pieces, last 5 min, videos ≥ 10 min. When
  unsure, nothing is left out (user: end credits staying in is acceptable). Contrast / sharpness and the thumbnail are
  taken on a frame where the text was seen (the middle of a merged piece can fall between two cards).
  On LAO-21-M2701 (Law & Order SVU) all 28 end-of-opening credits kept; animated title-sequence names left out as
  moving; back-to-back cards in one spot merge into one piece. Proposed next (not yet agreed): use this engine for a
  real "on-screen text" analysis in the web preview's analysis panel (results file → QC page checks). Mac app: later
  (user can't install new versions right away); idea: same model via Core ML instead of Vision text reading.
- Other open question from earlier: make playback follow the audio channel menu for multi-mono files (unanswered).
