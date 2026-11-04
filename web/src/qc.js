/* ==========================================================================
   Subtitle Language Check — app logic
   ========================================================================== */
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const SUB_EXT = /\.(ttml|dfxp|xml|itt|imsc|imscr|imsc1|ttml2|vtt|srt|scc)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v)$/i;

// ------------------------------------------------------------ reference list
const REF_BY_CODE = new Map();           // lowercased code -> {code, names[]}
const REF_BASES = new Set();
for (const [name, code] of REFERENCE_LIST) {
  const k = code.toLowerCase();
  if (!REF_BY_CODE.has(k)) REF_BY_CODE.set(k, { code, names: [] });
  REF_BY_CODE.get(k).names.push(name);
  REF_BASES.add(k.split('-')[0]);
}
const prettyName = n => NAME_DISPLAY[n] || n.toLowerCase().replace(/_/g, ' ').replace(/\b\p{L}/gu, c => c.toUpperCase()).replace(/\bMnland\b/, 'Mainland');
const langName = code => Detector.LANG_NAMES[code] || code;

// ------------------------------------------------------------ BCP-47 helpers
function parseTag(raw) {
  if (raw == null) return null;
  const parts = String(raw).trim().replace(/_/g, '-').split('-').filter(Boolean);
  if (!parts.length) return null;
  const t = { raw: String(raw).trim(), lang: parts[0].toLowerCase(), script: null, region: null };
  for (const p of parts.slice(1)) {
    if (REGION_ALIASES[p.toLowerCase()] && !t.region) t.region = REGION_ALIASES[p.toLowerCase()];
    else if (/^[a-z]{4}$/i.test(p) && !t.script && !t.region) t.script = p[0].toUpperCase() + p.slice(1).toLowerCase();
    else if (/^([a-z]{2}|\d{3})$/i.test(p) && !t.region) t.region = p.toUpperCase();
  }
  return t;
}
const tagStr = t => [t.lang, t.script, t.region].filter(Boolean).join('-');
function canonical(t) {
  const c = { ...t, lang: BASE_ALIASES[t.lang] || t.lang };
  if (t.lang === 'yue' || t.lang === 'cmn') c.lang = t.lang === 'cmn' ? 'zh' : 'yue';
  if (c.lang === 'zh' && !c.script && c.region && ZH_REGION_SCRIPT[c.region] && c.region !== 'SG') c.script = ZH_REGION_SCRIPT[c.region];
  return c;
}
// Script the text is expected to be in, if the label implies one.
function expectedScript(t) {
  if (!t) return null;
  if (t.script) return t.script;
  if (t.lang === 'zh' && t.region && ZH_REGION_SCRIPT[t.region]) return ZH_REGION_SCRIPT[t.region];
  return null;
}

function matchReference(raw) {
  const t = parseTag(raw);
  if (!t) return { status: 'missing' };
  const exact = REF_BY_CODE.get(t.raw.toLowerCase().replace(/_/g, '-'));
  if (exact) return { status: 'exact', tag: t, ref: exact };
  const c = canonical(t);
  const tries = [tagStr(c)];
  if (c.script) tries.push(c.lang + '-' + c.script);
  if (c.script && c.region) tries.push(c.lang + '-' + c.region);
  // zh-TW -> zh-Hant etc.
  if (c.lang === 'zh' && c.region === 'SG') tries.unshift('zh-sg');
  for (const k of tries) {
    const r = REF_BY_CODE.get(k.toLowerCase());
    if (r) return { status: 'equivalent', tag: t, canon: c, ref: r };
  }
  const baseRef = REF_BY_CODE.get(c.lang);
  if (baseRef) {
    // "en-US" when the list only has "en": a regional label of a listed language is fine. Only when
    // the list also has regional entries (fr-FR, fr-CA …) is the plain "fr" a vague match.
    const regional = [...REF_BY_CODE.keys()].some(k => k.startsWith(c.lang + '-'));
    return { status: regional ? 'base' : 'regional', tag: t, canon: c, ref: baseRef };
  }
  if (REF_BASES.has(c.lang)) {
    // Base exists only with regions (e.g. "es-US" when list has es-ES/es-419/…)
    const opts = [...REF_BY_CODE.values()].filter(r => r.code.toLowerCase().startsWith(c.lang + '-'));
    return { status: 'base', tag: t, canon: c, ref: opts[0], options: opts };
  }
  return { status: 'unknown', tag: t, canon: c };
}

