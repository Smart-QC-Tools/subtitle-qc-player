  // ================================================================ event panel: expanded table
  // The event list on the right of the QC tab can expand to about half the window and show every event
  // as a table. Same filters, search, selection and playhead as the list: only the presentation changes.
  // The left file panel narrows to 220 px while expanded; the player shrinks in between.
  const evTable = document.getElementById('evTable');
  const evBody = evTable ? evTable.tBodies[0] : null;
  const evWrap = document.getElementById('evWrap');
  const evCount = document.getElementById('evCount');
  const evDetail = document.getElementById('evDetail');
  // The table is the only view now (the narrow list is kept, hidden, for keyboard stepping).
  let expanded = true, evDirty = true, evRows = [], evDetailIdx = -2;
  const expandT = 1;
  const evSort = { key: 'begin', dir: 1 };
  // Column widths at the table's base width (Text 280 px); a wider table widens every column in proportion.
  // Every column except Text is as wide as its widest value (or header, with the sort arrow) in the font
  // actually in use: measured once here, so a wider system font (macOS) never cuts a header short.
  const EV_TEXT_W = 280;
  const EV_COLS = (() => {
    const fallback = [91, 67, EV_TEXT_W, 31, 38, 52, 63];
    if (!evTable) return fallback;
    try {
      const t = document.createElement('table');
      t.className = 'ev-table';
      t.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;width:auto;table-layout:auto';
      t.appendChild(evTable.tHead.cloneNode(true));
      const b = t.createTBody().insertRow();
      const samples = [['00:00:00:00', '00:00:00:00'], ['1:05:12m'], null, ['4'], ['60'], ['107.9'], ['Raised']];
      samples.forEach(v => {
        const c = b.insertCell();
        if (!v) { c.style.cssText = `width:${EV_TEXT_W}px;min-width:${EV_TEXT_W}px;box-sizing:border-box`; return; }
        if (v.length === 2) c.className = 'ev-io';
        for (const x of v) { const s = document.createElement('span'); s.className = 'bad'; s.textContent = x; c.appendChild(s); }
      });
      document.body.appendChild(t);
      const w = [...t.tHead.rows[0].cells].map((th, i) => i === 2 ? EV_TEXT_W : Math.ceil(Math.max(th.getBoundingClientRect().width, b.cells[i].getBoundingClientRect().width) / uiZoom()) + 2);
      t.remove();
      return w.every(x => x > 10) ? w : fallback;
    } catch (e) { return fallback; }
  })();
  const EV_TABLE_W = EV_COLS.reduce((a, b) => a + b, 0);
  if (evTable) {
    const cg = document.createElement('colgroup');
    for (const w of EV_COLS) { const col = document.createElement('col'); col.style.width = (w / EV_TABLE_W * 100).toFixed(3) + '%'; cg.appendChild(col); }
    evTable.insertBefore(cg, evTable.firstChild);
  }

  const placeRank = p => !p ? 0 : (p.h === 'mixed' ? 4 : 0) + (p.v === 'raised' ? 2 + (p.lift || 0) / 100 : 0) + (p.h === 'left' || p.h === 'right' ? 1 : 0) + (p.v === 'top' ? 0.5 : 0);
  const EV_SORT = {
    begin: c => c.begin, duration: c => c.duration ?? -1, lines: c => c.lineCount * 1000 + c.maxLineLength,
    cpl: c => c.maxLineLength, cps: c => c.cps ?? -1, place: c => placeRank(c.placement),
  };

  // Duration as trimmed seconds:frames with its unit (2:13s); from a minute up, minutes:seconds:frames (1:05:12m).
  function durText(d) {
    if (d == null || !isFinite(d)) return '';
    const nom = Math.round(fps() || docEffectiveFrameRate || 24);
    const f = Math.round(d * (fps() || docEffectiveFrameRate || 24));
    const ff = String(f % nom).padStart(2, '0'), s = Math.floor(f / nom);
    return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}:${ff}m` : `${s}:${ff}s`;
  }
  // Placement text: empty for the usual bottom-centre.
  // Placement text: empty for the usual bottom-centre. Short form for the table (L / R / Mix, Raised, Top);
  // the long form (details panel) adds roughly how high a raised subtitle sits.
  function placeText(p, long) {
    if (!p) return ['', ''];
    const parts = [];
    if (p.h === 'mixed') parts.push(long ? 'Mixed alignment' : 'Mix');
    else if (p.h === 'left' || p.h === 'right') parts.push(long ? hText(p.h) : p.h === 'left' ? 'L' : 'R');
    if (p.v === 'raised') parts.push(long && p.lift != null ? `Raised (about ${p.lift}% up)` : 'Raised');
    if (p.v === 'top') parts.push('Top');
    if (p.v === 'vertical') parts.push(long ? 'Vertical' : 'Vert');
    const unusual = p.v === 'raised' || p.h === 'left' || p.h === 'right';
    return [parts.join(long ? ' · ' : ' '), p.h === 'mixed' ? 'warn' : unusual ? 'place' : parts.length ? 'neutral' : ''];
  }
  // Hover text for a row: characters per line, then every flag in words.
  function rowTitle(c) {
    const lines = c.text.split('\n').map((l, k) => `Line ${k + 1}: ${Array.from(l).length} characters`);
    const out = [...lines, `On screen ${c.duration != null ? c.duration.toFixed(3) + ' s' : '—'} · ${c.chars} characters · ${c.cps != null ? c.cps.toFixed(1) + ' CPS' : ''}`];
    const flags = [...(c.issues || []), ...(c.warns || []), ...(c.placeTags || [])].map(t => '• ' + t.title);
    if (c.overlapsPrev) flags.unshift('• Starts before the previous event ends');
    if (c.overlapsNext) flags.unshift('• Ends after the next event starts');
    return flags.length ? out.concat('', flags.filter((t, k, a) => a.indexOf(t) === k)).join('\n') : out.join('\n');
  }
  const cell = (cls, text) => { const el = document.createElement('td'); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };
  const span = (cls, text) => { const el = document.createElement('span'); if (cls) el.className = cls; el.textContent = text; return el; };

  function renderEventsTable() {
    if (!evBody) return;
    evDirty = false;
    evBody.textContent = '';
    evRows = [];
    const frag = document.createDocumentFragment();
    cueList.forEach((c, i) => {
      const tr = document.createElement('tr');
      tr.dataset.index = String(i);
      const kind = cueKind(c);
      if (kind) tr.className = 'has-' + kind;
      tr.title = rowTitle(c);
      const io = cell('ev-io');
      io.appendChild(span(c.overlapsPrev ? 'bad' : '', formatVideoTC(c.begin)));
      io.appendChild(span(c.overlapsNext ? 'bad' : c.gapWarn ? 'warn' : '', isFinite(c.end) ? formatVideoTC(c.end) : '…'));
      tr.appendChild(io);
      const dur = cell('ev-num');
      dur.appendChild(span(c.tooShortCritical ? 'crit' : (c.tooShort || c.tooLong) ? 'bad' : '', durText(c.duration)));
      tr.appendChild(dur);
      const t = cell('ev-text');
      const tx = document.createElement('span');
      renderCueText(tx, c.text, searchQuery, searchCaseSensitive);
      t.appendChild(tx);
      const tl = document.createElement('span');   // English translation (web version, Translate button)
      tl.className = 'cue-translation';
      tl.style.display = 'none';
      t.appendChild(tl);
      if (translationCache.has(i)) applyTranslationToRow(tl, translationCache.get(i));
      tr.appendChild(t);
      tr.appendChild(cell('ev-num' + (c.lineCount >= LINE_COUNT_THRESHOLD ? ' bad' : ''), String(c.lineCount)));
      tr.appendChild(cell('ev-num' + (c.charLimitExceeded ? ' bad' : ''), String(c.maxLineLength)));
      tr.appendChild(cell('ev-num' + (c.cpsOver ? ' warn' : ''), c.cps != null ? c.cps.toFixed(1) : ''));
      const [pt, pc] = placeText(c.placement);
      const pcell = cell(pc, pt);
      if (pt) pcell.title = placeText(c.placement, true)[0];
      tr.appendChild(pcell);
      evRows[i] = tr;
      frag.appendChild(tr);
    });
    evBody.appendChild(frag);
    sortEvents();
    evApplyFilter();
    evSyncSel();
    evSyncActive();
    updateSortHeads();
  }

  function sortEvents() {
    if (!evRows.length) return;
    const key = EV_SORT[evSort.key] || EV_SORT.begin, dir = evSort.dir;
    const order = cueList.map((c, i) => i).sort((a, b) => {
      const x = key(cueList[a]), y = key(cueList[b]);
      return (x < y ? -1 : x > y ? 1 : 0) * dir || (a - b);
    });
    const frag = document.createDocumentFragment();
    order.forEach(i => frag.appendChild(evRows[i]));
    evBody.appendChild(frag);
  }
  function updateSortHeads() {
    if (!evTable) return;
    evTable.querySelectorAll('th[data-sort]').forEach(th => {
      const on = th.dataset.sort === evSort.key;
      th.classList.toggle('sorted', on);
      th.dataset.dir = on ? (evSort.dir > 0 ? '▲' : '▼') : '';
    });
  }
  if (evTable) evTable.tHead.addEventListener('click', e => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    // First click: time ascending, measures worst first. Again reverses.
    if (evSort.key === th.dataset.sort) evSort.dir = -evSort.dir;
    else { evSort.key = th.dataset.sort; evSort.dir = th.dataset.sort === 'begin' ? 1 : -1; }
    sortEvents(); updateSortHeads();
    evReveal(tlSelected, 'jump');
  });

  // ---- keeping the selected row in sight
  // 'jump' (a seek, a scrub, a typed timecode): if the row isn't fully in view, centre it.
  // 'page' (playing, or stepping with the arrows; dir = direction of travel): when the row comes within a few
  // rows of the edge it is heading for, turn the page, so it sits a quarter of the way in with what comes
  // next in view. The table then stays still until the next page.
  let evRevealedSel = -1, evRevealPending = false, evUserScrollAt = -1e9;
  function evReveal(i, mode, dir) {
    evRevealedSel = i;
    const r = evRows[i];
    if (!r || r.hidden || !expanded || !evWrap) return;
    const wr = evWrap.getBoundingClientRect(), rr = r.getBoundingClientRect();
    const hh = evTable.tHead.getBoundingClientRect().height;
    const top = wr.top + hh, bottom = wr.top + evWrap.clientHeight, vh = bottom - top;
    if (vh <= 0) return;
    let to = null;   // where the row's top should sit, as a fraction of the visible height
    if (mode === 'page') {
      const margin = Math.min(3 * rr.height, vh * 0.3);
      if (dir >= 0) { if (rr.bottom > bottom - margin || rr.top < top) to = 0.25; }
      else if (rr.top < top + margin || rr.bottom > bottom) to = 0.75 - rr.height / vh;
    } else if (rr.top < top || rr.bottom > bottom) to = 0.5 - rr.height / vh / 2;
    if (to != null) evWrap.scrollTop += Math.round(rr.top - top - to * vh);
  }
  // Scrolling the table by hand while the video plays: following waits a few seconds.
  if (evWrap) {
    const userScroll = () => { evUserScrollAt = performance.now(); };
    let wrapDown = false;
    evWrap.addEventListener('wheel', userScroll, { passive: true });
    evWrap.addEventListener('touchmove', userScroll, { passive: true });
    evWrap.addEventListener('mousedown', e => { if (e.target === evWrap) { wrapDown = true; userScroll(); } });   // its scrollbar
    window.addEventListener('mouseup', () => { wrapDown = false; });
    evWrap.addEventListener('scroll', () => { if (wrapDown) userScroll(); });
  }
  const EV_FOLLOW_PAUSE_MS = 4000;
  // Paused and the playhead moved (seek, scrub, frame step): select the event under the playhead, or in a
  // gap the one that last began, and bring it into view.
  function evFollowPaused() {
    if (!video || !cueList.length || isMoving()) return;
    const t = video.currentTime + effectiveOffset(), half = 0.5 / fps();
    let target = tlSelected;
    const cur = cueList[tlSelected];
    if (!(cur && t >= cur.begin && t < cur.end)) {
      let inside = -1, last = -1, lastB = -Infinity;
      cueList.forEach((c, i) => {
        if (!isFinite(c.begin)) return;
        if (t >= c.begin && t < c.end) { if (inside < 0) inside = i; }
        if (c.begin <= t + half && c.begin > lastB) { lastB = c.begin; last = i; }
      });
      target = inside >= 0 ? inside : last >= 0 ? last : tlSelected;
    }
    if (target !== tlSelected) { tlSelected = target; reapplyTlSel(); tlDirty = true; }
    if (evRevealPending || tlSelected !== evRevealedSel) evReveal(tlSelected, 'jump');
    evRevealPending = false;
  }

  // Same filter + search as the list.
  function evApplyFilter() {
    const f = FILTERS.find(x => x.key === currentFilter) || FILTERS[0];
    let n = 0;
    cueList.forEach((c, i) => { const show = f.test(c) && cueMatchesSearch(c); if (evRows[i]) evRows[i].hidden = !show; if (show) n++; });
    evMarkPreSel();
    if (evCount) evCount.textContent = !cueList.length ? '' : n === cueList.length ? `· ${n}` : `· ${n} of ${cueList.length}`;
  }
  function evSyncSel() {
    updateEvDetail();
    if (!evRows.length) return;
    for (const r of evBody.querySelectorAll('tr.sel')) r.classList.remove('sel');
    const r = evRows[tlSelected];
    if (r) r.classList.add('sel');
    evMarkPreSel();
  }
  // The visible row just above the selected one: its bottom line is the selection frame's top edge.
  function evMarkPreSel() {
    for (const p of evBody.querySelectorAll('tr.pre-sel,tr.sel-top')) p.classList.remove('pre-sel', 'sel-top');
    const r = evBody.querySelector('tr.sel');
    if (!r || r.hidden) return;
    let p = r.previousElementSibling;
    while (p && p.hidden) p = p.previousElementSibling;
    if (p) p.classList.add('pre-sel'); else r.classList.add('sel-top');
  }
  function evSyncActive() {
    updateEvDetail();
    if (!evRows.length) return;
    // One selection: the event under the playhead becomes the selected one (playing, stepping or
    // scrubbing). In a gap the last one stays selected; of overlapping events, a selected one is kept.
    const act = [...activeCueIndices];
    if (act.length && !act.includes(tlSelected)) { tlSelected = Math.min(...act); reapplyTlSel(); tlDirty = true; }
    for (const r of evBody.querySelectorAll('tr.active')) r.classList.remove('active');
    let first = null;
    activeCueIndices.forEach(i => { const r = evRows[i]; if (r) { r.classList.add('active'); if (!first) first = r; } });
    if (first && expanded && isMoving()) {
      // Playing: turn the page in the direction of travel (in time order; otherwise just keep it in sight).
      if (performance.now() - evUserScrollAt < EV_FOLLOW_PAUSE_MS) evRevealedSel = tlSelected;
      else if (evSort.key === 'begin') evReveal(tlSelected, 'page', (speed < 0 ? -1 : 1) * evSort.dir);
      else evReveal(tlSelected, 'jump');
    }
  }
  function evMarkDirty() { evDirty = true; evDetailIdx = -2; if (expanded) renderEventsTable(); else updateEvDetail(); }

  // Under the player (expanded view): the selected event, or the one playing, in detail.
  function updateEvDetail() {
    if (!evDetail || !expanded) return;
    let i = tlSelected;
    if ((isMoving() || i < 0) && activeCueIndices.size) i = [...activeCueIndices][0];
    if (i === evDetailIdx) return;
    evDetailIdx = i;
    const c = cueList[i];
    evDetail.textContent = '';
    // No event selected: nothing shown here, not even the switch.
    const box = document.getElementById('evDetailBox');
    if (box) box.classList.toggle('nosel', !c);
    if (!c) return;
    const row = (cls) => { const d = document.createElement('div'); d.className = 'evd-meta' + (cls ? ' ' + cls : ''); return d; };
    const item = (into, k, v, cls, extra) => { const s = document.createElement('span'); const i = document.createElement('i'); i.textContent = k; s.appendChild(i); s.appendChild(span(cls || '', v)); if (extra) s.appendChild(span('evd-dim', extra)); into.appendChild(s); };
    // Row 1: in / out / duration (styled like the row below), the text beside them.
    const top = document.createElement('div');
    top.className = 'evd-top';
    const times = row('evd-times');
    item(times, 'In', formatVideoTC(c.begin), c.overlapsPrev ? 'bad' : '');
    item(times, 'Out', isFinite(c.end) ? formatVideoTC(c.end) : '…', c.overlapsNext ? 'bad' : c.gapWarn ? 'warn' : '');
    item(times, 'Duration', durText(c.duration), c.tooShortCritical ? 'crit' : (c.tooShort || c.tooLong) ? 'bad' : '');
    top.appendChild(times);
    const lines = document.createElement('div');
    const ls = c.text.split('\n');
    lines.className = 'evd-lines' + (ls.length > 3 ? ' many' : '');
    for (const l of ls) {
      const row = document.createElement('div');
      const n = Array.from(l).length;
      const tx = document.createElement('span'); tx.className = 'evd-t'; renderCueText(tx, l, '', false);
      const ct = span('evd-n' + (n > CHAR_LIMIT ? ' bad' : ''), String(n));
      ct.title = 'Characters on this line';
      row.appendChild(tx); row.appendChild(ct);
      lines.appendChild(row);
    }
    top.appendChild(lines);
    evDetail.appendChild(top);
    // Row 2: the same order as the table's columns, then the gap and any flags in words.
    const p = c.placement;
    const meta = row();
    item(meta, 'Lines', String(c.lineCount), c.lineCount >= LINE_COUNT_THRESHOLD ? 'bad' : '');
    item(meta, 'Characters', String(c.chars));
    item(meta, 'CPS', c.cps != null ? c.cps.toFixed(1) : '—', c.cpsOver ? 'warn' : '');
    const [pt, pc] = placeText(p, true);
    item(meta, 'Placement', pt || 'Bottom · centre', pc);
    item(meta, 'Gap after', c.gap != null ? (Math.round(c.gap * fps()) < 100 ? `${Math.round(c.gap * fps())}f` : `${c.gap.toFixed(1)}s`) : '—', c.gap != null && c.gap < -0.001 ? 'bad' : c.gapWarn ? 'warn' : '');
    evDetail.appendChild(meta);
  }

  if (evBody) evBody.addEventListener('click', e => {
    const tr = e.target.closest('tr');
    if (!tr || e.target.closest('.suspicious-char')) return;
    selectCue(Number(tr.dataset.index), { seek: true, scrollList: false });
    evRevealedSel = tlSelected;
  });

  // Limits (shared with the list and the Conform page). Shown in the panel header while expanded.
  const limCps = document.getElementById('limCps'), limCpl = document.getElementById('limCpl'), limLines = document.getElementById('limLines');
  function showLimits() { if (limCps) limCps.value = CPS_LIMIT; if (limCpl) limCpl.value = CHAR_LIMIT; if (limLines) limLines.value = String(LINE_COUNT_THRESHOLD - 1); }
  showLimits();
  // Each limit is a value you can drag (press and move up / down) or click to type into, like the timecode:
  // click and release selects it for typing; Enter applies, Esc or clicking elsewhere cancels.
  const lo = el => +el.getAttribute('min'), hi = el => +el.getAttribute('max');
  const clamp = (el, v) => Math.min(hi(el), Math.max(lo(el), Math.round(v)));
  function applyLimits() {
    const num = (el, cur) => { const v = Number(String(el.value).trim()); return el.value.trim() && isFinite(v) ? clamp(el, v) : cur; };
    setLimits({ cps: num(limCps, CPS_LIMIT), cpl: num(limCpl, CHAR_LIMIT), lines: num(limLines, LINE_COUNT_THRESHOLD - 1) });
    showLimits();
  }
  function stopEditing(el, apply) {
    if (!el.classList.contains('editing')) return;
    el.classList.remove('editing');
    el.readOnly = true;
    if (apply) applyLimits(); else showLimits();
    if (document.activeElement === el) el.blur();
  }
  for (const el of [limCps, limCpl, limLines]) if (el) {
    el.addEventListener('pointerdown', e => {
      if (el.classList.contains('editing') || e.button !== 0) return;
      e.preventDefault();
      const y0 = e.clientY, v0 = Number(el.value);
      let dragged = false;
      el.setPointerCapture(e.pointerId);
      const move = ev => {
        const steps = Math.trunc((y0 - ev.clientY) / 6);   // 6 px per step, up = more
        if (!dragged && Math.abs(y0 - ev.clientY) < 3) return;
        if (!dragged) { dragged = true; document.body.classList.add('lim-dragging'); }
        const v = clamp(el, v0 + steps);
        if (String(v) !== el.value) { el.value = v; applyLimits(); }
      };
      const up = () => {
        el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
        document.body.classList.remove('lim-dragging');
        if (!dragged) {   // a click: type a new value
          el.readOnly = false; el.classList.add('editing'); el.focus(); el.select();
        }
      };
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    });
    el.addEventListener('keydown', e => {
      if (!el.classList.contains('editing')) return;
      if (e.key === 'Enter') { e.preventDefault(); stopEditing(el, true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stopEditing(el, false); }
      else if (e.key.length === 1 && !/\d/.test(e.key) && !e.metaKey && !e.ctrlKey) e.preventDefault();   // digits only
      e.stopPropagation();   // typing here doesn't reach the player's shortcuts
    });
    el.addEventListener('blur', () => stopEditing(el, false));
  }
  // A click anywhere else cancels typing (some areas, like the player, keep the focus where it is).
  document.addEventListener('pointerdown', e => {
    for (const el of [limCps, limCpl, limLines]) if (el && el.classList.contains('editing') && e.target !== el) stopEditing(el, false);
  }, true);
  document.addEventListener('qc-limits', () => { showLimits(); renderFilterBar(); applyFilterVisibility(); });
  // Scrolling over a limit changes it by one (no need to click into it first).
  for (const el of [limCps, limCpl, limLines]) if (el) el.addEventListener('wheel', e => {
    e.preventDefault();
    if (el.classList.contains('editing')) return;
    const v = clamp(el, (Number(el.value) || 0) + (e.deltaY < 0 ? 1 : -1));
    if (String(v) !== el.value) { el.value = v; applyLimits(); }
  }, { passive: false });

  // ---- Filter bar: a button only for checks that found something (an active filter keeps its button even
  // when it drops to 0); the checks that found nothing are listed on one quiet line with a green tick.
  const FB_SHORT = { chars: 'CPL', lines: 'Lines', overlap: 'Overlaps', duration: 'Duration', 
    suspicious: 'Odd chars', mixed: 'Mixed align', cps: 'CPS', gaps: 'Gaps' };
  function evDecorateFilters(bar, current) {
    const chips = [...bar.querySelectorAll('.filter-chip')];
    const clean = [];
    let shown = 0;
    for (const b of chips) {
      const n = +b.dataset.count, k = b.dataset.key;
      if (n || k === current) { shown++; continue; }
      b.remove();
      if (FB_SHORT[k]) clean.push(FB_SHORT[k]);
    }
    const all = bar.querySelector('.filter-chip[data-key="issues"]');
    if (all && all.nextElementSibling) { const d = document.createElement('span'); d.className = 'fb-div'; all.after(d); }
    if (!clean.length) return;
    const searching = !!(document.getElementById('searchInput') || {}).value;
    const line = document.createElement('div');
    line.className = 'fb-clean';
    if (!shown && !searching) line.textContent = 'No issues found — all checks passed';
    else line.innerHTML = '<b>' + (searching ? 'None in search:' : 'Clean:') + '</b> ' + clean.map(esc).join(' · ');
    line.title = searching ? 'Checks with no hits among the events matching the search' : 'Checks that found nothing in this file';
    bar.appendChild(line);
  }

  // Subtitle info under the player: on / off (off to start with); the space it takes stays the same.
  {
    const box = document.getElementById('evDetailBox'), sw = document.getElementById('infoToggle');
    const apply = on => { box.classList.toggle('off', !on); sw.classList.toggle('on', on); sw.setAttribute('aria-pressed', String(on)); };
    let on = Store.get('qc:showInfo') === '1';
    apply(on);
    sw.addEventListener('click', () => { on = !on; apply(on); Store.set('qc:showInfo', on ? '1' : '0'); sw.blur(); });
  }
  document.body.classList.add('ev-expanded');
  // Translate sits next to the search box (it translates the rows in view).
  { const tb = document.getElementById('translateBtn'), bar = document.querySelector('#sidebar .search-bar'); if (tb && bar) bar.appendChild(tb); }

  window.Player.pause = () => { setSpeed(0); if (video && !video.paused) video.pause(); };
  window.Player.setLimits = setLimits;
