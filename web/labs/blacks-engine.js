// ------------------------------------------------------------ commercial blacks in the browser
// Same rules as the Mac app (mac/Sources/Analysis.swift, runBlacks): a frame is black when 98% of its luma samples are
// at or below 10% (video range); runs of 0.25 s or more; the sound over the middle half of a black decides: silent
// (RMS ≤ −50 dBFS, loudest channel of every audio track) = a commercial black, sound = a black inside a scene (left out).
// Black head and tail of the file are kept whatever the sound.
// The Mac decodes every frame; a page can't afford to read a 50 GB ProRes file through, so this goes the other way:
// the sound is read first (small next to the picture), the silent stretches found, and the picture looked at only
// there (every 4th frame, then the first and last black frame found exactly). Without sound, the whole picture is
// looked at every 4th frame (slow on long ProRes files).
// Needs lab-video.js (parseMovie with moov, WcDecoder, ProresDecoder, blackCheckFrame, blackCheckYuv).

// ---- audio tracks of an MP4 / MOV
function audioTracksOf(m) {
  const dv = m.moov, out = [];
  const boxes = (start, end) => {
    const r = []; let p = start;
    while (p + 8 <= end) {
      let size = dv.getUint32(p), hdr = 8;
      const type = String.fromCharCode(dv.getUint8(p + 4), dv.getUint8(p + 5), dv.getUint8(p + 6), dv.getUint8(p + 7));
      if (size === 1) { size = Number(dv.getBigUint64(p + 8)); hdr = 16; } else if (size === 0) size = end - p;
      if (size < 8 || p + size > end) break;
      r.push({ type, start: p + hdr, end: p + size }); p += size;
    }
    return r;
  };
  const child = (b, t) => b && boxes(b.start, b.end).find(x => x.type === t);
  const find = (start, end, t, depth = 0) => {   // a box anywhere below (esds sits in 'wave' in QuickTime files)
    for (const b of boxes(start, end)) { if (b.type === t) return b; if (depth < 3 && b.end - b.start > 8) { const f = find(b.start, b.end, t, depth + 1); if (f) return f; } }
    return null;
  };
  const u32 = (b, i) => dv.getUint32(b.start + i);
  for (const trak of boxes(0, dv.byteLength).filter(b => b.type === 'trak')) {
    const mdia = child(trak, 'mdia'), hdlr = child(mdia, 'hdlr'); if (!hdlr) continue;
    if (String.fromCharCode(...new Uint8Array(dv.buffer, dv.byteOffset + hdlr.start + 8, 4)) !== 'soun') continue;
    const mdhd = child(mdia, 'mdhd'), mv = dv.getUint8(mdhd.start), timescale = dv.getUint32(mdhd.start + (mv ? 20 : 12));
    const stbl = child(child(mdia, 'minf'), 'stbl'), stsd = child(stbl, 'stsd');
    const e = boxes(stsd.start + 8, stsd.end)[0]; if (!e) continue;
    const fourcc = e.type, ver = dv.getUint16(e.start + 8);
    let channels = dv.getUint16(e.start + 16), bits = dv.getUint16(e.start + 18), rate = dv.getUint32(e.start + 24) / 65536, kidsAt = e.start + 28;
    let float = false, bigEndian = true, signed = true;
    if (ver === 1) kidsAt += 16;
    if (ver === 2) {
      rate = dv.getFloat64(e.start + 32); channels = dv.getUint32(e.start + 40); bits = dv.getUint32(e.start + 48);
      const fl = dv.getUint32(e.start + 52); float = !!(fl & 1); bigEndian = !!(fl & 2); signed = !!(fl & 4) || float; kidsAt = e.start + 64;
    }
    const enda = find(kidsAt, e.end, 'enda');
    const littleFlag = enda ? dv.getUint16(enda.start) === 1 : false;
    let pcm = true;
    if (fourcc === 'sowt') { bits = 16; bigEndian = false; }
    else if (fourcc === 'twos') { bigEndian = true; if (bits !== 8) bits = 16; }
    else if (fourcc === 'in24') { bits = 24; bigEndian = !littleFlag; }
    else if (fourcc === 'in32') { bits = 32; bigEndian = !littleFlag; }
    else if (fourcc === 'fl32' || fourcc === 'fl64') { bits = fourcc === 'fl32' ? 32 : 64; float = true; bigEndian = !littleFlag; }
    else if (fourcc === 'raw ') { bits = 8; signed = false; }
    else if (fourcc === 'lpcm') { /* version 2 fields above */ }
    else if (fourcc === 'ipcm' || fourcc === 'fpcm') {
      const pc = find(kidsAt, e.end, 'pcmC'); if (pc) { bigEndian = !(dv.getUint8(pc.start + 4) & 1); bits = dv.getUint8(pc.start + 5); }
      float = fourcc === 'fpcm';
    } else pcm = false;
    // sample table: chunks (PCM: a sample is one audio frame) or packets (AAC)
    const stsz = child(stbl, 'stsz'), fixed = u32(stsz, 4), count = u32(stsz, 8);
    const stco = child(stbl, 'stco'), co64 = child(stbl, 'co64'), chunks = [];
    if (stco) { for (let i = 0, n = u32(stco, 4); i < n; i++) chunks.push(u32(stco, 8 + 4 * i)); }
    else if (co64) { for (let i = 0, n = u32(co64, 4); i < n; i++) chunks.push(Number(dv.getBigUint64(co64.start + 8 + 8 * i))); }
    const stsc = child(stbl, 'stsc'), sc = [];
    for (let i = 0, n = u32(stsc, 4); i < n; i++) sc.push([u32(stsc, 8 + 12 * i), u32(stsc, 12 + 12 * i)]);
    const perChunk = ci => { let per = 0; for (const [first, n] of sc) if (first <= ci + 1) per = n; return per; };
    if (pcm) {
      if (![8, 16, 24, 32, 64].includes(bits) || !channels || !rate) continue;
      const bpf = channels * bits / 8;
      out.push({ kind: 'pcm', fourcc, channels, rate, bits, float, bigEndian, signed, bpf, chunks: chunks.map((o, ci) => ({ off: o, frames: perChunk(ci) })) });
    } else if (fourcc === 'mp4a') {
      const esds = find(kidsAt, e.end, 'esds'); if (!esds) continue;
      // ES_Descriptor (3) > DecoderConfigDescriptor (4) > DecoderSpecificInfo (5) = AudioSpecificConfig
      let p = esds.start + 4, asc = null;
      const len = () => { let n = 0; for (let k = 0; k < 4; k++) { const b = dv.getUint8(p++); n = (n << 7) | (b & 127); if (!(b & 128)) break; } return n; };
      while (p < esds.end && !asc) {
        const tag = dv.getUint8(p++), n = len();
        if (tag === 3) { const fl = dv.getUint8(p + 2); p += 3 + (fl & 128 ? 2 : 0) + (fl & 64 ? 1 + dv.getUint8(p + 3) : 0) + (fl & 32 ? 2 : 0); }
        else if (tag === 4) p += 13;
        else if (tag === 5) asc = new Uint8Array(dv.buffer.slice(dv.byteOffset + p, dv.byteOffset + p + n));
        else p += n;
      }
      if (!asc) continue;
      const size = new Uint32Array(count), offset = new Float64Array(count);
      for (let i = 0; i < count; i++) size[i] = fixed || u32(stsz, 12 + 4 * i);
      let s = 0;
      for (let ci = 0; ci < chunks.length && s < count; ci++) { let o = chunks[ci]; for (let k = 0, per = perChunk(ci); k < per && s < count; k++) { offset[s] = o; o += size[s]; s++; } }
      const aot = asc[0] >> 3;
      out.push({ kind: 'aac', fourcc, channels, rate, timescale, codec: 'mp4a.40.' + (aot || 2), asc, count, size, offset });
    }
  }
  return out;
}

