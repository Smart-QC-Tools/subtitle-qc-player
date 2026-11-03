  // ================================================================ event panel: expanded table
  // The event list on the right of the QC tab can expand to about half the window and show every event
  // as a table. Same filters, search, selection and playhead as the list: only the presentation changes.
  // The left file panel narrows to 220 px while expanded; the player shrinks in between.
  const evTable = document.getElementById('evTable');
  const evBody = evTable ? evTable.tBodies[0] : null;
  const evWrap = document.getElementById('evWrap');
  const evCount = document.getElementById('evCount');
  const evDetail = document.getElementById('evDetail');
  const expandBtn = document.getElementById('expandEvents');
  const EXPANDED_KEY = 'qc:eventsExpanded';
  let expanded = false, evDirty = true, evRows = [], evDetailIdx = -2;
  let expandT = 0, expandAnim = 0;                 // 0 = collapsed, 1 = expanded (animated in between)
  const evSort = { key: 'begin', dir: 1 };

  const placeRank = p => !p ? 0 : (p.h === 'mixed' ? 4 : 0) + (p.v === 'raised' ? 2 + (p.lift || 0) / 100 : 0) + (p.h === 'left' || p.h === 'right' ? 1 : 0) + (p.v === 'top' ? 0.5 : 0);
  const EV_SORT = {
    begin: c => c.begin, duration: c => c.duration ?? -1, lines: c => c.lineCount * 1000 + c.maxLineLength,
    cpl: c => c.maxLineLength, cps: c => c.cps ?? -1, place: c => placeRank(c.placement),
  };

  // Duration as trimmed seconds:frames (2:13), with minutes when needed (1:05:12).
  function durText(d) {
    if (d == null || !isFinite(d)) return '';
    const nom = Math.round(fps() || docEffectiveFrameRate || 24);
    const f = Math.round(d * (fps() || docEffectiveFrameRate || 24));
    const ff = String(f % nom).padStart(2, '0'), s = Math.floor(f / nom);
    return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}:${ff}` : `${s}:${ff}`;
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
    return [parts.join(long ? ' · ' : ' '), p.h === 'mixed' ? 'bad' : unusual ? 'place' : parts.length ? 'neutral' : ''];
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
      renderCueText(t, c.text, searchQuery, searchCaseSensitive);
      tr.appendChild(t);
      tr.appendChild(cell('ev-num' + (c.lineCount >= LINE_COUNT_THRESHOLD ? ' bad' : ''), String(c.lineCount)));
      tr.appendChild(cell('ev-num' + (c.charLimitExceeded ? ' bad' : ''), String(c.maxLineLength)));
      tr.appendChild(cell('ev-num' + (c.cpsOver ? ' bad' : ''), c.cps != null ? c.cps.toFixed(1) : ''));
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
    const sel = evRows[tlSelected];
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  });

  // Same filter + search as the list.
  function evApplyFilter() {
    const f = FILTERS.find(x => x.key === currentFilter) || FILTERS[0];
    let n = 0;
    cueList.forEach((c, i) => { const show = f.test(c) && cueMatchesSearch(c); if (evRows[i]) evRows[i].hidden = !show; if (show) n++; });
    if (evCount) evCount.textContent = !cueList.length ? '' : n === cueList.length ? `· ${n}` : `· ${n} of ${cueList.length}`;
  }
  function evSyncSel() {
    updateEvDetail();
    if (!evRows.length) return;
    for (const r of evBody.querySelectorAll('tr.sel')) r.classList.remove('sel');
    const r = evRows[tlSelected];
    if (r) r.classList.add('sel');
  }
  function evSyncActive() {
    updateEvDetail();
    if (!evRows.length) return;
    for (const r of evBody.querySelectorAll('tr.active')) r.classList.remove('active');
    let first = null;
    activeCueIndices.forEach(i => { const r = evRows[i]; if (r) { r.classList.add('active'); if (!first) first = r; } });
    if (first && expanded && isMoving()) {
      const wr = evWrap.getBoundingClientRect(), rr = first.getBoundingClientRect();
      if (rr.top < wr.top + 28 || rr.bottom > wr.bottom) first.scrollIntoView({ block: 'nearest' });
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
    if (!c) { evDetail.innerHTML = `<div class="evd-empty">${cueList.length ? 'Click an event to see it here.' : 'Open a subtitle file to see its events.'}</div>`; return; }
    // Row 1: in / out / duration stacked (like the table), the text beside them.
    const top = document.createElement('div');
    top.className = 'evd-top';
    const times = document.createElement('div');
    times.className = 'evd-times';
    times.appendChild(span(c.overlapsPrev ? 'bad' : '', formatVideoTC(c.begin)));
    times.appendChild(span(c.overlapsNext ? 'bad' : c.gapWarn ? 'warn' : '', isFinite(c.end) ? formatVideoTC(c.end) : '…'));
    const dur = document.createElement('span');
    dur.appendChild(span(c.tooShortCritical ? 'crit' : (c.tooShort || c.tooLong) ? 'bad' : '', durText(c.duration)));
    if (c.duration != null) dur.appendChild(span('evd-dim', `  ${c.duration.toFixed(3)} s`));
    times.appendChild(dur);
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
    const meta = document.createElement('div');
    meta.className = 'evd-meta';
    const item = (k, v, cls) => { const s = document.createElement('span'); const i = document.createElement('i'); i.textContent = k; s.appendChild(i); s.appendChild(span(cls || '', v)); meta.appendChild(s); };
    item('Lines', String(c.lineCount), c.lineCount >= LINE_COUNT_THRESHOLD ? 'bad' : '');
    item('Characters', String(c.chars));
    item('CPS', c.cps != null ? c.cps.toFixed(1) : '—', c.cpsOver ? 'bad' : '');
    const [pt, pc] = placeText(p, true);
    item('Placement', pt || 'Bottom · centre', pc);
    item('Gap after', c.gap != null ? (Math.round(c.gap * fps()) < 100 ? `${Math.round(c.gap * fps())}f` : `${c.gap.toFixed(1)}s`) : '—', c.gap != null && c.gap < -0.001 ? 'bad' : c.gapWarn ? 'warn' : '');
    const flags = [...(c.issues || []), ...(c.warns || [])];
    if (flags.length) {
      const tags = document.createElement('span');
      tags.className = 'evd-tags';
      for (const t of flags) { const q = span('qtag q-' + t.kind, t.text); q.title = t.title; tags.appendChild(q); }
      meta.appendChild(tags);
    }
    evDetail.appendChild(meta);
  }

  if (evBody) evBody.addEventListener('click', e => {
    const tr = e.target.closest('tr');
    if (!tr || e.target.closest('.suspicious-char')) return;
    selectCue(Number(tr.dataset.index), { seek: true, scrollList: false });
  });

  // Limits (shared with the list and the Conform page). Shown in the panel header while expanded.
  const limCps = document.getElementById('limCps'), limCpl = document.getElementById('limCpl');
  function showLimits() { if (limCps) limCps.value = CPS_LIMIT; if (limCpl) limCpl.value = CHAR_LIMIT; }
  showLimits();
  for (const el of [limCps, limCpl]) if (el) el.addEventListener('change', () => {
    const cps = Number(limCps.value), cpl = Math.round(Number(limCpl.value));
    if (!(cps > 0 && cps < 100) || !(cpl > 0 && cpl < 200)) { showLimits(); return; }
    setLimits({ cps, cpl });
    showLimits();
  });
  document.addEventListener('qc-limits', () => { showLimits(); renderFilterBar(); applyFilterVisibility(); });

  // ---------------------------------------------------------------- expand / collapse
  const ICON_EXPAND = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4L3 8l4 4M3 8h10"/></svg>';
  const ICON_COLLAPSE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4l4 4-4 4M13 8H3"/></svg>';
  function showExpandBtn() {
    if (!expandBtn) return;
    expandBtn.innerHTML = expanded ? ICON_COLLAPSE : ICON_EXPAND;
    expandBtn.title = expanded ? 'Back to the event list (E)' : 'Show all details in a table (E)';
  }
  function setExpanded(on, { animate = true } = {}) {
    on = !!on;
    if (on === expanded) return;
    expanded = on;
    Store.set(EXPANDED_KEY, on ? '1' : '0');
    document.body.classList.toggle('ev-expanded', on);
    showExpandBtn();
    if (on && evDirty) renderEventsTable();
    else if (on) { evSyncSel(); evSyncActive(); }
    evDetailIdx = -2; updateEvDetail();
    cancelAnimationFrame(expandAnim);
    const from = expandT, to = on ? 1 : 0, t0 = performance.now(), MS = animate && document.body.dataset.tab === 'player' ? 200 : 0;
    const step = now => {
      const k = MS ? Math.min(1, (now - t0) / MS) : 1;
      expandT = from + (to - from) * (1 - Math.pow(1 - k, 3));     // ease-out
      layoutQC();
      if (k < 1) expandAnim = requestAnimationFrame(step);
      else {
        const r = on ? (evRows[tlSelected] || evRows[[...activeCueIndices][0]]) : cueListContainer.children[tlSelected];
        if (r) r.scrollIntoView({ block: 'center' });
      }
    };
    expandAnim = requestAnimationFrame(step);
  }
  if (expandBtn) expandBtn.addEventListener('click', () => setExpanded(!expanded));
  document.addEventListener('keydown', e => {
    if (e.key !== 'e' && e.key !== 'E') return;
    if (document.body.dataset.tab !== 'player' || isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target && e.target.tagName === 'SELECT') return;
    e.preventDefault();
    setExpanded(!expanded);
  });
  showExpandBtn();
  if (Store.get(EXPANDED_KEY) === '1') { expanded = true; expandT = 1; document.body.classList.add('ev-expanded'); showExpandBtn(); }

  window.Player.pause = () => { setSpeed(0); if (video && !video.paused) video.pause(); };
  window.Player.setLimits = setLimits;
