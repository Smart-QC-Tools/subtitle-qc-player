import re
src=open('ref/player_v2.5.html').read().split('\n')
js='\n'.join(src[387:1535])   # lines 388..1535
def rep(old,new,count=1):
    global js
    assert js.count(old)>=1, old[:60]
    js=js.replace(old,new,count)


# Leading/trailing spaces on a line (SCC column indents) are not counted as characters or shown.
rep("""        const lineTexts = lines.map(line => line.map(seg => seg.ruby ? `(${seg.text})` : seg.text).join(''));""",
    """        const lineTexts = lines.map(line => line.map(seg => seg.ruby ? `(${seg.text})` : seg.text).join('').trim());""")
rep("""          Array.from(line.filter(seg => !seg.ruby).map(seg => seg.text).join('')).length""",
    """          Array.from(line.filter(seg => !seg.ruby).map(seg => seg.text).join('').trim()).length""")
rep("""    const lens = lines.map(l => Array.from(l).length);""","""    const lens = lines.map(l => Array.from(l.trim()).length);""")

rep("""  const videoInput = document.getElementById('videoInput');
  const subInput = document.getElementById('subInput');
""","")
rep("""      banner.style.display = 'none';
    };""","""      banner.style.display = 'none';
      window.dispatchEvent(new Event('imsc-ready'));
    };""")
rep("""      showBanner(
        'Could not load the imscJS rendering library from a local copy or either CDN (unpkg.com / jsdelivr.net). ' +
        'For offline/air-gapped use, copy imsc.all.min.js and place it in ' +
        'the same folder as this HTML file. Otherwise this page needs internet access on first load — an ' +
        'ad-blocker or privacy extension may be blocking unpkg.com/jsdelivr.net, or Safari may be restricting ' +
        'network requests from local file:// pages (try Chrome or Firefox instead).',
        'error'
      );""","""      showBanner(
        'Full subtitle rendering (imscJS) could not be loaded, so the player is using basic rendering: ' +
        'subtitles are placed in their regions (top, bottom, sides), but without fonts, colours, italics, ruby or vertical text. ' +
        'For full rendering, put imsc.all.min.js in the same folder as this HTML file, or open the page with internet access.',
        'warn'
      );""")
rep("""    banner.style.background = kind === 'error' ? '#3a1f1f' : '#1f2e1f';""","""    if (kind === 'warn') { banner.style.background = '#2e2716'; banner.style.border = '1px solid #4d4020'; banner.style.color = '#e8c77a'; return; }
    banner.style.background = kind === 'error' ? '#3a1f1f' : '#1f2e1f';""")
rep("    const rateNote = ttmlDoc\n","    const rateNote = (ttmlDoc || cueList.length)\n")
rep("(function loadImscLibrary() {","(function loadImscLibrary() {\n  if (typeof window.imsc !== 'undefined') return; // bundled into this file")
rep("""    overlay.style.width = video.clientWidth + 'px';
    overlay.style.height = video.clientHeight + 'px';""","""    // 5% safe area on every side, so subtitles never sit on the edge of the picture.
    const SAFE = 0.05, w = video.clientWidth, h = video.clientHeight;
    overlay.style.left = Math.round(video.offsetLeft + w * SAFE) + 'px';
    overlay.style.top = Math.round(video.offsetTop + h * SAFE) + 'px';
    overlay.style.width = Math.round(w * (1 - 2 * SAFE)) + 'px';
    overlay.style.height = Math.round(h * (1 - 2 * SAFE)) + 'px';""")
rep("    cueListContainer.appendChild(frag);","    cueListContainer.appendChild(frag);\n    reapplyTlSel();")
rep("        video.currentTime = Math.max(0, video.currentTime - (e.shiftKey ? JUMP_STEP : FRAME_STEP));\n        forceRender();",
    "        if (e.shiftKey) { video.currentTime = Math.max(0, video.currentTime - JUMP_STEP); forceRender(); } else stepFrame(-1);")
