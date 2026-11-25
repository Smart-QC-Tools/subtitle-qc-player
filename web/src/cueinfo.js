  // ================================================================ per-event QC info
  // Reading speed (CPS), placement (left / right / raised / top) and the issue list for each event.
  // Shared by the event list, the waveform, the Events table and the Conform page.
  // Colour scheme: red = a rule is broken, amber = worth a look (1-frame gap, unusual placement),
// grey = top (neutral).

  const QC_LIMITS_KEY = 'qc:limits';
  // CPS default 25 (amber only). Limits saved before that (no "v": 2) keep CPL and lines, but CPS starts again at 25.
  let CPS_LIMIT = 25;
  (function loadLimits() {
    try {
      const v = JSON.parse(Store.get(QC_LIMITS_KEY) || 'null');
      if (v && v.v === 2 && v.cps > 0) CPS_LIMIT = +v.cps;
      if (v && v.cpl > 0) CHAR_LIMIT = +v.cpl;
      if (v && v.lines > 0) LINE_COUNT_THRESHOLD = +v.lines + 1;
    } catch (e) { /* defaults */ }
  })();

  // Time on screen, in seconds (the same at any frame rate): amber = worth a look, red = too short / too long.
  // At 24 fps: amber at 15 frames or less, red at 10 frames or less.
  const DUR = { shortWarn: 0.65, shortBad: 0.45, longWarn: 7, longBad: 10 };

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
    if (qh && qv) return { h: qh, v: qv, lift: null, box: null };   // SCC / SRT: worked out when the file was read
    const d = placementDoc(root, resolveStyleAttr);
    const reg = d.regions.get(regionId) || null;
    const wm = (regionAttr(reg, 'writingMode', d) || '').toLowerCase();
    if (wm.startsWith('tb')) return { h: 'center', v: 'vertical', lift: null, box: null };   // vertical Japanese: placed at the side by design
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
    // Where the text roughly is on the picture (in %), for the comparison with on-screen text: a line is about
    // one cell high plus line spacing; the width is filled in from the longest line (see subBox).
    const lh = 100 / (d.rows || 15) * 1.25, bh = Math.min(e[1], Math.max(1, lineCount) * lh);
    let bt;
    if (disp === 'after') bt = o[1] + e[1] - bh; else if (disp === 'center') bt = o[1] + (e[1] - bh) / 2; else bt = o[1];
    return { h, v, lift: Math.max(0, Math.round(100 - bottom)), box: { top: bt, bottom: bt + bh, rx0: o[0], rx1: o[0] + e[0], al, cols: d.cols || 32, rows: d.rows || 15 } };
  }

  // ---------------------------------------------------------------- issues
  function finalizeQcFlags(list) {
    list.forEach((c, i) => {
      if (c.chars == null) c.chars = Array.from(c.text.replace(/\n/g, '')).length;
      c.cps = c.duration > 0 ? c.chars / c.duration : null;
      c.cpsOver = c.cps != null && c.cps > CPS_LIMIT + 1e-9;
      const dur = isFinite(c.end) && isFinite(c.begin) ? c.end - c.begin : null;
      c.tooShort = dur != null && dur < DUR.shortBad - 1e-6;
      c.tooLong = dur != null && dur > DUR.longBad + 1e-6;
      c.shortWarn = dur != null && !c.tooShort && dur < DUR.shortWarn - 1e-6;
      c.longWarn = dur != null && !c.tooLong && dur > DUR.longWarn + 1e-6;
      c.tooShortCritical = false;   // (the old "very short with a long line" flag: red under 0.45 s covers it)
      c.charLimitExceeded = c.maxLineLength > CHAR_LIMIT;
      const nx = list[i + 1];
      c.gap = nx && isFinite(c.end) ? nx.begin - c.end : null;
      // A gap of a single frame makes the subtitle blink off and on. 0 (back-to-back) is normal.
      const frame = 1 / (fps() || docEffectiveFrameRate || 24);
      c.gapWarn = c.gap != null && c.gap > 0.001 && c.gap < frame * 1.5;
      c.gapNext = c.gapWarn ? nx.begin : null;
      c.mixedAlign = !!(c.placement && c.placement.h === 'mixed');
      // Still on screen after the last frame of the video (usually the last event, by a few frames). Only for the
      // file in the player: the Conform page checks other files, not against this video.
      const d = list === cueList ? tlDuration() : 0, [, ve] = cueVideoTime(c);
      c.pastEnd = !!(d > 0 && isFinite(ve) && ve > d + frame * 0.5);
      c.videoEnd = d > 0 ? d + effectiveOffset() : null;
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
    analysisChecks(list);
    list.forEach(c => { c.issues = cueIssues(c); c.warns = cueWarns(c); c.placeTags = cuePlaceTags(c); });
  }

  // ---------------------------------------------------------------- against the video analysis (Mac app)
  // Credits and other on-screen text, and commercial blacks, found by Video Analysis for the video in the player.
  const NEAR_PCT = 5, RAISED_WINDOW = 20, TIME_MARGIN = 0.2;
  // The subtitle's box on the picture, in % (an estimate from its region, lines and longest line).
  function subBox(c) {
    const p = c.placement, n = Math.max(1, c.lineCount || 1), len = Math.max(1, c.maxLineLength || 1);
    const b = p && p.box;
    const rows = b ? b.rows : 15, lh = 100 / rows * 1.25;
    const width = Math.min(96, len * (100 / rows) * 0.5 * (9 / 16));   // a character is about half a line high, on a 16:9 picture
    let top, bottom, x0, x1;
    if (b) { top = b.top; bottom = b.bottom; }
    else if (p && p.v === 'top') { top = 10; bottom = 10 + n * lh; }
    else { bottom = 90; top = 90 - n * lh; }                            // SCC / SRT: the usual bottom position
    const al = b ? b.al : (p && p.h) || 'center';
    const r0 = b ? b.rx0 : 10, r1 = b ? b.rx1 : 90;
    if (al === 'left') { x0 = r0; x1 = r0 + width; }
    else if (al === 'right') { x1 = r1; x0 = r1 - width; }
    else { const m = (r0 + r1) / 2; x0 = m - width / 2; x1 = m + width / 2; }
    return { top, bottom, x0, x1 };
  }
  const CARD_WORD = { credit: 'credit', title: 'title', text: 'on-screen text' };
  function analysisChecks(list) {
    const m = list === cueList && typeof marksNow === 'function' ? marksNow() : null;
    const off = effectiveOffset(), fr = 1 / (fps() || 24);
    for (const c of list) { c.onText = c.nearText = c.raisedNoText = c.overBlack = c.textHere = null; }
    if (!m) return;
    for (const c of list) {
      const [vb, ve] = cueVideoTime(c);
      if (!isFinite(vb) || !isFinite(ve)) continue;
      const box = subBox(c);
      for (const k of m.cards || []) {
        if (!(vb < k.out + TIME_MARGIN && ve > k.in - TIME_MARGIN) || !k.box) continue;
        const ky0 = k.box[1] * 100, ky1 = (k.box[1] + k.box[3]) * 100, kx0 = k.box[0] * 100, kx1 = (k.box[0] + k.box[2]) * 100;
        const vGap = Math.max(ky0 - box.bottom, box.top - ky1), hGap = Math.max(kx0 - box.x1, box.x0 - kx1);
        const info = { kind: CARD_WORD[k.kind] || 'on-screen text', text: k.text, in: k.in + off, out: k.out + off, gap: Math.max(0, vGap) };
        if (vGap < 0 && hGap < 0) { c.onText = info; break; }
        if (vGap < NEAR_PCT && hGap < 2 && !c.nearText) c.nearText = info;
      }
      if (c.onText) c.nearText = null;
      // a tester flagged text here, but where it sits on the picture wasn't found: worth a look (amber)
      if (!c.onText) for (const [a, b] of m.unknown || []) if (vb < b && ve > a) { c.textHere = { in: a + off, out: b + off }; break; }
      // Raised (or at the top) with nothing to make room for: no credit within 20 s, no on-screen text at the time.
      if (c.placement && (c.placement.v === 'raised' || c.placement.v === 'top') && m.scannedTo && vb < m.scannedTo && m.cards) {
        // (markers from text detection don't tell credits from other text: any of it counts)
        const nearCredit = m.cards.some(k => (m.allText || k.kind === 'credit' || k.kind === 'title') && vb < k.out + RAISED_WINDOW && ve > k.in - RAISED_WINDOW);
        const withText = m.cards.some(k => vb < k.out + TIME_MARGIN && ve > k.in - TIME_MARGIN) || (m.unknown || []).some(([a, b]) => vb < b && ve > a);
        if (!nearCredit && !withText) c.raisedNoText = true;
      }
      for (const [a, b] of m.blacks || []) if (vb < b - fr * 0.5 && ve > a + fr * 0.5) { c.overBlack = { in: a + off, out: b + off }; break; }
    }
  }
  const secs = v => v < 10 ? v.toFixed(2).replace(/0$/, '') : v.toFixed(1);
  function cueIssues(c) {
    const out = [];
    const add = (key, text, title) => out.push({ key, text, title, kind: 'issue' });
    if (c.charLimitExceeded) add('chars', `CPL ${c.maxLineLength}`, `Longest line has ${c.maxLineLength} characters (limit ${CHAR_LIMIT})`);
    if (c.lineCount >= LINE_COUNT_THRESHOLD) add('lines', `${c.lineCount} lines`, `${c.lineCount} lines on screen`);
    if (c.overlap) add('overlap', 'Overlap', 'Overlaps another event');
    if (c.tooShort) add('duration', `Short ${secs(c.duration)}s`, `Under ${DUR.shortBad}s on screen (${c.duration.toFixed(3)}s)`);
    else if (c.tooLong) add('duration', `Long ${secs(c.duration)}s`, `Over ${DUR.longBad}s on screen (${c.duration.toFixed(3)}s)`);
    if (c.hasSuspiciousChars) add('suspicious', 'Odd char', 'Contains an invisible / control / replacement character');
    if (c.onText) add('onText', `On ${c.onText.kind === 'on-screen text' ? 'text' : c.onText.kind}`, `Covers ${c.onText.text ? `the ${c.onText.kind} “${c.onText.text}”` : `on-screen text`} (${formatVideoTC(c.onText.in)} – ${formatVideoTC(c.onText.out)})`);
    if (c.overBlack) add('overBlack', 'Over black', `Runs across the commercial black at ${formatVideoTC(c.overBlack.in)}`);
    if (c.pastEnd) add('pastEnd', 'Past end', `Still on screen after the video ends (the event ends ${formatVideoTC(c.end)}, the video at ${formatVideoTC(c.videoEnd)})`);
    return out;
  }
  // Amber: worth a look, not a broken rule. Reading speed over the limit is often still readable.
  function cueWarns(c) {
    const out = [];
    if (c.mixedAlign) out.push({ key: 'mixed', text: 'Mixed align', title: 'Lines of this event are aligned differently', kind: 'warn' });
    if (c.shortWarn) out.push({ key: 'duration', text: `Short ${secs(c.duration)}s`, title: `Under ${DUR.shortWarn}s on screen (${c.duration.toFixed(3)}s)`, kind: 'warn' });
    if (c.longWarn) out.push({ key: 'duration', text: `Long ${secs(c.duration)}s`, title: `Over ${DUR.longWarn}s on screen (${c.duration.toFixed(3)}s)`, kind: 'warn' });
    if (c.nearText) out.push({ key: 'nearText', text: `Near ${c.nearText.kind === 'on-screen text' ? 'text' : c.nearText.kind}`, title: `Close to ${c.nearText.text ? `the ${c.nearText.kind} “${c.nearText.text}”` : 'on-screen text'} (${formatVideoTC(c.nearText.in)} – ${formatVideoTC(c.nearText.out)}): about ${Math.round(c.nearText.gap)}% of the picture height apart`, kind: 'warn' });
    if (c.textHere) out.push({ key: 'textHere', text: 'Text here?', title: `A tester flagged on-screen text around ${formatVideoTC(c.textHere.in)} – ${formatVideoTC(c.textHere.out)}, but where it sits on the picture wasn't found: check the subtitle doesn't cover it`, kind: 'warn' });
    if (c.raisedNoText) out.push({ key: 'raisedNoText', text: 'Raised, no credit', title: `Raised or at the top, but there is no credit within ${RAISED_WINDOW} s and no other on-screen text at the time (from the video analysis)`, kind: 'warn' });
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
    { key: 'issues', label: 'All issues', cls: 'f-all', title: 'Every event with a red or amber flag (placement and top not included)', test: c => !!((c.issues && c.issues.length) || (c.warns && c.warns.length)) },
    { key: 'chars', get label() { return `CPL > ${CHAR_LIMIT}`; }, cls: 'f-issue', get title() { return `A line longer than ${CHAR_LIMIT} characters`; }, test: c => !!c.charLimitExceeded },
    { key: 'lines', get label() { return `Lines > ${LINE_COUNT_THRESHOLD - 1}`; }, cls: 'f-issue', get title() { return `More than ${LINE_COUNT_THRESHOLD - 1} lines`; }, test: c => c.lineCount >= LINE_COUNT_THRESHOLD },
    { key: 'overlap', label: 'Overlaps', cls: 'f-issue', test: c => !!c.overlap },
    // red and amber together; the button is red when any of them is red
    { key: 'duration', label: 'Duration', get cls() { return cueList.some(c => c.tooShort || c.tooLong) ? 'f-issue' : 'f-warn'; },
      title: `Short: under ${DUR.shortWarn}s amber, under ${DUR.shortBad}s red · Long: over ${DUR.longWarn}s amber, over ${DUR.longBad}s red`,
      test: c => !!(c.tooShort || c.tooLong || c.shortWarn || c.longWarn) },
    { key: 'suspicious', label: 'Odd Chars', cls: 'f-issue', title: 'Invisible, control or replacement characters', test: c => !!c.hasSuspiciousChars },
    { key: 'onText', get label() { const m = typeof marksNow === 'function' && marksNow(); return m && m.allText ? 'On text' : 'On credits'; }, cls: 'f-issue', title: 'Covers a credit or other on-screen text (from the video markers)', test: c => !!c.onText },
    { key: 'overBlack', label: 'Over black', cls: 'f-issue', title: 'Runs across a commercial black (from the video analysis)', test: c => !!c.overBlack },
    { key: 'pastEnd', label: 'Past end', cls: 'f-issue', title: 'Still on screen after the video ends', test: c => !!c.pastEnd },
    { key: 'cps', get label() { return `CPS > ${CPS_LIMIT}`; }, cls: 'f-warn', get title() { return `Over ${CPS_LIMIT} characters per second`; }, test: c => !!c.cpsOver },
    { key: 'mixed', label: 'Mixed align', cls: 'f-warn', title: 'Lines of one event aligned differently', test: c => !!c.mixedAlign },
    { key: 'nearText', get label() { const m = typeof marksNow === 'function' && marksNow(); return m && m.allText ? 'Near text' : 'Near credits'; }, cls: 'f-warn', title: `Within ${NEAR_PCT}% of the picture height of a credit or other on-screen text`, test: c => !!c.nearText },
    { key: 'textHere', label: 'Text, place unknown', cls: 'f-warn', title: 'A tester flagged on-screen text at the time, but its place on the picture wasn\'t found', test: c => !!c.textHere },
    { key: 'raisedNoText', label: 'Raised, no credit', cls: 'f-warn', title: `Raised or at the top, with no credit within ${RAISED_WINDOW} s and no on-screen text at the time`, test: c => !!c.raisedNoText },
    { key: 'gaps', label: 'Gaps', cls: 'f-warn', title: '1-frame gaps (the subtitle blinks off for a frame)', test: c => !!c.gapWarn },
    { key: 'placement', label: 'Placement', cls: 'f-place', title: 'Raised, or left / right-aligned', test: c => !!(c.placement && (c.placement.v === 'raised' || c.placement.h === 'left' || c.placement.h === 'right')) },
    { key: 'top', label: 'Top', cls: 'f-neutral', title: 'Placed at the top', test: c => !!(c.placement && c.placement.v === 'top') },
  );

  // Checks that depend on the video (its length, the offset) are made again when those change.
  function requalify() { if (cueList.length) { renderSidebarList(); tlDirty = true; } }   // (renderSidebarList re-checks)
  // Limits: changing them re-checks the loaded file at once (the Conform page re-counts too).
  function setLimits({ cps, cpl, lines }) {
    if (cps > 0) CPS_LIMIT = +cps;
    if (cpl > 0) CHAR_LIMIT = +cpl;
    if (lines > 0) LINE_COUNT_THRESHOLD = +lines + 1;
    Store.set(QC_LIMITS_KEY, JSON.stringify({ v: 2, cps: CPS_LIMIT, cpl: CHAR_LIMIT, lines: LINE_COUNT_THRESHOLD - 1 }));
    if (cueList.length) { finalizeQcFlags(cueList); renderSidebarList(); tlDirty = true; }
    document.dispatchEvent(new CustomEvent('qc-limits'));
  }
