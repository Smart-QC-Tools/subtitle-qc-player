// Shared by the lab pages (inlined by build_lab.py): reading MP4 / MOV files by byte range, and decoding single
// frames (WebCodecs for H.264 / HEVC, the ProRes decoder in WebAssembly for ProRes).
// Needs from the page: PRORES_WASM_B64, log(), now(), fmtMs().
// ------------------------------------------------------------ reading the file (by byte range)
let bytesRead = 0, readMs = 0, readCount = 0;
async function readRange(file, start, end) {
  const t = now();
  const buf = await file.slice(start, end).arrayBuffer();
  readMs += now() - t; bytesRead += buf.byteLength; readCount++;
  return buf;
}

// ------------------------------------------------------------ MP4 / MOV sample tables
async function parseMovie(file) {
  // top-level boxes: find moov (at the start or the end of the file)
  let off = 0, moov = null;
  while (off < file.size) {
    const h = new DataView(await readRange(file, off, Math.min(file.size, off + 16)));
    let size = h.getUint32(0), type = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7)), hdr = 8;
    if (size === 1) { size = Number(h.getBigUint64(8)); hdr = 16; } else if (size === 0) size = file.size - off;
    if (size < 8) throw new Error('Damaged file (box size)');
    if (type === 'moov') { moov = new DataView(await readRange(file, off + hdr, off + size)); break; }
    off += size;
  }
  if (!moov) throw new Error('No moov box: not an MP4 / MOV file, or not finished');
  const boxes = (dv, start, end) => {
    const out = []; let p = start;
    while (p + 8 <= end) {
      let size = dv.getUint32(p), hdr = 8;
      const type = String.fromCharCode(dv.getUint8(p + 4), dv.getUint8(p + 5), dv.getUint8(p + 6), dv.getUint8(p + 7));
      if (size === 1) { size = Number(dv.getBigUint64(p + 8)); hdr = 16; } else if (size === 0) size = end - p;
      if (size < 8) break;
      out.push({ type, start: p + hdr, end: p + size, box: p });
      p += size;
    }
    return out;
  };
  const child = (dv, b, t) => boxes(dv, b.start, b.end).find(x => x.type === t);
  const path = (dv, b, ...ts) => { for (const t of ts) { b = b && child(dv, b, t); } return b; };
  const dv = moov;
  const top = { start: 0, end: dv.byteLength };
  for (const trak of boxes(dv, 0, dv.byteLength).filter(b => b.type === 'trak')) {
    const mdia = child(dv, trak, 'mdia'); if (!mdia) continue;
    const hdlr = child(dv, mdia, 'hdlr'); if (!hdlr) continue;
    const handler = String.fromCharCode(...new Uint8Array(dv.buffer, dv.byteOffset + hdlr.start + 8, 4));
    if (handler !== 'vide') continue;
    const mdhd = child(dv, mdia, 'mdhd'), v = dv.getUint8(mdhd.start);
    const timescale = dv.getUint32(mdhd.start + (v ? 20 : 12));
    const mDuration = v ? Number(dv.getBigUint64(mdhd.start + 24)) : dv.getUint32(mdhd.start + 16);
    let mediaTime = 0;
    const elst = path(dv, trak, 'edts', 'elst');
    if (elst) { const ev = dv.getUint8(elst.start), n = dv.getUint32(elst.start + 4); if (n) mediaTime = ev ? Number(dv.getBigInt64(elst.start + 16)) : dv.getInt32(elst.start + 12); if (mediaTime < 0) mediaTime = 0; }
    const stbl = path(dv, mdia, 'minf', 'stbl');
    const stsd = child(dv, stbl, 'stsd');
    const entry = boxes(dv, stsd.start + 8, stsd.end)[0];
    const fourcc = entry.type;
    const width = dv.getUint16(entry.start + 24), height = dv.getUint16(entry.start + 26);
    let description = null, codec = null, kind = 'other';
    const kids = boxes(dv, entry.start + 78, entry.end);
    const cfg = kids.find(k => k.type === 'avcC' || k.type === 'hvcC');
    if (cfg) description = new Uint8Array(dv.buffer.slice(dv.byteOffset + cfg.start, dv.byteOffset + cfg.end));
    if (fourcc === 'avc1' || fourcc === 'avc3') {
      kind = 'h264';
      codec = description ? 'avc1.' + [1, 2, 3].map(i => description[i].toString(16).padStart(2, '0')).join('') : 'avc1.640028';
    } else if (fourcc === 'hvc1' || fourcc === 'hev1') {
      kind = 'hevc'; codec = description ? hevcCodecString(fourcc, description) : fourcc + '.1.6.L120.B0';
    } else if (/^ap(ch|cn|cs|co|4h|4x)$/.test(fourcc)) kind = 'prores';
    // sample table
    const u32 = (b, i) => dv.getUint32(b.start + i);
    const stsz = child(dv, stbl, 'stsz'), fixed = u32(stsz, 4), count = u32(stsz, 8);
    const size = new Uint32Array(count);
    for (let i = 0; i < count; i++) size[i] = fixed || u32(stsz, 12 + 4 * i);
    const stco = child(dv, stbl, 'stco'), co64 = child(dv, stbl, 'co64');
    const chunks = [];
    if (stco) { const n = u32(stco, 4); for (let i = 0; i < n; i++) chunks.push(u32(stco, 8 + 4 * i)); }
    else { const n = u32(co64, 4); for (let i = 0; i < n; i++) chunks.push(Number(dv.getBigUint64(co64.start + 8 + 8 * i))); }
    const stsc = child(dv, stbl, 'stsc'), scn = u32(stsc, 4), sc = [];
    for (let i = 0; i < scn; i++) sc.push([u32(stsc, 8 + 12 * i), u32(stsc, 12 + 12 * i)]);
    const offset = new Float64Array(count);
    let s = 0;
    for (let ci = 0; ci < chunks.length && s < count; ci++) {
      let per = 0; for (const [first, n] of sc) if (first <= ci + 1) per = n;
      let o = chunks[ci];
      for (let k = 0; k < per && s < count; k++) { offset[s] = o; o += size[s]; s++; }
    }
    const dts = new Float64Array(count), cts = new Float64Array(count);
    const stts = child(dv, stbl, 'stts'); let t = 0, si = 0;
    for (let i = 0, n = u32(stts, 4); i < n; i++) { const c = u32(stts, 8 + 8 * i), d = u32(stts, 12 + 8 * i); for (let k = 0; k < c && si < count; k++) { dts[si++] = t; t += d; } }
    cts.set(dts);
    const ctts = child(dv, stbl, 'ctts');
    if (ctts) { const cv = dv.getUint8(ctts.start); si = 0; for (let i = 0, n = u32(ctts, 4); i < n; i++) { const c = u32(ctts, 8 + 8 * i), o = cv ? dv.getInt32(ctts.start + 12 + 8 * i) : u32(ctts, 12 + 8 * i); for (let k = 0; k < c && si < count; k++) cts[si] = dts[si++] + o; } }
    const key = new Uint8Array(count);
    const stss = child(dv, stbl, 'stss');
    if (stss) { for (let i = 0, n = u32(stss, 4); i < n; i++) key[u32(stss, 8 + 4 * i) - 1] = 1; } else key.fill(1);
    // display order
    const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => cts[a] - cts[b]);
    const keyCount = key.reduce((a, b) => a + b, 0);
    return { file, kind, fourcc, codec, description, width, height, timescale, mediaTime, count, size, offset, dts, cts, key, order,
      duration: mDuration / timescale, fps: count / (mDuration / timescale), gop: count / Math.max(1, keyCount), keyCount,
      bytes: Array.from(size).reduce((a, b) => a + b, 0) };
  }
  throw new Error('No video track');
}
function hevcCodecString(fourcc, d) {
  // ISO/IEC 14496-15 Annex E: hvc1.<profile>.<compat, reversed bits>.<tier+level>.<constraints>
  const space = d[1] >> 6, tier = (d[1] >> 5) & 1, profile = d[1] & 31;
  const compat = ((d[2] << 24) | (d[3] << 16) | (d[4] << 8) | d[5]) >>> 0;   // big-endian in hvcC
  let rev = 0; for (let i = 0; i < 32; i++) if (compat & (1 << i)) rev |= 1 << (31 - i);
  rev >>>= 0;
  const cons = []; for (let i = 0; i < 6; i++) cons.push(d[6 + i]);
  while (cons.length > 1 && cons[cons.length - 1] === 0) cons.pop();
  return `${fourcc}.${['', 'A', 'B', 'C'][space]}${profile}.${rev.toString(16).toUpperCase()}.${tier ? 'H' : 'L'}${d[12]}.${cons.map(x => x.toString(16).toUpperCase()).join('.')}`;
}

