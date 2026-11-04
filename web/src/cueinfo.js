  // ================================================================ per-event QC info
  // Reading speed (CPS), placement (left / right / raised / top) and the issue list for each event.
  // Shared by the event list, the waveform, the Events table and the Conform page.
  // Colour scheme: red = a rule is broken, amber = worth a look (1-frame gap, unusual placement),
// grey = top (neutral).

  const QC_LIMITS_KEY = 'qc:limits';
  let CPS_LIMIT = 20;
  (function loadLimits() {
    try {
      const v = JSON.parse(Store.get(QC_LIMITS_KEY) || 'null');
      if (v && v.cps > 0) CPS_LIMIT = +v.cps;
      if (v && v.cpl > 0) CHAR_LIMIT = +v.cpl;
      if (v && v.lines > 0) LINE_COUNT_THRESHOLD = +v.lines + 1;
    } catch (e) { /* defaults */ }
  })();

  // ---------------------------------------------------------------- placement
  const RTL_LANG = /^(ar|he|iw|fa|ur|yi|ps|sd|ug|dv|ckb)\b/i;
  const placementDocs = new WeakMap();
  function placementDoc(root, resolveStyleAttr) {
    let d = placementDocs.get(root);
    if (d) return d;
    const num = s => { const m = String(s || '').trim().match(/^(-?[\d.]+)(px)?$/); return m ? +m[1] : null; };
    const ext = (getAttrByLocalName(root, 'extent') || '').trim().split(/\s+/);
    const cell = (getAttrByLocalName(root, 'cellResolution') || '32 15').trim().split(/\s+/).map(Number);
    d = {
      w: num(ext[0]), h: num(ext[1]), cols: cell[0] || 32, rows: cell[1] || 15,
      lang: (root.getAttribute('xml:lang') || getAttrByLocalName(root, 'lang') || ''),
      regions: new Map(), resolveStyleAttr,
    };
    (function collect(el) {
      for (const ch of el.children) {
        if (ch.localName === 'region') { const id = getAttrByLocalName(ch, 'id'); if (id) d.regions.set(id, ch); }
        else collect(ch);
      }
    })(root);
    placementDocs.set(root, d);
    return d;
  }
  // "x y" in %, px (needs the root extent) or c (cells) -> [x%, y%]
  function pairPct(v, d) {
    if (!v) return null;
    const parts = v.trim().split(/\s+/);
    if (parts.length < 2) return null;
    const one = (s, ref, cells) => {
      const m = s.match(/^(-?[\d.]+)(%|px|c)?$/);
      if (!m) return null;
      const n = +m[1];
      if (m[2] === '%') return n;
      if (m[2] === 'c') return n / cells * 100;
      return ref ? n / ref * 100 : null;
    };
    const a = one(parts[0], d.w, d.cols), b = one(parts[1], d.h, d.rows);
    return a == null || b == null ? null : [a, b];
  }
  function regionAttr(reg, name, d) {
    if (!reg) return null;
    const direct = getAttrByLocalName(reg, name);
    if (direct !== null) return direct;
    const v = d.resolveStyleAttr(getAttrByLocalName(reg, 'style'), name);
    if (v !== null) return v;
    for (const ch of reg.children) if (ch.localName === 'style') { const x = getAttrByLocalName(ch, name); if (x !== null) return x; }
    return null;
  }
  // A style property set on the element, one of its ancestors, or (failing that) its region.
  function contentAttr(el, name, reg, d) {
    for (let a = el; a && a.localName !== 'tt'; a = a.parentElement) {
      const direct = getAttrByLocalName(a, name);
      if (direct !== null) return direct;
      const v = d.resolveStyleAttr(getAttrByLocalName(a, 'style'), name);
      if (v !== null) return v;
    }
    return regionAttr(reg, name, d);
  }
  // -> { h: 'left'|'center'|'right'|'mixed', v: 'bottom'|'top'|'raised'|'vertical', lift: % of picture height above the bottom }
  function placementOf(p, regionId, root, resolveStyleAttr, lineCount) {
    const qh = getAttrByLocalName(p, 'halign'), qv = getAttrByLocalName(p, 'valign');
    if (qh && qv) return { h: qh, v: qv, lift: null };      // SCC / SRT: worked out when the file was read
    const d = placementDoc(root, resolveStyleAttr);
    const reg = d.regions.get(regionId) || null;
    const wm = (regionAttr(reg, 'writingMode', d) || '').toLowerCase();
    if (wm.startsWith('tb')) return { h: 'center', v: 'vertical', lift: null };   // vertical Japanese: placed at the side by design
    const o = pairPct(regionAttr(reg, 'origin', d), d) || [0, 0];
    const e = pairPct(regionAttr(reg, 'extent', d), d) || [100 - o[0], 100 - o[1]];
    const disp = (regionAttr(reg, 'displayAlign', d) || 'before').toLowerCase();
    // vertical: estimate where the text block sits inside its region
    const th = Math.min(e[1], Math.max(1, lineCount) * 6.5);
    let top, bottom;
    if (disp === 'after') { bottom = o[1] + e[1]; top = bottom - th; }
    else if (disp === 'center') { top = o[1] + (e[1] - th) / 2; bottom = top + th; }
    else { top = o[1]; bottom = top + th; }
    const v = bottom >= 78 ? 'bottom' : top <= 22 ? 'top' : 'raised';
    // horizontal: the text alignment, or for centred text, where the region's middle is
    const lang = p.getAttribute('xml:lang') || d.lang;
    const rtl = (contentAttr(p, 'direction', reg, d) || '') === 'rtl' || RTL_LANG.test(lang);
    let al = (contentAttr(p, 'textAlign', reg, d) || 'start').toLowerCase();
    if (al === 'start' || al === 'justify') al = rtl ? 'right' : 'left';
    else if (al === 'end') al = rtl ? 'left' : 'right';
    let h = al;
    if (al === 'center') { const c = o[0] + e[0] / 2; h = Math.abs(c - 50) <= 8 ? 'center' : c < 50 ? 'left' : 'right'; }
    return { h, v, lift: Math.max(0, Math.round(100 - bottom)) };
  }

  // ---------------------------------------------------------------- issues
  function finalizeQcFlags(list) {
    list.forEach((c, i) => {
      if (c.chars == null) c.chars = Array.from(c.text.replace(/\n/g, '')).length;
      c.cps = c.duration > 0 ? c.chars / c.duration : null;
      c.cpsOver = c.cps != null && c.cps > CPS_LIMIT + 1e-9;
      c.charLimitExceeded = c.maxLineLength > CHAR_LIMIT;
      const nx = list[i + 1];
      c.gap = nx && isFinite(c.end) ? nx.begin - c.end : null;
      // A gap of a single frame makes the subtitle blink off and on. 0 (back-to-back) is normal.
      const frame = 1 / (fps() || docEffectiveFrameRate || 24);
      c.gapWarn = c.gap != null && c.gap > 0.001 && c.gap < frame * 1.5;
      c.gapNext = c.gapWarn ? nx.begin : null;
      c.mixedAlign = !!(c.placement && c.placement.h === 'mixed');
    });
    // Which side of an event collides: its start (with an earlier event) and/or its end (with a later one).
    let runEnd = -Infinity;
    list.forEach(c => { c.overlapsPrev = c.begin < runEnd - 0.001; if (c.end > runEnd) runEnd = c.end; });
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      c.overlapsNext = false;
      for (let j = i + 1; j < list.length && list[j].begin < c.end - 0.001; j++) { c.overlapsNext = true; break; }
    }
    // Two events shown together with different alignment (e.g. a dash line in its own block).
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length && list[j].begin < list[i].begin + 0.001; j++) {
        const a = list[i], b = list[j];
        if (Math.abs(a.end - b.end) < 0.001 && a.placement && b.placement && a.placement.h !== b.placement.h) a.mixedAlign = b.mixedAlign = true;
      }
    }
    list.forEach(c => { c.issues = cueIssues(c); c.warns = cueWarns(c); c.placeTags = cuePlaceTags(c); });
  }
  const secs = v => v < 10 ? v.toFixed(2).replace(/0$/, '') : v.toFixed(1);
  function cueIssues(c) {
    const out = [];
    const add = (key, text, title) => out.push({ key, text, title, kind: 'issue' });
    if (c.charLimitExceeded) add('chars', `CPL ${c.maxLineLength}`, `Longest line has ${c.maxLineLength} characters (limit ${CHAR_LIMIT})`);
    if (c.lineCount >= LINE_COUNT_THRESHOLD) add('lines', `${c.lineCount} lines`, `${c.lineCount} lines on screen`);
    if (c.overlap) add('overlap', 'Overlap', 'Overlaps another event');
    if (c.tooShortCritical) add('durationCritical', `${secs(c.duration)}s, long line`, `On screen for only ${c.duration.toFixed(3)}s with a ${c.maxLineLength}-character line`);
    else if (c.tooShort) add('duration', `Short ${secs(c.duration)}s`, `Under ${SHORT_DURATION_SECONDS}s on screen (${c.duration.toFixed(3)}s)`);
    else if (c.tooLong) add('duration', `Long ${secs(c.duration)}s`, `Over ${MAX_DURATION_SECONDS}s on screen (${c.duration.toFixed(3)}s)`);
    if (c.hasSuspiciousChars) add('suspicious', 'Odd char', 'Contains an invisible / control / replacement character');
    if (c.mixedAlign) add('mixed', 'Mixed align', 'Lines of this event are aligned differently');
    return out;
  }
  // Amber: worth a look, not a broken rule. Reading speed over the limit is often still readable.
  function cueWarns(c) {
    const out = [];
    if (c.cpsOver) out.push({ key: 'cps', text: `CPS ${c.cps.toFixed(1)}`, title: `Fast: ${c.cps.toFixed(1)} characters per second (limit ${CPS_LIMIT})`, kind: 'warn' });
    if (!c.gapWarn) return out;
    return [...out, { key: 'gap', text: 'Gap 1f', title: `1-frame gap before the next event (${formatVideoTC(c.gapNext)}): the subtitle blinks off for a single frame`, kind: 'warn' }];
  }
  function cuePlaceTags(c) {
    const p = c.placement, out = [];
    if (!p) return out;
    if (p.v === 'raised') out.push({ key: 'raised', text: 'Raised', title: `Raised: text sits about ${p.lift != null ? p.lift + '% of the picture height' : 'well'} above the bottom`, kind: 'place' });
    if (p.h === 'left' || p.h === 'right') out.push({ key: 'side', text: p.h === 'left' ? 'Left' : 'Right', title: `${p.h === 'left' ? 'Left' : 'Right'}-aligned`, kind: 'place' });
    if (p.v === 'top') out.push({ key: 'top', text: 'Top', title: 'Placed at the top of the picture', kind: 'neutral' });
    if (p.v === 'vertical') out.push({ key: 'vertical', text: 'Vertical', title: 'Vertical text', kind: 'neutral' });
    return out;
  }
  const cueKind = c => (c.issues && c.issues.length) ? 'issue' : (c.warns && c.warns.length) ? 'warn' : (c.placeTags && c.placeTags.some(t => t.kind === 'place')) ? 'place' : '';
  function appendCueTags(el, cue) {
    for (const t of [...(cue.issues || []), ...(cue.warns || []), ...(cue.placeTags || [])]) {
      const s = document.createElement('span');
      s.className = 'qtag q-' + t.kind;
      s.textContent = t.text;
      s.title = t.title;
      el.appendChild(s);
    }
  }
  const hText = h => ({ left: 'Left', right: 'Right', center: 'Centre', mixed: 'Mixed' })[h] || '—';
  const vText = p => !p ? '—' : p.v === 'raised' ? `Raised${p.lift != null ? ' ' + p.lift + '%' : ''}` : ({ bottom: 'Bottom', top: 'Top', vertical: 'Vertical' })[p.v] || '—';

  // Filters for the event list and the table (one shared state). All are always shown, dimmed when empty.
  FILTERS.splice(0, FILTERS.length,
    { key: 'all', label: 'All', cls: null, test: () => true },
    { key: 'issues', label: 'Issues', cls: 'f-issue', title: 'Every event with a red flag', test: c => !!(c.issues && c.issues.length) },
    { key: 'chars', get label() { return `CPL > ${CHAR_LIMIT}`; }, cls: 'f-issue', get title() { return `A line longer than ${CHAR_LIMIT} characters`; }, test: c => !!c.charLimitExceeded },
    { key: 'lines', get label() { return `Lines > ${LINE_COUNT_THRESHOLD - 1}`; }, cls: 'f-issue', get title() { return `More than ${LINE_COUNT_THRESHOLD - 1} lines`; }, test: c => c.lineCount >= LINE_COUNT_THRESHOLD },
    { key: 'overlap', label: 'Overlaps', cls: 'f-issue', test: c => !!c.overlap },
    { key: 'duration', label: 'Duration', cls: 'f-issue', title: `Under ${SHORT_DURATION_SECONDS}s or over ${MAX_DURATION_SECONDS}s on screen`, test: c => !!(c.tooShort || c.tooLong) },
    { key: 'durationCritical', label: 'Critical', cls: 'f-issue', title: `Under ${SHORT_DURATION_SECONDS}s with a line of ${SHORT_DURATION_CRITICAL_CHARS}+ characters`, test: c => !!c.tooShortCritical },
    { key: 'suspicious', label: 'Odd Chars', cls: 'f-issue', title: 'Invisible, control or replacement characters', test: c => !!c.hasSuspiciousChars },
    { key: 'mixed', label: 'Mixed align', cls: 'f-issue', title: 'Lines of one event aligned differently', test: c => !!c.mixedAlign },
    { key: 'cps', get label() { return `CPS > ${CPS_LIMIT}`; }, cls: 'f-warn', get title() { return `Over ${CPS_LIMIT} characters per second`; }, test: c => !!c.cpsOver },
    { key: 'gaps', label: 'Gaps', cls: 'f-warn', title: '1-frame gaps (the subtitle blinks off for a frame)', test: c => !!c.gapWarn },
    { key: 'placement', label: 'Placement', cls: 'f-place', title: 'Raised, or left / right-aligned', test: c => !!(c.placement && (c.placement.v === 'raised' || c.placement.h === 'left' || c.placement.h === 'right')) },
    { key: 'top', label: 'Top', cls: 'f-neutral', title: 'Placed at the top', test: c => !!(c.placement && c.placement.v === 'top') },
  );

  // Limits: changing them re-checks the loaded file at once (the Conform page re-counts too).
  function setLimits({ cps, cpl, lines }) {
    if (cps > 0) CPS_LIMIT = +cps;
    if (cpl > 0) CHAR_LIMIT = +cpl;
    if (lines > 0) LINE_COUNT_THRESHOLD = +lines + 1;
    Store.set(QC_LIMITS_KEY, JSON.stringify({ cps: CPS_LIMIT, cpl: CHAR_LIMIT, lines: LINE_COUNT_THRESHOLD - 1 }));
    if (cueList.length) { finalizeQcFlags(cueList); renderSidebarList(); tlDirty = true; }
    document.dispatchEvent(new CustomEvent('qc-limits'));
  }