rep("        video.currentTime = Math.min(video.duration || Infinity, video.currentTime + (e.shiftKey ? JUMP_STEP : FRAME_STEP));\n        forceRender();",
    "        if (e.shiftKey) { video.currentTime = Math.min(video.duration || Infinity, video.currentTime + JUMP_STEP); forceRender(); } else stepFrame(1);")
# side-effect-free parser: return rates on the result instead of setting globals
rep("""    docFrameRate = frameRate;
    docEffectiveFrameRate = effectiveFrameRate;""","""    const declaredFrameRate = getAttrByLocalName(root, 'frameRate');""")
rep("""    results.forEach(c => { c.showRegionTag = regionCount > 1; });

    return results;""","""    results.forEach(c => { c.showRegionTag = regionCount > 1; });

    results.frameRate = frameRate;
    results.effectiveFrameRate = effectiveFrameRate;
    results.declaredFrameRate = declaredFrameRate;
    return results;""")
rep("""      raw = parseRawCueList(xmlStr);""","""      raw = parseRawCueList(xmlStr);
      if (raw) { docFrameRate = raw.frameRate; docEffectiveFrameRate = raw.effectiveFrameRate; }""")
# buildCueList must work without imscJS (fallback renderer)
rep("""    if (!ttmlDoc) { renderSidebarList(); return; }""","""    if (!ttmlDoc && !fallbackMode) { renderSidebarList(); return; }""")
rep("""    } else {
      cueList = buildCueListFromISD();""","""    } else if (ttmlDoc) {
      cueList = buildCueListFromISD();""")
# rendering: fallback when the imscJS library is not available
rep("""    if (!ttmlDoc || !video || !overlay) return;""","""    if (!video || !overlay) return;
    if (!ttmlDoc) { if (fallbackMode && cueList.length) renderFallback(); return; }""")
# keyboard only when the player tab is visible
rep("""    if (!video) return;
    const tag = (e.target && e.target.tagName) || '';""","""    if (!video) return;
    if (document.body.dataset.tab !== 'player') return;
    const tag = (e.target && e.target.tagName) || '';""")
# replace the two file-input listeners with an API
start=js.index("  videoInput.addEventListener('change', () => {")
end=js.index("  // --- Keyboard shortcuts")
js=js[:start]+open('src/cueinfo.js').read()+'\n'+open('src/player_api.js').read()+'\n'+open('src/events.js').read()+'\n'+open('src/timeline.js').read()+'\n'+js[end:]
# export shared checks for the QC tab
js=js.rstrip()
assert js.endswith('})();')
js=js[:-5]+"""
  window.CueCheck = {
    parse: parseRawCueList, finalizeDurationFlags, finalizeCharFlags, finalizeQcFlags, setLimits,
    get CHAR_LIMIT() { return CHAR_LIMIT; }, get CPS_LIMIT() { return CPS_LIMIT; },
    LINE_COUNT_THRESHOLD, SHORT_DURATION_SECONDS, SHORT_DURATION_CRITICAL_CHARS, MAX_DURATION_SECONDS
  };
})();
"""

# Drop-frame start timecodes (29.97/59.94 DF): convert the label to a real frame count.
rep("""    const frameCount = ((h * 3600 + m * 60 + s) * nominal) + f;""","""    let frameCount = ((h * 3600 + m * 60 + s) * nominal) + f;
    if (window.__videoDropFrame && (nominal === 30 || nominal === 60)) {
      const d = nominal === 30 ? 2 : 4, mins = h * 60 + m;
      frameCount -= d * (mins - Math.floor(mins / 10));
    }""")
# Draw subtitles smaller (see scaleRendered in player_api.js).
rep("""            false                 // enableRollUp
          );""","""            false                 // enableRollUp
          );
          scaleRendered(overlay);""")