// ------------------------------------------------------------ file name parsing
const NAME_MAP = (() => {
  const m = { ...FILENAME_WORDS };
  for (const [name, code] of REFERENCE_LIST) m[name.toLowerCase()] = code;
  // Natural word order too: BRAZILIAN_PORTUGUESE as well as PORTUGUESE_BRAZIL.
  Object.assign(m, {
    brazilian_portuguese: 'pt-BR', european_portuguese: 'pt-PT', latin_spanish: 'es-419', latin_american_spanish: 'es-419',
    latinamerican_spanish: 'es-419', castilian_spanish: 'es-ES', european_spanish: 'es-ES', mexican_spanish: 'es-MX',
    canadian_french: 'fr-CA', parisian_french: 'fr-FR', european_french: 'fr-FR', simplified_chinese: 'zh-Hans',
    traditional_chinese: 'zh-Hant', chinese_simplified: 'zh-Hans', chinese_traditional: 'zh-Hant',
    mainland_mandarin: 'zh-Hans', taiwanese_mandarin: 'zh-Hant', flemish: 'nl-BE',
  });
  return m;
})();
const ISO3 = new Set(Object.keys(BASE_ALIASES).filter(k => k.length === 3));

function languageFromFilename(filename) {
  const stem = filename.replace(/\.[^.]+$/, '');
  const toks = stem.split(/[\s._\-\[\]\(\)\{\}+,]+/).filter(Boolean);
  const n = toks.length;
  // In all-caps names (AMZN_…_PART_1_…) an upper-case token says nothing, so only position counts.
  const mostlyUpper = toks.filter(t => /\p{Ll}/u.test(t)).length < toks.length * 0.3;
  const cands = [];
  // Technical tokens (type, resolution, frame rate, version, dates …) don't count when judging
  // whether a code sits "near the end" of the name: SHOW_S01E01_POL_FN_HD_2398_FINAL.
  const TECH = /^(fn|fpn|forced|full|cc|sdh|hoh|hd|uhd|sd|hdr|sdr|dv|dovi|4k|2k|textless|txtl|final|fin|master|v\d+|r\d+|ver\d*|\d+[pi]|\d+|ttml|itt|imsc|imsc1|dfxp|xml|sub|subs|subtitles?|captions?|stereo|mono|\d+ch|proxy|prores|h264|h265|hevc|avc|mov|mp4|nf|amzn|apple|itunes|dcp|dl|web|webdl|bluray|bd|tv|eng?sub)$/i;
  const after = i => { let c = 0; for (let j = i + 1; j < n; j++) if (!TECH.test(toks[j])) c++; return c; };
  // Language words before the season/episode marker belong to the show title (THE_GERMAN_S01E01).
  const anchor = toks.findIndex(t => /^(s\d{1,2}e\d{1,3}|yr\d{1,2}|\d{1,2}x\d{2,3})$/i.test(t));
  const NOT_REGION = /^(fn|cc|hd|sd|ad|dv|tv|uk|fpn|sdh|eng)$/i;
  const isRegionTok = s => !NOT_REGION.test(s) && (/^([A-Za-z]{2}|\d{3}|hans|hant|latn|cyrl)$/i.test(s) || !!REGION_ALIASES[s.toLowerCase()]);
  for (let i = 0; i < n; i++) {
    const lo = toks[i].toLowerCase();
    // DETE-style names spanning up to 4 tokens: SPANISH_LATIN, CHINESE_MANDARIN_TAIWAN
    for (let len = 4; len >= 1; len--) {
      if (i + len > n) continue;
      const key = toks.slice(i, i + len).join('_').toLowerCase();
      if (NAME_MAP[key]) { cands.push({ pos: i + len - 1, len, code: NAME_MAP[key], src: toks.slice(i, i + len).join('_') }); break; }
    }
    if (FILENAME_COMPACT[lo]) cands.push({ pos: i, len: 1, code: FILENAME_COMPACT[lo], src: toks[i] });
    // Vendor / dubbing-house codes (CSP, LSP, BPT, EPT …), only when written in capitals: the
    // distinctive ones anywhere, the ones that are also ordinary words (LAT, LAS, CAS) only near the end.
    const vc = VENDOR_LANG_CODES[lo];
    if (vc && toks[i] === toks[i].toUpperCase() && (vc.strong || after(i) <= 2)) cands.push({ pos: i, len: 1, code: vc.code, src: toks[i] });
    const nearEnd = after(i) <= 1 || (i + 1 < n && isRegionTok(toks[i + 1]) && after(i + 1) <= 1);
    const upper = !mostlyUpper && toks[i] === toks[i].toUpperCase() && /[A-Z]/.test(toks[i]);
    const base = BASE_ALIASES[lo] || lo;
    const codeLike = (lo.length === 2 && REF_BASES.has(lo)) || lo === 'yue' || lo === 'prs' || (ISO3.has(lo) && REF_BASES.has(base));
    if (codeLike && (nearEnd || upper)) {
      let code = base, len = 1, src = toks[i];
      if (i + 1 < n && isRegionTok(toks[i + 1])) {
        const t = parseTag(base + '-' + toks[i + 1]);
        if (t && (t.script || t.region)) { code = tagStr(t); len = 2; src = toks[i] + '-' + toks[i + 1]; }
      }
      cands.push({ pos: i + len - 1, len, code, src });
    }
  }
  if (anchor > 0) for (let k = cands.length - 1; k >= 0; k--) if (cands[k].pos < anchor) cands.splice(k, 1);
  if (!cands.length) return null;
  cands.sort((a, b) => b.pos - a.pos || b.len - a.len);
  // Two-letter token that is itself a region right after another code (pt_BR) must not win as "br".
  return cands[0];
}

