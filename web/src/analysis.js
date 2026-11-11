/* ==========================================================================
   Video analysis: a batch job over a folder of videos, separate from QC.
   Finds commercial blacks and opening credits (on-screen text later) and keeps the
   results per video, for the QC page to use. One results file per video in a
   "Subtitle QC Data" folder next to the videos (Mac app). The web version is a preview:
   it simulates the analysis and keeps the results in the browser, so the window, the
   queue and the results can be tried without the Mac app.
   ========================================================================== */
const Analysis = (() => {
  const FORMAT = 'subtitle-qc-analysis', VERSION = 1, DATA_DIR = 'Subtitle QC Data';
  const TYPES = [
    { key: 'blacks', label: 'Commercial blacks', head: 'Blacks' },
    { key: 'credits', label: 'Opening credits', head: 'Opening credits' },
    { key: 'text', label: 'On-screen text', head: 'On-screen text', later: true },
  ];
  // Settings each result is made with; a result made with older settings shows as Outdated.
  const SETTINGS = {
    blacks: { v: 1, pixelLevel: 0.10, pictureShare: 0.98, minSeconds: 0.25, coarsePerSecond: 4 },
    credits: { v: 1, searchMinutes: 20, coarseStepSeconds: 4, joinGapSeconds: 30 },
  };
  const SIMULATED = !NATIVE;                 // the real engine lives in the Mac app

  // ------------------------------------------------------------ results store
  // By video file name; each result carries the fingerprint of the file it was made from.
  const store = new Map();
  const memKey = name => 'analysis:' + name;
  function loadStored(name) {
    if (store.has(name)) return store.get(name);
    let r = null;
    try { const s = localStorage.getItem(memKey(name)); r = s ? JSON.parse(s) : null; } catch (e) { r = null; }
    if (r && r.format === FORMAT) store.set(name, r);
    return store.get(name) || null;
  }
  function saveResult(name, r) {
    store.set(name, r);
    // Mac app: written to "Subtitle QC Data/<video>.analysis.json" (next step). Web preview: kept in the browser.
    try { localStorage.setItem(memKey(name), JSON.stringify(r)); } catch (e) { /* storage full or blocked */ }
    window.dispatchEvent(new CustomEvent('analysis-updated', { detail: { name } }));
  }
  // Results files that are already in the folder (from the Mac app, maybe on another machine).
  async function readDataDir(handle) {
    if (!handle || !handle.getDirectoryHandle) return;
    let dir;
    try { dir = await handle.getDirectoryHandle(DATA_DIR); } catch (e) { return; }
    for await (const [fname, h] of dir.entries()) {
      if (h.kind !== 'file' || !/\.analysis\.json$/i.test(fname)) continue;
      try {
        const r = JSON.parse(await (await h.getFile()).text());
        if (r && r.format === FORMAT && r.video && r.video.name) store.set(r.video.name, r);
      } catch (e) { /* not ours, or damaged */ }
    }
  }

  // ------------------------------------------------------------ fingerprint
  // Size plus a hash of three 64 KB pieces (start, middle, end): quick even for a 75 GB file,
  // and changes when the file is re-rendered. Matched by content, not by name.
  const fpCache = new Map();
  async function fingerprint(file) {
    const key = file.name + '|' + file.size + '|' + file.lastModified;
    if (fpCache.has(key)) return fpCache.get(key);
    const piece = 65536, n = file.size;
    const parts = [0, Math.max(0, Math.floor(n / 2) - piece / 2), Math.max(0, n - piece)].map(o => file.slice(o, Math.min(n, o + piece)));
    const buf = new Uint8Array(await new Blob(parts).arrayBuffer());
    let hex;
    if (window.crypto && crypto.subtle) {
      const h = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
      hex = [...h.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('');
    } else {   // no crypto (unusual): FNV-1a
      let h = 0x811c9dc5; for (const b of buf) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
      hex = h.toString(16).padStart(8, '0');
    }
    const fp = `${n}-${hex}`;
    fpCache.set(key, fp);
    return fp;
  }

  // Status of one analysis type for one video: none | done | outdated
  function typeStatus(r, fp, key) {
    const t = r && r[key];
    if (!t) return { state: 'none' };
    if (fp && r.video && r.video.fingerprint !== fp) return { state: 'outdated', why: 'The video file has changed since it was analysed', at: t.analysedAt };
    if (!t.settings || t.settings.v !== SETTINGS[key].v) return { state: 'outdated', why: 'Analysed with older settings', at: t.analysedAt };
    return { state: 'done', at: t.analysedAt, simulated: !!r.simulated };
  }

  // ------------------------------------------------------------ simulated engine (web preview)
  function rng(seedStr) {
    let h = 2166136261; for (const ch of seedStr) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
    return () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const NAMES = ['Alex Moreno', 'Dana Whitfield', 'Sam Okafor', 'Rita Castellanos', 'Jonah Pike', 'Mira Lindqvist', 'Theo Grant', 'Ines Varga', 'Paul Ambrose', 'Lena Hart', 'Oscar Bell', 'Nadia Rahman', 'Victor Lowe', 'Hana Sato'];
  const ROLES = ['Starring', 'Starring', 'Starring', 'Also starring', 'Casting by', 'Music by', 'Costume Designer', 'Edited by', 'Production Designer', 'Director of Photography', 'Co-Producer', 'Producer', 'Executive Producer', 'Executive Producer', 'Written by'];
  const r3 = x => Math.round(x * 1000) / 1000;
  function simBlacks(d, R) {
    const items = [], n = 3 + Math.floor(R() * 3);
    for (let k = 1; k <= n; k++) {
      const at = d * k / (n + 1) + (R() - 0.5) * 180, len = 0.5 + R() * 1.5;
      if (at > 30 && at < d - 30) items.push({ in: r3(at), out: r3(at + len) });
    }
    items.push({ in: r3(Math.max(0, d - 1 - R())), out: r3(d) });
    return { items };
  }
  function simCredits(d, R) {
    if (d < 300 || R() < 0.1) return { confirmed: false, directedBy: null, runs: [], cards: [] };   // nothing found
    const cards = [];
    const card = (t, len, text, place) => {
      const y = place === 'mid' ? 0.45 : 0.78 + R() * 0.06, x = place === 'left' ? 0.07 : place === 'right' ? 0.6 : 0.33;
      cards.push({ in: r3(t), out: r3(t + len), text, boxes: [[r3(x), r3(y), place === 'mid' ? 0.34 : 0.3, 0.05], [r3(x + 0.02), r3(y + 0.055), 0.24, 0.04]] });
    };
    // main titles: a few cards with the show's title
    let t = 30 + R() * 40;
    for (let i = 0; i < 2 + Math.floor(R() * 3); i++) { card(t, 2 + R() * 1.5, i ? `${ROLES[i]} ${NAMES[i]}` : 'Main title', 'mid'); t += 4 + R() * 3; }
    // opening credits over the first scenes, with a break or two
    t = Math.min(120 + R() * 780, d * 0.4);
    const n = Math.max(3, Math.min(10 + Math.floor(R() * 25), Math.floor((d * 0.9 - t) / 8)));
    for (let i = 0; i < n; i++) {
      const last = i === n - 1;
      card(t, 2 + R() * 1.5, last ? `Directed by ${NAMES[Math.floor(R() * NAMES.length)]}` : `${ROLES[i % ROLES.length]} ${NAMES[Math.floor(R() * NAMES.length)]}`, R() < 0.5 ? 'left' : 'right');
      t += 4 + R() * 4 + (R() < 0.08 ? 20 + R() * 60 : 0);
    }
    const runs = [];
    for (const c of cards) {
      const last = runs[runs.length - 1];
      if (last && c.in - last.out <= SETTINGS.credits.joinGapSeconds) last.out = c.out; else runs.push({ in: c.in, out: c.out });
    }
    const db = cards[cards.length - 1];
    return { confirmed: true, directedBy: { in: db.in, out: db.out, text: db.text }, runs, cards };
  }
  // Runs one analysis type on one video, reporting progress; simulated time scales with the length.
  async function runType(row, key, onProgress, stopped) {
    const R = rng(row.fp + key), d = row.duration || 2700;
    const secs = key === 'blacks' ? 2 + d / 1500 : 1.5 + Math.min(d, 1200) / 700;
    const t0 = performance.now();
    for (;;) {
      if (stopped()) throw new Error('stopped');
      const p = Math.min(1, (performance.now() - t0) / 1000 / secs);
      onProgress(p);
      if (p >= 1) break;
      await new Promise(r => setTimeout(r, 120));
    }
    return key === 'blacks' ? simBlacks(d, R) : simCredits(d, R);
  }

  // ------------------------------------------------------------ the window
  let rows = [], running = false, stopReq = false, built = false, sourceHandle = null, sourceLabel = '', ownFolder = false;
  let queueInfo = null;
  const typeOn = { blacks: Store.get('ana:t:blacks') !== '0', credits: Store.get('ana:t:credits') !== '0' };
  let skipDone = Store.get('ana:skip') !== '0';

  function fmtLen(s) {
    if (s == null) return '—';
    s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60, p = n => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
  }
  function fmtAt(iso) {
    if (!iso) return '';
    const d = new Date(iso); if (isNaN(d)) return '';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  function build() {
    if (built) return; built = true;
    const m = document.createElement('div');
    m.className = 'modal-bg'; m.id = 'anaModal'; m.hidden = true;
    m.innerHTML = `
      <div class="modal ana" role="dialog" aria-label="Video analysis">
        <div class="modal-h"><b>Video analysis</b>${SIMULATED ? '<span class="ana-sim" title="The web version simulates the analysis so the window can be tried; results are kept in this browser only. The real analysis runs in the Mac app.">Preview · simulated results</span>' : ''}<span class="spacer"></span><button class="btn sm" id="anaClose">Close</button></div>
        <div class="ana-body">
          <div class="ana-row"><span class="ana-k">Folder</span><span class="ana-folder" id="anaFolder"></span><button class="btn sm" id="anaChange">Change…</button><button class="btn sm" id="anaUseQc" hidden>Use the QC videos folder</button></div>
          <div class="ana-row"><span class="ana-k">Run</span>${TYPES.map(t => `<label class="ana-chk${t.later ? ' later' : ''}"${t.later ? ' title="Coming later"' : ''}><input type="checkbox" data-type="${t.key}"${t.later ? ' disabled' : typeOn[t.key] ? ' checked' : ''}> ${t.label}${t.later ? ' <i>(later)</i>' : ''}</label>`).join('')}</div>
          <div class="ana-tablewrap"><table class="ana-table"><colgroup><col class="c-c"><col class="c-f"><col class="c-l">${TYPES.map(() => '<col class="c-t">').join('')}</colgroup>
            <thead><tr><th><input type="checkbox" id="anaAll" title="Select all"></th><th>File</th><th>Length</th>${TYPES.map(t => `<th${t.later ? ' class="later"' : ''}>${t.head}</th>`).join('')}</tr></thead>
            <tbody id="anaBody"></tbody></table></div>
        </div>
        <div class="ana-foot">
          <button class="btn primary" id="anaStart">Start</button><button class="btn" id="anaStop" disabled>Stop</button>
          <span class="ana-sum" id="anaSum"></span><span class="spacer"></span>
          <label class="ana-chk"><input type="checkbox" id="anaSkip"${skipDone ? ' checked' : ''}> Skip what's already analysed</label>
          <label class="ana-chk${NATIVE ? '' : ' off'}" title="${NATIVE ? 'The Mac stays awake until the queue is finished (the display can still sleep)' : 'Mac app only'}"><input type="checkbox" id="anaAwake"${NATIVE ? ' checked' : ' disabled'}> Keep this Mac awake until finished</label>
        </div>
      </div>`;
    document.body.appendChild(m);
    $('#anaClose').onclick = close;
    m.addEventListener('mousedown', e => { if (e.target === m) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !m.hidden) close(); });
    m.querySelectorAll('input[data-type]').forEach(cb => cb.onchange = () => { typeOn[cb.dataset.type] = cb.checked; Store.set('ana:t:' + cb.dataset.type, cb.checked ? '1' : '0'); render(); });
    $('#anaSkip').onchange = e => { skipDone = e.target.checked; Store.set('ana:skip', skipDone ? '1' : '0'); render(); };
    $('#anaAll').onchange = e => { if (running) return; rows.forEach(r => r.checked = e.target.checked); render(); };
    $('#anaBody').addEventListener('change', e => { const cb = e.target.closest('input[data-i]'); if (cb && !running) { rows[+cb.dataset.i].checked = cb.checked; render(); } });
    $('#anaStart').onclick = start;
    $('#anaStop').onclick = () => { stopReq = true; };
    $('#anaChange').onclick = changeFolder;
    $('#anaUseQc').onclick = () => { ownFolder = false; refresh(); };
    $('#anaChange').hidden = NATIVE;   // Mac app: its own folder choice comes with the separate window
  }
  async function changeFolder() {
    if (running || !window.showDirectoryPicker) return;
    let dir; try { dir = await window.showDirectoryPicker({ mode: 'read', id: 'analysis' }); } catch (e) { return; }
    ownFolder = true; sourceHandle = dir; sourceLabel = dir.name;
    await loadRows((await listDir(dir, VIDEO_EXT)));
  }
  // The QC page's videos folder, every video in it (Matched only doesn't apply here).
  async function refresh() {
    if (running || ownFolder) { render(); return; }
    sourceHandle = state.vidHandle; sourceLabel = state.vidFolder || '';
    const files = [...state.videos.map(v => v.file), ...state.ignoredVideos.map(v => v.file)];
    await loadRows(files);
  }
  async function loadRows(files) {
    files = files.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    await readDataDir(sourceHandle);
    const old = new Map(rows.map(r => [r.name, r]));
    rows = files.map(f => {
      const qv = state.videos.find(v => v.name === f.name), ig = state.ignoredVideos.find(v => v.name === f.name);
      const prev = old.get(f.name);
      return { file: f, name: f.name, size: f.size, duration: qv && qv.probe ? qv.probe.duration : null, fps: qv && qv.probe ? qv.probe.fps : null,
        short: ig ? ig.reason : '', checked: prev ? prev.checked : !ig, fp: null, live: {} };
    });
    render();
    for (const r of rows) {           // lengths and fingerprints, filled in as they come
      if (r.duration == null) { try { const p = await TimecodeTrack.probe(r.file); r.duration = p && p.duration; r.fps = p && p.fps; } catch (e) { /* unreadable */ } }
      try { r.fp = await fingerprint(r.file); } catch (e) { r.fp = null; r.err = 'The file can\'t be read'; }
      loadStored(r.name);
      renderRow(r);
    }
    render();
  }
  function cellHtml(r, t) {
    if (t.later) return '<span class="ana-dim">—</span>';
    const lv = r.live[t.key];
    if (lv) {
      if (lv.state === 'queued') return '<span class="ana-dim">Queued</span>';
      if (lv.state === 'running') return `<span class="ana-run"><span class="ana-bar"><i style="width:${Math.round(lv.p * 100)}%"></i></span>${Math.round(lv.p * 100)}%</span>`;
      if (lv.state === 'failed') return `<span class="ana-bad" title="${esc(lv.msg || '')}">Failed</span>`;
    }
    const st = typeStatus(store.get(r.name), r.fp, t.key);
    if (st.state === 'done') return `<span class="ana-ok">✓</span> ${esc(fmtAt(st.at))}${st.simulated && !SIMULATED ? ' <span class="ana-dim">(simulated)</span>' : ''}`;
    if (st.state === 'outdated') return `<span class="ana-warn" title="${esc(st.why)}">Outdated</span>`;
    return '<span class="ana-dim">—</span>';
  }
  function rowHtml(r, i) {
    return `<tr data-i="${i}" class="${r.checked ? '' : 'off'}"><td><input type="checkbox" data-i="${i}"${r.checked ? ' checked' : ''}${running ? ' disabled' : ''}></td>
      <td class="ana-file"><div>${esc(r.name)}</div>${r.short ? `<div class="ana-note">${esc(r.short)}</div>` : ''}${r.err ? `<div class="ana-note bad">${esc(r.err)}</div>` : ''}</td>
      <td class="ana-len">${fmtLen(r.duration)}</td>${TYPES.map(t => `<td class="${t.later ? 'later' : ''}">${cellHtml(r, t)}</td>`).join('')}</tr>`;
  }
  function renderRow(r) {
    const i = rows.indexOf(r), tr = document.querySelector(`#anaBody tr[data-i="${i}"]`);
    if (tr) tr.outerHTML = rowHtml(r, i);
  }
  function plan() {
    const keys = TYPES.filter(t => !t.later && typeOn[t.key]).map(t => t.key), jobs = [];
    for (const r of rows) {
      if (!r.checked || r.err) continue;
      const ks = keys.filter(k => !(skipDone && typeStatus(store.get(r.name), r.fp, k).state === 'done'));
      if (ks.length) jobs.push({ row: r, keys: ks });
    }
    return jobs;
  }
  function render() {
    if (!built) return;
    $('#anaFolder').textContent = sourceLabel || (rows.length ? '' : 'No videos folder yet: choose one on the QC page or here');
    $('#anaUseQc').hidden = !ownFolder || running;
    $('#anaBody').innerHTML = rows.length ? rows.map(rowHtml).join('') : `<tr><td colspan="${3 + TYPES.length}" class="ana-empty">No video files in this folder.</td></tr>`;
    const all = $('#anaAll'); all.checked = rows.length > 0 && rows.every(r => r.checked); all.indeterminate = rows.some(r => r.checked) && !all.checked; all.disabled = running;
    const jobs = plan();
    $('#anaStart').disabled = running || !jobs.length;
    $('#anaStop').disabled = !running;
    document.querySelectorAll('#anaModal input[data-type], #anaSkip').forEach(i => i.disabled = running || i.closest('.later'));
    if (!running) $('#anaSum').textContent = !rows.length ? '' : jobs.length ? `${jobs.length} video${jobs.length === 1 ? '' : 's'} to analyse` : rows.some(r => r.checked) ? 'Nothing to do: already analysed (untick “Skip” to run again)' : 'Tick the videos to analyse';
    updateHeaderButton();
  }
  function updateHeaderButton() {
    const b = $('#anaBtn'); if (!b) return;
    b.classList.toggle('busy', running);
    b.textContent = running && queueInfo ? `Analysing ${queueInfo.done + 1} of ${queueInfo.total}…` : 'Analyse videos';
  }
  async function start() {
    const jobs = plan();
    if (running || !jobs.length) return;
    running = true; stopReq = false;
    for (const j of jobs) for (const k of j.keys) j.row.live[k] = { state: 'queued' };
    queueInfo = { done: 0, total: jobs.length, t0: performance.now(), failed: 0 };
    render();
    let doneSecs = 0, workSecs = 0;   // for the time-left estimate
    const totalLen = jobs.reduce((s, j) => s + (j.row.duration || 2700) * j.keys.length, 0);
    for (const j of jobs) {
      if (stopReq) break;
      const r = j.row;
      const prev = store.get(r.name), same = prev && prev.video && prev.video.fingerprint === r.fp;
      // a changed file starts over; otherwise other types already done are kept
      const res = Object.assign({}, same ? prev : {}, { format: FORMAT, version: VERSION, app: APP_VERSION, simulated: SIMULATED || undefined });
      res.video = { name: r.name, size: r.size, duration: r.duration, fps: r.fps, fingerprint: r.fp };
      for (const k of j.keys) {
        if (stopReq) break;
        r.live[k] = { state: 'running', p: 0 };
        const t0 = performance.now();
        try {
          const out = await runType(r, k, p => {
            r.live[k].p = p; renderRow(r);
            const el = (performance.now() - queueInfo.t0) / 1000, part = doneSecs + p * (r.duration || 2700);
            if (part > 0 && el > 1.5) $('#anaSum').textContent = `${queueInfo.done + 1} of ${queueInfo.total} · about ${fmtLeft(el / part * (totalLen - part))} left`;
            updateHeaderButton();
          }, () => stopReq);
          res[k] = Object.assign({ analysedAt: new Date().toISOString(), settings: SETTINGS[k] }, out);
          delete r.live[k];
        } catch (e) {
          if (stopReq) { delete r.live[k]; break; }
          r.live[k] = { state: 'failed', msg: e && e.message || 'Unknown error' }; queueInfo.failed++;
        }
        doneSecs += r.duration || 2700; workSecs += (performance.now() - t0) / 1000;
        saveResult(r.name, res);        // after each type: a stop or a crash keeps what's done
        renderRow(r);
      }
      queueInfo.done++;
    }
    for (const r of rows) for (const k of Object.keys(r.live)) if (r.live[k].state === 'queued' || r.live[k].state === 'running') delete r.live[k];
    const q = queueInfo; running = false;
    const doneN = q.done - (stopReq ? 1 : 0);
    queueInfo = null; render();
    $('#anaSum').textContent = stopReq ? `Stopped · ${Math.max(0, doneN)} of ${q.total} done` : `Finished · ${q.total} video${q.total === 1 ? '' : 's'} analysed${q.failed ? `, ${q.failed} failed` : ''}`;
    stopReq = false;
  }
  function fmtLeft(s) { s = Math.max(1, Math.round(s)); return s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`; }
  function open() { build(); $('#anaModal').hidden = false; refresh(); }
  function close() { if (built) $('#anaModal').hidden = true; }

  // ------------------------------------------------------------ for the QC page
  // Results for a video if they match the file (null otherwise), and a short status line.
  async function forVideo(v) {
    if (!v || !v.file) return null;
    const r = loadStored(v.name); if (!r) return null;
    const fp = await fingerprint(v.file);
    return r.video && r.video.fingerprint === fp ? r : null;
  }
  async function statusLine(v) {
    const r = loadStored(v.name);
    if (!r) return 'Not analysed';
    const fp = await fingerprint(v.file);
    const bits = TYPES.filter(t => !t.later).map(t => {
      const s = typeStatus(r, fp, t.key);
      return s.state === 'done' ? `${t.head} ✓` : s.state === 'outdated' ? `${t.head}: outdated` : null;
    }).filter(Boolean);
    return bits.length ? bits.join(' · ') + (r.simulated ? ' (simulated)' : '') : 'Not analysed';
  }
  window.addEventListener('qc-videos-changed', () => { if (built && !$('#anaModal').hidden) refresh(); });

  return { open, close, forVideo, statusLine, fingerprint, TYPES, DATA_DIR };
})();
