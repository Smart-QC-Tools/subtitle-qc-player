  // ---- Integration API (replaces the single-file inputs of v2.5) -------------
  let fallbackMode = false;   // true when imscJS is unavailable: draw plain text ourselves
  let fallbackKey = null;
  let currentSub = null;      // { name, text }
  let currentVideoName = null;
  let loadGen = 0;
  let currentVideoFile = null;

  // ---- Basic renderer used when imscJS is unavailable: honours region position,
  // size, displayAlign and textAlign, but not fonts/colours/ruby/vertical text.
  let fallbackRegions = {};
  function parseLen(v, total) {
    const m = String(v).trim().match(/^(-?[\d.]+)(%|px|c)?$/);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (m[2] === '%' || !m[2]) return n;
    if (m[2] === 'px') return total ? (100 * n / total) : null;
    return null;
  }
  function parseRegions(xmlStr) {
    const out = {};
    try {
      const doc = new DOMParser().parseFromString(xmlStr, 'application/xml');
      const root = doc.documentElement;
      const ext = (getAttrByLocalName(root, 'extent') || '').trim().split(/\s+/);
      const rootW = ext.length === 2 ? parseFloat(ext[0]) : 1920, rootH = ext.length === 2 ? parseFloat(ext[1]) : 1080;
      const cell = (getAttrByLocalName(root, 'cellResolution') || '32 15').trim().split(/\s+/).map(Number);
      const styles = {};
      for (const el of doc.getElementsByTagNameNS('*', 'style')) { const id = getAttrByLocalName(el, 'id'); if (id) styles[id] = el; }
      const styleAttr = (el, name, seen = new Set()) => {
        const d = getAttrByLocalName(el, name);
        if (d !== null && d !== undefined) return d;
        for (const c of el.children) if (c.localName === 'style') { const v = getAttrByLocalName(c, name); if (v) return v; }
        const ref = getAttrByLocalName(el, 'style');
        if (ref) for (const id of ref.trim().split(/\s+/)) { if (seen.has(id) || !styles[id]) continue; seen.add(id); const v = styleAttr(styles[id], name, seen); if (v) return v; }
        return null;
      };
      const pair = (v, isExtent) => {
        if (!v) return null;
        const p = v.trim().split(/\s+/);
        if (p.length !== 2) return null;
        const conv = (x, total, cells) => /c$/.test(x) ? 100 * parseFloat(x) / cells : parseLen(x, total);
        const a = conv(p[0], rootW, cell[0] || 32), b = conv(p[1], rootH, cell[1] || 15);
        return a == null || b == null ? null : [a, b];
      };
      for (const r of doc.getElementsByTagNameNS('*', 'region')) {
        const id = getAttrByLocalName(r, 'id');
        if (!id) continue;
        out[id] = {
          origin: pair(styleAttr(r, 'origin')) || [0, 0],
          extent: pair(styleAttr(r, 'extent')) || [100, 100],
          displayAlign: styleAttr(r, 'displayAlign') || 'before',
          textAlign: styleAttr(r, 'textAlign') || 'center',
        };
      }
    } catch (e) { console.warn('Region parse failed', e); }
    return out;
  }
  function renderFallback() {
    const t = video.currentTime + effectiveOffset();
    const active = cueList.filter(c => t >= c.begin && t < c.end);
    const key = active.map(c => c.begin + ':' + c.end).join(',') + '|' + overlay.clientHeight;
    if (key !== fallbackKey) {
      fallbackKey = key;
      overlay.innerHTML = '';
      const byRegion = new Map();
      active.forEach(c => { const k = fallbackRegions[c.region] ? c.region : '(default)'; if (!byRegion.has(k)) byRegion.set(k, []); byRegion.get(k).push(c); });
      const fontPx = Math.max(10, Math.round(overlay.clientHeight * 0.05 * SUB_SCALE));
      for (const [rid, cues] of byRegion) {
        const r = fallbackRegions[rid];
        const box = document.createElement('div');
        box.className = 'fallback-region';
        if (r) {
          Object.assign(box.style, { left: r.origin[0] + '%', top: r.origin[1] + '%', width: r.extent[0] + '%', height: r.extent[1] + '%',
            justifyContent: r.displayAlign === 'after' ? 'flex-end' : r.displayAlign === 'center' ? 'center' : 'flex-start',
            alignItems: /^(left|start)$/.test(r.textAlign) ? 'flex-start' : /^(right|end)$/.test(r.textAlign) ? 'flex-end' : 'center',
            textAlign: /^(left|start)$/.test(r.textAlign) ? 'left' : /^(right|end)$/.test(r.textAlign) ? 'right' : 'center' });
        } else Object.assign(box.style, { left: '5%', top: '5%', width: '90%', height: '85%', justifyContent: 'flex-end', alignItems: 'center', textAlign: 'center' });
        box.style.fontSize = fontPx + 'px';
        cues.forEach(c => { const line = document.createElement('div'); line.className = 'fallback-line'; line.textContent = c.text; box.appendChild(line); });
        overlay.appendChild(box);
      }
    }
    updateActiveSidebarRow(t);
  }

  // Subtitles are drawn at 75% of the size the file asks for.
  const SUB_SCALE = 0.75;
  function scaleRendered(root) {
    for (const el of root.querySelectorAll('*')) {
      const st = el.style;
      for (const prop of ['fontSize', 'lineHeight']) {
        const m = /^([\d.]+)px$/.exec(st[prop] || '');
        if (m) st[prop] = (parseFloat(m[1]) * SUB_SCALE) + 'px';
      }
    }
  }

  let offsetNote = '';
  function applyOffsetFromField(note) {
    offsetNote = note || '';
    offsetInput.dispatchEvent(new Event('change'));
    if (note && !offsetStatus.classList.contains('err')) offsetStatus.textContent = offsetStatus.textContent + ' — ' + note + '.';
  }

  // Remember a manually entered offset for the current video.
  offsetInput.addEventListener('change', (e) => {
    const user = e.isTrusted || e.userEdit;
    if (user) { offsetNote = 'remembered for this video'; baseOffset = { tc: offsetInput.value.trim(), note: offsetNote }; }
    if (user && currentVideoName && parseOffset(offsetInput.value) !== null) Store.set('offset:' + currentVideoName, offsetInput.value.trim());
    if (cueList.length) setTimeout(() => { requalify(); }, 0);   // event times (and Past end) depend on the offset
  });
  offsetFlip.addEventListener('click', () => {
    baseOffset = { tc: offsetInput.value.trim(), note: 'remembered for this video' };
    if (currentVideoName) Store.set('offset:' + currentVideoName, offsetInput.value.trim());
  });

  let stageMsg = null, stageMsgKind = '';
  function showStageMsg(html, kind = 'video') {
    if (!stageMsg) { stageMsg = document.createElement('div'); stageMsg.className = 'stage-msg'; stage.appendChild(stageMsg); }
    stageMsg.innerHTML = html; stageMsg.hidden = !html; stageMsgKind = html ? kind : '';
  }
  async function checkPicture(file, codec) {
    if (!video || currentVideoName !== file.name) return;
    if ((video.error || video.videoWidth === 0) && !(await fileReadable(file))) { showStageMsg(MOVED_MSG(file.name)); return; }
    video.classList.toggle('nopic', video.videoWidth === 0 || !!video.error);
    if (video.videoWidth === 0 || video.error) {
      const c = codec ? codec.name : 'unknown codec';
      if (NATIVE) {
        const why = video.error && video.error.message ? ' ' + esc(video.error.message) : '';
        showStageMsg(`<b>This video can't be played</b> (${c}).${why}` + (codec && /DNx|MPEG-2|XDCAM/.test(codec.name) ? ' Installing Apple\'s free “Pro Video Formats” may add support for it.' : ''));
        return;
      }
      showStageMsg(`<b>Chrome can't display the picture in this file</b> (${c}), so you only get audio. ` +
        (codec && /ProRes|DNx/.test(codec.name) ? 'Safari on a Mac can usually play ProRes — open this page in Safari, or use an H.264/HEVC copy.' : 'Try an H.264 or HEVC copy of this video, or open this page in Safari.'));
    } else showStageMsg('');
  }
  // A File from a folder that was moved, renamed or deleted in Finder can no longer be read.
  async function fileReadable(file) { try { await file.slice(0, 1).arrayBuffer(); return true; } catch (e) { return false; } }
  // Rescan is only offered when the browser kept access to the folder; otherwise the folder must be chosen again.
  const MOVED_MSG = (name) => `<b>Can't read “${esc(name)}”.</b> It may have been moved, renamed or deleted. ` +
    (document.getElementById('rescan') && !document.getElementById('rescan').hidden ? 'Click ↻ Rescan to refresh the list.' : 'Choose the folder again to refresh the list.');

  async function loadVideoFile(file, codec, probe) {
    ensureVideoElement();
    bindTransport();
    setSpeed(0);
    currentVideoFile = file;
    if (!(await fileReadable(file))) {
      if (video.src && video.src.startsWith('blob:')) URL.revokeObjectURL(video.src);
      video.removeAttribute('src'); video.load();
      currentVideoName = file.name; ++loadGen;
      showStageMsg(MOVED_MSG(file.name));
      return;
    }
    vmeta.fps = (probe && probe.fps) || 0;
    syncVttRates();
    vmeta.duration = (probe && probe.duration) || 0;
    fpsOverride = 0;
    setStartTimecode(null);
    showStageMsg('');
    // Switching files can make Chrome report a one-off decode error (or no picture yet) that a
    // page refresh would clear. Retry the load quietly before warning, ignore events from an
    // earlier load, and only release the previous file's URL once the new one is in place.
    const gen = ++loadGen;
    const oldUrl = video.src && video.src.startsWith('blob:') ? video.src : null;
    let url = null, tries = 0;
    const attach = () => { url = NATIVE ? file.path : URL.createObjectURL(file); video.src = url; video.load(); };
    const verdict = () => {
      if (gen !== loadGen) return;
      const bad = !!video.error || video.videoWidth === 0;
      if (bad && tries < 2 && !NATIVE && !(codec && codec.chrome === false)) {
        tries++;
        const prev = url;
        setTimeout(() => { if (gen !== loadGen) return; attach(); if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev); }, 200 * tries);
        return;
      }
      checkPicture(file, codec);
    };
    video.onloadedmetadata = () => { if (gen !== loadGen) return; if (video.videoWidth === 0) setTimeout(verdict, 400); else verdict(); };
    video.onerror = verdict;
    currentVideoName = file.name;
    attach();
    if (oldUrl && oldUrl.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(oldUrl), 3000);
    setStatus(videoStatus, `Loaded: ${file.name}`, 'ok');
    tlSelected = -1;
    startWaveform(file);
    const saved = Store.get('offset:' + file.name);
    let tc = null;
    try { tc = await TimecodeTrack.read(file); } catch (e) { console.warn('Timecode read failed', e); }
    if (currentVideoName !== file.name) return;
    setStartTimecode(tc);
    if (saved) { setBase(saved, 'remembered for this video'); guessOffset(); return; }
    if (tc) setBase(tc.tc, `read from the video's timecode track (${tc.fps} fps${tc.dropFrame ? ', drop-frame' : ''})`);
    else setBase('00:00:00:00', 'no timecode track in this video');
    guessOffset();
  }

  // Sanity check for the offset, run whenever the video or subtitle changes. Subtitle files are
  // usually timed from a whole hour (01:00:00:00, 10:00:00:00). If, with the current offset, fewer
  // than half of the cues fall inside the video (no timecode track, a track that starts at 00:00,
  // or an old remembered value), but starting the video at the hour of the first cue fits them,
  // use that hour instead.
  // The video's own start value (typed/remembered, timecode track, or 00:00:00:00) and where it came from.
  // The check always starts from this, so a correction made while the previous episode's subtitles were
  // still loaded never sticks.
  let baseOffset = { tc: '00:00:00:00', note: '' };
  function setBase(tc, note) { baseOffset = { tc, note }; offsetInput.value = tc; applyOffsetFromField(note); }
  function guessOffset() {
    if (!video || !cueList.length) return;
    const dur = (isFinite(video.duration) && video.duration > 0) ? video.duration : (vmeta.duration || 0);
    const begins = cueList.map(c => c.begin).filter(isFinite);
    if (!dur || !begins.length) return;
    const fit = (off) => off === null ? 0 : begins.filter(t => t - off >= -0.5 && t - off <= dur + 0.5).length / begins.length;
    let tc = baseOffset.tc, note = baseOffset.note;
    if (fit(parseOffset(tc)) < 0.5) {
      const H = Math.floor(Math.min(...begins) / 3600 + 1e-6);
      const hourTc = String(H).padStart(2, '0') + ':00:00:00';
      if (hourTc !== tc && fit(parseOffset(hourTc)) >= 0.8) { note = `adjusted to the subtitle timing (${tc} didn't line up with the subtitles)`; tc = hourTc; }
    }
    if (offsetInput.value === tc && offsetNote === note) return;
    offsetInput.value = tc;
    applyOffsetFromField(note);
    if (typeof renderSidebarList === 'function') renderSidebarList();
  }

  function getXmlLangTagSafe(xmlStr) { try { return getXmlLangTag(xmlStr); } catch (e) { return null; } }

  // ttp:timeBase="smpte" (Apple iTT): begin/end are timecode LABELS, not elapsed time. Convert them
  // to media seconds with the same frame-count math as the offset field, so a cue at 01:00:12:00
  // shows when the picture's timecode reads 01:00:12:00 (matters at 23.976/29.97 with an hour start).
  function smpteToMedia(xmlStr) {
    const root = (xmlStr.match(/<(?:\w+:)?tt\b[^>]*>/) || [''])[0];
    const attr = n => { const m = root.match(new RegExp('(?:\\w+:)?' + n + '\\s*=\\s*["\']([^"\']*)["\']')); return m ? m[1].trim() : null; };
    if (attr('timeBase') !== 'smpte') return xmlStr;
    const nominal = Number(attr('frameRate')) || 30;
    const mul = (attr('frameRateMultiplier') || '1 1').split(/\s+/).map(Number);
    const effective = nominal * ((mul[0] || 1) / (mul[1] || 1));
    const drop = /^drop/.test(attr('dropMode') || '') && Math.round(effective) !== effective ? (nominal === 60 ? 4 : 2) : 0;
    const conv = (v) => {
      const m = v.trim().match(/^(\d+):(\d{2}):(\d{2})[:;](\d{2,})(?:\.(\d+))?$/);
      if (!m) return v;
      const [h, mi, se, f] = [m[1], m[2], m[3], m[4]].map(Number);
      const totalMin = h * 60 + mi;
      const frames = (h * 3600 + mi * 60 + se) * nominal + f + (m[5] ? Number('0.' + m[5]) : 0) - drop * (totalMin - Math.floor(totalMin / 10));
      return (frames / effective).toFixed(6) + 's';
    };
    return xmlStr
      .replace(/(\s(?:begin|end)\s*=\s*)(["'])([^"']*)\2/g, (all, pre, q, v) => pre + q + conv(v) + q)
      .replace(/(timeBase\s*=\s*["'])smpte(["'])/, '$1media$2');
  }

  // Apple iTT puts a default region on <body>/<div> and overrides it on individual <p> (e.g.
  // body region="bottom", p region="top"). Strict TTML region selection drops those lines
  // entirely, so give each element its nearest region and remove the conflicting defaults.
  function nearestRegions(xmlStr) {
    try {
      if (!/\bregion\s*=/.test(xmlStr)) return xmlStr;
      const doc = new DOMParser().parseFromString(xmlStr, 'application/xml');
      if (doc.getElementsByTagName('parsererror').length) return xmlStr;
      const body = [...doc.getElementsByTagNameNS('*', 'body')][0];
      if (!body) return xmlStr;
      const all = [body, ...body.getElementsByTagNameNS('*', '*')];
      const conflict = all.some(el => {
        const r = el.getAttribute('region'); if (!r) return false;
        for (let a = el.parentElement; a && a !== doc.documentElement; a = a.parentElement) { const ar = a.getAttribute('region'); if (ar) return ar !== r; }
        return false;
      });
      if (!conflict) return xmlStr;
      const eff = el => { for (let a = el; a && a !== doc.documentElement; a = a.parentElement) { const r = a.getAttribute('region'); if (r) return r; } return null; };
      const ps = [...body.getElementsByTagNameNS('*', 'p')];
      const pr = ps.map(eff);
      all.forEach(el => { if (el.localName !== 'p' && el.localName !== 'span') el.removeAttribute('region'); });
      ps.forEach((p, i) => { if (pr[i]) p.setAttribute('region', pr[i]); });
      return new XMLSerializer().serializeToString(doc);
    } catch (e) { console.warn('Region normalisation skipped', e); return xmlStr; }
  }

  let subIsVtt = false, subFormat = '';
  // WebVTT and SRT times are plain clock times with no frame rate: timecodes use the video's frame rate.
  function syncVttRates() {
    if (!subIsVtt) return;
    const f = vmeta.fps || 0;
    if (f) { docFrameRate = Math.round(f); docEffectiveFrameRate = f; }
  }
  function loadSubtitle(xmlStr, name) {
    setSpeed(0);
    // a new subtitle keeps the playhead where it is, but stops playback
    const side = Sidecar.convert(xmlStr, name);   // WebVTT / SRT / SCC -> TTML
    subFormat = side ? side.format : '';
    subIsVtt = !!side && !side.hasFps;
    if (side) xmlStr = side.ttml;
    if (stageMsgKind === 'sub') showStageMsg('');
    xmlStr = nearestRegions(smpteToMedia(xmlStr));
    currentSub = { name, text: xmlStr };
    tlSelected = -1; tlDirty = true;
    lastRenderedIndex = -2; fallbackKey = null;
    if (overlay) overlay.innerHTML = '';
    ttmlDoc = null; timeEvents = []; fallbackMode = false;
    fallbackRegions = parseRegions(xmlStr);
    if (typeof window.imsc !== 'undefined') {
      try {
        ttmlDoc = imsc.fromXML(xmlStr, function (err) { console.warn('imscJS parse warning:', err); });
        timeEvents = ttmlDoc.getMediaTimeEvents() || [];
      } catch (e) { console.warn('imscJS could not parse; using basic rendering', e); ttmlDoc = null; fallbackMode = true; }
    } else fallbackMode = true;
    setStatus(subStatus, 'Parsing…');
    try {
      buildCueList(xmlStr);
    } catch (e) {
      console.error(e); cueList = []; renderSidebarList();
      setStatus(subStatus, 'Failed to parse: ' + e.message, 'err');
      return;
    }
    if (!cueList.length) {
      setStatus(subStatus, `No subtitle events found in ${name}.`, 'err');
      return;
    }
    syncVttRates();
    const langTag = getXmlLangTagSafe(xmlStr);
    const rateLabel = formatRateLabel(docEffectiveFrameRate);
    qcFrameRateInput.value = rateLabel;
    qcFrameRate = docEffectiveFrameRate;
    finalizeDurationFlags(cueList);
    renderSidebarList();
    setStatus(qcFrameRateStatus, `Detected from file: ${rateLabel} fps. Confirm this matches the video's actual frame rate.`, 'ok');
    setStatus(subStatus, `Loaded: ${name}${langTag ? ` (${langTag})` : ''}${fallbackMode ? ' — basic rendering (imscJS not loaded)' : ''}`, fallbackMode ? '' : 'ok');
    // Re-convert the offset with this file's own frame rate.
    if (offsetInput.value.trim()) applyOffsetFromField(offsetNote);
    guessOffset();
    if (video) { syncOverlaySize(); forceRender(); }
  }

  window.addEventListener('imsc-ready', () => { if (currentSub) loadSubtitle(currentSub.text, currentSub.name); });

  window.Player = {
    loadVideoFile, loadSubtitle,
    currentVideo: () => currentVideoName,
    currentVideoFile: () => currentVideoFile,
    currentSubtitle: () => currentSub && currentSub.name,
    subtitleHasFps: () => !subIsVtt,
    subtitleFormat: () => subFormat,
    showMessage: (html, kind) => { if (stage) showStageMsg(html, kind); },
    movedMessage: (name) => MOVED_MSG(name),
    fileReadable,
    onShow: () => { if (window.Player.layout) window.Player.layout(); if (video) syncOverlaySize(); },
  };