// ------------------------------------------------------------ reading & parsing
async function readText(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let enc = 'utf-8', start = 0;
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) start = 3;
  else if (buf[0] === 0xFF && buf[1] === 0xFE) { enc = 'utf-16le'; start = 2; }
  else if (buf[0] === 0xFE && buf[1] === 0xFF) { enc = 'utf-16be'; start = 2; }
  else if (buf[0] === 0x3C && buf[1] === 0x00) enc = 'utf-16le';
  else if (buf[0] === 0x00 && buf[1] === 0x3C) enc = 'utf-16be';
  else {
    const head = new TextDecoder('latin1').decode(buf.slice(0, 200));
    const m = head.match(/encoding\s*=\s*["']([\w\-]+)["']/i);
    if (m) enc = m[1].toLowerCase();
  }
  let text;
  try { text = new TextDecoder(enc).decode(buf.slice(start)); }
  catch { enc = 'utf-8'; text = new TextDecoder('utf-8').decode(buf.slice(start)); }
  return { text, encoding: enc };
}

function xmlLang(el) {
  if (!el || el.nodeType !== 1) return null;
  if (el.hasAttributeNS && el.hasAttributeNS(XML_NS, 'lang')) return el.getAttributeNS(XML_NS, 'lang');
  if (el.hasAttribute('xml:lang')) return el.getAttribute('xml:lang');
  return null;
}
function effectiveLang(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentNode) { const v = xmlLang(n); if (v !== null) return v; }
  return null;
}

function parseSubtitle(text, filename) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const perr = doc.getElementsByTagName('parsererror')[0];
  if (perr) return { error: 'XML parse error: ' + (perr.textContent || '').split('\n').filter(Boolean).slice(0, 2).join(' ').slice(0, 200) };
  const root = doc.documentElement;
  if (!root || root.localName !== 'tt') return { notTTML: true, rootName: root && root.localName };
  const profile = (root.getAttribute('ttp:profile') || '') + ' ' + [...root.attributes].map(a => a.value).join(' ');
  let format = 'TTML';
  if (/\.itt$/i.test(filename)) format = 'iTT';
  else if (/\.dfxp$/i.test(filename)) format = 'DFXP';
  if (/imsc/i.test(profile)) format = /\.itt$/i.test(filename) ? 'iTT' : 'IMSC';
  const rootLang = xmlLang(root);
  const body = root.getElementsByTagNameNS('*', 'body')[0];
  const cues = [];
  const langUse = new Map();
  let imageCues = 0;
  if (body) {
    for (const el of body.getElementsByTagNameNS('*', '*')) {
      const l = xmlLang(el); if (l !== null) langUse.set(l, (langUse.get(l) || 0) + 1);
      if (el.localName === 'div' && [...el.attributes].some(a => /backgroundImage|image/i.test(a.name))) imageCues++;
    }
    for (const p of body.getElementsByTagNameNS('*', 'p')) {
      const pLang = effectiveLang(p);
      const segs = [];
      const walk = (node) => {
        let s = '';
        for (const c of node.childNodes) {
          if (c.nodeType === 3 || c.nodeType === 4) s += c.nodeValue;
          else if (c.nodeType === 1) {
            if (c.localName === 'br') s += '\n';
            else if (c.localName === 'metadata') continue;
            else {
              const inner = walk(c);
              const own = xmlLang(c);
              if (own !== null && own !== pLang && inner.trim()) segs.push({ lang: own, text: inner.trim() });
              s += inner;
            }
          }
        }
        return s;
      };
      const t = walk(p).replace(/[ \t\r]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
      if (t) cues.push({ begin: p.getAttribute('begin') || '', text: t, lang: pLang, segs });
    }
  }
  return { format, rootLang, cues, langUse, imageCues, text, root };
}

