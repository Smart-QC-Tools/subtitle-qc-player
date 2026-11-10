/* ==========================================================================
   File-name parsing and video <-> subtitle matching.
   Works on names only. Signals, strongest first:
     1. production code shared by both names (T8801, 8GD01)
     2. season / episode numbers (S4E1, Season 1 Episode 1, YR04)
     3. episode title (fuzzy: case, separators, CamelCase, roman numerals,
        "The" moved to the end, small typos)
     4. show title (tie-breaker)
   ========================================================================== */
const Match = (() => {
  const ARTICLES = new Set(['the', 'a', 'an']);
  const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
  const PART_WORDS = new Set(['part', 'pt', 'chapter', 'chap', 'vol', 'volume', 'book']);
  const VENDOR = new Set(['amzn', 'giant', 'nbcu', 'nbc', 'wbd', 'hbo', 'netflix', 'nflx', 'dsny', 'apple']);
  const ORDINALS = new Set(['first','second','third','fourth','fifth','sixth','seventh','eighth','ninth','tenth','eleventh','twelfth']);
  // Tokens that end an episode title (technical info that follows it).
  const STOP = new Set(['episode','ep','hd','uhd','sd','hdr','sdr','stereo','mono','full','forced','stream','fn','cc','sdh','textless','proxy','final','subs','subtitles','captions','feature','trailer','dub','dubbed','v1','eng']);
  const isStop = (t) =>
    STOP.has(t) || /^\d{5,}$/.test(t) || /^\d+x\d+$/.test(t) || /^e\d{5,}$/.test(t) ||
    /^(2398|2997|5994|23976|29970|59940|25|24|30|50|60|178|185|239|16x9|4x3)$/.test(t) ||
    /^\d+ch$/.test(t) || /^v\d+$/.test(t) || /^r\d+$/.test(t) || /^hr\d$/.test(t) || /^s\d$/.test(t) ||
    /^(1080|2160|720|480)[pi]?$/.test(t) || /^(h264|h265|hevc|avc|prores|mp4|mov)$/.test(t);

  // Raw tokens (keep original case for CamelCase splitting).
  function rawTokens(name) {
    const stem = name.replace(/\.(mp4|mov|m4v|itt|ttml|dfxp|xml|imsc|imscr|scc|srt)$/i, '');
    return stem.replace(/['’`´]/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  }
  // Split CamelCase and letter/digit boundaries: "20HoursinAmerica" -> 20 Hoursin America
  function splitCamel(t) {
    return t.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2').replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
            .replace(/(\p{L})(\p{N})/gu, '$1 $2').replace(/(\p{N})(\p{L})/gu, '$1 $2').split(' ');
  }
  // Words of a title: lower-case, CamelCase split, roman numerals after "part" -> digits, articles dropped at the ends.
  function titleWords(toks) {
    let w = [];
    for (const t of toks) w.push(...splitCamel(t).map(x => x.toLowerCase()));
    w = w.filter(Boolean).map((x, i, a) => (ROMAN[x] && i > 0 && PART_WORDS.has(a[i - 1])) ? String(ROMAN[x]) : x);
    while (w.length && ARTICLES.has(w[0])) w.shift();
    while (w.length && ARTICLES.has(w[w.length - 1])) w.pop();
    return w;
  }
  // Article that was moved/stripped: "THE_ORIGINALS" or "ORIGINALS_THE" / "Originals, The" -> 'the'
  function articleOf(toks) {
    const w = [];
    for (const t of toks) w.push(...splitCamel(t).map(x => x.toLowerCase()));
    const f = w.filter(Boolean);
    if (f.length > 1 && ARTICLES.has(f[0])) return f[0];
    if (f.length > 1 && ARTICLES.has(f[f.length - 1])) return f[f.length - 1];
    return null;
  }
  const squash = w => w.join('');

  const isProdCode = t => /^[A-Za-z0-9]{4,8}$/.test(t) && /\d/.test(t) && /[A-Za-z]/.test(t) &&
    !/^s\d+e\d+$/i.test(t) && !/^yr\d+$/i.test(t) && !/^e\d+$/i.test(t) && !/^\d+x\d+$/i.test(t) &&
    !/^\d+ch$/i.test(t) && !/^(hr|v|r|s)\d+$/i.test(t) && !/^\d{3,4}[pi]$/i.test(t) && !/^(h264|h265|x264|x265)$/i.test(t) &&
    !/^\d+(st|nd|rd|th)$/i.test(t) && (t === t.toUpperCase() || /^[A-Z]\d+$/.test(t));

  function parse(name) {
    const toks = rawTokens(name);
    const lo = toks.map(t => t.toLowerCase());
    const info = { name, season: null, episode: null, codes: [], showWords: [], titleWords: [], anchor: null };
    for (const t of toks) if (isProdCode(t)) info.codes.push(t.toUpperCase());

    // ---- find the season/episode anchor
    let start = -1, end = -1;
    for (let i = 0; i < lo.length && start < 0; i++) {
      let m;
      if ((m = lo[i].match(/^s(\d{1,2})e(\d{1,3})$/))) { info.season = +m[1]; info.episode = +m[2]; start = i; end = i + 1; info.anchor = toks[i]; }
      else if ((m = lo[i].match(/^(\d{1,2})x(\d{2,3})$/)) && +m[1] < 40) { info.season = +m[1]; info.episode = +m[2]; start = i; end = i + 1; info.anchor = toks[i]; }
      else if (lo[i] === 'season' && /^\d+$/.test(lo[i + 1] || '')) {
        info.season = +lo[i + 1]; start = i; end = i + 2;
        if (/^(episode|ep)$/.test(lo[i + 2] || '') && /^\d+$/.test(lo[i + 3] || '')) { info.episode = +lo[i + 3]; end = i + 4; }
        info.anchor = toks.slice(start, end).join(' ');
      } else if ((m = lo[i].match(/^yr(\d{1,2})$/))) {
        info.season = +m[1]; start = i; end = i + 1;
        // Amazon: YR04_02_03 -> air-year span follows the season
        if (/^\d{2}$/.test(lo[i + 1] || '') && /^\d{2}$/.test(lo[i + 2] || '')) end = i + 3;
        info.anchor = toks.slice(start, end).join('_');
      } else if ((m = lo[i].match(/^(?:ep|e)(\d{1,3})$/)) && i > 0) { info.episode = +m[1]; start = i; end = i + 1; info.anchor = toks[i]; }
      else if (/^(episode|ep)$/.test(lo[i]) && /^\d{1,3}$/.test(lo[i + 1] || '') && i > 0) { info.episode = +lo[i + 1]; start = i; end = i + 2; info.anchor = toks.slice(i, i + 2).join(' '); }
    }

    // A season written on its own (Warehouse13_S4_T7701, Show_Season2_EP03, Show_S2_E3, Series 2,
    // Season Two, Saison 2 …): before an episode marker, or early in the name, right after the show.
    if (info.season == null) {
      const limit = start >= 0 ? start : Math.min(lo.length, 6);
      for (let i = 1; i < limit; i++) {
        const sa = seasonAt(lo, i);
        if (sa && sa[0] > 0) {
          info.season = sa[0];
          if (start < 0) { end = i + sa[1]; info.anchor = toks.slice(i, i + sa[1]).join('_'); }
          start = i;
          break;
        }
      }
    }

    if (start >= 0) {
      // show = before anchor, minus vendor prefix and "The Complete Nth Season"
      let show = toks.slice(0, start);
      const cIdx = show.findIndex((t, i) => t.toLowerCase() === 'complete' && i > 0);
      if (cIdx > 0) show = show.slice(0, show[cIdx - 1].toLowerCase() === 'the' ? cIdx - 1 : cIdx);
      const showToks = show.filter(t => !VENDOR.has(t.toLowerCase()) && !ORDINALS.has(t.toLowerCase()) && t.toLowerCase() !== 'season');
      info.showWords = titleWords(showToks); info.showArticle = articleOf(showToks);
      // title = after anchor until technical info
      const t = [];
      for (let i = end; i < toks.length; i++) { if (isStop(lo[i]) || isLanguageWord(lo[i]) || isLangTag(toks, lo, i)) break; if (!isProdCode(toks[i])) t.push(toks[i]); }
      info.titleWords = titleWords(t); info.titleArticle = articleOf(t);
    } else {
      // No anchor (e.g. nbcu_Warehouse13_T8801_...): show = tokens before the first code / technical token.
      const show = [];
      for (let i = 0; i < toks.length; i++) {
        if (VENDOR.has(lo[i]) && show.length === 0) continue;
        if (isProdCode(toks[i]) || isStop(lo[i])) break;
        show.push(toks[i]);
      }
      info.showWords = titleWords(show); info.showArticle = articleOf(show);
    }
    info.type = subtitleType(lo);
    info.fps = (lo.find(t => /^(2398|23976|2997|29970|25|24|30|5994|50|60)$/.test(t)) || null);
    return info;
  }

  // Language tag at the tail of a name: "_en-US", "_es-419", "_zh-Hans", "_FR" (only when nothing but
  // technical tokens follow, so title words like "It" or "No" are left alone).
  const LANG_BASES = new Set(typeof REFERENCE_LIST !== 'undefined' ? REFERENCE_LIST.map(r => r[1].split('-')[0].toLowerCase()) : []);
  const isRegion = (raw) => /^([A-Z]{2}|\d{3}|Hans|Hant|Latn|Cyrl|HANS|HANT)$/.test(raw);
  function isLangTag(toks, lo, i) {
    if (!LANG_BASES.has(lo[i])) return false;
    let j = i + 1;
    if (j < toks.length && isRegion(toks[j])) j++;
    else if (j < toks.length) return false;
    for (; j < toks.length; j++) if (!isStop(lo[j]) && !isLanguageWord(lo[j]) && !LANG_BASES.has(lo[j]) && !isRegion(toks[j])) return false;
    return true;
  }

  // "s2", "se02", "season2", "series2" … or a season word followed by a number ("season 2", "series two").
  const SEASON_WORDS = 'season|series|saison|staffel|temporada|stagione|seizoen|sezon|sezona|sasong|säsong|sæson|sesong|kausi';
  const SEASON_TOKEN = new RegExp('^(?:s|se|' + SEASON_WORDS + ')(\\d{1,2})$');
  const SEASON_WORD = new RegExp('^(?:' + SEASON_WORDS + ')$');
  const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
  function seasonAt(lo, i) {
    const m = lo[i].match(SEASON_TOKEN);
    if (m) return [+m[1], 1];
    if (SEASON_WORD.test(lo[i]) && i + 1 < lo.length) {
      const n = lo[i + 1];
      if (/^\d{1,2}$/.test(n)) return [+n, 2];
      if (NUM_WORDS[n]) return [NUM_WORDS[n], 2];
    }
    return null;
  }
  // Season named anywhere in a text such as a folder name ("Season_02", "S2", "YR02", "S02E01").
  function seasonFromText(text) {
    const lo = String(text || '').split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(t => t.toLowerCase());
    for (let i = 0; i < lo.length; i++) {
      let m;
      if ((m = lo[i].match(/^s(\d{1,2})e\d{1,3}$/)) || (m = lo[i].match(/^yr(\d{1,2})$/))) return +m[1];
      const sa = seasonAt(lo, i);
      if (sa) return sa[0];
    }
    return null;
  }

  function isLanguageWord(t) {
    if (typeof VENDOR_LANG_CODES !== 'undefined' && VENDOR_LANG_CODES[t] && VENDOR_LANG_CODES[t].strong) return true;
    return typeof NAME_MAP !== 'undefined' ? !!NAME_MAP[t] : false;
  }

  function subtitleType(lo) {
    if (lo.includes('forced') || lo.includes('fn') || lo.includes('fpn')) return 'Forced';
    if (lo.includes('cc') || lo.includes('sdh')) return 'CC';
    if (lo.includes('full')) return 'Full';
    return null;
  }

  // Sørensen–Dice on character bigrams.
  function dice(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const m = new Map();
    for (let i = 0; i < a.length - 1; i++) { const g = a.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); }
    let hit = 0;
    for (let i = 0; i < b.length - 1; i++) { const g = b.slice(i, i + 2); const c = m.get(g); if (c) { hit++; m.set(g, c - 1); } }
    return (2 * hit) / (a.length + b.length - 2);
  }

  // Score a subtitle against a video. Returns {score, reasons[], reject}
  function score(v, s) {
    const reasons = [];
    let sc = 0;
    const sharedCode = v.codes.find(c => s.codes.includes(c));
    if (sharedCode) { sc += 100; reasons.push(`code ${sharedCode}`); }
    // With the same production code it is the same episode, so a different season / episode number
    // in the name is a naming mistake to report, not a reason to keep the files apart.
    let conflict = null;
    if (v.season != null && s.season != null) {
      if (v.season !== s.season) {
        if (!sharedCode) return { score: -100, reasons: [`season ${v.season} ≠ ${s.season}`], reject: true };
        conflict = Object.assign(conflict || {}, { season: [v.season, s.season] });
      } else { sc += 10; reasons.push(`season ${v.season}`); }
    }
    if (v.episode != null && s.episode != null) {
      if (v.episode !== s.episode) {
        if (!sharedCode) return { score: -100, reasons: [`episode ${v.episode} ≠ ${s.episode}`], reject: true };
        conflict = Object.assign(conflict || {}, { episode: [v.episode, s.episode] });
      } else { sc += 30; reasons.push(`episode ${v.episode}`); }
    }
    const tv = squash(v.titleWords), ts = squash(s.titleWords);
    if (tv.length >= 3 && ts.length >= 3) {
      const d = dice(tv, ts);
      if (d >= 0.8) { sc += 60 * d; reasons.push('title'); }
      else if (d >= 0.6) { sc += 30 * d; reasons.push('title ~'); }
      else if (d < 0.4) sc -= 15;
    }
    const sv = squash(v.showWords), ss = squash(s.showWords);
    if (sv.length >= 3 && ss.length >= 3) {
      const d = Math.max(dice(sv, ss), sv.includes(ss) || ss.includes(sv) ? 0.9 : 0);
      if (d >= 0.7) { sc += 10 * d; if (!reasons.length) reasons.push('show'); }
      else if (d < 0.35) { sc -= 25; }
    }
    if (!sharedCode && v.codes.length && s.codes.length && sv && ss && dice(sv, ss) > 0.7) {
      // Same show, both carry production codes, but they differ -> different episode.
      return { score: -100, reasons: [`code ${v.codes[0]} ≠ ${s.codes[0]}`], reject: true };
    }
    return conflict ? { score: sc, reasons, conflict } : { score: sc, reasons };
  }

  const MATCH_THRESHOLD = 50;

  // Episode identity for grouping subtitle files when no video is involved.
  function episodeKey(p) {
    if (p.codes.length) return 'code:' + p.codes[0];
    const t = squash(p.titleWords);
    if (!t && p.season == null && p.episode == null) return null;
    return ['ep', squash(p.showWords), p.season ?? '', p.episode ?? '', t].join('|');
  }
  const SMALL = new Set(['a','an','the','and','or','nor','but','of','in','on','at','to','for','with','from','by','vs','as']);
  const cap = w => w.map((x, i) => /^\d+$/.test(x) ? x : (i > 0 && SMALL.has(x)) ? x : x[0].toUpperCase() + x.slice(1)).join(' ');
  const withArticle = (a, w) => w.length ? (a ? a[0].toUpperCase() + a.slice(1) + ' ' : '') + cap(w) : '';
  const showName = p => withArticle(p.showArticle, p.showWords);
  // opts.omitShow / opts.omitSeason drop parts shared by every file in the list.
  function episodeTitle(p, opts = {}) {
    const show = opts.omitShow ? '' : showName(p);
    const se = (p.season != null && !opts.omitSeason) ? `S${p.season}` + (p.episode != null ? `E${p.episode}` : '') : (p.episode != null ? `E${p.episode}` : '');
    const parts = [show, se, withArticle(p.titleArticle, p.titleWords)].filter(Boolean);
    if (p.codes.length && !p.titleWords.length) parts.push(p.codes[0]);
    return parts.join(' · ') || p.name;
  }

  // Show/season shared by every info in the list (for a header).
  function common(infos) {
    if (infos.length < 2) return null;
    const k = squash(infos[0].showWords);
    if (!k || !infos.every(i => squash(i.showWords) === k)) return null;
    const art = infos.map(i => i.showArticle).find(Boolean) || null;
    const season = infos[0].season;
    const sameSeason = season != null && infos.every(i => i.season === season);
    return { show: withArticle(art, infos[0].showWords), season: sameSeason ? season : null,
             label: withArticle(art, infos[0].showWords) + (sameSeason ? ` · Season ${season}` : ''), opts: { omitShow: true, omitSeason: sameSeason } };
  }
  return { seasonFromText, common, showName, titleCase: cap, parse, score, MATCH_THRESHOLD, episodeKey, episodeTitle, dice };
})();
if (typeof module !== 'undefined') module.exports = Match;