# In the Mac app the <video> is a stand-in element; AVFoundation draws the picture underneath it.
rep("""    video = document.createElement('video');""","""    video = NATIVE ? Native.createVideo() : document.createElement('video');""")
# Event list times count from the first frame of the video (like the playhead timecode).
rep("""  function formatRange(begin, end) {
    const b = formatTimestamp(begin);
    return isFinite(end) ? `${b}-${formatTimestamp(end)}` : `${b}-…`;
  }""","""  // Same frame numbering and timecode (incl. drop-frame) as the playhead display.
  function formatVideoTC(t) { const v = t - effectiveOffset(); return (v < -1e-6 ? '-' : '') + timecodeAt(Math.round(Math.abs(v) * fps())); }
  function formatRange(begin, end) {
    const b = formatVideoTC(begin);
    return isFinite(end) ? `${b} - ${formatVideoTC(end)}` : `${b} - …`;
  }""")


# ---- per-event QC info (cueinfo.js): CPS, placement, issue tags, limits
rep("""  const CHAR_LIMIT = 42;""", """  let CHAR_LIMIT = 42;""")
rep("""        results.push({
          begin, end,
          region: region || '(default)',""", """        results.push({
          begin, end,
          chars: perLineLen.reduce((a, b) => a + b, 0),
          placement: placementOf(el, region, root, resolveStyleAttr, lines.length),
          region: region || '(default)',""")
rep("""  function renderSidebarList() {
    cueListContainer.innerHTML = '';""", """  function renderSidebarList() {
    if (cueList.length && cueList[0].duration !== undefined) finalizeQcFlags(cueList);   // also follows the video's frame rate (gap check)
    cueListContainer.innerHTML = '';""")
rep("""      row.className = 'cue-item' + (cue.overlap ? ' overlap' : '');""", """      row.className = 'cue-item' + (cueKind(cue) ? ' has-' + cueKind(cue) : '');""")
a = js.index("      if (cue.showRegionTag) {")
b = js.index("      const textEl = document.createElement('span');\n      textEl.className = 'cue-text';")
js = js[:a] + "      appendCueTags(timeEl, cue);\n\n" + js[b:]
# filter chips: hide the ones with nothing to show (except All / Issues / the active one)
rep("""      btn.addEventListener('click', () => {
        currentFilter = f.key;""", """      btn.addEventListener('click', () => {
        currentFilter = currentFilter === f.key ? 'all' : f.key;   // click the active filter again to show everything""")
rep("""    FILTERS.forEach(f => {
      const count = f.key === 'all'""", """    FILTERS.forEach(f => {
      if (f.key === 'all') return;   // no chip: "all" is simply no filter selected
      const count = f.key === 'all'""")
rep("""      btn.className = 'filter-chip' + (f.key === currentFilter ? ' active' : '') + (f.cls ? ' ' + f.cls : '');""",
    """      btn.className = 'filter-chip' + (f.key === currentFilter ? ' active' : '') + (f.cls ? ' ' + f.cls : '') + (count || f.key === 'all' ? '' : ' empty');
      if (f.title) btn.title = f.title;""")


# ---- Events tab hooks (events.js): the table follows the event list's filter, selection and playhead
rep("""    filterEmptyMsg.style.display = (visibleCount === 0 && cueList.length > 0) ? 'block' : 'none';
  }""", """    filterEmptyMsg.style.display = (visibleCount === 0 && cueList.length > 0) ? 'block' : 'none';
    evApplyFilter();
  }""")
rep("""    cueListContainer.appendChild(frag);
    reapplyTlSel();
    applyFilterVisibility();
  }""", """    cueListContainer.appendChild(frag);
    reapplyTlSel();
    applyFilterVisibility();
    evMarkDirty();
  }""")
rep("""    const row = cueListContainer.children[tlSelected];
    if (row) row.classList.add('tl-sel');
    return row;""", """    const row = cueListContainer.children[tlSelected];
    if (row) row.classList.add('tl-sel');
    evSyncSel();
    return row;""")
rep("""    if (firstEl) firstEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }""", """    if (firstEl && !expanded) firstEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    evSyncActive();
  }""")

rep("""      filterEmptyMsg.style.display = 'none';
      return;
    }
    sidebarEmpty.style.display = 'none';""", """      filterEmptyMsg.style.display = 'none';
      evMarkDirty();
      return;
    }
    sidebarEmpty.style.display = 'none';""")

open('src/player.js','w').write(js)
print('ok', len(js))
