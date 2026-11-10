/* ==========================================================================
   UI: folders, tabs, QC table (grouped by episode), player library
   ========================================================================== */
const state = {
  subs: [], videos: [],
  subFolder: '', vidFolder: '', subHandle: null, vidHandle: null,
  groupBy: Store.get('groupBy') === 'episode' ? 'episode' : 'name', issuesOnly: false,
  open: new Set(), lang: '',   // language picked with the filter buttons ('' = all)
  selectedVideo: null, busy: false, matchedOnly: Store.get('matchedOnly') !== 'all', ignoredVideos: [], subCount: 0, vidCount: 0,
};
const STATUS_OPTS = [['', 'Not reviewed'], ['progress', 'In progress'], ['done', 'Done'], ['issues', 'Has issues']];

// ------------------------------------------------------------ folders
async function listDir(handle, re) {
  const out = [];
  for await (const [name, h] of handle.entries()) if (h.kind === 'file' && re.test(name) && !name.startsWith('._')) out.push(await h.getFile());
  return out;
}
// Last-used folders are kept as directory handles in IndexedDB (Chrome/Edge). Pages opened
// from a file don't get the browser's own "last location" memory, so we pass it via startIn.
const HandleStore = {
  db: null, cache: {},
  async open() {
    if (NATIVE) throw new Error('not used in the app');
    if (this.db) return this.db;
    this.db = await new Promise((res, rej) => { const r = indexedDB.open('subtitle-qc', 1); r.onupgradeneeded = () => r.result.createObjectStore('h'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    return this.db;
  },
  async load(k) {
    if (NATIVE) { const p = Store.get('folder:' + k); this.cache[k] = p ? new Native.NDir(p) : null; return this.cache[k]; }
    try { const db = await this.open(); this.cache[k] = await new Promise(res => { const q = db.transaction('h').objectStore('h').get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); }); }
    catch (e) { this.cache[k] = null; }
    return this.cache[k];
  },
  async set(k, v) {
    this.cache[k] = v;
    if (NATIVE) { if (v && v.path) Store.set('folder:' + k, v.path); return; }
    try { const db = await this.open(); await new Promise(res => { const t = db.transaction('h', 'readwrite'); t.objectStore('h').put(v, k); t.oncomplete = res; t.onerror = res; }); } catch (e) {}
  },
};
async function useDir(kind, dir) {
  HandleStore.set(kind, dir);
  if (kind === 'subs') { state.subHandle = dir; state.subFolder = dir.name; await loadSubs(await listDir(dir, SUB_EXT)); }
  else { state.vidHandle = dir; state.vidFolder = dir.name; await loadVideos(await listDir(dir, VIDEO_EXT)); }
}
async function pick(kind) {
  if (NATIVE) {
    const last = HandleStore.cache[kind];
    const dir = await Native.pickFolder(kind, last && last.path);
    if (dir) return useDir(kind, dir);
    return;
  }
  if (window.showDirectoryPicker) {
    const last = HandleStore.cache[kind];
    let dir = null;
    try { dir = await window.showDirectoryPicker(last ? { mode: 'read', id: kind, startIn: last } : { mode: 'read', id: kind }); }
    catch (e) {
      if (e && e.name === 'AbortError') return;
      try { dir = await window.showDirectoryPicker({ mode: 'read', id: kind }); } catch (e2) { if (e2 && e2.name === 'AbortError') return; }
    }
    if (dir) return useDir(kind, dir);
  }
  $(kind === 'subs' ? '#subDirInput' : '#vidDirInput').click();
}
function topLevel(files, re) {
  return [...files].filter(f => f.webkitRelativePath.split('/').length === 2 && re.test(f.name) && !f.name.startsWith('._'));
}
function onDirInput(kind, e) {
  const all = [...e.target.files];
  if (!all.length) return;
  const top = all[0].webkitRelativePath.split('/')[0];
  if (kind === 'subs') { state.subFolder = top; state.subHandle = null; loadSubs(topLevel(all, SUB_EXT)); }
  else { state.vidFolder = top; state.vidHandle = null; loadVideos(topLevel(all, VIDEO_EXT)); }
  e.target.value = '';
}
async function onDrop(e) {
  e.preventDefault(); document.body.classList.remove('drag');
  const entry = e.dataTransfer.items[0] && e.dataTransfer.items[0].webkitGetAsEntry && e.dataTransfer.items[0].webkitGetAsEntry();
  let files = [], folder = '';
  if (entry && entry.isDirectory) {
    folder = entry.name;
    const reader = entry.createReader(), entries = [];
    await new Promise(res => { const next = () => reader.readEntries(b => { if (!b.length) return res(); entries.push(...b); next(); }); next(); });
    files = await Promise.all(entries.filter(en => en.isFile).map(en => new Promise(res => en.file(res))));
  } else files = [...e.dataTransfer.files];
  const vids = files.filter(f => VIDEO_EXT.test(f.name)), subs = files.filter(f => SUB_EXT.test(f.name));
  if (vids.length) { state.vidFolder = folder || '(dropped)'; state.vidHandle = null; await loadVideos(vids); }
  if (subs.length) { state.subFolder = folder || '(dropped)'; state.subHandle = null; await loadSubs(subs); }
}
async function reopen(kind) {
  const h = HandleStore.cache[kind];
  if (!h) return;
  try {
    let perm = await h.queryPermission({ mode: 'read' });
    if (perm !== 'granted') perm = await h.requestPermission({ mode: 'read' });
    if (perm === 'granted') return useDir(kind, h);
  } catch (e) { console.warn('Reopen failed', e); }
  pick(kind);
}
async function rescan() {
  if (state.vidHandle) await loadVideos(await listDir(state.vidHandle, VIDEO_EXT));
  if (state.subHandle) await loadSubs(await listDir(state.subHandle, SUB_EXT));
}

// Episode files only: skip audio-only files, dubcards and anything shorter than a minute.
const MIN_EPISODE_SECONDS = 60;
async function classifyVideo(f, probes) {
  const lo = f.name.toLowerCase();
  let p = null;
  try { p = await TimecodeTrack.probe(f); } catch (e) { p = null; }
  probes[f.name] = p;
  if (p) {
    if (!p.hasVideo) return 'audio only (no picture track)';
    if (p.duration != null && p.duration < MIN_EPISODE_SECONDS) return `short (${Math.round(p.duration)}s), probably a dubcard`;
    if (/dub[\s_.-]*card/.test(lo)) return '“dubcard” in name';
    return null;
  }
  // Could not read the file's structure: fall back to the name.
  if (/dub[\s_.-]*card/.test(lo)) return '“dubcard” in name';
  const words = lo.split(/[^\p{L}]+/u);
  if (words.some(w => FILENAME_WORDS[w] && w !== 'latin')) return 'language in name, probably a dub audio file';
  return null;
}
async function loadVideos(files) {
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  state.vidCount = files.length;
  const keep = [], ignored = [], probes = {};
  for (const f of files) {
    const reason = await classifyVideo(f, probes);
    if (reason && !Store.get('include:' + f.name)) ignored.push({ file: f, name: f.name, reason });
    else keep.push({ file: f, name: f.name, info: Match.parse(f.name), forced: !!reason, probe: probes[f.name], codec: probes[f.name] && TimecodeTrack.codecInfo(probes[f.name].codec) });
  }
  state.videos = keep; state.ignoredVideos = ignored;
  if (state.selectedVideo && !state.videos.some(v => v.name === state.selectedVideo)) state.selectedVideo = null;
  assign(); renderAll();
}
function includeVideo(name, on) {
  on ? Store.set('include:' + name, '1') : Store.del('include:' + name);
  const all = [...state.videos.map(v => v.file), ...state.ignoredVideos.map(v => v.file)];
  loadVideos(all);
}

async function loadSubs(files) {
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  state.subs = []; state.open.clear(); state.busy = true; state.subCount = files.length;
  renderAll();
  const prog = $('#progress');
  prog.hidden = false;
  for (let i = 0; i < files.length; i++) {
    prog.textContent = `Reading ${i + 1} / ${files.length}: ${files[i].name}`;
    const r = await analyzeFile(files[i]);
    if (r) state.subs.push(r);
    if (i % 4 === 3) await new Promise(res => setTimeout(res, 0));
  }
  prog.hidden = true; state.busy = false;
  assign(); renderAll();
}

// ------------------------------------------------------------ matching
function assign() {
  for (const r of state.subs) {
    r.video = null; r.matchReasons = null; r.matchScore = null;
    let best = null;
    for (const v of state.videos) {
      const s = Match.score(v.info, r.nameInfo || Match.parse(r.name));
      if (s.score >= Match.MATCH_THRESHOLD && (!best || s.score > best.s.score)) best = { v, s };
    }
    if (best) { r.video = best.v.name; r.matchReasons = best.s.reasons; r.matchScore = best.s.score; r.matchConflict = best.s.conflict || null; }
    else r.matchConflict = null;
  }
  nameChecks();
}

// ------------------------------------------------------------ season / episode in file names
// Compares the season (and episode) in each subtitle file name with: its matched video, the chosen
// folder's name, and the other subtitle files of the same show. Mismatches are shown under the
// file name on the Conform page and count as errors / warnings.
const seasonFromText = (t) => Match.seasonFromText(t);
function nameChecks() {
  const KIND = 'name';
  for (const r of state.subs) { r.flags = (r.flags || []).filter(f => f.kind !== KIND); r.nameIssues = []; }
  const add = (r, sev, text, detail) => { r.flags.push({ sev, text, detail, kind: KIND }); r.nameIssues.push({ sev, text }); };
  const seasonOf = r => (r.nameInfo || {}).season;

  // 1. against the matched video (same production code, different season / episode)
  for (const r of state.subs) {
    const c = r.matchConflict;
    if (!c) continue;
    if (c.season) add(r, 'error', `Season ${c.season[1]} in file name, but the video is Season ${c.season[0]}`, `Same production code as the video “${r.video}”.`);
    if (c.episode) add(r, 'error', `Episode ${c.episode[1]} in file name, but the video is episode ${c.episode[0]}`, `Same production code as the video “${r.video}”.`);
  }
  // 2. against the chosen folder's name (e.g. "Season_02")
  const folderSeason = seasonFromText(state.subFolder);
  if (folderSeason != null) for (const r of state.subs) {
    const s = seasonOf(r);
    if (s != null && s !== folderSeason && !(r.matchConflict && r.matchConflict.season))
      add(r, 'error', `Season ${s} in file name, but the folder is Season ${folderSeason}`, `Folder “${state.subFolder}”.`);
  }
  // 3. against the other files of the same show: flag the odd ones out when most agree
  const byShow = new Map();
  for (const r of state.subs) {
    const s = seasonOf(r), show = ((r.nameInfo || {}).showWords || []).join('');
    if (s == null || !show) continue;
    if (!byShow.has(show)) byShow.set(show, []);
    byShow.get(show).push(r);
  }
  for (const list of byShow.values()) {
    if (list.length < 3) continue;
    const counts = new Map();
    for (const r of list) counts.set(seasonOf(r), (counts.get(seasonOf(r)) || 0) + 1);
    if (counts.size < 2) continue;
    const [major, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (n <= list.length / 2) continue;   // no clear majority: probably a mixed folder on purpose
    for (const r of list) {
      if (seasonOf(r) === major || r.nameIssues.length) continue;
      add(r, 'warn', `Season ${seasonOf(r)} in file name; the other ${n} files are Season ${major}`, 'Check that the file belongs to this season.');
    }
  }
  for (const r of state.subs) r.severity = r.flags.reduce((s, f) => SEV_RANK[f.sev] > SEV_RANK[s] ? f.sev : s, 'ok');
}
function subsForVideo(name) { return state.subs.filter(r => r.video === name); }

// ------------------------------------------------------------ grouping
function groupsFor(list) {
  const groups = new Map();
  const add = (key, init, r) => { if (!groups.has(key)) groups.set(key, { key, rows: [], ...init }); if (r) groups.get(key).rows.push(r); };
  if (state.groupBy === 'episode') {
    for (const v of state.videos) add('v:' + v.name, { title: videoTitle(v), video: v.name, sort: '0' + videoTitle(v) }, null);
    for (const r of list) {
      if (r.video) { add('v:' + r.video, {}, r); continue; }
      const info = r.nameInfo || Match.parse(r.name);
      const k = Match.episodeKey(info);
      if (k) add('e:' + k, { title: Match.episodeTitle(info, (state.common && state.common.opts) || {}), noVideo: state.videos.length > 0, sort: '1' + Match.episodeTitle(info) }, r);
      else add('e:~', { title: 'Episode not recognised from file name', noVideo: state.videos.length > 0, sort: '2' }, r);
    }
  } else if (state.groupBy === 'name') {
    // One group per language as written in the file name (regions kept apart), split by type.
    const TYPE_ORDER = { Full: 0, Forced: 1, 'CC/SDH': 2 };
    for (const r of list) {
      const code = r.fileLang && r.fileLang.code;
      const type = r.type || 'Full';
      if (!code) { add('n:~', { title: 'No language in file name', sort: '\uffff' }, r); continue; }
      const name = langLabel({ fileLang: r.fileLang }) || code;
      add('n:' + code.toLowerCase() + '|' + type, { title: `${name} · ${type}`, code, sort: name.toLowerCase() + ' ' + (TYPE_ORDER[type] ?? 9) }, r);
    }
  } else {
    for (const r of list) {
      let key, title, code;
      if (state.groupBy === 'detected') {
        const d = r.detected;
        if (!d || !d.lang) { key = '~'; title = 'Not detected'; }
        else { const scr = (d.script === 'Hans' || d.script === 'Hant') ? '-' + d.script : ''; key = d.lang + scr; code = key; title = langName(d.lang) + (scr ? ` (${Detector.SCRIPT_NAMES[d.script]})` : ''); }
      } else if (!r.rawLabel) { key = '~'; title = 'No label'; }
      else { key = r.match && r.match.ref ? r.match.ref.code.toLowerCase() : r.rawLabel.toLowerCase(); code = r.match && r.match.ref ? r.match.ref.code : r.rawLabel; title = r.match && r.match.ref ? r.match.ref.names.map(prettyName).join(' / ') : 'Unknown code'; }
      add('l:' + key, { title, code, sort: key === '~' ? '~' : title }, r);
    }
  }
  const out = [...groups.values()];
  out.forEach(g => g.rows.sort(state.groupBy === 'name'
    ? (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    : (a, b) => langSortKey(a).localeCompare(langSortKey(b)) || a.name.localeCompare(b.name)));
  return out.sort((a, b) => a.sort.localeCompare(b.sort, undefined, { numeric: true }));
}
function langSortKey(r) { return (r.expected ? r.expected.names[0] : (r.rawLabel || '~')) + ' ' + (r.type || ''); }
function videoInfo(v) {
  // Prefer the cleaner episode title from a matched subtitle name if there is one.
  const sub = state.subs.find(r => r.video === v.name && r.nameInfo && r.nameInfo.titleWords.length);
  return sub ? { ...v.info, titleWords: sub.nameInfo.titleWords, titleArticle: sub.nameInfo.titleArticle } : v.info;
}
function videoTitle(v, opts) { return Match.episodeTitle(videoInfo(v), opts || (state.common && state.common.opts) || {}); }

// "Matched only" applies once both folders are loaded.
function filterActive() { return state.matchedOnly && state.videos.length > 0 && state.subs.length > 0; }
function visibleVideos() { return filterActive() ? state.videos.filter(v => subsForVideo(v.name).length) : state.videos; }
// The title for the top of the Conform page, from the video names and the subtitle names. A short
// abbreviation ("OGZ") gives way to a real name ("LawOrderOrganizedCrime" → Law Order Organized Crime);
// otherwise the fuller name wins (videos when equal).
function showTitle() {
  const pick = infos => {
    const n = new Map();
    for (const i of infos) { if (!i || !i.showWords || !i.showWords.length) continue; const k = i.showWords.join(' '); const e = n.get(k) || { i, c: 0 }; e.c++; n.set(k, e); }
    const best = [...n.values()].sort((a, b) => b.c - a.c)[0];
    return best && best.c >= infos.length / 2 ? best.i : null;   // the name most files share
  };
  const seasonOf = infos => { const s = infos.filter(Boolean).map(i => i.season); return s.length && s[0] != null && s.every(x => x === s[0]) ? s[0] : null; };
  const vInfos = visibleVideos().map(videoInfo), sInfos = state.subs.map(r => r.nameInfo).filter(Boolean);
  const v = pick(vInfos), s = pick(sInfos);
  const abbrev = i => i.showWords.length === 1 && i.showWords[0].length <= 4;
  let best = v || s;
  if (v && s && v.showWords.join('') !== s.showWords.join('')) {
    if (abbrev(v) && !abbrev(s)) best = s;
    else if (abbrev(s) && !abbrev(v)) best = v;
    else best = s.showWords.length > v.showWords.length ? s : v;
  }
  if (!best) return '';
  const season = seasonOf(vInfos.length ? vInfos : sInfos);
  return Match.showName(best) + (season != null ? ` · Season ${season}` : '');
}
function computeCommon() {
  const vids = visibleVideos();
  const infos = vids.length ? vids.map(videoInfo) : state.subs.map(r => r.nameInfo).filter(Boolean);
  state.common = Match.common(infos);
}

// ------------------------------------------------------------ render: header & tabs
// Switching tabs pauses playback.
function setTab(t) {
  if (document.body.dataset.tab && document.body.dataset.tab !== t && Player.pause) Player.pause();
  document.body.dataset.tab = t;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  $('#tab-qc').hidden = t !== 'qc';
  $('#tab-player').hidden = t !== 'player';
  if (t === 'player') {
    renderLibrary(); Player.onShow();
    // Nothing open yet: start with the first video in the list and its first subtitle file.
    if (!state.selectedVideo && !Player.currentSubtitle()) {
      const v = visibleVideos()[0];
      if (v) selectVideo(v.name);
      else if (state.subs.length) openSubtitle([...state.subs].sort((a, b) => langSortKey(a).localeCompare(langSortKey(b)))[0]);
    }
  }
}
function renderHeader() {
  const fold = (el, name, n, extra) => {
    const kind = el.id === 'subFolderName' ? 'subs' : 'videos', box = el.parentElement;
    el.classList.toggle('unset', !name);
    box.classList.toggle('empty', !name);
    const h = HandleStore.cache[kind];
    const what = kind === 'subs' ? 'subtitles' : 'videos';
    // A folder from last time that the browser needs a click to open again: the field offers it.
    const canReopen = !name && !!h && !!(window.showDirectoryPicker || NATIVE);
    box.dataset.reopen = canReopen ? '1' : '';
    $(kind === 'subs' ? '#subReopen' : '#vidReopen').hidden = !canReopen;
    el.textContent = name ? `${name} · ${n} file${n === 1 ? '' : 's'}${extra || ''}` : canReopen ? `↺ Reopen “${h.name}”` : 'Select folder…';
    el.title = '';
    box.title = name ? (NATIVE && h && h.path ? h.path : `${name}\nBrowsers only reveal the folder's name, not its full path.`) + `\nClick to select another ${what} folder.`
      : canReopen ? `Reopen the ${what} folder used last time (“${h.name}”)` : `Select the ${what} folder (or drop it on the window)`;
  };
  fold($('#subFolderName'), state.subFolder, state.subCount);
  fold($('#vidFolderName'), state.vidFolder, state.videos.length, state.ignoredVideos.length ? ` (+${state.ignoredVideos.length} ignored)` : '');
  $('#rescan').hidden = !(state.subHandle || state.vidHandle);
  renderToggle();
  const res = state.subs, n = s => res.filter(r => r.severity === s).length;
  // (File counts are in the folder fields; errors / warnings / OK are on each group.)
  $('#summary').innerHTML = '';
}
function renderAll() { computeCommon(); renderHeader(); renderQC(); if (document.body.dataset.tab === 'player') renderLibrary(); }
function renderToggle() {
  const b = $('#matchToggle');
  b.classList.toggle('on', state.matchedOnly);
  b.setAttribute('aria-checked', String(state.matchedOnly));
  b.title = (state.matchedOnly ? 'Showing only videos and subtitle files that match each other.' : 'Showing every video and subtitle file.') +
    (state.videos.length && state.subs.length ? '' : '\n(Takes effect once both folders are chosen.)') + '\nClick to switch.';
}

// ------------------------------------------------------------ render: QC tab
const COLS = `<colgroup><col class="c-dot"><col class="c-file"><col class="c-type"><col class="c-label"><col class="c-det"><col class="c-flags"><col class="c-notes"><col class="c-sp"><col class="c-play"></colgroup>`;
const THEAD = `<thead><tr><th></th><th>File</th><th>Type</th><th>Label</th><th>Detected</th><th>Checks</th><th>Notes</th><th></th><th></th></tr></thead>`;

function renderQC() {
  const empty = !state.subs.length && !state.busy;
  $('#empty').hidden = true;
  $('#qcResults').hidden = empty && !state.videos.length;
  const host = $('#groups');
  if (empty && !state.videos.length) { host.innerHTML = ''; return; }
  const matched = filterActive() ? state.subs.filter(r => r.video) : state.subs;
  renderLangFilter(matched);
  const list = state.lang ? matched.filter(r => langKey(r) === state.lang) : matched;
  const hiddenSubs = state.subs.length - matched.length;
  const tl = showTitle();
  $('#commonHead').innerHTML = tl ? `<span class="common-l" title="Title">${esc(tl)}</span>` : '';
  $('#hiddenNote').textContent = hiddenSubs ? `${hiddenSubs} unmatched subtitle file${hiddenSubs === 1 ? '' : 's'} hidden` : '';
  let html = '';
  for (const g of groupsFor(list)) {
    if (filterActive() && state.groupBy === 'episode' && (!g.video || !g.rows.length)) continue;
    if (state.lang && !g.rows.length) continue;
    const rows = state.issuesOnly ? g.rows.filter(r => r.severity === 'error' || r.severity === 'warn') : g.rows;
    if (state.issuesOnly && !rows.length) continue;
    const e = g.rows.filter(r => r.severity === 'error').length, w = g.rows.filter(r => r.severity === 'warn').length, ok = g.rows.length - e - w;
    const status = Store.get('status:' + g.key) || '';
    const meta = g.video ? `<span class="muted small" title="${esc(g.video)}">🎬 ${esc(g.video)}</span>` : g.noVideo ? `<span class="tag-novideo">no matching video</span>` : '';
    html += `<section class="card st-${status || 'none'}" data-g="${esc(g.key)}">
      <div class="card-h">
        <div class="ct"><div class="title">${esc(g.title)} ${g.code ? `<code>${esc(g.code)}</code>` : ''}</div>${meta}</div>
        <span class="muted small">${g.rows.length} file${g.rows.length === 1 ? '' : 's'}</span>
        ${e ? `<span class="chip sev-error sm">${e} error${e === 1 ? '' : 's'}</span>` : ''}${w ? `<span class="chip sev-warn sm">${w} warning${w === 1 ? '' : 's'}</span>` : ''}${ok ? `<span class="chip sev-ok sm">${ok} OK</span>` : ''}
        <span class="spacer"></span>
        ${state.groupBy === 'episode' ? `<select class="rstatus" data-g="${esc(g.key)}" title="Review status">${STATUS_OPTS.map(([v, l]) => `<option value="${v}"${v === status ? ' selected' : ''}>${l}</option>`).join('')}</select>` : ''}
        ${g.video ? `<button class="ghost open-video" data-v="${esc(g.video)}">▶ Open in player</button>` : ''}
      </div>`;
    if (!g.rows.length) html += `<div class="card-empty">No subtitle files matched this video.</div>`;
    else html += `<table>${COLS}${THEAD}<tbody>${rows.map(r => rowHtml(r) + (state.open.has(r.name) ? detailHtml(r) : '')).join('')}</tbody></table>`;
    html += `</section>`;
  }
  host.innerHTML = html || `<div class="none">No issues found.</div>`;
}

// Language filter buttons: All, then one per language found in the file names (plus "no language"). One at a time.
const langKey = r => (r.fileLang && r.fileLang.code) ? r.fileLang.code.toLowerCase() : '~';
function renderLangFilter(list) {
  const host = $('#langFilter');
  if (!host) return;
  const groups = new Map();
  for (const r of list) {
    const k = langKey(r);
    if (!groups.has(k)) groups.set(k, { k, n: 0, name: k === '~' ? 'No language in file name' : (langLabel({ fileLang: r.fileLang }) || r.fileLang.code) });
    groups.get(k).n++;
  }
  if (state.lang && !groups.has(state.lang)) state.lang = '';   // that language is no longer present
  const items = [...groups.values()].sort((a, b) => (a.k === '~') - (b.k === '~') || a.name.localeCompare(b.name));
  host.hidden = items.length < 2;
  // Long names shortened: every word but the last becomes an initial (Brazilian Portuguese → B. Portuguese).
  const short = g => g.k === '~' ? 'No language' : g.name.split(/\s+/).map((w, i, a) => i < a.length - 1 ? w[0] + '.' : w).join(' ');
  host.innerHTML = `<button type="button" class="lchip${state.lang ? '' : ' on'}" data-k="">All <span>${list.length}</span></button>`
    + items.map(g => `<button type="button" class="lchip${state.lang === g.k ? ' on' : ''}${g.k === '~' ? ' lnone' : ''}" data-k="${esc(g.k)}" title="${esc(g.name)}">${esc(short(g))} <span>${g.n}</span></button>`).join('');
}

function cueChecksHtml(c) {
  if (!c) return '<span class="muted">—</span>';
  const items = [['cps', 'S', `Over ${CueCheck.CPS_LIMIT} characters per second`], ['chars', 'C', `Over ${CueCheck.CHAR_LIMIT} characters on a line`], ['lines', 'L', `${CueCheck.LINE_COUNT_THRESHOLD}+ lines`],
    ['overlap', 'O', 'Overlapping cues'], ['duration', 'D', `Shorter than ${CueCheck.SHORT_DURATION_SECONDS}s or longer than ${CueCheck.MAX_DURATION_SECONDS}s`], ['critical', '!', 'Very short with a long line'],
    ['odd', '#', 'Invisible / odd characters'], ['mixed', 'M', 'Lines aligned differently within an event'],
    ['gaps', 'G', '1-frame gaps (the subtitle blinks off for a frame)'],
    ['raised', '↑', 'Raised'], ['side', '↔', 'Left / right-aligned']]
    .filter(([k]) => c[k]).map(([k, t, title]) => `<span class="ft ${k === 'raised' || k === 'side' ? 'ft-place' : k === 'gaps' || k === 'cps' || k === 'mixed' ? 'ft-warn' : 'ft-issue'}" title="${esc(title)}: ${c[k]}">${t}<b>${c[k]}</b></span>`);
  return items.length ? items.join('') : '<span class="ok small">clean</span>';
}

function rowHtml(r) {
  const d = r.detected;
  const expCls = r.match && (r.match.status === 'exact' || r.match.status === 'regional') ? '' : r.match && (r.match.status === 'equivalent' || r.match.status === 'base') ? 'hl-warn' : r.match ? 'hl-error' : '';
  let det = '<span class="muted">—</span>';
  if (d && d.lang) {
    const main = r.breakdown.find(b => b.lang === d.lang);
    const scr = (d.script === 'Hans' || d.script === 'Hant') ? ` <span class="tag">${d.script === 'Hans' ? 'Simplified' : 'Traditional'}</span>`
      : d.lang === 'sr' ? ` <span class="tag">${d.script === 'Cyrl' ? 'Cyrillic' : 'Latin'}</span>` : d.script === 'Hans/Hant?' ? ' <span class="tag">Mixed Hans/Hant</span>' : '';
    det = r.littleText ? `<span class="muted" title="Too little text to be sure">${esc(langName(d.lang))}? · little text</span>` : `${esc(langName(d.lang))}${scr}`;
  }
  const detErr = r.flags.some(f => f.sev === 'error' && /^(Content is|Script is|Serbian script)/.test(f.text));
  const detWarn = r.flags.some(f => f.sev === 'warn' && /^(Text looks like|Written Cantonese|Mixed Simplified|Possibly)/.test(f.text));
  const fnWarn = r.flags.some(f => /^File name says/.test(f.text));
  // Detected: just the language when it is all one language and matches the label; otherwise with percentages
  // and any other languages found.
  if (d && d.lang && !r.littleText) {
    const main = r.breakdown.find(b => b.lang === d.lang);
    const others = r.secondary || [];
    if (detErr || detWarn || others.length || (main && main.pct < 99.5)) {
      det += ` <span class="pct">${main ? fmtPct(main.pct) : ''}</span>` + others.map(s => `<div class="det-o">${esc(langName(s.lang))} <span class="pct">${fmtPct(s.pct)}</span></div>`).join('');
    }
  }
  // Checks: errors and warnings (or OK). Notes: things worth knowing that are not problems.
  const flags = r.flags.filter(f => f.sev !== 'info').map(f => `<span class="flag sev-${f.sev}">${esc(f.text)}</span>`).join('');
  const notes = r.flags.filter(f => f.sev === 'info' && /^(Region|Cantonese|Inner|Image|Low|.* close variants|.* has no language label)/.test(f.text) && !/markers consistent/.test(f.text))
    .map(f => `<span class="note" title="${esc(f.detail || '')}">${esc(f.text)}</span>`).join('');
  const typeCls = r.type === 'Forced' ? 'ty-forced' : r.type === 'CC/SDH' ? 'ty-cc' : 'ty-full';
  return `<tr class="row sev-row-${r.severity}${state.open.has(r.name) ? ' open' : ''}" data-f="${esc(r.name)}">
    <td class="dot"><span class="sd sd-${r.severity}" title="${r.severity}"></span></td>
    <td class="fname"><div class="dn fn" title="${esc(r.name)}">${esc(r.name)}</div>${(r.nameIssues || []).map(i => `<div class="name-issue sev-${i.sev}">⚠ ${esc(i.text)}</div>`).join('')}</td>
    <td><span class="ty ${typeCls}">${esc(r.type)}</span></td>
    <td class="lbl ${r.rawLabel ? expCls : ''}" title="${esc(r.expected ? r.expected.names.map(prettyName).join(' / ') + (r.match && r.match.ref ? ` (list code ${r.match.ref.code})` : '') : '')}">${r.rawLabel ? `<code>${esc(r.rawLabel)}</code>` : '<span class="no-label">No label</span>'}${r.match && r.match.ref && r.match.status !== 'exact' ? `<div class="muted small">list: ${esc(r.match.ref.code)}</div>` : ''}</td>
    <td class="${detErr ? 'hl-error' : detWarn ? 'hl-warn' : ''}">${det}</td>
    <td class="flags">${flags || '<span class="ok">✓ OK</span>'}</td>
    <td class="notes">${notes}</td>
    <td></td>
    <td><button class="play" data-f="${esc(r.name)}" title="Open in player">▶</button></td></tr>`;
}

function detailHtml(r) {
  const d = r.detected || {};
  const flags = r.flags.map(f => `<li class="sev-${f.sev}"><b>${esc(f.text)}</b>${f.detail ? ` — <span>${esc(f.detail)}</span>` : ''}</li>`).join('') || '<li class="sev-ok">No issues.</li>';
  const bars = (r.breakdown || []).map(b => `<div class="bar"><span class="bl">${esc(langName(b.lang))}</span><span class="bt"><span class="bf ${b.lang === d.lang ? 'main' : 'alt'}" style="width:${Math.max(1, b.pct)}%"></span></span><span class="bn">${fmtPct(b.pct)} · ${b.n}</span></div>`).join('');
  let samples = '';
  for (const [l, cs] of Object.entries(r.samples || {})) {
    samples += `<div class="samp"><div class="muted">${esc(langName(l))} — ${cs.length} cue${cs.length === 1 ? '' : 's'}${cs.length > 8 ? ' (first 8)' : ''}</div>` +
      cs.slice(0, 8).map(c => `<div class="cue-s"><span class="tc">${esc(c.begin)}</span>${esc(c.text).replace(/\n/g, ' / ')}</div>`).join('') + '</div>';
  }
  const rm = r.regionMarkers ? Object.entries(r.regionMarkers).map(([k, g]) => `<div><b>${k}</b>: ${g.total} <span class="muted">${esc(topMarkers(g))}</span></div>`).join('') : '';
  const hz = r.han && r.han.total ? `<div class="muted small">Chinese chars: ${r.han.total} · Simplified-only ${r.han.simp} · Traditional-only ${r.han.trad} · Cantonese markers ${r.han.cantonese}</div>` : '';
  const ni = r.nameInfo || {};
  const nameBits = [ni.showWords && ni.showWords.length ? `show “${Match.titleCase(ni.showWords)}”` : '', ni.season != null ? `season ${ni.season}` : '', ni.episode != null ? `episode ${ni.episode}` : '',
    ni.titleWords && ni.titleWords.length ? `title “${Match.titleCase(ni.titleWords)}”` : '', ni.codes && ni.codes.length ? `code ${ni.codes.join(', ')}` : ''].filter(Boolean).join(' · ');
  return `<tr class="detail"><td></td><td colspan="8"><div class="dchecks"><h4 class="h-checks">Checks</h4><ul class="fl">${flags}</ul></div><div class="dgrid">
    <div><h4 class="h-file">File</h4><div class="kv"><span>Full name</span><code class="full">${esc(r.name)}</code></div>
      <div class="kv"><span>Format</span>${esc(r.format || '—')}${r.cueCount != null ? ` · ${r.cueCount} cue${r.cueCount === 1 ? '' : 's'}` : ''}</div>
      <div class="kv"><span>Frame rate</span>${r.fileFps ? `${+r.fileFps.toFixed(3)} fps declared` : '<span class="muted">not declared</span>'}${r.nameFps ? ` · name says ${r.nameFps}` : ''}</div>
      <div class="kv"><span>Encoding</span>${esc(r.encoding || '—')}</div>
      <h4 class="h-name">Name &amp; video</h4>
      <div class="kv"><span>Language in name</span>${r.fileLang ? `<code>${esc(r.fileLang.src)}</code> → ${esc(r.fileLang.code)}` : '<span class="muted">none found</span>'}</div>
      <div class="kv"><span>Episode in name</span>${esc(nameBits || '—')}</div>
      <div class="kv"><span>Video</span>${r.video ? esc(r.video) : `<span class="muted">${state.videos.length ? 'no match' : 'no videos folder'}</span>`}</div></div>
    <div><h4 class="h-lang">Language label</h4>
      <div class="kv"><span>xml:lang on &lt;tt&gt;</span><code>${esc(r.rawLabel ?? '(none)')}</code></div>
      <div class="kv"><span>List match</span>${r.match ? esc({ exact: 'exact', regional: 'regional variant of a list code', equivalent: 'equivalent code', base: 'base language only', unknown: 'not in list', missing: '—' }[r.match.status]) : '—'}${r.expected ? ` → <code>${esc(r.expected.code)}</code> ${esc(r.expected.names.join(', '))}` : ''}</div>
      ${r.innerLangs && r.innerLangs.length ? `<div class="kv"><span>Inner tags</span>${r.innerLangs.map(([l, n]) => `<code>${esc(l)}</code>×${n}`).join(' ')}</div>` : ''}
    <h4 class="h-lang">Detected language by cue <span class="muted small">(${r.classified || 0} of ${r.cueCount || 0} cues had enough text)</span></h4>${bars || '<span class="muted">—</span>'}
      ${d.lang ? `<div class="muted small">Primary: ${esc(langName(d.lang))} · script ${esc(Detector.SCRIPT_NAMES[d.script] || d.script || '')} · confidence ${esc(d.conf)}${d.alt ? ` · runner-up ${esc(langName(d.alt))}` : ''}</div>` : ''}
      ${hz}${rm ? `<h4>Regional markers</h4>${rm}` : ''}
      ${samples ? `<h4>Cues in other languages</h4>${samples}` : ''}</div>
  </div></td></tr>`;
}

// ------------------------------------------------------------ render: player library
function renderLibrary() {
  const vl = $('#videoList'), sl = $('#subList');
  const vids = visibleVideos();
  const hiddenV = state.videos.length - vids.length;
  $('#videoCount').innerHTML = (showTitle() ? `<span class="common-l">${esc(showTitle())}</span> ` : '') +
    (state.videos.length ? `<span class="muted">${vids.length}${hiddenV ? ` of ${state.videos.length}` : ''}</span>` : '');
  // fixed info line for the selected video
  const sv = state.videos.find(v => v.name === state.selectedVideo);
  if (sv) {
    const n = subsForVideo(sv.name).length;
    $('#vidInfo').innerHTML = `<div class="vi-name">${esc(sv.name)}</div><div class="vi-meta">${sv.codec ? `${esc(sv.codec.name)}${sv.probe && sv.probe.width ? ` · ${sv.probe.width}×${sv.probe.height}` : ''} · ` : ''}${n ? `${n} subtitle file${n === 1 ? '' : 's'}` : 'no matching subtitle files'}${sv.codec && sv.codec.chrome === false ? ` · <span class="warn-t">${PLAYER_NAME} can't show this picture</span>` : ''}${sv.forced ? ` · <button class="mini excl" data-n="${esc(sv.name)}">Ignore again</button>` : ''}</div>`;
  } else $('#vidInfo').innerHTML = '';

  if (!state.videos.length) vl.innerHTML = '';
  else if (!vids.length) vl.innerHTML = `<div class="list-empty">No video matches any subtitle file. Switch “Matched only” off to see every video.</div>`;
  else vl.innerHTML = vids.map(v => {
    const st = Store.get('status:v:' + v.name) || '';
    return `<div class="vrow${state.selectedVideo === v.name ? ' sel' : ''}" data-v="${esc(v.name)}" title="${esc(v.name)}">
      <div class="vline"><span class="vt">${esc(videoTitle(v))}</span>${v.codec && v.codec.chrome === false ? ` <span class="nochrome" title="${PLAYER_NAME} can't display this codec">⚠</span>` : ''}</div></div>`;
  }).join('');
  if (state.ignoredVideos.length) vl.innerHTML += `<details class="ign"${state.ignOpen ? ' open' : ''}><summary>Ignored (${state.ignoredVideos.length}): audio files, dubcards, short clips</summary>${state.ignoredVideos.map(v => `
    <div class="li ignored" data-ign="${esc(v.name)}"><div class="li-s">${esc(v.name)}</div><div class="li-n muted">${esc(v.reason)} · <button class="mini incl" data-n="${esc(v.name)}">Include</button></div></div>`).join('')}</details>`;
  const selRow = vl.querySelector('.vrow.sel');
  if (selRow) { const lt = vl.getBoundingClientRect(), rt = selRow.getBoundingClientRect(); if (rt.top < lt.top || rt.bottom > lt.bottom) selRow.scrollIntoView({ block: 'nearest' }); }

  let subs = state.subs, note = '';
  if (!state.subs.length) note = '';
  else if (!state.videos.length) note = `All ${state.subs.length}`;
  else if (filterActive()) {
    if (state.selectedVideo) {
      subs = subsForVideo(state.selectedVideo);
      note = subs.length ? `${subs.length} matched to this video` : `<span class="warn-t">No subtitle files match this video.</span>`;
    } else { subs = []; note = ''; }
  } else if (state.selectedVideo) {
    const m = subsForVideo(state.selectedVideo);
    if (m.length) { subs = m; note = `${m.length} matched to this video`; }
    else note = `<span class="warn-t">No subtitle names match this video. Showing all ${state.subs.length}.</span>`;
  } else note = `All ${state.subs.length}`;
  $('#subNote').innerHTML = note;
  if (!state.subs.length) { sl.innerHTML = ''; return; }
  if (!subs.length) { sl.innerHTML = state.selectedVideo ? `<div class="list-empty">Switch “Matched only” off to pick any subtitle file.</div>` : ''; return; }
  const cur = Player.currentSubtitle();
  sl.innerHTML = [...subs].sort((a, b) => langSortKey(a).localeCompare(langSortKey(b))).map(r => `
    <div class="li${cur === r.name ? ' sel' : ''}" data-f="${esc(r.name)}" title="${esc(r.name)}">
      <div class="li-t">${esc(langLabel(r) || 'No label')}
        <code>${esc(r.rawLabel || '—')}</code> <span class="ty ${r.type === 'Forced' ? 'ty-forced' : r.type === 'CC/SDH' ? 'ty-cc' : 'ty-full'}">${esc(r.type)}</span></div>
      <div class="li-s">${esc(state.selectedVideo && r.video === state.selectedVideo ? r.name : displayName(r))}</div>
      ${(r.nameIssues || []).map(i => `<div class="name-issue sev-${i.sev}">⚠ ${esc(i.text)}</div>`).join('')}
      ${state.selectedVideo && r.video === state.selectedVideo ? `<div class="li-n muted">matched on ${esc(r.matchReasons.join(', '))}</div>` : ''}
    </div>`).join('');
}

async function selectVideo(name, { autoSub = true } = {}) {
  const v = state.videos.find(x => x.name === name);
  if (!v) return;
  state.selectedVideo = name;
  if (Player.currentVideoFile() !== v.file) await Player.loadVideoFile(v.file, v.codec, v.probe);
  if (autoSub) {
    const matched = subsForVideo(name).sort((a, b) => langSortKey(a).localeCompare(langSortKey(b)));   // same order as the list
    const curName = Player.currentSubtitle();
    if (matched.length && !matched.some(r => r.name === curName)) {
      // Keep the same language/type as the current subtitle when switching episodes.
      const cur = state.subs.find(r => r.name === curName);
      const same = cur && matched.find(r => r.rawLabel === cur.rawLabel && r.type === cur.type);
      await openSubtitle(same || matched[0]);
    }
  }
  renderLibrary();
}
async function openSubtitle(r) {
  let text;
  try { ({ text } = await readText(r.file)); }
  catch (e) {
    Player.showMessage(Player.movedMessage(r.name), 'sub');
    return;
  }
  Player.loadSubtitle(text, r.name);
  renderLibrary();
}
async function playFromQC(name) {
  const r = state.subs.find(x => x.name === name);
  if (!r) return;
  setTab('player');
  if (r.video) await selectVideo(r.video, { autoSub: false });
  await openSubtitle(r);
}

// ------------------------------------------------------------ wiring
document.addEventListener('DOMContentLoaded', () => {
  document.body.dataset.tab = 'qc';
  $('#appVersion').textContent = `Subtitle QC Player Version ${APP_VERSION}` + (NATIVE ? ' (Mac app)' : '');
  $('#helpNav').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    document.querySelectorAll('#helpNav button').forEach(x => x.classList.toggle('on', x === b));
    document.querySelectorAll('.help-pages section').forEach(s => { s.hidden = s.dataset.h !== b.dataset.h; });
  };
  $('#pickSubs').onclick = () => pick('subs');
  $('#pickVids').onclick = () => pick('videos');
  // The folder fields themselves are the buttons (Reopen inside them keeps its own action).
  document.querySelectorAll('.folder[data-kind]').forEach(box => {
    const act = e => (box.dataset.reopen && !e.target.closest('.fl-other')) ? reopen(box.dataset.kind) : pick(box.dataset.kind);
    box.addEventListener('click', act);
    box.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === box) { e.preventDefault(); act(e); } });
  });
  $('#subDirInput').onchange = e => onDirInput('subs', e);
  $('#vidDirInput').onchange = e => onDirInput('videos', e);
  $('#rescan').onclick = rescan;
  // New CPS / line-length limits: re-count the Conform page too.
  document.addEventListener('qc-limits', () => { state.subs.forEach(countChecks); renderQC(); });
  $('#helpBtn').onclick = () => { $('#helpModal').hidden = false; };
  $('#helpClose').onclick = () => { $('#helpModal').hidden = true; };
  $('#helpModal').addEventListener('click', e => { if (e.target.id === 'helpModal') $('#helpModal').hidden = true; });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#helpModal').hidden = true; });
  $('#matchToggle').onclick = () => { state.matchedOnly = !state.matchedOnly; Store.set('matchedOnly', state.matchedOnly ? 'matched' : 'all'); renderAll(); };
  $('#vidInfo').addEventListener('click', e => { const exc = e.target.closest('button.excl'); if (exc) includeVideo(exc.dataset.n, false); });
  Promise.all([HandleStore.load('subs'), HandleStore.load('videos')]).then(async () => {
    renderHeader();
    // The app can reopen the last folders straight away (a browser needs a click for permission).
    if (NATIVE) for (const kind of ['videos', 'subs']) {
      const d = HandleStore.cache[kind];
      if (d) { try { await useDir(kind, d); } catch (e) { console.warn('Could not reopen', d.path, e); } }
    }
  });
  // Folders or files dragged onto the app window from Finder.
  if (NATIVE) window.onNativeDrop = async (items) => {
    for (const it of items.filter(i => i.isDir)) {
      const dir = new Native.NDir(it.path), list = await Native.listFolder(it.path);
      if (list.some(f => VIDEO_EXT.test(f.name))) await useDir('videos', dir);
      if (list.some(f => SUB_EXT.test(f.name))) await useDir('subs', dir);
    }
    const files = items.filter(i => !i.isDir).map(i => new Native.NFile(i));
    const vids = files.filter(f => VIDEO_EXT.test(f.name)), subs = files.filter(f => SUB_EXT.test(f.name));
    if (vids.length) { state.vidFolder = '(dropped)'; state.vidHandle = null; await loadVideos(vids); }
    if (subs.length) { state.subFolder = '(dropped)'; state.subHandle = null; await loadSubs(subs); }
  };
  document.querySelectorAll('.tab').forEach(b => b.onclick = () => setTab(b.dataset.tab));
  $('#groupBy').value = state.groupBy;
  $('#groupBy').onchange = e => { e.target.blur(); state.groupBy = e.target.value; Store.set('groupBy', state.groupBy); renderQC(); };
  $('#langFilter').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    state.lang = b.dataset.k;   // one language at a time; All = ''
    renderQC();
  };
  $('#issuesOnly').onchange = e => { state.issuesOnly = e.target.checked; renderQC(); };
  $('#groups').addEventListener('change', e => {
    const s = e.target.closest("select.rstatus");
    if (s) { s.value ? Store.set('status:' + s.dataset.g, s.value) : Store.del('status:' + s.dataset.g); s.closest('.card').className = 'card st-' + (s.value || 'none'); }
  });
  $('#groups').addEventListener('click', e => {
    if (e.target.closest('select')) return;
    const cp = e.target.closest('button.copy');
    if (cp) { e.stopPropagation(); navigator.clipboard && navigator.clipboard.writeText(cp.dataset.copy).then(() => { cp.textContent = 'Copied'; setTimeout(() => cp.textContent = 'Copy', 1200); }); return; }
    if (e.target.closest('tr.detail')) return;
    const play = e.target.closest('button.play');
    if (play) { e.stopPropagation(); return playFromQC(play.dataset.f); }
    const ov = e.target.closest('button.open-video');
    if (ov) { setTab('player'); return selectVideo(ov.dataset.v); }
    const row = e.target.closest('tr.row');
    if (row) { const f = row.dataset.f; state.open.has(f) ? state.open.delete(f) : state.open.add(f); renderQC(); }
  });
  $('#videoList').addEventListener('click', e => {
    const inc = e.target.closest('button.incl');
    if (inc) { state.ignOpen = true; return includeVideo(inc.dataset.n, true); }
    const exc = e.target.closest('button.excl');
    if (exc) return includeVideo(exc.dataset.n, false);
    if (e.target.closest('details.ign')) { if (e.target.tagName === 'SUMMARY') state.ignOpen = !e.target.parentElement.open; return; }
    const li = e.target.closest('.vrow'); if (li && li.dataset.v) selectVideo(li.dataset.v);
  });
  $('#subList').addEventListener('click', e => { const li = e.target.closest('.li'); if (li) { const r = state.subs.find(x => x.name === li.dataset.f); if (r) openSubtitle(r); } });
  document.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('drag'); });
  document.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('drag'); });
  document.addEventListener('drop', onDrop);
  renderAll();
});

// ------------------------------------------------------------ readable names
function langLabel(r) {
  const code = (r.fileLang && r.fileLang.code) || r.rawLabel;
  if (!code) return null;
  const m = matchReference(code);
  if (m.ref && m.status !== 'base') { const n = m.ref.names.find(x => !/VERIFY/.test(x)); if (n) return prettyName(n); return langName(m.ref.code.split('-')[0]); }
  const t = parseTag(code);
  const base = t ? (BASE_ALIASES[t.lang] || t.lang) : code;
  return langName(base) + (t && t.region ? ` (${t.region})` : '');
}
function displayName(r) {
  const ni = r.nameInfo || Match.parse(r.name);
  const v = r.video && state.videos.find(x => x.name === r.video);
  const info = { ...ni, showWords: [...ni.showWords], titleWords: [...ni.titleWords] };
  if (v) {
    if (info.season == null) info.season = v.info.season;
    if (info.episode == null) info.episode = v.info.episode;
    if (!info.showWords.length) info.showWords = v.info.showWords;
    if (!info.titleWords.length) info.titleWords = v.info.titleWords;
  }
  return [Match.episodeTitle(info, (state.common && state.common.opts) || {}), langLabel(r), r.type].filter(Boolean).join(' · ');
}
