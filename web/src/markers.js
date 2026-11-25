/* ==========================================================================
   Video markers for the QC page: finding and reading VideoMarkers/<video name>.markers.json (format video-markers v1,
   written by Video Analysis in 1.1.0), matching them to the video in the player (by name, or by episode when the length
   agrees within a second: a proxy's markers serve its encode), and turning them into marks and checks.
   Shared by 1.0.0 (reads only, and shows nothing when there are none) and 1.1.0 (analysis.js writes them).
   Where they are: beside the topmost delivery folder (Encodes / _Encodes / QC_PASS / QC_FAIL) when the videos are in one,
   otherwise inside the videos' folder. Web: also the folders analysed in this browser (IndexedDB markerRoots) and
   folders linked by hand (markerLinks); Mac app: Swift markersRead (around the videos folder).
   ========================================================================== */
const Markers = (() => {
  const FORMAT = 'video-markers', VERSION = 1, MARKERS_DIR = 'VideoMarkers', SUFFIX = '.markers.json';
  const DELIVERY = /^(_?encodes|qc[ _-]?(pass|fail))$/i;
  // 1.0.0 has no Video Analysis: no "none found" line and no Link button there, so nothing changes without markers.
  const quiet = () => typeof Analysis === 'undefined';

  // Mac app (paths): the VideoMarkers folder for videos in this folder.
  function markersPathFor(folder) {
    const parts = String(folder || '').replace(/\/+$/, '').split('/');
    for (let i = Math.max(1, parts.length - 4); i < parts.length; i++) if (DELIVERY.test(parts[i])) return parts.slice(0, i).join('/') + '/' + MARKERS_DIR;
    return parts.join('/') + '/' + MARKERS_DIR;
  }
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
    if (!m) return qc.ask ? 'markers found, needs permission' : quiet() ? null : 'none found';   // null: show nothing
    const bits = [m.r.text && 'on-screen text', m.r.flags && 'flags', m.r.blacks && 'blacks', m.r.credits && 'credits'].filter(Boolean);
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
    if (quiet()) return;
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
  window.addEventListener('qc-videos-changed', () => { qc.key = null; });
  window.addEventListener('analysis-updated', e => { if (!e.detail || e.detail.name) qc.key = null; });
  if (NATIVE) Native.on('analysisFile', () => { qc.key = null; window.dispatchEvent(new CustomEvent('analysis-updated', { detail: {} })); });   // saved in the other window

  // For the waveform and index bars: on-screen text (or credits) joined where less than 20 s apart, commercial blacks,
  // and every card / piece with its box for the checks.
  const JOIN = 20;
  function marks(r) {
    if (!r) return null;
    const text = (r.text || r.flags) && [...((r.text && r.text.pieces) || []), ...((r.flags && r.flags.pieces) || [])];
    const unknown = ((r.flags && r.flags.unknown) || []).map(u => [u.in, u.out]);
    const cards = text ? text.map(p => ({ in: p.in, out: p.out, kind: 'text', text: '', box: p.box }))
      : ((r.credits && r.credits.cards) || []).map(c => ({ in: c.in, out: c.out, kind: c.kind || 'credit', text: c.text, box: c.box || (c.boxes && c.boxes[0]) || null }));
    const spans = [];
    for (const c of [...cards.filter(c => text || c.kind === 'credit'), ...unknown.map(([a, b]) => ({ in: a, out: b }))].sort((a, b) => a.in - b.in)) {
      const last = spans[spans.length - 1];
      if (last && c.in - last[1] < JOIN) last[1] = Math.max(last[1], c.out); else spans.push([c.in, c.out]);
    }
    const blacks = ((r.blacks && r.blacks.items) || []).filter(b => b.kind === 'commercial').map(b => [b.in, b.out]);
    const scannedTo = text ? (r.text && r.text.scannedTo) || (r.video && r.video.duration) : r.credits ? r.credits.scannedTo || (r.video && r.video.duration) : 0;
    return spans.length || blacks.length || r.credits || text ? { video: null, credits: spans, label: text ? 'On-screen text' : 'Credits', allText: !!text, blacks, cards, unknown, scannedTo } : null;
  }
  return { FORMAT, VERSION, MARKERS_DIR, SUFFIX, DELIVERY, markersPathFor, parse, readDirHandle, readNative, forVideo, statusLine, qcActions, marks, quiet };
})();