function cleanForDetection(t) {
  return t
    .replace(/[♪♫♬#*]/g, ' ')
    .replace(/^\s*[-–—]\s*/gm, '')
    .replace(/^[\p{Lu}][\p{Lu}\s.'’\-]{1,30}:\s*/gmu, '')   // SPEAKER:
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\d+/g, ' ');
}

// ------------------------------------------------------------ analysis
const SEV_RANK = { error: 3, warn: 2, info: 1, ok: 0 };
const REGION_GROUP = {
  es: r => r === 'ES' ? 'es-ES' : 'es-419',
  pt: r => r === 'PT' ? 'pt-PT' : r === 'BR' ? 'pt-BR' : null,
  fr: r => r === 'CA' ? 'fr-CA' : 'fr-FR'
};

async function analyzeFile(file) {
  const r = { name: file.name, size: file.size, file, flags: [] };
  const flag = (sev, text, detail) => r.flags.push({ sev, text, detail });
  let parsed;
  try {
    let { text, encoding } = await readText(file);
    r.encoding = encoding;
    const side = Sidecar.convert(text, file.name);       // WebVTT / SRT / SCC -> TTML
    if (side) { r.sidecar = side.format; text = side.ttml; }
    parsed = parseSubtitle(text, file.name);
    if (side && !parsed.error && !parsed.notTTML) parsed.format = side.format;
  } catch (e) { parsed = { error: String(e && e.message || e) }; }
  if (parsed.notTTML) return null;              // not a subtitle file (e.g. other .xml)
  r.fileLang = languageFromFilename(file.name);
  r.nameInfo = Match.parse(file.name);
  r.type = r.nameInfo.type || 'Full';
  r.forced = r.type === 'Forced';
  if (parsed.error) { r.format = '—'; flag('error', 'Could not read file', parsed.error); return finish(r); }
  Object.assign(r, { format: parsed.format, rawLabel: parsed.rootLang, cueCount: parsed.cues.length });

  cueChecks(r, parsed, flag);

  // ---- label vs reference list
  // WebVTT, SRT and SCC have no language label of their own (WebVTT may have a "Language:" header):
  // use the file name's.
  const lab = parsed.rootLang || (r.sidecar && r.fileLang ? r.fileLang.code : null);
  if (r.sidecar && !parsed.rootLang) {
    if (r.fileLang) flag('info', `${r.sidecar} has no language label`, `Checked against the language in the file name (${r.fileLang.code}).`);
    else flag('error', 'No language label', `${r.sidecar} files carry no language label, and the file name has none either.`);
  }
  const m = matchReference(lab);
  r.match = m;
  if (m.status === 'missing') { if (!r.sidecar) flag('error', 'No xml:lang on <tt>', 'The root <tt> element has no xml:lang attribute (or it is empty).'); }
  else if (m.status === 'unknown') flag('error', `Label “${lab}” is not in the reference list`, 'No matching code or base language in the DETE list.');
  else if (m.status === 'equivalent') flag('warn', `Non-standard code “${lab}”`, `Equivalent to list code “${m.ref.code}” (${m.ref.names.map(prettyName).join(' / ')}).`);
  else if (m.status === 'base') flag('warn', `“${lab}” is not an exact list code`, m.options ? `List has: ${m.options.map(o => o.code).join(', ')}.` : `Closest list code: “${m.ref.code}” (${m.ref.names.map(prettyName).join(' / ')}).`);

  const labelTag = m.tag ? canonical(m.tag) : null;
  const expBase = labelTag ? labelTag.lang : null;
  const expScript = expectedScript(labelTag) || (m.ref ? expectedScript(parseTag(m.ref.code)) : null);
  r.expected = m.ref ? { code: m.ref.code, names: m.ref.names } : null;

  // ---- other xml:lang values inside the document
  const others = [...parsed.langUse.entries()].filter(([l]) => l !== parsed.rootLang);
  r.innerLangs = others;

  // ---- detection
  const analyses = [];
  const primaryPool = [];
  for (const c of parsed.cues) {
    const a = Detector.analyze(cleanForDetection(c.text));
    analyses.push(a);
    primaryPool.push(a);
  }
  const merged = Detector.merge(primaryPool);
  const prim = Detector.primaryFrom(merged);
  r.detected = prim;
  r.letters = merged.letters;
  r.han = merged.han;
  const counts = {}; const samples = {};
  let classified = 0;
  if (prim && prim.lang) {
    analyses.forEach((a, i) => {
      const c = Detector.classifyCue(a, prim.lang);
      if (!c) return;
      classified++;
      let lang = c.strong && !Detector.sameCluster(c.lang, prim.lang) ? c.lang : prim.lang;
      counts[lang] = (counts[lang] || 0) + 1;
      if (lang !== prim.lang) (samples[lang] = samples[lang] || []).push(parsed.cues[i]);
    });
  }
  r.classified = classified;
  r.breakdown = Object.entries(counts).map(([l, n]) => ({ lang: l, n, pct: classified ? 100 * n / classified : 0 })).sort((a, b) => b.n - a.n);
  r.samples = samples;
  r.secondary = r.breakdown.filter(b => prim && b.lang !== prim.lang && b.n >= 2);

  // ---- compare
  const littleText = merged.letters < 40 || classified < 3;
  r.littleText = littleText;
  if (parsed.cues.length === 0) {
    if (parsed.imageCues) flag('info', 'Image-based subtitles', 'No text to analyse (image profile).');
    else flag('error', 'No subtitle text found', r.forced ? 'A forced file should contain at least one subtitle.' : 'The file has no <p> elements with text.');
  } else if (!prim || !prim.lang) {
    flag(r.forced ? 'info' : 'warn', 'Could not detect language', 'Too little recognisable text.');
  } else if (littleText) {
    flag(r.forced ? 'info' : 'warn', 'Too little text to verify language', `${classified} usable cue${classified === 1 ? '' : 's'}${r.forced ? ' (normal for a forced file)' : ''}.`);
  }
  if (prim && prim.lang && expBase) {
    const d = prim.lang;
    const chinese = l => l === 'zh' || l === 'yue';
    if (chinese(d) && chinese(expBase)) {
      if (expBase === 'zh' && d === 'yue') flag('warn', 'Written Cantonese in a Mandarin-labelled file', `${merged.han.cantonese} Cantonese-specific characters (係, 嘅, 唔, 咗 …).`);
      if (expBase === 'yue' && d === 'zh') flag('info', 'Cantonese not verifiable', 'Text is standard written Chinese (common for Cantonese subtitles).');
    } else if (!Detector.sameCluster(d, expBase)) {
      if (littleText) { if (prim.conf === 'high' && merged.hits >= 3 && !(merged.scores[expBase] > 0)) flag('warn', `Possibly ${langName(d)}, labelled ${langName(expBase)}`, `Based on very little text (${merged.letters} letters), so this may be wrong.`); }
      else if (merged.letters < 200) flag('warn', `Possibly ${langName(d)}, labelled ${langName(expBase)}`, `Based on little text (${merged.letters} letters); short lines, all-caps signs and close languages are easy to confuse.`);
      else flag('error', `Content is ${langName(d)}, labelled ${langName(expBase)}`, `Detected ${langName(d)} (${prim.conf} confidence)${prim.alt ? `; runner-up ${langName(prim.alt)}` : ''}.`);
    } else if (d !== expBase) {
      flag('info', `${langName(d)} / ${langName(expBase)} are close variants`, 'These languages cannot be reliably told apart from subtitle text.');
    }
    if (Detector.sameCluster(d, expBase) || (chinese(d) && chinese(expBase))) {
      // script checks
      if ((expScript === 'Hans' || expScript === 'Hant') && chinese(d)) {
        if (prim.script === 'Hans' || prim.script === 'Hant') {
          if (prim.script !== expScript) flag('error', `Script is ${Detector.SCRIPT_NAMES[prim.script]}, label expects ${Detector.SCRIPT_NAMES[expScript]}`, `Simplified-only chars: ${merged.han.simp}, Traditional-only chars: ${merged.han.trad}.`);
        } else if (prim.script === 'Hans/Hant?') flag('warn', 'Mixed Simplified/Traditional characters', `Simplified-only: ${merged.han.simp}, Traditional-only: ${merged.han.trad}.`);
      }
      if (expBase === 'sr' && expScript && (expScript === 'Latn' || expScript === 'Cyrl') && prim.script !== expScript)
        flag('error', `Serbian script is ${Detector.SCRIPT_NAMES[prim.script]}, label expects ${Detector.SCRIPT_NAMES[expScript]}`);
      // regional checks
      const region = labelTag.region || (m.ref && parseTag(m.ref.code).region);
      const grp = REGION_GROUP[expBase];
      if (grp && region && !littleText) {
        const own = grp(region);
        if (own) {
          const rm = Detector.regionMarkers(expBase, parsed.cues.map(c => c.text).join('\n'));
          r.regionMarkers = rm;
          const contraryKey = Object.keys(rm).find(k => k !== own);
          const ownN = rm[own].total, conN = rm[contraryKey].total;
          const ratio = expBase === 'pt' ? 1.5 : 2;
          if (conN >= 5 && conN >= ratio * Math.max(1, ownN))
            flag('warn', `Text looks like ${contraryKey} (label ${tagStr(labelTag)})`, `${contraryKey} markers: ${conN}, ${own} markers: ${ownN}. ${topMarkers(rm[contraryKey])}`);
          else if (ownN >= 3 && conN * 3 <= ownN) flag('info', `Region ${region}: markers consistent`, `${own} markers: ${ownN}, ${contraryKey} markers: ${conN}. ${topMarkers(rm[own])}`);
          else flag('info', `Region ${region} not verified`, `${own} markers: ${ownN}, ${contraryKey} markers: ${conN}. Regional variants can't be reliably confirmed from text.`);
        }
      }
    }
    if (prim.conf === 'low' && !littleText && !r.flags.some(f => f.sev === 'error')) flag('info', 'Low detection confidence', prim.alt ? `Runner-up: ${langName(prim.alt)}.` : '');
  }

  // ---- mixed
  if (r.secondary.length) {
    flag('info', 'Mixed: ' + r.secondary.map(s => `${langName(s.lang)} ${fmtPct(s.pct)}`).join(', '), 'Cues confidently detected in another language.');
  }
  if (others.length) flag('info', `Inner xml:lang tags: ${others.map(([l, n]) => `${l || '""'}×${n}`).join(', ')}`, 'Elements inside <body> that carry their own xml:lang.');

  // ---- file name
  if (r.fileLang && labelTag) {
    const f = canonical(parseTag(r.fileLang.code));
    const lt = canonical(labelTag);
    const fScript = expectedScript(f), lScript = expectedScript(lt) || expScript;
    const sameBase = f.lang === lt.lang || (f.lang === 'zh' && lt.lang === 'yue') || (f.lang === 'yue' && lt.lang === 'zh') || Detector.sameCluster(f.lang, lt.lang);
    const regionDiff = f.region && lt.region && f.region !== lt.region && !(f.region === '419' && REGION_GROUP.es && lt.lang === 'es' && lt.region !== 'ES') && !(lt.region === '419' && f.lang === 'es' && f.region !== 'ES');
    const scriptDiff = fScript && lScript && fScript !== lScript;
    if (!sameBase) flag('warn', `File name says ${langName(f.lang)} (“${r.fileLang.src}”)`, `xml:lang is “${parsed.rootLang}”.`);
    else if (regionDiff || scriptDiff) flag('warn', `File name says ${tagStr(f)} (“${r.fileLang.src}”)`, `xml:lang is “${parsed.rootLang}”.`);
  }
  return finish(r);
}
function topMarkers(g) {
  const e = Object.entries(g.counts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  return e.length ? 'e.g. ' + e.map(([w, n]) => `“${w}”×${n}`).join(', ') : '';
}
function fmtPct(p) { return p >= 10 ? Math.round(p) + '%' : p >= 1 ? p.toFixed(1).replace(/\.0$/, '') + '%' : '<1%'; }
function finish(r) {
  r.severity = r.flags.reduce((s, f) => SEV_RANK[f.sev] > SEV_RANK[s] ? f.sev : s, 'ok');
  return r;
}


// ------------------------------------------------------------ cue-level checks (shared with the player)
function countChecks(r) {
  const list = r.cueList;
  if (!list) return;
  CueCheck.finalizeQcFlags(list);
  const n = f => list.filter(f).length;
  r.checks = {
    cps: n(x => x.cpsOver),
    chars: n(x => x.charLimitExceeded),
    lines: n(x => x.lineCount >= CueCheck.LINE_COUNT_THRESHOLD),
    overlap: n(x => x.overlap),
    duration: n(x => (x.tooShort || x.tooLong) && !x.tooShortCritical),
    critical: n(x => x.tooShortCritical),
    odd: n(x => x.hasSuspiciousChars),
    mixed: n(x => x.mixedAlign),
    gaps: n(x => x.gapWarn),
    raised: n(x => x.placement && x.placement.v === 'raised'),
    side: n(x => x.placement && (x.placement.h === 'left' || x.placement.h === 'right')),
  };
}
const NAME_FPS = { '2398': 23.976, '23976': 23.976, '24': 24, '25': 25, '2997': 29.97, '29970': 29.97, '30': 30, '50': 50, '5994': 59.94, '60': 60 };
function cueChecks(r, parsed, flag) {
  // Frame rate in the name vs. the rate the file declares.
  const declared = parsed.root.getAttributeNS('http://www.w3.org/ns/ttml#parameter', 'frameRate') || [...parsed.root.attributes].find(a => a.localName === 'frameRate')?.value;
  let eff = null;
  if (declared) {
    const mult = [...parsed.root.attributes].find(a => a.localName === 'frameRateMultiplier')?.value;
    eff = Number(declared);
    if (mult) { const [a, b] = mult.trim().split(/\s+/).map(Number); if (a && b) eff = eff * a / b; }
    r.fileFps = eff;
  }
  const nameFps = r.nameInfo.fps ? NAME_FPS[r.nameInfo.fps] : null;
  r.nameFps = nameFps;
  // SCC timecode is 29.97 by convention whatever the video's rate, so that is not a mismatch.
  const sccNtsc = r.sidecar === 'SCC' && eff && Math.abs(eff - 29.97) < 0.01;
  if (nameFps && eff && !sccNtsc && Math.abs(nameFps - eff) > 0.01)
    flag('warn', `Frame rate: name says ${nameFps}, file declares ${+eff.toFixed(3)}`, `ttp:frameRate="${declared}"${r.fileFps !== Number(declared) ? ' with frameRateMultiplier' : ''}.`);

  // Encoding damage: text that went through the wrong character encoding somewhere. Either "�"
  // (characters that couldn't be decoded) or UTF-8 read as Latin-1 ("Ã©" for "é", "â€™" for "’").
  {
    const body = String(parsed.text || '').replace(/<[^>]*>/g, '');
    const repl = (body.match(/\uFFFD/g) || []).length;
    const moji = (body.match(/[ÃÂ][\u0080-\u00BF]|â€[\u0080-\u00BF™œ\u201A-\u201E\u2020-\u2022\u2026\u2030\u2039\u203A]/g) || []).length;
    r.encodingDamage = { repl, moji };
    if (repl) flag('error', `Encoding damage: ${repl} “�” character${repl === 1 ? '' : 's'}`, 'Characters that could not be decoded: the text went through the wrong encoding before this file was made.');
    if (moji) flag('error', `Encoding damage: ${moji} garbled character${moji === 1 ? '' : 's'} (like “Ã©” for “é”)`, 'UTF-8 text that was read as Latin-1 / Windows-1252 somewhere along the way.');
  }

  // Same checks as the player's filters (counted for the QC tab's limits).
  r.checks = null;
  if (typeof CueCheck === 'undefined') return;
  let list = null;
  try { list = CueCheck.parse(parsed.text); } catch (e) { list = null; }
  if (!list) return;
  CueCheck.finalizeDurationFlags(list);
  CueCheck.finalizeCharFlags(list);
  r.cueList = list;                                   // kept so a change of CPS/CPL limit can re-count
  countChecks(r);
  const c = r.checks;
  // (Per-event checks live in the QC tab; the Conform page is about names, labels and languages.)
}