// ------------------------------------------------------------ WebCodecs (H.264, HEVC)
class WcDecoder {
  constructor(m) { this.m = m; this.out = []; this.err = null; }
  async open() {
    const m = this.m;
    this.config = { codec: m.codec, codedWidth: m.width, codedHeight: m.height, hardwareAcceleration: 'no-preference' };
    if (m.description) this.config.description = m.description;
    const sup = await VideoDecoder.isConfigSupported(this.config);
    if (!sup.supported) throw new Error(`Chrome can't decode ${m.codec} on this computer`);
    this.dec = new VideoDecoder({ output: f => this.out.push(f), error: e => { this.err = e; } });
    this.dec.configure(this.config);
  }
  close() { try { this.dec.close(); } catch (e) {} }
  // The frame shown at display position i: decode from the keyframe before it, up to it.
  async frameAt(i, keep) {
    const m = this.m, target = m.order[i];
    let k = target; while (k > 0 && !m.key[k]) k--;
    const lo = m.offset[k], hi = Math.max(...Array.from({ length: target - k + 1 }, (_, j) => m.offset[k + j] + m.size[k + j]));
    let span = null, spanStart = 0;
    const t0 = now(), r0 = readMs;
    if (hi - lo < 256 * 1048576) { span = await readRange(m.file, lo, hi); spanStart = lo; }
    const tRead = readMs - r0;
    const td = now();
    for (let j = k; j <= target; j++) {
      const data = span ? new Uint8Array(span, m.offset[j] - spanStart, m.size[j]) : new Uint8Array(await readRange(m.file, m.offset[j], m.offset[j] + m.size[j]));
      this.dec.decode(new EncodedVideoChunk({ type: m.key[j] ? 'key' : 'delta', timestamp: Math.round(m.cts[j] / m.timescale * 1e6), data }));
    }
    await this.dec.flush();
    if (this.err) throw this.err;
    const want = Math.round(m.cts[target] / m.timescale * 1e6);
    let frame = null;
    for (const f of this.out) { if (!frame && f.timestamp === want) frame = f; else f.close(); }
    this.out = [];
    const tDecode = now() - td;
    return { frame, decoded: target - k + 1, readMs: tRead, decodeMs: tDecode, totalMs: now() - t0, bytes: hi - lo };
  }
  // Straight through: n frames in decode order from the first keyframe (bytes read first, then timed separately).
  async sequential(n) {
    const m = this.m; n = Math.min(n, m.count);
    const lo = m.offset[0], hi = Math.max(...Array.from({ length: n }, (_, j) => m.offset[j] + m.size[j]));
    const r0 = readMs, span = await readRange(m.file, lo, hi), tRead = readMs - r0;
    let got = 0; this.dec.reset(); this.dec.configure(this.config);
    const t = now();
    for (let j = 0; j < n; j++) {
      this.dec.decode(new EncodedVideoChunk({ type: m.key[j] ? 'key' : 'delta', timestamp: Math.round(m.cts[j] / m.timescale * 1e6), data: new Uint8Array(span, m.offset[j] - lo, m.size[j]) }));
      while (this.out.length) { this.out.shift().close(); got++; }
      if (this.dec.decodeQueueSize > 8) await new Promise(r => setTimeout(r, 0));
    }
    await this.dec.flush();
    got += this.out.length; this.out.forEach(f => f.close()); this.out = [];
    return { frames: got, decodeMs: now() - t, readMs: tRead, bytes: hi - lo };
  }
}
// Black check on a decoded frame: copy the picture out and look at about 30,000 luma samples.
async function blackCheckFrame(frame) {
  const t = now();
  const fmt = frame.format;
  let black = null;
  if (fmt && /^(I420|I420A|I422|I444|NV12)/.test(fmt)) {
    const buf = new Uint8Array(frame.allocationSize());
    const layout = await frame.copyTo(buf);
    black = isBlack8(buf, layout[0].offset, layout[0].stride, frame.codedWidth, frame.codedHeight);
  } else {
    const c = new OffscreenCanvas(480, 270), g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(frame, 0, 0, 480, 270);
    const d = g.getImageData(0, 0, 480, 270).data; let bright = 0;
    for (let i = 0; i < d.length; i += 16) { const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; if (y > 25.5) bright++; }
    black = bright <= d.length / 16 * 0.02;
  }
  return { black, ms: now() - t, path: fmt || 'canvas' };
}
function isBlack8(y, off, stride, w, h) {
  const step = Math.max(1, Math.floor(Math.min(w, h) / 135)), limit = 16 + 0.1 * 219;
  let n = 0, bright = 0;
  for (let r = 0; r < h; r += step) { const p = off + r * stride; for (let c = 0; c < w; c += step) { n++; if (y[p + c] > limit) bright++; } }
  return bright <= n * 0.02;
}

