/* ==========================================================================
   Video analysis: its own workflow (start screen ▸ Video Analysis), a batch job over a folder of videos.
   Finds on-screen text (web version: the lab's engine, see textdetect.js), and in the Mac app commercial blacks
   (native engine: mac/Sources/Analysis.swift). The opening-credits reader (AnalysisCredits.swift) is no longer offered;
   results made with it still show.

   Results ("markers") are kept in a visible VideoMarkers folder, one file per video (<video name>.markers.json):
   - a video in a delivery folder (Encodes / _Encodes / QC_PASS / QC_FAIL, or below one): VideoMarkers sits beside
     the topmost of them, never inside;
   - otherwise: VideoMarkers inside the video's own folder (proxies, for example).
   The QC page finds markers for a video by name, or by episode (Match.episodeKey: a proxy's markers serve its
   encode and the other way round) when the length agrees within a second. Fallback: Link markers folder….

   Mac app: Video Analysis has its own window (Window ▸ Video Analysis), this same page in "window" mode.
   ========================================================================== */
const Analysis = (() => {
  const FORMAT = 'video-markers', VERSION = 1, MARKERS_DIR = 'VideoMarkers', SUFFIX = '.markers.json';
  const DELIVERY = /^(_?encodes|qc[ _-]?(pass|fail))$/i;
  const TEXT = typeof TextDetect !== 'undefined' && !!TextDetect;
  const TYPES = [
    { key: 'text', label: 'On-screen text', head: 'On-screen text', can: !NATIVE && TEXT, why: NATIVE ? 'Coming to the Mac app later (it runs in the web version)' : 'Not in this build of the web version' },
    { key: 'blacks', label: 'Commercial blacks', head: 'Blacks', can: NATIVE, why: 'Mac app only for now' },
  ];
  // Settings each result is made with; a result made with older settings shows as Outdated.
  const SETTINGS = {
    // Black frame: pictureShare of the picture at or below pixelLevel. Kept from minSeconds. Silent: sound at or
    // below silenceDb (dBFS, RMS) across the black. Blacks with sound (inside a scene) are left out.
    blacks: { v: 3, pixelLevel: 0.10, pictureShare: 0.98, minSeconds: 0.25, silenceDb: -50 },
    // Every piece of text over the whole video, without reading it (the lab's rules: TEXT_RULES in text-engine.js).
    // step: a look every 2 s, or every second with the Dense setting.
    text: TEXT ? Object.assign({}, TextDetect.rules) : { v: 2 },
  };
  let dense = Store.get('ana:dense') === '1';
  const settingsFor = key => key === 'text' ? Object.assign({}, SETTINGS.text, { step: dense ? 1 : 2 }) : SETTINGS[key];
  const WINDOW = NATIVE && !!window.__analysisWindow;   // this page is the Mac app's Video Analysis window
  if (WINDOW) document.documentElement.classList.add('ana-window');

  // ------------------------------------------------------------ where markers go
  const dirname = p => String(p || '').replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/';
  // Mac app (paths): the VideoMarkers folder for videos in this folder.
  function markersPathFor(folder) {
    const parts = String(folder || '').replace(/\/+$/, '').split('/');
    for (let i = Math.max(1, parts.length - 4); i < parts.length; i++) if (DELIVERY.test(parts[i])) return parts.slice(0, i).join('/') + '/' + MARKERS_DIR;
    return parts.join('/') + '/' + MARKERS_DIR;
  }
  // Web (folder handles): the folder that holds VideoMarkers for videos in root/segs…, or { needParent } when the
  // delivery folder is the chosen folder itself (a page can't reach above the folder it was given).
  async function markersPlace(root, segs) {
    const names = [root.name, ...segs];
    const i = names.findIndex(n => DELIVERY.test(n));
    if (i === 0) return { needParent: true, label: root.name };
    const upTo = i > 0 ? i - 1 : segs.length;    // walk this many folders down from the chosen one
    let h = root;
    try { for (let k = 0; k < upTo; k++) h = await h.getDirectoryHandle(segs[k]); } catch (e) { return { needParent: false, parent: null }; }
    return { parent: h, label: [...names.slice(0, upTo + 1), MARKERS_DIR].join(' / ') };
  }
  async function markersDir(place, create) {
    if (!place || !place.parent) return null;
    try { return await place.parent.getDirectoryHandle(MARKERS_DIR, create ? { create: true } : undefined); } catch (e) { return null; }
  }

  // ------------------------------------------------------------ reading and writing markers files
  const parse = text => { try { const r = JSON.parse(text); return r && r.format === FORMAT && r.video && r.video.name ? r : null; } catch (e) { return null; } };
  async function readDirHandle(dir) {
    const out = [];
    if (!dir) return out;
    try {
      for await (const [fname, h] of dir.entries()) {
        if (h.kind !== 'file' || !fname.toLowerCase().endsWith(SUFFIX)) continue;
        const r = parse(await (await h.getFile()).text());
        if (r) out.push(Object.assign(r, { _dir: dir.name }));
      }
    } catch (e) { /* not allowed or gone */ }
    return out;
  }
  // Mac app: every markers file in these VideoMarkers folders (and, with `around`, the ones near that folder).
  async function readNative(dirs, around) {
    let list = [];
    try { list = await Native.call('markersRead', { dirs, around: around || '' }); } catch (e) { return []; }
    return (list || []).map(x => { const r = parse(x.json); return r ? Object.assign(r, { _dir: x.dir }) : null; }).filter(Boolean);
  }
  async function writeResult(row, res) {
    const json = JSON.stringify(res, null, 1), fname = row.name + SUFFIX;
    if (NATIVE) { await Native.call('markersWrite', { dir: row.markersPath, name: fname, json }); return; }
    const dir = await markersDir(row.place, true);
    if (!dir) throw new Error('The VideoMarkers folder could not be made here');
    const w = await (await dir.getFileHandle(fname, { create: true })).createWritable();
    await w.write(json); await w.close();
  }

  // ------------------------------------------------------------ fingerprint
  // Size plus a hash of three 64 KB pieces (start, middle, end): quick even for a 75 GB file.
  const fpCache = new Map();
  async function fingerprint(file) {
    const key = file.name + '|' + file.size + '|' + file.lastModified;
    if (fpCache.has(key)) return fpCache.get(key);
    const piece = 65536, n = file.size;
    const parts = await Promise.all([0, Math.max(0, Math.floor(n / 2) - piece / 2), Math.max(0, n - piece)].map(o => file.slice(o, Math.min(n, o + piece)).arrayBuffer()));
    const buf = new Uint8Array(parts.reduce((s, p) => s + p.byteLength, 0));
    parts.reduce((o, p) => { buf.set(new Uint8Array(p), o); return o + p.byteLength; }, 0);
    let hex;
    if (window.crypto && crypto.subtle) {
      const h = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
      hex = [...h.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('');
    } else { let h = 0x811c9dc5; for (const b of buf) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; } hex = h.toString(16).padStart(8, '0'); }
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
    if (key === 'text' && dense && (t.settings.step || 2) > 1) return { state: 'outdated', why: `Analysed with a look every ${t.settings.step || 2} s (Dense is on)`, at: t.analysedAt };
    return { state: 'done', at: t.analysedAt };
  }

  // ------------------------------------------------------------ engines
  const nativeJobs = new Map(); let nativeSeq = 0, nativeCurrent = 0;
  if (NATIVE) Native.on('analysis', m => {
    const j = nativeJobs.get(m.id); if (!j) return;
    if (m.type === 'progress') { j.onProgress(m.p); return; }
    nativeJobs.delete(m.id);
    if (m.type === 'done') j.resolve(m.result); else j.reject(new Error(m.type === 'cancelled' ? 'stopped' : (m.message || 'Unknown error')));
  });
  function runNative(row, key, onProgress) {
    return new Promise((resolve, reject) => {
      const id = nativeCurrent = ++nativeSeq;
      nativeJobs.set(id, { resolve, reject, onProgress });
      Native.call('analysisStart', { id, path: row.file.path, type: key, settings: settingsFor(key) }).catch(e => { nativeJobs.delete(id); reject(new Error(String(e && e.message || e))); });
    });
  }
  async function runType(row, key, onProgress, stopped) {
    if (NATIVE) return runNative(row, key, onProgress);
    if (key === 'text' && TEXT) return TextDetect.run(row.file, { onProgress, stopped, step: dense ? 1 : 2 });
    throw new Error('Not available here');
  }

  // ------------------------------------------------------------ the analysis page / window
  let rows = [], running = false, stopReq = false, built = false, sourceHandle = null, sourceLabel = '', ownFolder = false;
  let queueInfo = null, folderProblem = '', needParent = false;
  // Web, videos in a delivery folder: the folder chosen for the results (it holds the videos folder; VideoMarkers is
  // made beside the topmost delivery folder in it), the path from it down to the videos folder, and what went wrong.
  let resultsRoot = null, resultsRel = null, resultsNote = '', resultsAsk = null;
  const collapsed = new Set((() => { try { return JSON.parse(Store.get('ana:collapsed') || '[]'); } catch (e) { return []; } })());
  let ignOpen = false;
  const probeCache = new Map();   // file key → { probe, reason } (a rescan doesn't read every file again)
  const store = new Map();   // video name → its markers (the videos on this page)
  const typeOn = {}; for (const t of TYPES) typeOn[t.key] = t.can && Store.get('ana:t:' + t.key) !== '0';
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
  const HOME_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11.5 12 5l8 6.5"/><path d="M6.5 10v9h11v-9"/></svg>';
  function build() {
    if (built) return; built = true;
    const m = document.createElement('div');
    m.className = 'modal-bg'; m.id = 'anaModal'; m.hidden = true;
    m.innerHTML = `
      <div class="modal ana" role="dialog" aria-label="Video analysis">
        <div class="modal-h"><button class="textbtn home-btn" id="anaHome" title="Back to the start screen (the analysis keeps running)">${HOME_ICON} Home</button><b>Video Analysis</b><span class="spacer"></span><button class="textbtn" id="anaHelp" title="Where results are kept">Where results go</button></div>
        <div class="ana-body">
          <div class="ana-row"><span class="ana-k">Videos</span><span class="ana-folder" id="anaFolder"></span><button class="btn sm" id="anaChange">Change…</button><button class="btn sm" id="anaRescan" hidden title="Read the folder again">↻ Rescan</button><button class="btn sm" id="anaUseQc" hidden>Use the QC videos folder</button></div>
          <div class="ana-row"><span class="ana-k">Results</span><span class="ana-dest" id="anaDest"></span><button class="btn sm" id="anaPickRes" hidden>Choose…</button></div>
          <div class="ana-note-box" id="anaParent" hidden></div>
          <div class="ana-row"><span class="ana-k">Find</span>${TYPES.map(t => `<label class="ana-chk${t.can ? '' : ' later'}"${t.can ? '' : ` title="${esc(t.why)}"`}><input type="checkbox" data-type="${t.key}"${!t.can ? ' disabled' : typeOn[t.key] ? ' checked' : ''}> ${t.label}${t.can ? '' : ` <i>(${NATIVE ? 'later' : 'Mac app'})</i>`}</label>`).join('')}${TYPES.some(t => t.key === 'text' && t.can) ? `<label class="ana-chk ana-dense" title="On-screen text: a look at every second instead of every 2 seconds, so captions and name cards shorter than 2 s are found too. Takes about 1.5 times as long."><input type="checkbox" id="anaDense"${dense ? ' checked' : ''}> Dense (a look every second, slower)</label>` : ''}</div>
          <div class="ana-tablewrap"><table class="ana-table"><colgroup><col class="c-c"><col class="c-f"><col class="c-l">${TYPES.map(() => '<col class="c-t">').join('')}</colgroup>
            <thead><tr><th><input type="checkbox" id="anaAll" title="Select all"></th><th>File</th><th>Length</th>${TYPES.map(t => `<th${t.can ? '' : ' class="later"'}>${t.head}</th>`).join('')}</tr></thead>
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
    $('#anaHome').onclick = () => { if (WINDOW) Native.post('showHome'); else Home.show(); };
    $('#anaHelp').onclick = () => alert('Results go in a VideoMarkers folder, one file per video, so anyone opening the episode can use them.\n\n• Videos in a delivery folder (Encodes, _Encodes, QC_PASS, QC_FAIL): VideoMarkers sits beside that folder, never inside it.\n• Other videos (proxies, for example): VideoMarkers is inside the videos\' own folder.\n\nMarkers count for the episode: a proxy\'s markers serve its encode, and the other way round, as long as the length agrees.');
    m.querySelectorAll('input[data-type]').forEach(cb => cb.onchange = () => { typeOn[cb.dataset.type] = cb.checked; Store.set('ana:t:' + cb.dataset.type, cb.checked ? '1' : '0'); render(); });
    if ($('#anaDense')) $('#anaDense').onchange = e => { dense = e.target.checked; Store.set('ana:dense', dense ? '1' : '0'); render(); };
    $('#anaSkip').onchange = e => { skipDone = e.target.checked; Store.set('ana:skip', skipDone ? '1' : '0'); render(); };
    $('#anaAll').onchange = e => { if (running) return; rows.forEach(r => r.checked = e.target.checked && !r.blocked && !r.ignored); render(); };
    $('#anaBody').addEventListener('change', e => {
      if (running) return;
      const cb = e.target.closest('input[data-i]'); if (cb) { rows[+cb.dataset.i].checked = cb.checked; render(); return; }
      const g = e.target.closest('input[data-g]'); if (g) { groupRows(g.dataset.g).forEach(r => { if (!r.blocked) r.checked = g.checked; }); render(); }
    });
    $('#anaBody').addEventListener('click', e => {
      if (e.target.closest('#anaReopen')) { reopenLast(); return; }
      if (e.target.closest('input') || e.target.closest('tr.ana-detail')) return;
      // a folder: open / close it
      const gt = e.target.closest('tr[data-g]');
      if (gt) {
        const k = gt.dataset.g;
        if (k === IGN) ignOpen = !ignOpen;
        else { if (collapsed.has(k)) collapsed.delete(k); else collapsed.add(k); Store.set('ana:collapsed', JSON.stringify([...collapsed].slice(-200))); }
        $('#anaBody').innerHTML = bodyHtml(); return;
      }
      // a click on an analysed row shows what was found
      const tr = e.target.closest('tr[data-i]'); if (!tr) return;
      const r = rows[+tr.dataset.i]; if (!r || !hasResults(store.get(r.name))) return;
      r.open = !r.open; $('#anaBody').innerHTML = bodyHtml();
    });
    $('#anaRescan').onclick = rescan;
    $('#anaPickRes').onclick = pickResults;
    $('#anaStart').onclick = start;
    $('#anaStop').onclick = stop;
    $('#anaChange').onclick = changeFolder;
    $('#anaUseQc').onclick = async () => {
      if (running) return;
      if (WINDOW) { Store.del('ana:folder'); const p = await qcFolderPath(); sourceHandle = p ? new Native.NDir(p) : null; }
      ownFolder = false;
      refresh();
    };
    $('#anaAwake').onchange = e => { Store.set('ana:awake', e.target.checked ? '1' : '0'); tellApp(true); };
    if (NATIVE) $('#anaAwake').checked = Store.get('ana:awake') !== '0';
    // a folder dropped on the page (web)
    if (!NATIVE) m.addEventListener('dragover', e => e.preventDefault());
    if (!NATIVE) m.addEventListener('drop', async e => {
      e.preventDefault(); if (running) return;
      const it = [...(e.dataTransfer.items || [])].find(i => i.kind === 'file');
      const h = it && it.getAsFileSystemHandle ? await it.getAsFileSystemHandle() : null;
      if (h && h.kind === 'directory') await useOwnFolder(h);
    });
  }
  function stop() { stopReq = true; if (NATIVE && nativeCurrent) Native.post('analysisCancel', { id: nativeCurrent }); }
  // ---- Mac app's analysis window: its own folder (the QC videos folder until another one is chosen)
  const qcFolderPath = async () => { try { return await Native.call('storeGet', { key: 'folder:videos' }) || ''; } catch (e) { return ''; } };
  async function setWindowFolder(path, own) {
    sourceHandle = new Native.NDir(path); ownFolder = own;
    if (own) Store.set('ana:folder', path);
    await refresh();
  }
  let toldApp = '';
  function tellApp(force) {   // the window's title, and whether the Mac may sleep
    if (!WINDOW) return;
    const title = running && queueInfo ? `Video Analysis: ${queueInfo.done + 1} of ${queueInfo.total}` : '';
    const msg = { running, awake: $('#anaAwake') ? $('#anaAwake').checked : true, title };
    const key = JSON.stringify(msg);
    if (!force && key === toldApp) return;
    toldApp = key; Native.post('analysisBusy', msg);
  }
  async function useOwnFolder(dir) {
    HandleStore.set('analysis', dir);
    ownFolder = true; sourceHandle = dir; sourceLabel = dir.name;
    await rememberRoot(dir);
    await recallResults();
    await loadRows(await listDeep(dir));
  }
  // The last folder, opened again with one click (Chrome asks once per visit).
  async function reopenLast() {
    const last = sourceHandle || HandleStore.cache.analysis || await HandleStore.load('analysis');
    if (!last) return changeFolder();
    try { if (await last.requestPermission({ mode: 'readwrite' }) !== 'granted') return; } catch (e) { return changeFolder(); }
    folderProblem = '';
    await useOwnFolder(last);
  }
  async function rescan() {
    if (running) return;
    if (WINDOW || !ownFolder) { await refresh(true); return; }
    if (sourceHandle) await loadRows(await listDeep(sourceHandle));
  }
  // ---- web: where results go when the videos folder is a delivery folder (or inside one). The page can't reach above
  // the folder it was given, so the folder that holds the delivery folder is chosen once; it's remembered per videos folder.
  async function recallResults() {
    resultsRoot = null; resultsRel = null; resultsNote = ''; resultsAsk = null;
    if (NATIVE || !sourceHandle || !sourceHandle.isSameEntry) return;
    for (const x of ((await HandleStore.load('anaResults')) || [])) {
      let same = false; try { same = x && x.videos && await x.videos.isSameEntry(sourceHandle); } catch (e) { /* gone */ }
      if (!same) continue;
      let perm = 'prompt'; try { perm = await x.results.queryPermission({ mode: 'readwrite' }); } catch (e) { /* */ }
      if (perm === 'granted') await setResults(x.results, false); else resultsAsk = x.results;
      return;
    }
  }
  async function setResults(root, save) {
    let rel = null; try { rel = await root.resolve(sourceHandle); } catch (e) { rel = null; }
    if (!rel) { resultsNote = `“${root.name}” doesn't hold ${sourceLabel}. Choose the folder ${sourceLabel} is in, or one above it.`; return false; }
    const pl = await markersPlace(root, rel);
    if (pl.needParent) { resultsNote = `“${root.name}” is a delivery folder too: results can't go inside it. Choose the folder that holds it.`; return false; }
    resultsRoot = root; resultsRel = rel; resultsNote = ''; resultsAsk = null;
    await rememberRoot(root);
    if (save) {
      const list = ((await HandleStore.load('anaResults')) || []).filter(x => x && x.videos);
      const keep = []; for (const x of list) { let same = false; try { same = await x.videos.isSameEntry(sourceHandle); } catch (e) { /* */ } if (!same) keep.push(x); }
      HandleStore.set('anaResults', [{ videos: sourceHandle, results: root }, ...keep].slice(0, 30));
    }
    return true;
  }
  async function pickResults() {
    if (running || NATIVE || !window.showDirectoryPicker) return;
    if (resultsAsk && !resultsRoot) {   // chosen before: just allow it again
      try { if (await resultsAsk.requestPermission({ mode: 'readwrite' }) === 'granted') { await setResults(resultsAsk, false); await loadRows(rows.map(r => ({ file: r.file, segs: r.segs }))); return; } } catch (e) { /* choose */ }
    }
    let dir = null;
    try { dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'anaResults', startIn: resultsRoot || sourceHandle }); }
    catch (e) { if (e && e.name === 'AbortError') return; try { dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'anaResults' }); } catch (e2) { return; } }
    await setResults(dir, true);
    await loadRows(rows.map(r => ({ file: r.file, segs: r.segs })));
  }
  async function changeFolder() {
    if (running) return;
    if (WINDOW) {
      const dir = await Native.pickFolder('analysis', sourceHandle && sourceHandle.path);
      if (dir) await setWindowFolder(dir.path, true);
      return;
    }
    if (!window.showDirectoryPicker) return;
    // starts where it was last picked from; read and write (the VideoMarkers folder is made inside it)
    const last = HandleStore.cache.analysis || await HandleStore.load('analysis');
    let dir = null;
    try { dir = await window.showDirectoryPicker(last ? { mode: 'readwrite', id: 'analysis', startIn: last } : { mode: 'readwrite', id: 'analysis' }); }
    catch (e) { if (e && e.name === 'AbortError') return; try { dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'analysis' }); } catch (e2) { return; } }
    await useOwnFolder(dir);
  }
  // Web: the videos in a folder and in the folders inside it (3 levels; not inside VideoMarkers), so a season or
  // Digital folder takes in Encodes, QC_PASS and Proxies at once. Each: { file, segs (folders below the chosen one) }.
  async function listDeep(dir, segs = [], depth = 0, out = []) {
    for await (const [name, h] of dir.entries(true)) {   // (the Mac app's folders list sub-folders only when asked)
      if (name.startsWith('.') || name.startsWith('._')) continue;
      if (h.kind === 'file' && VIDEO_EXT.test(name)) out.push({ file: await h.getFile(), segs });
      else if (h.kind === 'directory' && depth < 3 && name !== MARKERS_DIR) await listDeep(h, [...segs, name], depth + 1, out);
    }
    return out;
  }
  // Web: the folders analysed here are remembered, so the QC page can find their markers later on its own.
  async function rememberRoot(dir) {
    const list = (await HandleStore.load('markerRoots')) || [];
    for (const r of list) { try { if (await r.isSameEntry(dir)) return; } catch (e) { /* gone */ } }
    HandleStore.set('markerRoots', [dir, ...list].slice(0, 30));
  }
  // The page's folder: its own, or the QC page's videos folder.
  async function refresh(force) {
    if (WINDOW) {
      if (running) { render(); return; }
      sourceLabel = sourceHandle ? sourceHandle.path : '';
      let files = [], problem = '';
      if (sourceHandle) { try { files = await listDeep(sourceHandle); } catch (e) { problem = 'This folder can\'t be read: choose it again with Change…'; } }
      folderProblem = problem;
      await loadRows(files);
      return;
    }
    if (running || (ownFolder && !force)) { render(); return; }
    const same = sourceHandle && state.vidHandle && sourceHandle === state.vidHandle;
    sourceHandle = state.vidHandle; sourceLabel = state.vidFolder || '';
    let files;
    if (sourceHandle && sourceHandle.getDirectoryHandle) { try { files = await listDeep(sourceHandle); } catch (e) { files = null; } }
    if (!files) files = [...state.videos.map(v => v.file), ...state.ignoredVideos.map(v => v.file)].filter(Boolean).map(f => ({ file: f, segs: [] }));
    if (sourceHandle && sourceHandle.getDirectoryHandle) await rememberRoot(sourceHandle);
    if (!same) await recallResults();
    await loadRows(files);
  }
  async function loadRows(items) {
    items = items.filter(x => x && x.file).sort((a, b) => (a.segs.join('/') + '/' + a.file.name).localeCompare(b.segs.join('/') + '/' + b.file.name, undefined, { numeric: true }));
    const old = new Map(rows.map(r => [r.key, r]));
    store.clear();
    needParent = false;
    // which files are episodes: audio-only files, dubcards and clips under a minute are set aside (as on the QC page)
    for (const [i, it] of items.entries()) {
      const f = it.file, ck = [...it.segs, f.name, f.size, f.lastModified].join('|');
      if (!probeCache.has(ck)) {
        if (built && !running && items.length > 3) $('#anaSum').textContent = `Reading the videos: ${i + 1} of ${items.length}…`;
        const probes = {}; let reason = null;
        try { reason = await classifyVideo(f, probes); } catch (e) { reason = null; }
        probeCache.set(ck, { probe: probes[f.name] || null, reason });
      }
      it.info = probeCache.get(ck);
    }
    const fresh = [];
    for (const it of items) {
      const f = it.file, key = [...it.segs, f.name].join('/'), p = it.info.probe, ignored = it.info.reason || '';
      const prev = old.get(key);
      const r = { key, file: f, name: f.name, segs: it.segs, size: f.size, duration: p ? p.duration : null, fps: p ? p.fps : null,
        ignored, checked: prev && !prev.blocked ? prev.checked : !ignored, open: prev ? prev.open : false, fp: null, live: {} };
      if (NATIVE) { r.markersPath = markersPathFor(dirname(f.path)); r.dest = r.markersPath; }
      else if (sourceHandle && sourceHandle.getDirectoryHandle) {
        r.place = resultsRoot ? await markersPlace(resultsRoot, [...resultsRel, ...it.segs]) : await markersPlace(sourceHandle, it.segs);
        if (r.place.needParent) { needParent = true; r.blocked = true; r.checked = false; }
        r.dest = r.place.label;
      } else { r.blocked = true; r.checked = false; }
      fresh.push(r);
    }
    rows = [...fresh.filter(r => !r.ignored), ...fresh.filter(r => r.ignored)];
    // the markers already there
    if (NATIVE) { for (const res of await readNative([...new Set(rows.map(r => r.markersPath))])) if (!store.has(res.video.name)) store.set(res.video.name, res); }
    else {
      const seen = [];
      for (const r of rows) {
        const d = await markersDir(r.place, false); if (!d) continue;
        let dup = false; for (const s of seen) { try { if (await s.isSameEntry(d)) { dup = true; break; } } catch (e) { /* */ } }
        if (dup) continue; seen.push(d);
        for (const res of await readDirHandle(d)) if (!store.has(res.video.name)) store.set(res.video.name, res);
      }
    }
    render();
    for (const r of rows) {           // lengths and fingerprints, filled in as they come
      if (r.duration == null) { try { const p = await TimecodeTrack.probe(r.file); r.duration = p && p.duration; r.fps = p && p.fps; } catch (e) { /* unreadable */ } }
      try { r.fp = await fingerprint(r.file); } catch (e) { r.fp = null; r.err = 'The file can\'t be read'; }
      renderRow(r);
    }
    render();
  }
  function cellHtml(r, t) {
    if (!t.can) return '<span class="ana-dim">—</span>';
    const lv = r.live[t.key];
    if (lv) {
      if (lv.state === 'queued') return '<span class="ana-dim">Queued</span>';
      if (lv.state === 'running') return `<span class="ana-run"${lv.msg ? ` title="${esc(lv.msg)}"` : ''}><span class="ana-bar"><i style="width:${Math.round(lv.p * 100)}%"></i></span>${Math.round(lv.p * 100)}%</span>`;
      if (lv.state === 'failed') return `<span class="ana-bad" title="${esc(lv.msg || '')}">Failed</span>`;
    }
    const st = typeStatus(store.get(r.name), r.fp, t.key);
    if (st.state === 'done') return `<span class="ana-ok">✓</span> <span title="Analysed ${esc(fmtAt(st.at))}">${esc(found(store.get(r.name), t.key) || fmtAt(st.at))}</span>`;
    if (st.state === 'outdated') return `<span class="ana-warn" title="${esc(st.why)}">Outdated</span>`;
    return '<span class="ana-dim">—</span>';
  }
  // What an analysis found, in a few words (the cell), and in full (the row opened with a click).
  function found(res, key) {
    const t = res && res[key]; if (!t) return '';
    if (key === 'blacks') { const c = (t.items || []).filter(b => b.kind === 'commercial').length; return `${c} commercial black${c === 1 ? '' : 's'}`; }
    if (key === 'credits') {
      const n = (t.cards || []).filter(c => !c.kind || c.kind === 'credit').length;
      return n ? `${n} credit${n === 1 ? '' : 's'}${t.confirmed ? '' : ' (no “Directed by”)'}` : 'none found';
    }
    if (key === 'text') { const n = (t.pieces || []).length; return n ? `${n} piece${n === 1 ? '' : 's'} of text` : 'no text found'; }
    return '';
  }
  const KIND = { commercial: 'Commercial black', start: 'Start of the file', end: 'End of the file', other: 'Black with sound (inside a scene)' };
  function fmtFrames(sec, fps) {   // h:mm:ss:ff from the start of the file
    const f = Math.round(fps) || 24, n = Math.max(0, Math.round(sec * fps)), p = x => String(x).padStart(2, '0');
    return `${Math.floor(n / (f * 3600))}:${p(Math.floor(n / (f * 60)) % 60)}:${p(Math.floor(n / f) % 60)}:${p(n % f)}`;
  }
  const hasResults = res => !!(res && (res.blacks || res.credits || res.text));
  const CARD_KIND = { credit: 'Credit', title: 'Main title', text: 'Other text (not a credit)' };
  const WHY = { small: 'small', moving: 'moving with the camera', title: 'large title (older settings)', scene: 'part of the shot', faint: 'faint', 'end credits': 'end credits' };
  const where = b => { if (!b) return ''; const cx = b[0] + b[2] / 2, cy = b[1] + b[3] / 2; return `${cy < 0.33 ? 'top' : cy > 0.66 ? 'bottom' : 'middle'} ${cx < 0.38 ? 'left' : cx > 0.62 ? 'right' : 'centre'}`; };
  function textHtml(res, r) {
    const t = res && res.text; if (!t) return '';
    const fps = t.fps || r.fps || (res.video && res.video.fps) || 24, ps = t.pieces || [], lo = t.leftOut || [];
    const counts = {}; for (const x of lo) counts[x.why] = (counts[x.why] || 0) + 1;
    const loTxt = Object.entries(counts).map(([k, n]) => `${n} ${WHY[k] || k}`).join(', ');
    const lines = ps.map(x => `<tr><td>${fmtFrames(x.in, fps)}</td><td>${fmtFrames(x.out, fps)}</td><td>${((x.out - x.in)).toFixed(1)} s</td><td>${esc(where(x.box))}</td></tr>`).join('');
    return `<div class="ana-dh">On-screen text <span class="ana-dim">· ${t.seconds != null ? `found in ${fmtLen(t.seconds)}${t.device ? ' on the ' + esc(t.device) : ''}` : ''}${t.step ? ` · a look every ${t.step === 1 ? 'second' : t.step + ' s'}` : ''}${loTxt ? ` · left out: ${esc(loTxt)}` : ''}</span></div>${
      ps.length ? `<table class="ana-dt"><thead><tr><th>In</th><th>Out</th><th>Length</th><th>Where</th></tr></thead><tbody>${lines}</tbody></table>` : '<div class="ana-dim">No on-screen text found.</div>'}`;
  }
  function creditsHtml(res, r) {
    const c = res && res.credits; if (!c) return '';
    const fps = c.fps || r.fps || (res.video && res.video.fps) || 24, cards = c.cards || [];
    const runs = (c.runs || []).map(x => `${fmtFrames(x.in, fps)} – ${fmtFrames(x.out, fps)}`).join(' · ');
    const lines = cards.map(x => `<tr class="k-${esc(x.kind || 'credit')}"><td>${fmtFrames(x.in, fps)}</td><td>${fmtFrames(x.out, fps)}</td><td>${esc(CARD_KIND[x.kind || 'credit'] || '')}</td><td>${esc(x.text || '')}</td></tr>`).join('');
    return `<div class="ana-dh">Opening credits <span class="ana-dim">· ${c.confirmed ? 'ends with “Directed by”' : 'no “Directed by” found'}${runs ? ` · credits ${runs}` : ''}</span></div>${
      cards.length ? `<table class="ana-dt"><thead><tr><th>In</th><th>Out</th><th>What it is</th><th>Text</th></tr></thead><tbody>${lines}</tbody></table>` : '<div class="ana-dim">No on-screen text found.</div>'}`;
  }
  function blacksHtml(res, r) {
    const b = res && res.blacks; if (!b) return '';
    const fps = b.fps || r.fps || (res.video && res.video.fps) || 24, items = b.items || [];
    const lines = items.map(x => {
      const n = x.frames != null ? x.frames : Math.round((x.out - x.in) * fps);
      const len = n < Math.round(fps) ? `${n} fr` : `${(x.out - x.in).toFixed(1)} s`;
      const snd = x.audio === 'sound' ? `Sound${x.level != null ? ` (${Math.round(x.level)} dB)` : ''}` : x.audio === 'silent' ? 'Silent' : x.audio === 'none' ? 'No audio' : '';
      return `<tr class="k-${esc(x.kind || '')}"><td>${fmtFrames(x.in, fps)}</td><td>${fmtFrames(x.out, fps)}</td><td>${len}</td><td>${snd}</td><td>${esc(KIND[x.kind] || '')}</td></tr>`;
    }).join('');
    return `<div class="ana-dh">Blacks <span class="ana-dim">· times from the start of the file (h:mm:ss:frames)</span></div>${
      items.length ? `<table class="ana-dt"><thead><tr><th>In</th><th>Out</th><th>Length</th><th>Sound</th><th>What it is</th></tr></thead><tbody>${lines}</tbody></table>` : '<div class="ana-dim">No blacks found.</div>'}`;
  }
  function detailHtml(r) {
    const res = store.get(r.name);
    if (!hasResults(res)) return '';
    return `<tr class="ana-detail"><td></td><td colspan="${2 + TYPES.length}">${textHtml(res, r)}${blacksHtml(res, r)}${creditsHtml(res, r)}</td></tr>`;
  }
  const rowHtml = (r, i) => rowMain(r, i) + (r.open ? detailHtml(r) : '');
  const FOLDER_ICON = '<svg class="ana-fi" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3 6.5a1.5 1.5 0 0 1 1.5-1.5h4.2l2 2.2h8.8A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/></svg>';
  const IGN = '::ignored';   // (no folder name has "::" on Mac or Windows)
  const groupKey = r => r.ignored ? IGN : r.segs.join('/');
  const groupRows = k => rows.filter(r => groupKey(r) === k);
  const hasSub = () => rows.some(x => groupKey(x) !== '' && groupKey(x) !== IGN);   // videos in folders inside the chosen one
  function groupHtml(k, list) {
    const open = k === IGN ? ignOpen : !collapsed.has(k);
    const live = list.filter(r => !r.blocked), on = live.filter(r => r.checked).length;
    const cb = `<input type="checkbox" data-g="${esc(k)}"${on && on === live.length ? ' checked' : ''}${running || !live.length ? ' disabled' : ''} title="Tick or untick every video in this folder">`;
    const label = k === IGN ? `Ignored (${list.length}): audio files, dubcards, short clips` : `${FOLDER_ICON}<span class="ana-gname">${esc(k === '' ? sourceLabel : k.split('/').join(' / '))}</span><span class="ana-gn">${list.length} video${list.length === 1 ? '' : 's'}</span>`;
    return `<tr class="ana-grp${k === IGN ? ' ign' : ''}${open ? ' open' : ''}" data-g="${esc(k)}"><td>${cb.replace('<input', on && on < live.length ? '<input data-mixed="1"' : '<input')}</td><td colspan="${2 + TYPES.length}"><span class="ana-chev">${open ? '▾' : '▸'}</span>${label}</td></tr>`;
  }
  function bodyHtml() {
    if (!rows.length) return '';
    let html = '', cur = null;
    rows.forEach((r, i) => {
      const k = groupKey(r);
      if (k !== cur) { cur = k; if (k !== '' || hasSub()) html += groupHtml(k, groupRows(k)); }
      const open = k === IGN ? ignOpen : !collapsed.has(k);
      if (open) html += rowHtml(r, i);
    });
    return html;
  }
  function rowMain(r, i) {
    const sub = r.ignored && r.segs.length ? `<div class="ana-sub">${esc(r.segs.join(' / '))}</div>` : '';
    const inGroup = groupKey(r) !== '' || hasSub();
    // in a folder: the tick box sits in the File column, a step further in than the folder's name
    const cb = `<input type="checkbox" data-i="${i}"${r.checked ? ' checked' : ''}${running || r.blocked ? ' disabled' : ''}>`;
    const info = `${sub}<div>${esc(r.name)}</div>${r.ignored ? `<div class="ana-note">${esc(r.ignored)}</div>` : ''}${r.err ? `<div class="ana-note bad">${esc(r.err)}</div>` : ''}`;
    return `<tr data-i="${i}" class="${r.checked ? '' : 'off'}${hasResults(store.get(r.name)) ? ' has-res' : ''}${r.open ? ' open' : ''}${inGroup ? ' in-grp' : ''}"><td>${inGroup ? '' : cb}</td>
      <td class="ana-file">${inGroup ? `<div class="ana-fl">${cb}<div>${info}</div></div>` : info}</td>
      <td class="ana-len">${fmtLen(r.duration)}</td>${TYPES.map(t => `<td class="${t.can ? '' : 'later'}">${cellHtml(r, t)}</td>`).join('')}</tr>`;
  }
  function renderRow(r) {
    if (!built) return;
    if (rows.some(x => x.open)) { $('#anaBody').innerHTML = bodyHtml(); return; }
    const i = rows.indexOf(r), tr = document.querySelector(`#anaBody tr[data-i="${i}"]`);
    if (tr) tr.outerHTML = rowHtml(r, i);
  }
  function plan() {
    const keys = TYPES.filter(t => t.can && typeOn[t.key]).map(t => t.key), jobs = [];
    for (const r of rows) {
      if (!r.checked || r.err || r.blocked) continue;
      const ks = keys.filter(k => !(skipDone && typeStatus(store.get(r.name), r.fp, k).state === 'done'));
      if (ks.length) jobs.push({ row: r, keys: ks });
    }
    return jobs;
  }
  function render() {
    if (!built) return;
    $('#anaFolder').textContent = sourceLabel || (rows.length ? '' : WINDOW ? 'No folder yet: choose one with Change…, or drop it on this window' : 'No folder yet: choose one with Change…, or drop it here');
    $('#anaFolder').title = sourceLabel;
    // the videos folder: with a results folder chosen above it, the whole path, the results folder's part dimmed
    if (resultsRoot && resultsRel) $('#anaFolder').innerHTML = `<span class="ana-dim">${esc([resultsRoot.name, ...resultsRel.slice(0, -1)].join(' / '))} / </span>${esc(sourceLabel)}`;
    const dests = [...new Set(rows.filter(r => r.dest && !(r.place && r.place.needParent)).map(r => r.dest))];
    const dest = $('#anaDest'), pr = $('#anaPickRes');
    if (needParent && !resultsRoot) {
      dest.innerHTML = resultsAsk ? `<span class="ana-warn">${esc(resultsAsk.name)} / VideoMarkers</span> <span class="ana-dim">(chosen before: Chrome asks once per visit)</span>` : '<span class="ana-warn">Not chosen yet</span>';
      pr.hidden = running; pr.textContent = resultsAsk ? 'Allow' : 'Choose the folder above…';
    } else {
      dest.textContent = !rows.length ? '' : dests.length === 1 ? dests[0] : dests.length ? `${dests.length} VideoMarkers folders (beside each delivery folder, or inside the videos' folder)` : '';
      const dv = resultsRoot && resultsRel ? resultsRel.find(n => DELIVERY.test(n)) : null;
      if (dv && dests.length === 1) dest.insertAdjacentHTML('beforeend', ` <span class="ana-dim">· beside ${esc(dv)}, the delivery folder</span>`);
      pr.hidden = !resultsRoot || running; pr.textContent = 'Change…';
    }
    dest.title = dests.join('\n');
    const pb = $('#anaParent');
    pb.hidden = !(needParent && !resultsRoot) && !resultsNote;
    pb.classList.toggle('bad', !!resultsNote);
    if (!pb.hidden) pb.innerHTML = (resultsNote ? esc(resultsNote) + '<br>' : '') + (needParent && !resultsRoot ? `<b>${esc(sourceLabel)}</b> is a delivery folder: results are kept beside it, never inside. ${resultsAsk ? 'Click <b>Allow</b> to use the results folder chosen before, or' : 'Click <b>Choose the folder above…</b> and pick'} the folder that holds it (Digital, or the season's folder). The videos are still listed from <b>${esc(sourceLabel)}</b>.` : '');
    $('#anaUseQc').hidden = !ownFolder || running;
    $('#anaChange').disabled = running;
    $('#anaRescan').hidden = !sourceHandle || running;
    $('#anaBody').innerHTML = rows.length ? bodyHtml() : `<tr><td colspan="${3 + TYPES.length}" class="ana-empty">${folderProblem || (sourceLabel ? 'No video files in this folder or the folders inside it.' : '')}</td></tr>`;
    document.querySelectorAll('#anaBody input[data-mixed]').forEach(i => i.indeterminate = true);
    const main = rows.filter(r => !r.blocked && !r.ignored);
    const all = $('#anaAll'); all.checked = main.length > 0 && main.every(r => r.checked); all.indeterminate = rows.some(r => r.checked) && !all.checked; all.disabled = running;
    const jobs = plan();
    $('#anaStart').disabled = running || !jobs.length;
    $('#anaStop').disabled = !running;
    document.querySelectorAll('#anaModal input[data-type], #anaSkip, #anaDense').forEach(i => i.disabled = running || !!i.closest('.later'));
    if (!running) $('#anaSum').textContent = !rows.length ? '' : jobs.length ? `${jobs.length} video${jobs.length === 1 ? '' : 's'} to analyse` : !TYPES.some(t => t.can) ? 'Nothing can run in this version' : rows.some(r => r.checked) ? 'Nothing to do: already analysed (untick “Skip” to run again)' : 'Tick the videos to analyse';
    updateIndicators();
  }
  // The QC header's "Analysing 2 of 5…" (web) and the start screen's card.
  function updateIndicators() {
    const b = $('#anaBtn');
    if (b) { b.hidden = !running; b.textContent = running && queueInfo ? `Analysing ${queueInfo.done + 1} of ${queueInfo.total}…` : ''; }
    const h = $('#homeAnaLast');
    if (h && !NATIVE) h.textContent = running && queueInfo ? `Running: ${queueInfo.done + 1} of ${queueInfo.total}` : (HandleStore.cache.analysis ? 'Last folder: ' + HandleStore.cache.analysis.name : '');
    tellApp();
  }
  async function start() {
    const jobs = plan();
    if (running || !jobs.length) return;
    // web: writing needs permission on the folder (asked once, on this click)
    if (!NATIVE && sourceHandle && sourceHandle.requestPermission) {
      const target = resultsRoot || sourceHandle;
      try { if (await target.queryPermission({ mode: 'readwrite' }) !== 'granted' && await target.requestPermission({ mode: 'readwrite' }) !== 'granted') { $('#anaSum').textContent = 'Results can\'t be saved without permission to write in this folder'; return; } } catch (e) { /* ask on write */ }
    }
    running = true; stopReq = false;
    for (const j of jobs) for (const k of j.keys) j.row.live[k] = { state: 'queued' };
    queueInfo = { done: 0, total: jobs.length, t0: performance.now(), failed: 0 };
    render();
    let doneSecs = 0;   // for the time-left estimate
    const totalLen = jobs.reduce((s, j) => s + (j.row.duration || 2700) * j.keys.length, 0);
    for (const j of jobs) {
      if (stopReq) break;
      const r = j.row;
      const prev = store.get(r.name), same = prev && prev.video && prev.video.fingerprint === r.fp;
      // a changed file starts over; otherwise other types already done are kept
      const res = Object.assign({}, same ? prev : {}, { format: FORMAT, version: VERSION, app: APP_VERSION });
      delete res._dir;
      res.video = { name: r.name, size: r.size, duration: r.duration, fps: r.fps, fingerprint: r.fp };
      for (const k of j.keys) {
        if (stopReq) break;
        r.live[k] = { state: 'running', p: 0 };
        try {
          const out = await runType(r, k, (p, msg) => {
            r.live[k].p = p; r.live[k].msg = msg || ''; renderRow(r);
            const el = (performance.now() - queueInfo.t0) / 1000, part = doneSecs + p * (r.duration || 2700);
            if (part > 0 && el > 1.5) $('#anaSum').textContent = `${queueInfo.done + 1} of ${queueInfo.total} · about ${fmtLeft(el / part * (totalLen - part))} left`;
            updateIndicators();
          }, () => stopReq);
          res[k] = Object.assign({ analysedAt: new Date().toISOString(), settings: settingsFor(k) }, out);
          delete r.live[k];
        } catch (e) {
          if (stopReq) { delete r.live[k]; break; }
          r.live[k] = { state: 'failed', msg: e && e.message || 'Unknown error' }; queueInfo.failed++;
        }
        doneSecs += r.duration || 2700;
        // after each type: a stop or a crash keeps what's done
        if (!r.live[k]) {
          try { await writeResult(r, res); store.set(r.name, res); window.dispatchEvent(new CustomEvent('analysis-updated', { detail: { name: r.name } })); }
          catch (e) { r.live[k] = { state: 'failed', msg: 'The results could not be saved: ' + (e && e.message || e) }; queueInfo.failed++; }
        }
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
  // The analysis as a page of its own (web), or the Mac app's analysis window.
  async function open() {
    if (NATIVE && !WINDOW) { Native.post('analysisOpen'); return; }
    build(); $('#anaModal').hidden = false;
    document.documentElement.classList.add('ana-page');
    if (!WINDOW && !ownFolder && !sourceHandle) {
      const last = HandleStore.cache.analysis || await HandleStore.load('analysis');
      if (last) { sourceHandle = last; sourceLabel = last.name; ownFolder = true; try { if (await last.queryPermission({ mode: 'read' }) === 'granted') { await recallResults(); await loadRows(await listDeep(last)); return; } } catch (e) { /* ask */ } rows = []; folderProblem = `<button class="btn sm" id="anaReopen">Open “${esc(last.name)}” again</button><div class="ana-note" style="margin-top:6px">The folder used last time (Chrome asks for permission once per visit).</div>`; render(); return; }
    }
    refresh();
  }
  function close() { if (built) $('#anaModal').hidden = true; document.documentElement.classList.remove('ana-page'); }

  // ------------------------------------------------------------ for the QC page: markers for the video in the player
  // Read once per videos folder; found by name, or by episode when the length agrees within a second.
  let qc = { key: null, results: [], ask: null, links: [] };
  const sameLen = (a, b) => a == null || b == null || Math.abs(a - b) <= 1;
  async function qcResults() {
    const vh = state.vidHandle;
    if (!vh) return qc = { key: null, results: [], ask: null };
    const key = NATIVE ? vh.path : vh;
    if (qc.key === key && qc.results) return qc;
    const out = [], ask = [];
    if (NATIVE) {
      const own = markersPathFor(vh.path), link = Store.get('markersLink:' + vh.path);
      out.push(...await readNative([own, ...(link ? [link] : [])], vh.path));
    } else {
      // 1. VideoMarkers inside the videos folder (proxies)
      try { out.push(...await readDirHandle(await vh.getDirectoryHandle(MARKERS_DIR))); } catch (e) { /* none */ }
      // 2. folders analysed in this browser that hold this videos folder: their VideoMarkers folders
      for (const root of ((await HandleStore.load('markerRoots')) || [])) {
        let rel = null; try { rel = await root.resolve(vh); } catch (e) { rel = null; }
        if (rel == null) continue;
        let perm = 'denied'; try { perm = await root.queryPermission({ mode: 'read' }); } catch (e) { /* */ }
        if (perm !== 'granted') { ask.push(root); continue; }
        for (const d of await findMarkerDirs(root)) out.push(...await readDirHandle(d));
      }
      // 3. a VideoMarkers folder linked to this videos folder by hand
      for (const l of ((await HandleStore.load('markerLinks')) || [])) {
        let same = false; try { same = await l.videos.isSameEntry(vh); } catch (e) { /* */ }
        if (!same) continue;
        let perm = 'denied'; try { perm = await l.markers.queryPermission({ mode: 'read' }); } catch (e) { /* */ }
        if (perm !== 'granted') { ask.push(l.markers); continue; }
        out.push(...await readDirHandle(l.markers.name === MARKERS_DIR ? l.markers : await l.markers.getDirectoryHandle(MARKERS_DIR).catch(() => l.markers)));
      }
    }
    return qc = { key, results: out, ask: ask[0] || null };
  }
  async function findMarkerDirs(root, depth = 0, out = []) {
    try {
      for await (const [name, h] of root.entries()) {
        if (h.kind !== 'directory' || name.startsWith('.')) continue;
        if (name === MARKERS_DIR) out.push(h); else if (depth < 3) await findMarkerDirs(h, depth + 1, out);
      }
    } catch (e) { /* */ }
    return out;
  }
  // The markers for this video, how they were matched, and where from.
  async function match(v) {
    if (!v || !v.file) return null;
    const { results } = await qcResults();
    const dur = v.probe && v.probe.duration;
    const newest = list => list.sort((a, b) => String(b.text && b.text.analysedAt || '').localeCompare(String(a.text && a.text.analysedAt || '')))[0];
    const byName = newest(results.filter(r => r.video.name === v.name && sameLen(r.video.duration, dur)));
    if (byName) return { r: byName, from: null };
    const key = Match.episodeKey(Match.parse(v.name));
    if (!key) return null;
    const ep = newest(results.filter(r => Match.episodeKey(Match.parse(r.video.name)) === key && r.video.duration != null && dur != null && sameLen(r.video.duration, dur)));
    return ep ? { r: ep, from: ep.video.name } : null;
  }
  async function forVideo(v) { const m = await match(v); return m ? m.r : null; }
  async function statusLine(v) {
    const m = await match(v);
    if (!m) return qc.ask ? 'markers found, needs permission' : 'none found';
    const bits = [m.r.text && 'on-screen text', m.r.blacks && 'blacks', m.r.credits && 'credits'].filter(Boolean);
    return bits.join(', ') + (m.from ? ` (from ${m.from})` : '');
  }
  // The QC page's analysis line: Allow (permission for a remembered folder) or Link markers folder….
  async function qcActions(el) {
    if (!el) return;
    const v = state.videos.find(x => x.name === state.selectedVideo);
    const m = v ? await match(v) : null;
    el.querySelectorAll('.ana-act').forEach(b => b.remove());
    if (m) return;
    if (qc.ask) {
      const b = document.createElement('button'); b.className = 'textbtn ana-act'; b.textContent = 'Allow';
      b.title = `Markers may be in “${qc.ask.name}”: Chrome asks for permission once per visit`;
      b.onclick = async () => { try { await qc.ask.requestPermission({ mode: 'read' }); } catch (e) { /* */ } qc.key = null; window.dispatchEvent(new CustomEvent('analysis-updated', { detail: {} })); };
      el.appendChild(b);
    }
    const l = document.createElement('button'); l.className = 'textbtn ana-act'; l.textContent = 'Link markers folder…';
    l.title = 'Point to the VideoMarkers folder for these videos (for example when the proxies were analysed in another folder)';
    l.onclick = linkMarkers; el.appendChild(l);
  }
  async function linkMarkers() {
    const vh = state.vidHandle; if (!vh) return;
    if (NATIVE) {
      const d = await Native.pickFolder('markers', ''); if (!d) return;
      Store.set('markersLink:' + vh.path, /\/VideoMarkers\/?$/.test(d.path) ? d.path : d.path.replace(/\/+$/, '') + '/' + MARKERS_DIR);
    } else {
      if (!window.showDirectoryPicker) return;
      let d; try { d = await window.showDirectoryPicker({ mode: 'read', id: 'markers' }); } catch (e) { return; }
      const list = ((await HandleStore.load('markerLinks')) || []).filter(x => x && x.videos);
      HandleStore.set('markerLinks', [{ videos: vh, markers: d }, ...list].slice(0, 50));
    }
    qc.key = null; window.dispatchEvent(new CustomEvent('analysis-updated', { detail: {} }));
  }
  window.addEventListener('qc-videos-changed', () => { qc.key = null; if (built && !$('#anaModal').hidden && !WINDOW && !ownFolder) refresh(); });
  window.addEventListener('analysis-updated', e => { if (!e.detail || e.detail.name) qc.key = null; });
  if (NATIVE) Native.on('analysisFile', () => { qc.key = null; window.dispatchEvent(new CustomEvent('analysis-updated', { detail: {} })); });   // saved in the other window
  if (WINDOW) {
    Native.on('analysisShow', () => { if (!running) refresh(); });      // the window was brought back: look at the folder again
    Native.on('analysisStop', () => stop());                            // the window is closing
    document.addEventListener('DOMContentLoaded', async () => {
      window.onNativeDrop = async items => {                            // a folder dropped on the window
        const d = (items || []).find(i => i.isDir);
        if (d && !running) await setWindowFolder(d.path, true);
      };
      build(); $('#anaModal').hidden = false; render();
      const own = Store.get('ana:folder'), p = own || await qcFolderPath();
      if (p) await setWindowFolder(p, false); else render();
      ownFolder = !!own; render();
    });
  }

  // For the waveform and index bars: on-screen text (or credits) joined where less than 20 s apart, commercial blacks,
  // and every card / piece with its box for the checks.
  const JOIN = 20;
  function marks(r) {
    if (!r) return null;
    const text = r.text && r.text.pieces;
    const cards = text ? text.map(p => ({ in: p.in, out: p.out, kind: 'text', text: '', box: p.box }))
      : ((r.credits && r.credits.cards) || []).map(c => ({ in: c.in, out: c.out, kind: c.kind || 'credit', text: c.text, box: c.box || (c.boxes && c.boxes[0]) || null }));
    const spans = [];
    for (const c of cards.filter(c => text || c.kind === 'credit').sort((a, b) => a.in - b.in)) {
      const last = spans[spans.length - 1];
      if (last && c.in - last[1] < JOIN) last[1] = Math.max(last[1], c.out); else spans.push([c.in, c.out]);
    }
    const blacks = ((r.blacks && r.blacks.items) || []).filter(b => b.kind === 'commercial').map(b => [b.in, b.out]);
    const scannedTo = text ? r.text.scannedTo || (r.video && r.video.duration) : r.credits ? r.credits.scannedTo || (r.video && r.video.duration) : 0;
    return spans.length || blacks.length || r.credits || text ? { video: null, credits: spans, label: text ? 'On-screen text' : 'Credits', allText: !!text, blacks, cards, scannedTo } : null;
  }
  return { open, close, forVideo, statusLine, qcActions, marks, fingerprint, TYPES, markersPathFor, markersPlace, MARKERS_DIR,
    _useFolder: useOwnFolder, _start: start, _rescan: rescan,
    _pickResults: async d => { await setResults(d, true); await loadRows(rows.map(r => ({ file: r.file, segs: r.segs }))); },   // (tests: a folder without the picker)
    get running() { return running; } };
})();

/* ==========================================================================
   Start screen (1.1.0): QC / Conform or Video Analysis; the Home button in either comes back here.
   Not in the Mac app's analysis window or in the self-test.
   ========================================================================== */
const Home = (() => {
  const el = () => document.getElementById('home');
  function show() {
    const h = el(); if (!h || window.__selftest) return;
    Analysis.close();
    const v = HandleStore.cache.videos, s = HandleStore.cache.subs;
    const q = document.getElementById('homeQcLast');
    if (q) q.textContent = v || s ? 'Last folders: ' + [v && v.name, s && s.name].filter(Boolean).join(' · ') : '';
    const a = document.getElementById('homeAnaLast');
    if (a) a.textContent = Analysis.running ? 'Running now' : (!NATIVE && HandleStore.cache.analysis ? 'Last folder: ' + HandleStore.cache.analysis.name : '');
    h.hidden = false;
    document.documentElement.classList.add('home-on');
  }
  function hide() { const h = el(); if (h) h.hidden = true; document.documentElement.classList.remove('home-on'); }
  function goQc() { hide(); Analysis.close(); }
  function goAnalysis() { if (NATIVE) { Native.post('analysisOpen'); return; } hide(); Analysis.open(); }
  document.addEventListener('DOMContentLoaded', () => {
    const h = el(); if (!h) return;
    document.getElementById('homeQc').onclick = goQc;
    document.getElementById('homeAna').onclick = goAnalysis;
    const hb = document.getElementById('homeBtn'); if (hb) hb.onclick = show;
    const ab = document.getElementById('anaBtn'); if (ab) ab.onclick = () => { hide(); Analysis.open(); };
    if (NATIVE) Native.on('showHome', show);
    if (window.__analysisWindow || window.__selftest) return;
    Promise.all([HandleStore.load('videos'), HandleStore.load('subs'), NATIVE ? null : HandleStore.load('analysis')]).then(show, show);
    setTimeout(() => { if (window.__selftest) hide(); }, 0);   // the self-test drives the QC page
  });
  return { show, hide };
})();
