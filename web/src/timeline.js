  // ===================================================================== timeline + transport
  // Under the video: a control row (play/pause, volume, timecode, zoom, channel)
  // and a waveform bar with subtitle events drawn as outlined blocks.
  const tlWave = document.getElementById('waveCanvas');
  const tlStatus = document.getElementById('waveStatus');
  const tlSel = document.getElementById('waveChannel');
  const btnPlay = document.getElementById('btnPlay');
  const volIcon = document.getElementById('volIcon');
  const volSlider = document.getElementById('volSlider');
  const tcDisplay = document.getElementById('tcDisplay');
  const tlOv = document.getElementById('overviewCanvas');
  const PEAK_RATE = 100, RULER = 21, DB_RANGE = 48;
  const PLAYHEAD = '#0f8cff', BAR_BG = '#1b4560', RULER_BG = '#101216', HANDLE_TRACK = '#17191d', EMPTY_BG = '#070708';
  const TC_FONT_SMALL = '500 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif';
  const wf = { peaks: null, rms: null, duration: 0, worker: null, key: null, total: 0, sel: null, state: 'idle', msg: '', file: null };
  const view = { start: 0, end: 0 };
  let tlSelected = -1, tlDirty = true;
  const memCache = new Map();
  // Video timing: frame rate and the timecode of the first frame.
  const vmeta = { fps: 0, tcStartFrames: null, tcFps: 0, dropFrame: false };
  let fpsOverride = 0;

  // ---------------------------------------------------------------- waveform data
  const WaveDB = {
    db: null,
    async open() {
      if (this.db) return this.db;
      this.db = await new Promise((res, rej) => { const r = indexedDB.open('subtitle-qc-waves', 2); r.onupgradeneeded = () => { const d = r.result; if (d.objectStoreNames.contains('w')) d.deleteObjectStore('w'); d.createObjectStore('w2'); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      return this.db;
    },
    async get(k) { try { const db = await this.open(); return await new Promise(res => { const q = db.transaction('w2').objectStore('w2').get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); }); } catch (e) { return null; } },
    async set(k, v) { try { const db = await this.open(); db.transaction('w2', 'readwrite').objectStore('w2').put(v, k); } catch (e) {} },
  };
  const prefsFor = () => { try { return JSON.parse(Store.get('waveSel') || '{}'); } catch (e) { return {}; } };
  const defaultSel = (total) => total === 1 ? '[0]' : total === 2 ? '[0,1]' : '[2]';
  const selKey = (total) => { const p = prefsFor()[total]; return p ? JSON.stringify(p) : defaultSel(total); };

  function tlDuration() { return (video && isFinite(video.duration) && video.duration > 0) ? video.duration : wf.duration; }

  async function startWaveform(file) {
    if (wf.worker) { wf.worker.terminate(); wf.worker = null; }
    Object.assign(wf, { file, peaks: null, rms: null, duration: 0, total: 0, sel: null, state: 'loading', msg: 'Reading audio…' });
    wf.key = `${file.name}|${file.size}|${file.lastModified}`;
    view.start = 0; view.end = 0; tlDirty = true;
    renderChannelSelect();
    const knownTotal = Store.get('waveTotal:' + wf.key);
    if (knownTotal) {
      const k = wf.key + '|' + selKey(+knownTotal);
      const hit = memCache.get(k) || await WaveDB.get(k);
      if (hit && wf.file === file) { useWave(hit); return; }
    }
    let worker;
    try { worker = NATIVE ? Native.waveWorker() : new Worker(URL.createObjectURL(new Blob([WAVE_WORKER_SRC], { type: 'text/javascript' }))); }
    catch (e) { wf.state = 'error'; wf.msg = 'Waveform unavailable (background worker blocked).'; tlDirty = true; return; }
    wf.worker = worker;
    worker.onmessage = (ev) => {
      if (wf.worker !== worker) return;
      const m = ev.data;
      if (m.type === 'info') {
        Object.assign(wf, { duration: m.duration, total: m.total, sel: m.sel, codec: m.codec });
        wf.peaks = new Float32Array(Math.ceil(m.duration * PEAK_RATE) + 1);
        wf.rms = new Float32Array(wf.peaks.length);
        Store.set('waveTotal:' + wf.key, String(m.total));
        renderChannelSelect();
      } else if (m.type === 'peaks') {
        wf.peaks.set(m.data, m.start); wf.rms.set(m.rms, m.start); tlDirty = true;
      } else if (m.type === 'progress') {
        wf.msg = `Reading audio… ${Math.round(m.p * 100)}%`; tlDirty = true;
      } else if (m.type === 'done') {
        wf.state = 'ready'; wf.msg = ''; tlDirty = true; worker.terminate(); wf.worker = null;
        const entry = { peaks: wf.peaks, rms: wf.rms, duration: wf.duration, total: wf.total, sel: wf.sel, codec: wf.codec };
        const k = wf.key + '|' + selKey(wf.total);
        memCache.set(k, entry); WaveDB.set(k, entry);
      } else if (m.type === 'error') {
        wf.state = 'error'; wf.msg = 'Waveform unavailable: ' + m.message; tlDirty = true; worker.terminate(); wf.worker = null;
      }
    };
    worker.onerror = (e) => { if (wf.worker === worker) { wf.state = 'error'; wf.msg = 'Waveform unavailable: ' + (e.message || 'worker error'); tlDirty = true; } };
    worker.postMessage({ file, prefs: prefsFor() });
  }
  function useWave(entry) {
    Object.assign(wf, { peaks: entry.peaks, rms: entry.rms, duration: entry.duration, total: entry.total, sel: entry.sel, codec: entry.codec, state: 'ready', msg: '' });
    tlDirty = true; renderChannelSelect();
  }

  function renderChannelSelect() {
    const n = wf.total;
    if (!n) { tlSel.innerHTML = '<option>Audio</option>'; tlSel.disabled = true; return; }
    tlSel.disabled = false;
    const opts = [];
    if (n >= 2) opts.push(['[0,1]', 'Ch 1+2']);
    if (n >= 8) opts.push(['[6,7]', 'Ch 7+8']);
    for (let i = 0; i < n; i++) opts.push([`[${i}]`, `Ch ${i + 1}`]);
    const cur = selKey(n);
    tlSel.innerHTML = opts.map(([v, l]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${l}</option>`).join('');
  }
  tlSel.addEventListener('change', () => {
    const prefs = prefsFor();
    if (tlSel.value === defaultSel(wf.total)) delete prefs[wf.total]; else prefs[wf.total] = JSON.parse(tlSel.value);
    Store.set('waveSel', JSON.stringify(prefs));
    if (wf.file) startWaveform(wf.file);
  });

  // ---------------------------------------------------------------- frames & timecode
  function fps() { return vmeta.fps || fpsOverride || docEffectiveFrameRate || 23.976; }
  function currentFrame() { return video ? Math.max(0, Math.floor(video.currentTime * fps() + 1e-4)) : 0; }
  function seekFrame(n) {
    if (!video) return;
    const d = tlDuration() || Infinity;
    n = Math.max(0, n);
    // Land in the middle of the frame so the browser shows exactly that frame.
    video.currentTime = Math.min(d - 0.001, (n + 0.5) / fps());
    forceRender(); keepInView(); tlDirty = true;
  }
  function stepFrame(dir) { if (!video) return; video.pause(); seekFrame(currentFrame() + dir); }
  function seekTo(t) { if (!video) return; video.currentTime = Math.max(0, Math.min((tlDuration() || t) - 0.001, t)); forceRender(); tlDirty = true; }
  function setStartTimecode(tc) {   // from the video's timecode track
    window.__videoDropFrame = !!(tc && tc.dropFrame);
    if (tc) { vmeta.tcStartFrames = tc.frameNumber; vmeta.tcFps = Math.round(tc.fps); vmeta.dropFrame = tc.dropFrame; }
    else { vmeta.tcStartFrames = null; vmeta.tcFps = 0; vmeta.dropFrame = false; }
  }
  function startFramesFromField() {
    const m = (offsetInput.value || '').trim().match(/^\+?(\d+):(\d{1,2}):(\d{1,2}):(\d{1,2})$/);
    if (!m) return 0;
    const nom = Math.round(fps());
    return ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * nom + +m[4];
  }
  // Displayed timecode always counts from 00:00:00:00 at the first frame of the video (the real
  // start timecode is still used for syncing via the offset).
  function timecodeAt(frame) {
    const nom = vmeta.tcFps || Math.round(fps());
    return TimecodeTrack.framesToTC(frame, nom, vmeta.dropFrame);
  }
  function updateTC() {
    if (document.activeElement === tcDisplay) return;   // don't overwrite while the user is typing
    const v = video && video.currentSrc ? timecodeAt(currentFrame()) : '00:00:00:00';
    if (tcDisplay.textContent !== v) tcDisplay.textContent = v;
  }
  // Timecode label -> frame number (the inverse of framesToTC, drop-frame aware).
  function tcToFrames(h, m, s, f, nom, drop) {
    let n = (h * 3600 + m * 60 + s) * nom + f;
    if (drop && (nom === 30 || nom === 60)) { const d = nom === 30 ? 2 : 4, mins = h * 60 + m; n -= d * (mins - Math.floor(mins / 10)); }
    return n;
  }
  // Typed entry: "01:00:12:00", "1:0:12:0", "01;00;12;00", "01001200". Short entries count from the
  // right and missing digits are zeros: "1200" and "12:00" both mean 00:00:12:00.
  function parseTypedTC(str, cur) {
    str = (str || '').trim();
    let parts;
    if (/^\d+$/.test(str)) { if (str.length > 8) return null; const p = str.padStart(Math.ceil(str.length / 2) * 2, '0'); parts = p.match(/\d\d/g); }
    else if (/^\d{1,2}([:;.]\d{1,2}){0,3}$/.test(str)) parts = str.split(/[:;.]/);
    else return null;
    if (parts.length > 4) return null;
    return ['0', '0', '0', '0'].slice(0, 4 - parts.length).concat(parts).map(Number);
  }
  function goToTypedTC() {
    const v = parseTypedTC(tcDisplay.textContent);
    const nom = vmeta.tcFps || Math.round(fps());
    const bad = () => {};   // invalid entry: nothing changes, the field just closes
    if (!video || !video.currentSrc) { bad(); return false; }
    if (!v || v[1] > 59 || v[2] > 59 || v[3] >= nom) { bad(); return false; }
    const target = tcToFrames(v[0], v[1], v[2], v[3], nom, vmeta.dropFrame);
    const last = Math.floor(((tlDuration() || 0) - 0.001) * fps());
    const n = Math.max(0, Math.min(last, target));
    seekFrame(n); centerOn(video.currentTime);
    tcDisplay.classList.remove('err');
    return true;
  }
  // Keep the field's width while typing so the play button doesn't move.
  // Keep the field's width while typing (padding fills the gap), so the play button doesn't move.
  let tcW = 0;
  const holdWidth = () => {
    if (!tcW) return;
    tcDisplay.style.paddingLeft = tcDisplay.style.paddingRight = '0px';
    const pad = Math.max(0, (tcW - tcDisplay.getBoundingClientRect().width) / 2 / uiZoom());
    tcDisplay.style.setProperty('padding-left', pad + 'px', 'important'); tcDisplay.style.setProperty('padding-right', pad + 'px', 'important');
  };
  tcDisplay.addEventListener('focus', () => { tcW = tcDisplay.getBoundingClientRect().width; });
  tcDisplay.addEventListener('input', holdWidth);
  const selectAllTC = () => { const r = document.createRange(); r.selectNodeContents(tcDisplay); const s = getSelection(); s.removeAllRanges(); s.addRange(r); };
  tcDisplay.addEventListener('mouseup', e => { if (tcDisplay.dataset.sel !== '1') { e.preventDefault(); selectAllTC(); tcDisplay.dataset.sel = '1'; } });
  tcDisplay.addEventListener('paste', e => { e.preventDefault(); const t = (e.clipboardData.getData('text') || '').trim().slice(0, 16); document.execCommand('insertText', false, t); });
  tcDisplay.addEventListener('blur', () => { tcDisplay.dataset.sel = ''; tcW = 0; tcDisplay.style.removeProperty('padding-left'); tcDisplay.style.removeProperty('padding-right'); getSelection().removeAllRanges(); updateTC(); });
  tcDisplay.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); goToTypedTC(); tcDisplay.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); tcDisplay.blur(); }
  });

  // ---------------------------------------------------------------- view & zoom
  const MIN_SPAN = 10, MAX_SPAN = 90, DEFAULT_SPAN = 60;   // the bar shows 10 s to 1.5 min; the index below shows it all
  function ensureView() {
    const d = tlDuration();
    if (!d) return false;
    if (!(view.end > view.start)) { view.start = 0; view.end = Math.min(DEFAULT_SPAN, d); }
    const span = Math.max(Math.min(MIN_SPAN, d), Math.min(d, MAX_SPAN, view.end - view.start));
    view.start = Math.max(0, Math.min(d - span, view.start));
    view.end = view.start + span;
    return true;
  }
  function setSpan(span, anchor) {
    const d = tlDuration(); if (!d) return;
    span = Math.max(Math.min(MIN_SPAN, d), Math.min(d, MAX_SPAN, span));
    const old = view.end - view.start || d;
    const a = anchor != null ? anchor : (video ? video.currentTime : view.start + old / 2);
    const f = old ? (a - view.start) / old : 0.5;
    view.start = a - Math.max(0, Math.min(1, f)) * span; view.end = view.start + span;
    ensureView(); tlDirty = true;
  }
  function keepInView() {
    if (!video || !ensureView()) return;
    const t = video.currentTime, span = view.end - view.start;
    if (span >= tlDuration() - 0.01) return;
    if (t > view.end - span * 0.03 || t < view.start) { view.start = t - span * 0.1; view.end = view.start + span; ensureView(); tlDirty = true; }
  }
  function centerOn(t) { const span = view.end - view.start || tlDuration(); view.start = t - span / 2; view.end = view.start + span; ensureView(); tlDirty = true; }

  // ---------------------------------------------------------------- drawing
  const cueVideoTime = c => [c.begin - effectiveOffset(), c.end - effectiveOffset()];
  function fitCanvas(c) {
    const dpr = (window.devicePixelRatio || 1) * uiZoom(), w = c.clientWidth, h = c.clientHeight;   // sharp when scaled down
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }
  function cueColor(c) {
    if (c.overlap) return [255, 90, 90];
    if (c.tooShortCritical) return [255, 61, 184];
    if (c.tooShort || c.tooLong) return [79, 209, 197];
    if (c.charLimitExceeded) return [199, 146, 234];
    if (c.lineCount >= LINE_COUNT_THRESHOLD) return [255, 159, 67];
    return [245, 215, 110];
  }
  // Level in dB mapped to 0..1, so speech is readable and loud passages don't fill the bar.
  const level = v => v <= 0 ? 0 : Math.max(0, Math.min(1, (20 * Math.log10(v) + DB_RANGE) / DB_RANGE));
  function rulerStep(span, w) {
    const target = span / (w / 90);
    return [1 / 24, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].find(s => s >= target) || 3600;
  }
  function draw() {
    const { ctx, w, h } = fitCanvas(tlWave);
    const loaded = !!(video && video.currentSrc);
    document.getElementById('timeline').classList.toggle('empty', !loaded);
    ctx.fillStyle = loaded ? BAR_BG : EMPTY_BG; ctx.fillRect(0, 0, w, h);
    updateTC();
    if (!ensureView()) { tlStatus.textContent = wf.msg || ''; return; }
    const span = view.end - view.start, x = t => (t - view.start) / span * w;
    const base = h - 1, amp = h - RULER - 3;
    // ruler on whole timecode values
    ctx.fillStyle = RULER_BG; ctx.fillRect(0, 0, w, RULER);
    const step = rulerStep(span, w), off = 0;   // ruler counts from the first frame, like the timecode display
    const k = (docFrameRate || 24) / (docEffectiveFrameRate || docFrameRate || 24);
    ctx.font = TC_FONT_SMALL; ctx.textBaseline = 'middle';
    // Labels count from the hour the video starts in (01:00:00:00 -> 00:00), hours only appear
    // past the first hour, frames only when ticks are closer than a second.
    const nominal = docFrameRate || 24, p2 = n => String(n).padStart(2, '0');
    const baseHour = Math.max(0, Math.floor((off / k) / 3600 + 1e-9));
    const rulerLabel = (tc) => {
      let rel = tc - baseHour * 3600; const neg = rel < -1e-9; rel = Math.abs(rel);
      let whole = Math.floor(rel + 1e-6), f = Math.round((rel - whole) * nominal);
      if (f >= nominal) { whole++; f = 0; }
      const hh = Math.floor(whole / 3600), mm = Math.floor(whole / 60) % 60, ss = whole % 60;
      let out = (hh ? p2(hh) + ':' : '') + p2(mm) + ':' + p2(ss);
      if (step < 1) out += ':' + p2(f);
      return (neg ? '-' : '') + out;
    };
    // Minor ticks between the labels: the smallest even subdivision
    // at least 9px apart (down to single frames), with a taller tick halfway when it falls on one.
    const frameStep = 1 / nominal, pxPerSec = w / span;
    const minor = [frameStep, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 300].find(m => m < step - 1e-9 && m * k * pxPerSec >= 9 &&
      Math.abs(step / m - Math.round(step / m)) < 1e-6) || 0;
    if (minor) {
      const half = step / 2, hasHalf = Math.abs(half / minor - Math.round(half / minor)) < 1e-6;
      ctx.beginPath();
      for (let i = Math.ceil((view.start / k) / minor - 1e-9); ; i++) {
        const tc = i * minor, t = tc * k; if (t > view.end) break;
        const rel = tc / step - Math.floor(tc / step + 1e-9);
        if (rel < 1e-6 || rel > 1 - 1e-6) continue;                 // a labelled tick
        const len = hasHalf && Math.abs(rel - 0.5) < 1e-6 ? 7 : 4;
        const px = Math.round(x(t)) + 0.5;
        ctx.moveTo(px, RULER - len); ctx.lineTo(px, RULER);
      }
      ctx.strokeStyle = 'rgba(200,205,212,0.32)'; ctx.stroke();
    }
    for (let tc = Math.ceil(((view.start + off) / k) / step - 1e-9) * step; ; tc += step) {
      const t = tc * k - off; if (t > view.end) break;
      const px = Math.round(x(t)) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.beginPath(); ctx.moveTo(px, RULER); ctx.lineTo(px, h); ctx.stroke();
      ctx.strokeStyle = 'rgba(200,205,212,0.45)'; ctx.beginPath(); ctx.moveTo(px, 2); ctx.lineTo(px, RULER); ctx.stroke();
      ctx.fillStyle = 'rgba(200,205,212,0.78)'; ctx.fillText(rulerLabel(tc), px + 4, 8.5);
    }
    // subtitle event fills go under the waveform
    cueList.forEach((c, i) => {
      const [b, e] = cueVideoTime(c);
      if (!isFinite(e) || e < view.start || b > view.end) return;
      const x0 = Math.round(x(b)) + 0.5, x1 = Math.max(x0 + 1, Math.round(x(e)) - 0.5);
      const tNow = video ? video.currentTime : 0;
      const hi = isMoving() ? (tNow >= b && tNow < e) : i === tlSelected;
      ctx.fillStyle = `rgba(255,255,255,${hi ? 0.42 : 0.25})`;
      ctx.fillRect(x0, RULER + 1, x1 - x0, h - RULER - 2);
    });
    // waveform: RMS solid, peak faint
    if (wf.peaks) {
      for (let px = 0; px < w; px++) {
        const i0 = Math.floor((view.start + px / w * span) * PEAK_RATE);
        const i1 = Math.max(i0 + 1, Math.floor((view.start + (px + 1) / w * span) * PEAK_RATE));
        let pk = 0, rs = 0, n = 0;
        for (let i = Math.max(0, i0); i < Math.min(wf.peaks.length, i1); i++) { if (wf.peaks[i] > pk) pk = wf.peaks[i]; rs += wf.rms[i] * wf.rms[i]; n++; }
        if (!n) continue;
        const hp = level(pk) * amp, hr = level(Math.sqrt(rs / n)) * amp;
        // half phase: grows from the bottom up
        if (hr > 0.4) { ctx.fillStyle = 'rgba(120,214,206,0.92)'; ctx.fillRect(px, base - hr, 1, hr); }
      }
    }
    // scanlines: a faint dark line on every other screen pixel row (a lit-display texture), drawn in
    // device pixels so it stays even at any window scale; the in / out lines go on top, crisp.
    if (loaded) {
      const sc = (window.devicePixelRatio || 1) * uiZoom(), unit = Math.max(1, Math.round(window.devicePixelRatio || 1));
      const W = tlWave.width, y0 = Math.ceil((RULER + 1) * sc), y1 = Math.floor((h - 1) * sc);
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = 'rgba(0,0,0,0.10)';
      for (let y = y0; y < y1; y += 2 * unit) ctx.fillRect(0, y, W, unit);
      ctx.restore();
    }
    // subtitle events
    const t = video ? video.currentTime : 0, d = tlDuration();
    let inRange = 0;
    cueList.forEach((c, i) => {
      const [b, e] = cueVideoTime(c);
      if (!isFinite(e)) return;
      if (e > 0 && b < d) inRange++;
      if (e < view.start || b > view.end) return;
      const x0 = Math.round(x(b)) + 0.5, x1 = Math.max(x0 + 1, Math.round(x(e)) - 0.5);
      const sel = i === tlSelected;
      // left and right edges only (in and out points)
      ctx.strokeStyle = `rgba(255,255,255,${sel ? 1 : 0.8})`; ctx.lineWidth = sel ? 2 : 1;
      ctx.beginPath(); ctx.moveTo(x0, RULER + 1); ctx.lineTo(x0, h - 1); ctx.moveTo(x1, RULER + 1); ctx.lineTo(x1, h - 1); ctx.stroke(); ctx.lineWidth = 1;
    });
    // thin white border along the top and bottom of the bar
    if (loaded) { ctx.fillStyle = '#3d5a73'; ctx.fillRect(0, RULER, w, 1); ctx.fillRect(0, h - 1, w, 1); }
    // playhead
    if (video) {
      const px = Math.round(x(t)) + 0.5;
      const ph = Math.round(x(t));   // 2px line
      ctx.lineWidth = 2; ctx.strokeStyle = PLAYHEAD; ctx.beginPath(); ctx.moveTo(ph, 0); ctx.lineTo(ph, h); ctx.stroke(); ctx.lineWidth = 1;
      ctx.fillStyle = PLAYHEAD; ctx.beginPath(); ctx.moveTo(ph - 9, 0); ctx.lineTo(ph + 9, 0); ctx.lineTo(ph, 11); ctx.closePath(); ctx.fill();
    }
    let msg = wf.state === 'ready' ? '' : wf.msg;
    if (cueList.length && !inRange) msg = (msg ? msg + ' · ' : '') + 'No subtitle events fall inside this video — check the offset.';
    tlStatus.textContent = msg;
  }

  let lastT = -1;
  function tlTick() {
    requestAnimationFrame(tlTick);
    if (document.body.dataset.tab !== 'player') return;
    const t = video ? video.currentTime : -1;
    if (t !== lastT) { lastT = t; tlDirty = true; if (video && !video.paused && !scrub) keepInView(); }
    updateFps();
    if (!tlDirty && wf.state !== 'loading') return;
    tlDirty = false;
    draw(); drawOverview();
  }
  requestAnimationFrame(tlTick);
  window.addEventListener('resize', () => { tlDirty = true; });

  // ---------------------------------------------------------------- selection shared with the event list
  function reapplyTlSel() {
    for (const el of cueListContainer.querySelectorAll('.tl-sel')) el.classList.remove('tl-sel');
    const row = cueListContainer.children[tlSelected];
    if (row) row.classList.add('tl-sel');
    return row;
  }
  function selectCue(i, { seek, scrollList }) {
    tlSelected = i;
    const row = reapplyTlSel();
    if (row && scrollList) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const c = cueList[i];
    if (c && seek && video) { video.currentTime = Math.max(0, c.begin - effectiveOffset()); forceRender(); }
    if (c) { const [b, e] = cueVideoTime(c); if (b < view.start || e > view.end) centerOn((b + e) / 2); }
    tlDirty = true;
  }
  cueListContainer.addEventListener('click', (e) => {
    const row = e.target.closest('.cue-item');
    if (row) selectCue(Number(row.dataset.index), { seek: true, scrollList: false });
  });

  // ---------------------------------------------------------------- mouse on the bar
  // Press/drag = move the playhead (scrub). A click on a block without dragging selects that event.
  let scrub = null;
  const timeAtX = (clientX) => { const r = tlWave.getBoundingClientRect(); return view.start + (clientX - r.left) / r.width * (view.end - view.start); };
  tlWave.addEventListener('mousedown', (e) => {
    if (!video || !ensureView()) return;
    e.preventDefault();
    scrub = { x: e.clientX, y: e.clientY, moved: false, wasPlaying: !video.paused };
    video.pause();
    seekTo(timeAtX(e.clientX));
  });
  window.addEventListener('mousemove', (e) => {
    if (!scrub) return;
    if (Math.abs(e.clientX - scrub.x) > 3) scrub.moved = true;
    let tt = timeAtX(e.clientX);
    // drag past an edge scrolls the view
    const r = tlWave.getBoundingClientRect(), span = view.end - view.start;
    if (e.clientX > r.right) { view.start += span * 0.02; view.end += span * 0.02; ensureView(); }
    else if (e.clientX < r.left) { view.start -= span * 0.02; view.end -= span * 0.02; ensureView(); }
    seekTo(Math.max(view.start, Math.min(view.end, tt)));
  });
  window.addEventListener('mouseup', (e) => {
    if (!scrub) return;
    const s = scrub; scrub = null;
    if (!s.moved) {
      const r = tlWave.getBoundingClientRect();
      if (e.clientY - r.top > RULER) {
        const t = timeAtX(e.clientX);
        let hit = -1, best = -Infinity;
        cueList.forEach((c, i) => { const [b, en] = cueVideoTime(c); if (t >= b && t < en && b > best) { best = b; hit = i; } });
        if (hit >= 0) selectCue(hit, { seek: true, scrollList: true });
      }
    }
    if (s.wasPlaying) video.play();
  });
  tlWave.addEventListener('wheel', (e) => {
    if (!ensureView()) return;
    const span = view.end - view.start;
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); setSpan(span * Math.pow(1.0025, e.deltaY), timeAtX(e.clientX)); }
    else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
      e.preventDefault();
      const r = tlWave.getBoundingClientRect();
      view.start += (e.deltaX || e.deltaY) / r.width * span; view.end = view.start + span; ensureView(); tlDirty = true;
    }
  }, { passive: false });

  // ---------------------------------------------------------------- transport controls
  const svg = (b) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${b}</svg>`;
  const ICON_PLAY = svg('<path d="M7 5l12 7-12 7z" fill="currentColor" stroke="none"/>');
  const ICON_PAUSE = svg('<path d="M8 5v14M16 5v14" stroke-width="3"/>');
  const ICON_VOL = svg('<path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" stroke="none"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>');
  const ICON_MUTED = svg('<path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" stroke="none"/><path d="M17 9l5 6M22 9l-5 6"/>');
  btnPlay.innerHTML = ICON_PLAY; volIcon.innerHTML = ICON_VOL;
  let transportBound = false;
  // ---------------------------------------------------------------- speed: one scale for J / K / L
  // -6/-4/-2 = reverse, 0 = paused, 1 = normal, 2/4/6 = fast-forward (see stepSpeed).
  // Browsers can't play backwards, so reverse is done by seeking back in small steps (no sound).
  let speed = 0, rwRaf = 0, rwLast = 0, rwPos = 0, ownPause = false;
  const speedBadge = document.getElementById('speedBadge');
  function showSpeed() {
    if (!speedBadge) return;
    speedBadge.textContent = speed < 0 ? '◀◀ ' + (-speed) + '×' : speed > 1 ? '▶▶ ' + speed + '×' : '';
    speedBadge.hidden = !(speed < 0 || speed > 1);
    placeSpeedBadge();
    tlDirty = true;
  }
  // Just right of the timecode, in the space kept free at the start of the right-hand group.
  function placeSpeedBadge() {
    if (!speedBadge || speedBadge.hidden) return;
    const bar = speedBadge.offsetParent || speedBadge.parentElement;
    const tr = tcDisplay.getBoundingClientRect(), br = bar.getBoundingClientRect();
    speedBadge.style.right = 'auto'; speedBadge.style.left = Math.round((tr.right - br.left) / uiZoom() + 10) + 'px';
  }
  window.addEventListener('resize', placeSpeedBadge);
  // Stepped reverse keeps its own steady position (seeks may land a little earlier, on a keyframe);
  // stopping lands exactly on that position.
  function stopReverse() {
    if (!rwRaf) return false;
    cancelAnimationFrame(rwRaf); rwRaf = 0;
    return true;
  }
  function reverseLoop(now) {
    if (!video || speed >= 0) { rwRaf = 0; return; }
    const dt = rwLast ? Math.min(0.25, (now - rwLast) / 1000) : 0;
    rwLast = now;
    rwPos = Math.max(0, rwPos + speed * dt);
    if (!video.seeking) {
      if (video.fastSeek && NATIVE) video.fastSeek(rwPos); else video.currentTime = rwPos;
      forceRender(); keepInView(); tlDirty = true;
    }
    if (rwPos <= 0) { setSpeed(0); return; }
    rwRaf = requestAnimationFrame(reverseLoop);
  }
  const SPEEDS = [-6, -4, -2, 1, 2, 4, 6];   // pause (0) sits between -2 and 1
  // L: from a pause play at 1×, otherwise one step faster forward (from reverse straight to 1×).
  // J: from a pause rewind at 2×, otherwise one step towards reverse (from 1× straight to ◀◀ 2×).
  function stepSpeed(dir) {
    if (speed === 0) return setSpeed(dir > 0 ? 1 : -2);
    const i = SPEEDS.indexOf(speed);
    setSpeed(SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? SPEEDS.indexOf(1) : i) + dir))]);
  }
  function setSpeed(n) {
    if (!video) { speed = 0; showSpeed(); return; }
    speed = n;
    if (stopReverse()) video.currentTime = rwPos;   // leave stepped reverse exactly where it was
    if (speed > 0) { video.playbackRate = speed; if (video.paused) video.play().catch(() => {}); }
    else if (speed < 0 && video.canPlayReverse && (speed === -1 || video.canPlayFastReverse)) {   // the Mac app plays backwards for real (ProRes …)
      video.playbackRate = speed; if (video.paused) video.play().catch(() => {});
    } else {
      // Pause first, then reset the speed: the other way round, the Mac app could briefly be told to play
      // forward at 1× and (on ProRes after native reverse) keep doing so after the pause.
      if (!video.paused) { ownPause = true; video.pause(); }
      video.playbackRate = 1;
      if (speed < 0) { rwLast = 0; rwPos = video.currentTime; rwRaf = requestAnimationFrame(reverseLoop); }
    }
    showSpeed(); syncPlayIcon();
  }
  function togglePlay() { setSpeed(speed !== 0 ? 0 : 1); }
  function syncPlayIcon() {
    if (!video) return;
    const moving = speed !== 0;
    btnPlay.innerHTML = moving ? ICON_PAUSE : ICON_PLAY; btnPlay.title = moving ? 'Pause (Space)' : 'Play (Space)';
  }
  // Keep the scale in step when playback starts or stops some other way (end of video, code paths
  // that call play()/pause() directly).
  function onVideoPlay() {
    const nativeRev = speed < 0 && video.canPlayReverse && (speed === -1 || video.canPlayFastReverse);
    if (speed === 0 || (speed < 0 && !nativeRev)) { stopReverse(); speed = 1; video.playbackRate = 1; showSpeed(); }
    syncPlayIcon();
  }
  function onVideoPause() {
    if (ownPause) { ownPause = false; syncPlayIcon(); return; }
    if (speed !== 0) { stopReverse(); speed = 0; video.playbackRate = 1; showSpeed(); }
    syncPlayIcon();
  }
  const isMoving = () => speed !== 0;

  function bindTransport() {
    if (transportBound || !video) return;
    transportBound = true;
    video.controls = false;
    video.addEventListener('play', onVideoPlay); video.addEventListener('pause', onVideoPause); video.addEventListener('ended', () => setSpeed(0));
    video.addEventListener('loadedmetadata', () => { view.start = 0; view.end = 0; ensureView(); tlDirty = true; layoutQC(); });
    video.addEventListener('click', togglePlay);
    const v = parseFloat(Store.get('volume'));
    video.volume = isFinite(v) ? v : 1;
    video.muted = Store.get('muted') === '1';
    const syncVol = () => { volSlider.value = video.muted ? 0 : Math.round(video.volume * 100); volFill(); volIcon.innerHTML = video.muted || video.volume === 0 ? ICON_MUTED : ICON_VOL; };
    video.addEventListener('volumechange', () => { syncVol(); Store.set('volume', String(video.volume)); Store.set('muted', video.muted ? '1' : '0'); });
    syncVol(); syncPlayIcon();
  }
  btnPlay.addEventListener('mouseup', () => btnPlay.blur());
  offsetFlip.addEventListener('mouseup', () => offsetFlip.blur());
  btnPlay.addEventListener('click', () => { if (video) togglePlay(); });
  const volFill = () => volSlider.style.setProperty('--v', volSlider.value + '%');
  volFill();
  volSlider.addEventListener('input', volFill);
  volSlider.addEventListener('input', () => { if (!video) return; video.volume = volSlider.value / 100; video.muted = +volSlider.value === 0; });
  offsetInput.addEventListener('change', () => { tlDirty = true; });
  video && bindTransport();

  // ---------------------------------------------------------------- zoom handle (under the bar)
  // ---------------------------------------------------------------- index bar (the whole video)
  // Under the bar: the whole video at once. Where subtitles are (coverage)
  // and a box marking the part the bar above shows. Drag the box to look around
  // (the playhead stays); click anywhere to jump there (drag on to scrub).
  const OV_MIN_BLOCK = 2, OV_MIN_GAP = 3;          // px: a lone event shows at least 2 px; gaps under 3 px are filled
  let ovHover = null, ovDrag = null, ovCache = null, ovKey = '';
  const ovTime = (px, w) => Math.max(0, Math.min(tlDuration(), px / w * tlDuration()));
  function ovLabel(t) {
    const s = Math.round(t), hh = Math.floor(s / 3600), mm = Math.floor(s / 60) % 60, ss = s % 60, p2 = n => String(n).padStart(2, '0');
    return (hh ? hh + ':' + p2(mm) : String(mm)) + ':' + p2(ss);
  }
  // Coverage per pixel column: on where any event touches it, then short runs widened, small gaps closed.
  function ovCoverage(w, d) {
    const on = new Uint8Array(w);
    for (const c of cueList) {
      const [b, e] = cueVideoTime(c);
      if (!isFinite(b) || !isFinite(e) || e <= 0 || b >= d) continue;
      const x0 = Math.max(0, Math.floor(b / d * w)), x1 = Math.min(w - 1, Math.max(x0, Math.ceil(e / d * w) - 1));
      for (let x = x0; x <= x1; x++) on[x] = 1;
    }
    for (let x = 0; x < w; ) {                       // runs narrower than OV_MIN_BLOCK
      if (!on[x]) { x++; continue; }
      let e = x; while (e < w && on[e]) e++;
      for (let k = e; k < Math.min(w, x + OV_MIN_BLOCK); k++) on[k] = 1;
      x = Math.max(e, x + OV_MIN_BLOCK);
    }
    for (let x = 0; x < w; ) {                       // gaps narrower than OV_MIN_GAP (between two runs)
      if (on[x]) { x++; continue; }
      let e = x; while (e < w && !on[e]) e++;
      if (x > 0 && e < w && e - x < OV_MIN_GAP) for (let k = x; k < e; k++) on[k] = 1;
      x = e;
    }
    return on;
  }
  // The static part (waveform, coverage, labels) is drawn once into a cache and only redrawn when
  // something it shows changes; each frame then just adds the box and the playhead.
  function ovStatic(w, h, d) {
    const dpr = (window.devicePixelRatio || 1) * uiZoom();
    const n = cueList.length, c0 = n ? cueList[0].begin : 0, cN = n ? cueList[n - 1].end : 0;
    const key = [w, h, dpr, d, n, c0, cN, effectiveOffset()].join('|');
    if (ovCache && key === ovKey) return ovCache;
    ovKey = key;
    const cv = ovCache || document.createElement('canvas');
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#101216'; ctx.fillRect(0, 0, w, h);
    const top = 0, bandH = h - 3;
    // subtitle coverage
    const on = ovCoverage(w, d);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    for (let x = 0; x < w; ) {
      if (!on[x]) { x++; continue; }
      let e = x; while (e < w && on[e]) e++;
      ctx.fillRect(x, top + 2, e - x, bandH - 2);
      x = e;
    }
    ovCache = cv;
    return cv;
  }
  function boxGeom(w) {
    const d = tlDuration(), minW = 8;
    let x0 = view.start / d * w, x1 = view.end / d * w;
    if (x1 - x0 < minW) { const c = (x0 + x1) / 2; x0 = Math.max(0, Math.min(w - minW, c - minW / 2)); x1 = x0 + minW; }
    return { x0, x1 };
  }
  function drawOverview() {
    const { ctx, w, h } = fitCanvas(tlOv);
    const loaded = !!(video && video.currentSrc);
    const d = tlDuration();
    if (!loaded || !d || !ensureView()) { ctx.fillStyle = loaded ? HANDLE_TRACK : EMPTY_BG; ctx.fillRect(0, 0, w, h); return; }
    ctx.drawImage(ovStatic(w, h, d), 0, 0, w, h);
    // the part the bar above shows
    const { x0, x1 } = boxGeom(w), act = ovHover === 'box' || (ovDrag && ovDrag.mode === 'move');
    ctx.fillStyle = act ? 'rgba(255,255,255,0.42)' : 'rgba(255,255,255,0.34)'; ctx.fillRect(x0, 0, x1 - x0, h);
    ctx.strokeStyle = act ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x0) + 0.5, 0.5, Math.max(1, Math.round(x1 - x0) - 1), h - 1);
    // hover: a line and the time under the pointer
    if (ovHover != null && typeof ovHover === 'object' && !ovDrag) {
      const px = Math.round(ovHover.x) + 0.5, txt = ovLabel(ovTime(ovHover.x, w));
      ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillRect(px - 0.5, 0, 1, h);
      ctx.font = '600 10.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif'; ctx.textBaseline = 'middle';
      const tw = ctx.measureText(txt).width + 10, bx = Math.max(0, Math.min(w - tw, px + 6));
      ctx.fillStyle = 'rgba(10,11,13,0.92)'; ctx.beginPath(); ctx.roundRect(bx, 2, tw, h - 4, 3); ctx.fill();
      ctx.fillStyle = '#e8e9ec'; ctx.fillText(txt, bx + 5, h / 2);
    }
  }
  function ovHitBox(px, w) { const { x0, x1 } = boxGeom(w); return px >= x0 - 2 && px <= x1 + 2; }
  tlOv.addEventListener('mousedown', (e) => {
    const d = tlDuration(); if (!d || !ensureView() || !video) return;
    e.preventDefault();
    const r = tlOv.getBoundingClientRect(), px = e.clientX - r.left;
    if (ovHitBox(px, r.width)) ovDrag = { mode: 'move', x: e.clientX, start: view.start, moved: false };
    else { ovDrag = { mode: 'scrub' }; seekTo(ovTime(px, r.width)); centerOn(ovTime(px, r.width)); }
    tlDirty = true;
  });
  window.addEventListener('mousemove', (e) => {
    const r = tlOv.getBoundingClientRect();
    if (!ovDrag) {
      const d = tlDuration(); if (!d || scrub) return;
      const inside = !(e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX > r.right);
      const hv = !inside ? null : ovHitBox(e.clientX - r.left, r.width) ? 'box' : { x: e.clientX - r.left };
      tlOv.style.cursor = hv === 'box' ? 'grab' : 'default';
      if (JSON.stringify(hv) !== JSON.stringify(ovHover)) { ovHover = hv; tlDirty = true; }
      return;
    }
    const d = tlDuration();
    if (ovDrag.mode === 'move') {
      if (Math.abs(e.clientX - ovDrag.x) > 2) ovDrag.moved = true;
      const span = view.end - view.start;
      view.start = ovDrag.start + (e.clientX - ovDrag.x) / r.width * d; view.end = view.start + span; ensureView();
      tlOv.style.cursor = 'grabbing';
    } else { const t = ovTime(e.clientX - r.left, r.width); seekTo(t); centerOn(t); }
    tlDirty = true;
  });
  window.addEventListener('mouseup', (e) => {
    if (!ovDrag) return;
    // a click on the box (no drag) jumps there too
    if (ovDrag.mode === 'move' && !ovDrag.moved) { const r = tlOv.getBoundingClientRect(); seekTo(ovTime(e.clientX - r.left, r.width)); }
    ovDrag = null; tlOv.style.cursor = 'default'; tlDirty = true;
  });

  // ---------------------------------------------------------------- Space = play/pause (also when a button or slider has focus)
  const isTyping = el => el && (el.tagName === 'TEXTAREA' || el.isContentEditable || (el.tagName === 'INPUT' && !/^(range|checkbox|radio|button)$/.test(el.type)));
  document.addEventListener('keydown', (e) => {
    if (document.body.dataset.tab !== 'player' || !video || isTyping(e.target) || e.metaKey || e.ctrlKey) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const space = e.key === ' ' || e.code === 'Space';
    if (!space && !['k', 'j', 'l', 'ArrowLeft', 'ArrowRight'].includes(k)) return;
    if (e.target && e.target.tagName === 'SELECT' && k.startsWith('Arrow')) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (space) { if (!e.repeat) togglePlay(); return; }
    if (k === 'k') { setSpeed(0); return; }
    if (k === 'j') { if (!e.repeat) stepSpeed(-1); return; }
    if (k === 'l') { if (!e.repeat) stepSpeed(1); return; }
    const dir = k === 'ArrowRight' ? 1 : -1;
    setSpeed(0);
    if (e.altKey) seekTo(video.currentTime + dir * 300);           // ⌥ Option: 5 minutes
    else if (e.shiftKey) seekTo(video.currentTime + dir * 5);      // Shift: 5 seconds
    else { stepFrame(dir); return; }
    keepInView(); tlDirty = true;
  }, true);
  // Up / down arrows: previous / next subtitle event (only the events shown in the list, so a filter
  // or search narrows what you step through). Jumps the playhead to the event's first frame.
  function stepEvent(dir) {
    if (!video || !cueList.length) return;
    const rows = [...cueListContainer.querySelectorAll('.cue-item')].filter(r => r.style.display !== 'none');
    const idx = rows.map(r => Number(r.dataset.index)).filter(i => cueList[i] && isFinite(cueList[i].begin));
    if (!idx.length) return;
    // Events table sorted by something other than time: ↑/↓ follow the table's row order.
    if (expanded && !(evSort.key === 'begin' && evSort.dir > 0)) {
      const order = [...evBody.rows].filter(r => !r.hidden).map(r => Number(r.dataset.index));
      const pos = order.indexOf(tlSelected), n = pos < 0 ? (dir > 0 ? 0 : order.length - 1) : pos + dir;
      if (n < 0 || n >= order.length) return;
      seekFrame(Math.round((cueList[order[n]].begin - effectiveOffset()) * fps()));
      selectCue(order[n], { seek: false, scrollList: true });
      if (evRows[order[n]]) evRows[order[n]].scrollIntoView({ block: 'nearest' });
      return;
    }
    const half = 0.5 / fps(), t = video.currentTime + effectiveOffset();
    // The current event is the one at (or last passed by) the playhead; ↑ goes to the one before it,
    // ↓ to the one after, like moving a cursor through the list. Works the same while playing.
    // Inside an event, ↑ goes to the one before it. In a gap, ↑ goes back to the event that just ended.
    let cur = -1;
    idx.forEach((i, n) => { if (cueList[i].begin <= t + half) cur = n; });
    const inside = cur >= 0 && t < cueList[idx[cur]].end - half;
    const n = dir > 0 ? cur + 1 : (inside ? cur - 1 : cur);
    if (n < 0 || n >= idx.length) return;
    const target = idx[n];
    if (target < 0) return;
    seekFrame(Math.round((cueList[target].begin - effectiveOffset()) * fps()));
    selectCue(target, { seek: false, scrollList: !expanded });
    if (expanded && evRows[target]) evRows[target].scrollIntoView({ block: 'nearest' });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (document.body.dataset.tab !== 'player' || !video || isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target && e.target.tagName === 'SELECT') return;
    e.preventDefault(); e.stopImmediatePropagation();
    stepEvent(e.key === 'ArrowDown' ? 1 : -1);
  }, true);
  document.addEventListener('keyup', (e) => {
    if ((e.key === ' ' || e.code === 'Space') && document.body.dataset.tab === 'player' && !isTyping(e.target)) e.preventDefault();
  }, true);

  // ---------------------------------------------------------------- fit the QC tab to the window (no scrolling)
  const qcGrid = document.querySelector('.qcgrid');
  // Fixed grid: the black video area fills the space above the bar, so the bar always lines up
  // with the offset/fps panel on the left. All heights are whole pixels and include borders.
  const BOTTOM_PAD = 4;
  function layoutQC() {
    if (document.body.dataset.tab !== 'player' || !qcGrid) return;
    const top = Math.round(qcGrid.getBoundingClientRect().top / uiZoom() + window.scrollY);
    const avail = Math.max(420, viewH() - top - BOTTOM_PAD);
    const left = document.querySelector('.qcleft'), side = document.getElementById('sidebar');
    left.style.height = (avail + BOTTOM_PAD) + 'px'; side.style.height = (avail + BOTTOM_PAD) + 'px';
    const tl = document.getElementById('timeline');
    const tlH = tl.offsetHeight;
    const fullH = avail - tlH;
    // Base layout (the 1640 x 840 design): file panel 270 px, event table 664 px, player in between.
    // Extra height makes the picture bigger (16:9, so it then takes width too). Width the picture can't
    // use, because the window isn't tall enough for it, is shared out in proportion between the file
    // panel and the table (and the table shares it among its columns). The details panel under the bar
    // always gets DETAIL_H, so it never scrolls.
    const LEFT_W = 270, RIGHT_W = EV_TABLE_W, DETAIL_H = 152;
    const total = qcGrid.clientWidth;
    const maxPicH = fullH - DETAIL_H;
    let midW = total - LEFT_W - RIGHT_W, lw = LEFT_W, rw = RIGHT_W;
    if (midW * 9 / 16 > maxPicH) {
      const pictureW = Math.round(maxPicH * 16 / 9), f = (total - pictureW) / (LEFT_W + RIGHT_W);
      lw = Math.round(LEFT_W * f); rw = total - lw - pictureW; midW = pictureW;
    }
    const wide = viewW() >= 1100;
    qcGrid.style.gridTemplateColumns = wide ? `${lw}px minmax(0,1fr) ${rw}px` : '';
    document.documentElement.style.setProperty('--left-w', lw + 'px');
    const picH = Math.max(160, Math.min(maxPicH, Math.round(midW * 9 / 16)));
    const stageH = picH;
    stage.parentElement.style.height = (avail + BOTTOM_PAD) + 'px';
    tlDirty = true;   // the bar's width changed: redraw it at its new size (otherwise it looks stretched)
    const vp = document.querySelector('.qcleft .vpanel'), sp = document.querySelector('.qcleft .spanel');
    const GUTTER = 6, colH = avail + BOTTOM_PAD;
    const vH = Math.round((colH - GUTTER) / 2);
    vp.style.height = vH + 'px'; sp.style.height = (colH - GUTTER - vH) + 'px';
    fitStage(stageH);
  }
  // The black video area is stageH tall; the picture is the largest that fits, centred.
  function fitStage(stageH) {
    stage.style.height = stageH + 'px';
    const ph = document.getElementById('placeholder');
    if (ph && ph.isConnected) {
      // No video yet: an empty 16:9 black player, centred, like a loaded video would be.
      let w = stage.clientWidth, h = w * 9 / 16;
      if (h > stageH || stageH - h < 3) { h = stageH; w = Math.min(stage.clientWidth, h * 16 / 9); }
      ph.style.width = Math.floor(w) + 'px'; ph.style.height = Math.floor(h) + 'px';
    }
    if (video) {
      // Largest size that fits the black area, keeping the aspect ratio; centred inside it.
      const W = stage.clientWidth, ar = (video.videoWidth && video.videoHeight) ? video.videoWidth / video.videoHeight : 16 / 9;
      let w = W, h = W / ar;
      if (h > stageH || stageH - h < 3) { h = stageH; w = Math.min(W, h * ar); }
      video.style.width = Math.floor(w) + 'px'; video.style.height = Math.floor(h) + 'px';
      syncOverlaySize();
    }
  }
  window.addEventListener('resize', layoutQC);
  // Re-fit whenever the bar's own height changes (e.g. the FPS lines fill in).
  if (window.ResizeObserver) { let lastH = 0; new ResizeObserver(() => { const h = document.getElementById('timeline').offsetHeight; if (h !== lastH) { lastH = h; layoutQC(); } }).observe(document.getElementById('timeline')); }
  window.Player.layout = layoutQC;

  // ---------------------------------------------------------------- FPS display (read-only; override only if the video's rate is unknown)
  const STD_FPS = [[24000 / 1001, '23.976'], [24, '24'], [25, '25'], [30000 / 1001, '29.97'], [30, '30']];
  const fpsLabel = v => { const m = STD_FPS.find(([r]) => Math.abs(r - v) < 0.01); return m ? m[1] : (+v.toFixed(3)).toString(); };
  const fpsBox = document.getElementById('fpsDisplay');
  let fpsKey = '';
  function updateFps() {
    const loaded = !!(video && video.currentSrc);
    const vf = vmeta.fps || fpsOverride || 0;
    const sf = cueList.length && window.Player.subtitleHasFps() ? docEffectiveFrameRate : 0;
    const key = [loaded, vmeta.fps, fpsOverride, sf].join('|');
    if (key === fpsKey) return;
    fpsKey = key;
    let html = '<span class="k">Video fps</span>';
    if (loaded && !vmeta.fps) {
      html += `<select id="fpsOverride" title="The video's frame rate couldn't be read. Pick it to keep frame steps and timecode exact.">` +
        `<option value="">?</option>` + STD_FPS.map(([r, l]) => `<option value="${r}"${Math.abs(r - fpsOverride) < 0.001 ? ' selected' : ''}>${l}</option>`).join('') + `</select>`;
    } else html += vf ? `<span>${fpsLabel(vf)}</span>` : '<span class="muted">—</span>';
    // SCC timecode is 29.97 by convention and plays in sync with any video rate.
    const scc = window.Player.subtitleFormat && window.Player.subtitleFormat() === 'SCC' && Math.abs(sf - 29.97) < 0.01;
    const mismatch = vf && sf && !scc && Math.abs(vf - sf) > 0.01;
    const tip = scc ? 'SCC captions are timed in 29.97 timecode by convention. They stay in sync with any video frame rate.' : mismatch ? 'The subtitle file declares a different frame rate than the video — timing will drift.' : "The subtitle file's declared frame rate.";
    html += `<span class="k">Subs fps</span>` + (sf ? `<span class="${mismatch ? 'mis' : ''}" title="${tip}">${fpsLabel(sf)}${scc ? ' SCC' : ''}${mismatch ? ' ⚠' : ''}</span>` : '<span class="muted">—</span>');
    fpsBox.innerHTML = html;
    const sel = document.getElementById('fpsOverride');
    if (sel) sel.addEventListener('change', () => { fpsOverride = +sel.value || 0; vmeta.fps = 0; tlDirty = true; updateFps(); });
  }

  // ---------------------------------------------------------------- offset field with fixed colons
  // Digits overwrite in place (colons are skipped); Backspace zeroes the previous digit.
  (function maskOffset() {
    const el = offsetInput;
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    const raw = { get: () => desc.get.call(el), set: v => desc.set.call(el, v) };
    const norm = v => {
      const sign = /^\s*-/.test(v) ? '-' : '';
      const d = (String(v).replace(/\D/g, '') + '00000000').slice(0, 8);
      return sign + d.replace(/(\d\d)(\d\d)(\d\d)(\d\d)/, '$1:$2:$3:$4');
    };
    const nominal = () => Math.round(fps()) || 24;
    // hh 00-23, mm 00-59, ss 00-59, ff below the frame rate
    function valid(v) {
      const m = v.replace(/^-/, '').match(/^(\d\d):(\d\d):(\d\d):(\d\d)$/);
      return !!m && +m[1] <= 23 && +m[2] <= 59 && +m[3] <= 59 && +m[4] < nominal();
    }
    // Is this single digit acceptable at this position (checking only what is known so far)?
    function digitOk(v, p, d) {
      const off = v.startsWith('-') ? 1 : 0, i = p - off;           // 0..10 inside hh:mm:ss:ff
      const field = Math.floor(i / 3), tens = i % 3 === 0;
      const units = tens ? null : +v[p - 1];
      const max = [23, 59, 59, nominal() - 1][field];
      if (tens) return d * 10 <= max;
      return units * 10 + d <= max;
    }
    const digitPos = (v, i) => i >= 0 && i < v.length && /\d/.test(v[i]);
    const firstDigit = () => raw.get().search(/\d/);
    let atFocus = raw.get(), lastGood = raw.get();
    function flash() { el.classList.add('bad'); setTimeout(() => el.classList.remove('bad'), 350); }
    function commit() {
      const v = raw.get();
      if (!valid(v)) { el.classList.add('err'); el.title = 'Not a valid timecode: hours 00–23, minutes and seconds 00–59, frames below ' + nominal() + '.'; return; }
      el.classList.remove('err');
      lastGood = v;
      if (v !== atFocus) { atFocus = v; const ev = new Event('change'); ev.userEdit = true; el.dispatchEvent(ev); }
    }
    raw.set(norm(raw.get()));
    // Editing works like the playhead timecode: the first click selects the value; typing replaces it
    // with just what you type (digits, colons optional); Enter applies, Esc or clicking away cancels.
    // Short entries count from the right, missing digits are zeros ("1200" -> 00:00:12:00).
    const parseEntry = (str) => {
      str = (str || '').trim();
      const neg = /^-/.test(str); str = str.replace(/^[-+]/, '');
      const v = parseTypedTC(str);
      if (!v) return null;
      const out = (neg ? '-' : '') + v.map(n => String(n).padStart(2, '0')).join(':');
      return valid(out) ? out : null;
    };
    let editing = false;
    // The browser's own 'change' (fired on blur while typing) must not apply a half-typed value;
    // only Enter (commit) applies it.
    el.addEventListener('change', (e) => { if (e.isTrusted) e.stopImmediatePropagation(); }, true);
    el.addEventListener('mousedown', (e) => {
      if (document.activeElement === el) return;
      e.preventDefault(); el.focus(); el.select();
    });
    el.addEventListener('focus', () => { atFocus = raw.get(); editing = false; });
    el.addEventListener('blur', () => { raw.set(lastGood); editing = false; el.classList.remove('err'); });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const v = editing ? parseEntry(raw.get()) : raw.get();
        if (!v) { el.blur(); return; }   // invalid entry: keep the previous value
        raw.set(v); editing = false; commit(); el.blur(); return;
      }
      if (e.key === 'Escape') { e.preventDefault(); el.blur(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;   // shortcuts, arrows, backspace
      if (!/[\d:;.\-+]/.test(e.key)) { e.preventDefault(); return; }
      if (!editing) { editing = true; raw.set(''); }   // the first key starts a fresh entry
      el.classList.remove('err');
    });
    el.addEventListener('input', () => {
      if (!editing) { editing = true; }
      const p = el.selectionStart, clean = raw.get().replace(/[^\d:;.\-+]/g, '').slice(0, 12);
      if (clean !== raw.get()) { raw.set(clean); el.setSelectionRange(p, p); }
    });
    el.addEventListener('paste', (e) => {
      e.preventDefault();
      const t = (e.clipboardData.getData('text') || '').trim().replace(/[^\d:;.\-+]/g, '').slice(0, 12);
      editing = true; el.setRangeText(t, el.selectionStart, el.selectionEnd, 'end');
    });
    el.addEventListener('drop', (e) => e.preventDefault());
    // Keep the format when the value is set by the program (timecode track, remembered offset, ± button).
    Object.defineProperty(el, 'value', { get() { return raw.get(); }, set(v) { raw.set(/\d/.test(String(v)) ? norm(String(v)) : String(v)); if (valid(raw.get())) { lastGood = raw.get(); el.classList.remove('err'); } } });
  })();
  // The offset/fps panel shows two lines; the full messages are in the tooltips.
  const offSt = document.getElementById('offsetStatus'), fpsSt = document.getElementById('qcFrameRateStatus');
  new MutationObserver(() => {
    const oi = document.getElementById('offsetInput');
    const t = offSt.textContent || '';
    const src = /timecode track \(/.test(t) ? "read from the video's timecode track"
      : /remembered/i.test(t) ? 'remembered for this video'
      : /adjusted to the subtitle timing/.test(t) ? 'set from the subtitle timing, because ' + ((t.match(/\(([^)]*) didn't line up/) || [])[1] || 'the previous value') + " didn't line up with the subtitles"
      : /guessed/.test(t) ? 'no timecode track in this video, so taken from the subtitle timing'
      : /no timecode track/i.test(t) ? 'no timecode track in this video'
      : /Flipped/.test(t) ? 'sign flipped with ±' : '';
    oi.title = 'Video start timecode' + (src ? ' (' + src + ')' : '') + '. Click to select, type a new one and press Enter.';
    oi.classList.toggle('err', offSt.classList.contains('err'));
  }).observe(offSt, { childList: true, characterData: true, subtree: true, attributes: true });
  new MutationObserver(() => { document.getElementById('qcFrameRateInput').title = fpsSt.textContent || "The subtitle file's declared frame rate."; }).observe(fpsSt, { childList: true, characterData: true, subtree: true });

  window.Player.waveState = () => ({ state: wf.state, msg: wf.msg, sel: wf.sel, total: wf.total, view: { ...view }, frame: currentFrame(), tc: tcDisplay.textContent });