// ------------------------------------------------------------ ProRes (FFmpeg's decoder, WebAssembly)
let proresModule = null;
async function proresInstance() {
  if (!proresModule) {
    const bin = Uint8Array.from(atob(PRORES_WASM_B64), c => c.charCodeAt(0));
    const t = now(); proresModule = await WebAssembly.compile(bin);
    log(`ProRes decoder: ${(bin.length / 1024).toFixed(0)} KB, compiled in ${fmtMs(now() - t)}`);
  }
  let mem;
  const wasi = new Proxy({
    fd_write: (fd, iov, n, out) => { const v = new DataView(mem.buffer); let s = '', tot = 0; for (let i = 0; i < n; i++) { const p = v.getUint32(iov + 8 * i, true), l = v.getUint32(iov + 8 * i + 4, true); s += new TextDecoder().decode(new Uint8Array(mem.buffer, p, l)); tot += l; } v.setUint32(out, tot, true); if (s.trim()) log('[prores] ' + s.trim()); return 0; },
    clock_time_get: (id, prec, out) => { new DataView(mem.buffer).setBigUint64(out, BigInt(Math.round(performance.now() * 1e6)), true); return 0; },
    environ_sizes_get: (a, b) => { const v = new DataView(mem.buffer); v.setUint32(a, 0, true); v.setUint32(b, 0, true); return 0; },
    environ_get: () => 0, fd_prestat_get: () => 8, proc_exit: c => { throw new Error('ProRes decoder exited ' + c); },
  }, { get: (t, k) => t[k] || (() => 52) });
  const inst = await WebAssembly.instantiate(proresModule, { wasi_snapshot_preview1: wasi });
  mem = inst.exports.memory; inst.exports._initialize();
  return inst.exports;
}
class ProresDecoder {
  constructor(m) { this.m = m; }
  async open() {
    this.e = await proresInstance();
    const f = this.m.fourcc, tag = f.charCodeAt(0) | f.charCodeAt(1) << 8 | f.charCodeAt(2) << 16 | f.charCodeAt(3) << 24;
    if (this.e.pr_open(this.m.width, this.m.height, tag >>> 0) < 0) throw new Error('ProRes decoder did not open');
    this.cap = 0; this.ptr = 0;
  }
  close() {}
  async frameAt(i) {
    const m = this.m, s = m.order[i], e = this.e;
    const t0 = now(), r0 = readMs;
    const buf = await readRange(m.file, m.offset[s], m.offset[s] + m.size[s]);
    const tRead = readMs - r0;
    const td = now();
    if (buf.byteLength > this.cap) { if (this.ptr) e.pr_free(this.ptr); this.cap = buf.byteLength * 1.5 | 0; this.ptr = e.pr_alloc(this.cap); }
    new Uint8Array(e.memory.buffer, this.ptr, buf.byteLength).set(new Uint8Array(buf));
    const r = e.pr_decode(this.ptr, buf.byteLength);
    if (r < 0) throw new Error('ProRes decode failed (' + r + ')');
    return { frame: this.picture(), decoded: 1, readMs: tRead, decodeMs: now() - td, totalMs: now() - t0, bytes: buf.byteLength };
  }
  picture() {
    const e = this.e, f = e.pr_format();
    const bits = (f === e.pr_fmt_yuv422p12() || f === e.pr_fmt_yuv444p12() || f === e.pr_fmt_yuva444p12()) ? 12 : 10;
    const c444 = f !== e.pr_fmt_yuv422p10() && f !== e.pr_fmt_yuv422p12();
    const w = e.pr_width(), h = e.pr_height();
    const plane = k => new Uint16Array(e.memory.buffer, e.pr_plane(k), e.pr_linesize(k) / 2 * h);
    return { kind: 'yuv', w, h, bits, c444, Y: plane(0), U: plane(1), V: plane(2), ys: e.pr_linesize(0) / 2, cs: e.pr_linesize(1) / 2 };
  }
}
function blackCheckYuv(p) {
  const t = now(), sh = p.bits - 8, step = Math.max(1, Math.floor(Math.min(p.w, p.h) / 135)), limit = (16 + 0.1 * 219) * (1 << sh);
  let n = 0, bright = 0;
  for (let r = 0; r < p.h; r += step) { const o = r * p.ys; for (let c = 0; c < p.w; c += step) { n++; if (p.Y[o + c] > limit) bright++; } }
  return { black: bright <= n * 0.02, ms: now() - t, path: 'YUV ' + p.bits + '-bit' };
}
function yuvToCanvas(p, cv) {
  const W = 480, H = Math.round(480 * p.h / p.w); cv.width = W; cv.height = H;
  const g = cv.getContext('2d'), img = g.createImageData(W, H), d = img.data, sh = p.bits - 8, k = 1 << sh;
  for (let y = 0; y < H; y++) {
    const sy = Math.floor(y * p.h / H);
    for (let x = 0; x < W; x++) {
      const sx = Math.floor(x * p.w / W), cx = p.c444 ? sx : sx >> 1;
      const Y = (p.Y[sy * p.ys + sx] / k - 16) / 219, Cb = (p.U[sy * p.cs + cx] / k - 128) / 224, Cr = (p.V[sy * p.cs + cx] / k - 128) / 224;
      const o = (y * W + x) * 4;
      d[o] = 255 * (Y + 1.5748 * Cr); d[o + 1] = 255 * (Y - 0.1873 * Cb - 0.4681 * Cr); d[o + 2] = 255 * (Y + 1.8556 * Cb); d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
}