// ---- sound levels: mean square of the loudest channel in 20 ms windows, every audio track (the loudest wins)
const LEVEL_WIN = 0.02;
async function soundLevels(m, tracks, onPart, stopped) {
  const n = Math.ceil(m.duration / LEVEL_WIN) + 2, level = new Float32Array(n);
  let done = 0; const total = tracks.length;
  for (const tr of tracks) {
    const W = tr.rate * LEVEL_WIN, sums = Array.from({ length: tr.channels }, () => new Float64Array(n)), cnt = new Uint32Array(n);
    const add = (frame, ch, v) => { const w = Math.floor(frame / W); if (w < n) { sums[ch][w] += v * v; if (ch === 0) cnt[w]++; } };
    if (tr.kind === 'pcm') {
      const by = tr.bits / 8, max = tr.float ? 1 : 2 ** (tr.bits - 1), le = !tr.bigEndian;
      let frame0 = 0, ci = 0;
      for (const c of tr.chunks) {
        if (stopped()) throw new Error('stopped');
        if (c.frames) {
          const buf = new DataView(await readRange(m.file, c.off, c.off + c.frames * tr.bpf));
          const nf = Math.floor(buf.byteLength / tr.bpf);
          for (let f = 0; f < nf; f += 4) {   // every 4th frame: plenty for a level
            const o = f * tr.bpf;
            for (let ch = 0; ch < tr.channels; ch++) {
              const q = o + ch * by; let v;
              if (tr.float) v = by === 4 ? buf.getFloat32(q, le) : buf.getFloat64(q, le);
              else if (by === 2) v = buf.getInt16(q, le) / max;
              else if (by === 3) { const b0 = buf.getUint8(q), b1 = buf.getUint8(q + 1), b2 = buf.getUint8(q + 2); let x = le ? (b2 << 16) | (b1 << 8) | b0 : (b0 << 16) | (b1 << 8) | b2; if (x & 0x800000) x -= 0x1000000; v = x / max; }
              else if (by === 4) v = buf.getInt32(q, le) / max;
              else v = tr.signed ? buf.getInt8(q) / 128 : (buf.getUint8(q) - 128) / 128;
              add(frame0 + f, ch, v);
            }
          }
          frame0 += c.frames;
        }
        if (++ci % 50 === 0) onPart((done + ci / tr.chunks.length) / total);
      }
    } else {
      let decErr = null, step = 0;
      const dec = new AudioDecoder({ output: a => {
        const f0 = Math.round(a.timestamp / 1e6 * tr.rate), nf = a.numberOfFrames, ch = Math.min(a.numberOfChannels, tr.channels);
        const tmp = new Float32Array(nf);
        for (let c = 0; c < ch; c++) { a.copyTo(tmp, { planeIndex: c, format: 'f32-planar' }); for (let f = 0; f < nf; f += 4) add(f0 + f, c, tmp[f]); }
        a.close();
      }, error: e => { decErr = e; } });
      dec.configure({ codec: tr.codec, sampleRate: tr.rate, numberOfChannels: tr.channels, description: tr.asc });
      const SPF = 1024;   // AAC frames per packet
      for (let i = 0; i < tr.count;) {
        if (stopped()) { dec.close(); throw new Error('stopped'); }
        // read a run of packets that sit together in the file
        let j = i, end = tr.offset[i] + tr.size[i];
        while (j + 1 < tr.count && tr.offset[j + 1] === end && end - tr.offset[i] < 4 * 1048576) { j++; end += tr.size[j]; }
        const buf = await readRange(m.file, tr.offset[i], end);
        for (let k = i; k <= j; k++) dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(k * SPF / tr.rate * 1e6), data: new Uint8Array(buf, tr.offset[k] - tr.offset[i], tr.size[k]) }));
        if (dec.decodeQueueSize > 64) await dec.flush();
        if (decErr) throw decErr;
        i = j + 1;
        if (++step % 20 === 0) onPart((done + i / tr.count) / total);
      }
      await dec.flush(); dec.close();
      if (decErr) throw decErr;
    }
    for (let w = 0; w < n; w++) if (cnt[w]) { let mx = 0; for (let c = 0; c < tr.channels; c++) mx = Math.max(mx, sums[c][w] / cnt[w]); level[w] = Math.max(level[w], mx); }
    done++;
  }
  return level;
}
const toDb = ms => ms > 0 ? 10 * Math.log10(ms) : -120;

// ---- the blacks
async function findBlacks(file, o = {}) {
  const S = Object.assign({ pixelLevel: 0.10, pictureShare: 0.98, minSeconds: 0.25, silenceDb: -50 }, o.settings || {});
  const status = o.onStatus || (() => {}), stopped = o.stopped || (() => false);
  const T0 = now();
  const m = await parseMovie(file);
  const dec = m.kind === 'prores' ? new ProresDecoder(m) : (m.kind === 'h264' || m.kind === 'hevc') ? new WcDecoder(m) : null;
  if (!dec) throw new Error(`This video can't be read here (${m.fourcc})`);
  await dec.open();
  try {
    const pts = m.order.map(s => (m.cts[s] - m.mediaTime) / m.timescale), N = pts.length;
    const fd = 1 / (m.fps || 24), end = m.duration;
    const posAt = t => { let lo = 0, hi = N - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (pts[mid] <= t + 1e-6) lo = mid; else hi = mid - 1; } return lo; };
    // 1. the sound
    const tracks = audioTracksOf(m);
    let level = null;
    if (tracks.length) {
      status('reading the sound', 0);
      try { level = await soundLevels(m, tracks, p => status(`reading the sound: ${Math.round(p * 100)}%`, 0.5 * p), stopped); }
      catch (e) { if (String(e && e.message) === 'stopped') throw e; log('sound not readable: ' + (e && e.message)); level = null; }
    }
    const levelDb = (a, b) => {   // RMS over a stretch, in dBFS
      if (!level || b <= a) return null;
      let s = 0, k = 0; for (let w = Math.floor(a / LEVEL_WIN); w <= Math.floor(b / LEVEL_WIN) && w < level.length; w++) { s += level[w]; k++; }
      return k ? toDb(s / k) : null;
    };
    // 2. where to look: silent stretches (a little looser than the rule: the black is judged on its own below)
    let spans = [];
    if (level) {
      const lim = 10 ** ((S.silenceDb + 5) / 10);
      for (let w = 0; w < level.length;) {
        if (level[w] > lim) { w++; continue; }
        let v = w; while (v + 1 < level.length && (level[v + 1] <= lim || (v + 2 < level.length && level[v + 2] <= lim))) v++;
        const a = w * LEVEL_WIN, b = (v + 1) * LEVEL_WIN;
        if (b - a >= S.minSeconds * 0.8) spans.push([Math.max(0, a - 0.25), Math.min(end, b + 0.25)]);
        w = v + 1;
      }
    } else spans = [[0, end]];
    spans.push([0, Math.min(end, 0.5)], [Math.max(0, end - 0.5), end]);   // head and tail, whatever the sound
    spans.sort((x, y) => x[0] - y[0]);
    // 3. the picture there
    const cache = new Map(); let checked = 0;
    const black = async p => {
      if (p < 0 || p >= N) return false;
      if (cache.has(p)) return cache.get(p);
      if (stopped()) throw new Error('stopped');
      const r = await dec.frameAt(p);
      let b = false;
      if (r.frame) {
        if (r.frame.kind === 'yuv') b = blackCheckYuv(r.frame).black;
        else { b = (await blackCheckFrame(r.frame)).black; r.frame.close(); }
      }
      checked++; cache.set(p, b); return b;
    };
    const STEP = 4, runs = [];
    const edge = async (p, dir) => {   // the last black frame going this way from black frame p
      let q = p, cap = Math.round(30 / fd);
      while (cap-- > 0) { const nx = q + dir * STEP; if (nx < 0 || nx >= N) { q = dir > 0 ? N - 1 : 0; while (!(await black(q))) q -= dir; return q; } if (!(await black(nx))) { let lo = q, hi = nx; while (Math.abs(hi - lo) > 1) { const mid = (lo + hi) >> 1; if (await black(mid)) lo = mid; else hi = mid; } return lo; } q = nx; }
      return q;
    };
    const totalLen = spans.reduce((s, x) => s + x[1] - x[0], 0); let doneLen = 0;
    for (const [a, b] of spans) {
      let p = posAt(a);
      const pe = posAt(b);
      while (p <= pe) {
        if (runs.length && p <= runs[runs.length - 1].last) { p = runs[runs.length - 1].last + 1; continue; }
        if (await black(p)) {
          const first = await edge(p, -1), last = await edge(p, 1);
          runs.push({ first, last }); p = last + 1;
        } else p += STEP;
      }
      doneLen += b - a;
      status(`looking at the picture: ${runs.length} black${runs.length === 1 ? '' : 's'} so far`, 0.5 + 0.5 * Math.min(1, doneLen / Math.max(1, totalLen)));
    }
    // 4. what each black is
    runs.sort((x, y) => x.first - y.first);
    const items = [], r3 = x => Math.round(x * 1000) / 1000;
    for (const r of runs) {
      const tin = pts[r.first], tout = r.last + 1 < N ? pts[r.last + 1] : Math.max(pts[r.last] + fd, end);
      if (tout - tin < S.minSeconds - 0.0005) continue;
      const it = { in: r3(tin), out: r3(tout), frames: r.last - r.first + 1 };
      let audio = 'none';
      if (level) {
        const len = tout - tin, pad = len > fd * 4 ? len / 4 : Math.min(fd, len / 4), db = levelDb(tin + pad, tout - pad);
        if (db != null) { it.level = Math.round(db * 10) / 10; audio = db <= S.silenceDb ? 'silent' : 'sound'; }
      }
      it.audio = audio;
      if (r.first === 0) it.kind = 'start';
      else if (tout >= end - fd * 1.5) it.kind = 'end';
      else if (audio === 'sound') continue;   // a black inside a scene (the sound carries on): not a break
      else it.kind = 'commercial';
      items.push(it);
    }
    status('done', 1);
    return { items, frameCount: N, checked, fps: r3(m.fps), seconds: Math.round((now() - T0) / 100) / 10, sound: tracks.length ? tracks.map(t => t.kind === 'pcm' ? `PCM ${t.bits}-bit ${t.channels} ch` : `AAC ${t.channels} ch`).join(', ') : 'none' };
  } finally { try { dec.close(); } catch (e) { /* closed */ } }
}
