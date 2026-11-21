// Finding on-screen text without reading it: the detector (PaddleOCR's PP-OCRv4 text detector, or image checks),
// the frame helpers and the rules (findText). Shared by the lab page (text-detection.src.html) and the app's Video
// Analysis (web/src/textdetect.js): change the rules here and both follow.
// Needs from the page: lab-video.js (parseMovie, decoders), ORT_MJS_B64 / ORT_WASM_B64 / DET_MODEL_B64, b64bytes(),
// log(), now(), fmtMs(), median().

// ------------------------------------------------------------ the frame as a small RGB picture
function frameToImage(frame, W, H) {
  const c = new OffscreenCanvas(W, H), g = c.getContext('2d', { willReadFrequently: true });
  if (frame.kind === 'yuv') {
    const p = frame, img = g.createImageData(W, H), d = img.data, k = 1 << (p.bits - 8);
    for (let y = 0; y < H; y++) {
      const sy = Math.floor((y + 0.5) * p.h / H);
      for (let x = 0; x < W; x++) {
        const sx = Math.floor((x + 0.5) * p.w / W), cx = p.c444 ? sx : sx >> 1;
        const Y = (p.Y[sy * p.ys + sx] / k - 16) / 219, Cb = (p.U[sy * p.cs + cx] / k - 128) / 224, Cr = (p.V[sy * p.cs + cx] / k - 128) / 224, o = (y * W + x) * 4;
        d[o] = 255 * (Y + 1.5748 * Cr); d[o + 1] = 255 * (Y - 0.1873 * Cb - 0.4681 * Cr); d[o + 2] = 255 * (Y + 1.8556 * Cb); d[o + 3] = 255;
      }
    }
    return img;
  }
  g.drawImage(frame, 0, 0, W, H);
  return g.getImageData(0, 0, W, H);
}

// ------------------------------------------------------------ finding text: the model (PP-OCRv4 detector)
let ort = null, session = null, sessionEp = '';
async function loadModel(want) {
  if (session && (want === 'auto' || want === sessionEp)) return;
  const t = now();
  if (!ort) {
    // The library finds its files next to itself (import.meta.url); inlined here it has no address, so it gets the page's.
    const src = new TextDecoder().decode(b64bytes(ORT_MJS_B64)).replaceAll('import.meta.url', JSON.stringify(location.href));
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    ort = await import(url);
    ort.env.wasm.wasmBinary = b64bytes(ORT_WASM_B64).buffer;
    ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false;
  }
  const model = b64bytes(DET_MODEL_B64);
  const eps = want === 'wasm' ? ['wasm'] : (navigator.gpu ? ['webgpu', 'wasm'] : ['wasm']);
  for (const ep of eps) {
    try { session = await ort.InferenceSession.create(model, { executionProviders: [ep] }); sessionEp = ep; break; }
    catch (e) { log(`model on ${ep}: ${e.message}`); }
  }
  if (!session) throw new Error('The text-detection model did not load');
  log(`text-detection model ready on ${sessionEp === 'webgpu' ? 'the graphics chip (WebGPU)' : 'the processor (WebAssembly, 1 thread)'} in ${fmtMs(now() - t)}`);
}
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
// near: when we already know where the text is (finding in / out), only a window around it is looked at
// (fixed sizes, so the graphics chip keeps its prepared work): much less to compute, same detail.
async function detectModel(img, near) {
  const IW = img.width, IH = img.height, d = img.data;
  let cx = 0, cy = 0, W = IW, H = IH;
  if (near) {
    const m = 24, x0 = near.x * IW - m, y0 = near.y * IH - m, bw = near.w * IW + 2 * m, bh = near.h * IH + 2 * m;
    const win = [[320, 192], [IW, 192], [IW, IH]].find(([w, h]) => bw <= w && bh <= h);
    [W, H] = win;
    cx = Math.round(Math.min(Math.max(0, x0 + bw / 2 - W / 2), IW - W)); cy = Math.round(Math.min(Math.max(0, y0 + bh / 2 - H / 2), IH - H));
  }
  const n = W * H, x = new Float32Array(3 * n);
  for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) {
    const i = yy * W + xx, o = 4 * ((yy + cy) * IW + xx + cx);
    for (let c = 0; c < 3; c++) x[c * n + i] = (d[o + c] / 255 - MEAN[c]) / STD[c];
  }
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', x, [1, 3, H, W]) });
  const boxes = dbBoxes(out[session.outputNames[0]].data, W, H);
  return near ? boxes.map(b => ({ x: (cx + b.x * W) / IW, y: (cy + b.y * H) / IH, w: b.w * W / IW, h: b.h * H / IH })) : boxes;
}
// DB post-processing: text pixels (probability > 0.3), joined into regions, kept if confident, then grown back
// (the model marks a shrunk core of each text line).
function dbBoxes(prob, W, H) {
  const lab = new Int32Array(W * H), boxes = [], stack = [];
  let id = 0;
  for (let i = 0; i < W * H; i++) {
    if (prob[i] <= 0.3 || lab[i]) continue;
    id++; let x0 = W, y0 = H, x1 = 0, y1 = 0, sum = 0, cnt = 0;
    stack.push(i); lab[i] = id;
    while (stack.length) {
      const p = stack.pop(), px = p % W, py = (p - px) / W;
      sum += prob[p]; cnt++;
      if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
      if (px > 0 && !lab[p - 1] && prob[p - 1] > 0.3) { lab[p - 1] = id; stack.push(p - 1); }
      if (px < W - 1 && !lab[p + 1] && prob[p + 1] > 0.3) { lab[p + 1] = id; stack.push(p + 1); }
      if (py > 0 && !lab[p - W] && prob[p - W] > 0.3) { lab[p - W] = id; stack.push(p - W); }
      if (py < H - 1 && !lab[p + W] && prob[p + W] > 0.3) { lab[p + W] = id; stack.push(p + W); }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (cnt < 6 || h < 2 || sum / cnt < 0.6) continue;
    // Lines close together can come out as one region (small text, tight leading): split at the thin rows between them,
    // so each line is measured on its own.
    const rows = []; for (let y = y0; y <= y1; y++) { let n = 0; for (let x = x0; x <= x1; x++) if (lab[y * W + x] === id) n++; rows.push(n); }
    const top = Math.max(...rows), cuts = [y0];
    for (let k = 2; k < rows.length - 2; k++) if (rows[k] < top * 0.25 && rows[k] <= rows[k - 1] && rows[k] <= rows[k + 1] && y0 + k - cuts[cuts.length - 1] >= 2) cuts.push(y0 + k);
    cuts.push(y1 + 1);
    for (let k = 0; k + 1 < cuts.length; k++) {
      const ya = cuts[k], yb = cuts[k + 1] - 1; if (yb - ya < 1) continue;
      let xa = W, xb = 0; for (let y = ya; y <= yb; y++) for (let x = x0; x <= x1; x++) if (lab[y * W + x] === id) { if (x < xa) xa = x; if (x > xb) xb = x; }
      const lw = xb - xa + 1, lh = yb - ya + 1, grow = (lw * lh * 1.5) / (2 * (lw + lh));
      boxes.push({ x: Math.max(0, xa - grow) / W, y: Math.max(0, ya - grow) / H, w: Math.min(W, lw + 2 * grow) / W, h: Math.min(H, lh + 2 * grow) / H });
    }
  }
  return boxes;
}

// ------------------------------------------------------------ finding text: image checks (no model)
// Text = many short, sharp, high-contrast strokes packed along a line. Edges are found on the brightness, joined
// sideways into line-shaped regions, and kept if their size, shape and density look like lettering.
function detectImage(img, thr = 70) {
  const W = img.width, H = img.height, d = img.data, L = new Uint8Array(W * H), E = new Uint8Array(W * H), M = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) L[i] = (d[4 * i] * 54 + d[4 * i + 1] * 183 + d[4 * i + 2] * 19) >> 8;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x, g = Math.abs(L[i + 1] - L[i - 1]) + Math.abs(L[i + W] - L[i - W]);
    if (g > thr) E[i] = 1;
  }
  const RX = 4, RY = 1;
  for (let y = 0; y < H; y++) { let run = -1e9; for (let x = 0; x < W; x++) { if (E[y * W + x]) run = x; if (x - run <= RX) M[y * W + x] = 1; } let r2 = 1e9; for (let x = W - 1; x >= 0; x--) { if (E[y * W + x]) r2 = x; if (r2 - x <= RX) M[y * W + x] |= 1; } }
  const M2 = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let on = 0; for (let k = -RY; k <= RY && !on; k++) { const yy = y + k; if (yy >= 0 && yy < H && M[yy * W + x]) on = 1; } M2[y * W + x] = on; }
  const lab = new Int32Array(W * H), boxes = [], stack = [];
  let id = 0;
  for (let i = 0; i < W * H; i++) {
    if (!M2[i] || lab[i]) continue;
    id++; let x0 = W, y0 = H, x1 = 0, y1 = 0, edges = 0, area = 0;
    stack.push(i); lab[i] = id;
    while (stack.length) {
      const p = stack.pop(), px = p % W, py = (p - px) / W; area++; edges += E[p];
      if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
      if (px > 0 && M2[p - 1] && !lab[p - 1]) { lab[p - 1] = id; stack.push(p - 1); }
      if (px < W - 1 && M2[p + 1] && !lab[p + 1]) { lab[p + 1] = id; stack.push(p + 1); }
      if (py > 0 && M2[p - W] && !lab[p - W]) { lab[p - W] = id; stack.push(p - W); }
      if (py < H - 1 && M2[p + W] && !lab[p + W]) { lab[p + W] = id; stack.push(p + W); }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1, dens = edges / (w * h);
    if (h < 5 || h > H * 0.2 || w < 12 || w < h * 1.3 || edges < 30 || dens < 0.1 || dens > 0.7) continue;
    boxes.push({ x: x0 / W, y: y0 / H, w: w / W, h: h / H });
  }
  return boxes;
}

// ------------------------------------------------------------ how a piece of text looks (contrast, sharpness)
function lookOf(frame, box) {
  let L, w, h;
  if (frame.kind === 'yuv') {
    const p = frame, sh = p.bits - 8, x0 = Math.max(0, Math.floor(box.x * p.w)), y0 = Math.max(0, Math.floor(box.y * p.h));
    w = Math.min(p.w - x0, Math.ceil(box.w * p.w)); h = Math.min(p.h - y0, Math.ceil(box.h * p.h));
    L = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) L[y * w + x] = ((p.Y[(y0 + y) * p.ys + x0 + x] >> sh) - 16) * 255 / 219;
  } else {
    const FW = frame.displayWidth, FH = frame.displayHeight, x0 = Math.max(0, Math.floor(box.x * FW)), y0 = Math.max(0, Math.floor(box.y * FH));
    w = Math.max(1, Math.min(FW - x0, Math.ceil(box.w * FW))); h = Math.max(1, Math.min(FH - y0, Math.ceil(box.h * FH)));
    const c = new OffscreenCanvas(w, h), g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(frame, x0, y0, w, h, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data; L = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) L[i] = (d[4 * i] * 54 + d[4 * i + 1] * 183 + d[4 * i + 2] * 19) / 256;
  }
  if (w < 4 || h < 4) return null;
  const sorted = Float32Array.from(L).sort(), contrast = sorted[Math.floor(sorted.length * 0.98)] - sorted[Math.floor(sorted.length * 0.02)];
  const grads = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; grads.push(Math.max(Math.abs(L[i + 1] - L[i - 1]), Math.abs(L[i + w] - L[i - w])) / 2); }
  grads.sort((a, b) => b - a);
  const top = grads.slice(0, Math.max(1, Math.floor(grads.length * 0.05))), edge = top.reduce((a, b) => a + b, 0) / top.length;
  return { contrast: Math.round(contrast), sharp: contrast > 1 ? Math.round(Math.min(100, edge / contrast * 100)) : 0 };
}

// ------------------------------------------------------------ from boxes to cards
const overlap = (a, b) => { const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y); if (ix <= 0 || iy <= 0) return 0; return ix * iy / Math.min(a.w * a.h, b.w * b.h); };
const union = (a, b) => { const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }; };
// Lines that belong together (a role above a name; words on one line) make one block.
function blocks(boxes) {
  const ls = boxes.filter(b => b.h >= 0.012).sort((a, b) => a.y - b.y), out = [];
  for (const l of ls) {
    const k = out.findLastIndex(b => {
      const lh = Math.max(b.lh, l.h), gap = l.y - (b.y + b.h);
      const sameRow = Math.min(b.y + b.h, l.y + l.h) - Math.max(b.y, l.y) > lh * 0.5;
      const hGap = Math.max(b.x, l.x) - Math.min(b.x + b.w, l.x + l.w);
      if (sameRow) return hGap < 0.08;
      const aligned = hGap < 0 || Math.abs(b.x - l.x) < 0.04 || Math.abs(b.x + b.w - l.x - l.w) < 0.04 || Math.abs(b.x + b.w / 2 - l.x - l.w / 2) < 0.04;
      return gap > -lh * 0.5 && gap < lh * 1.6 && aligned;
    });
    if (k >= 0) { const u = union(out[k], l); Object.assign(out[k], u, { lh: Math.max(out[k].lh, l.h), n: out[k].n + 1 }); }
    else out.push({ ...l, lh: l.h, n: 1 });
  }
  // Text is wider than tall (in picture pixels): drops rings, balls, faces.
  return out.filter(b => b.w * 16 / 9 >= b.h * 1.6);
}


// ------------------------------------------------------------ finding every piece of text in a video (the rules)
// One frame every o.step seconds; pieces followed from frame to frame; in / out found to the frame by bisection; then
// what doesn't matter for subtitles is left out (each with its reason). Used by the lab page (which also shows timings
// and pictures) and by the app's Video Analysis. Options (all optional):
//   det 'model' | 'image', step 2, end (seconds, default the whole video), msize 640 | 960, ep 'auto' | 'wasm',
//   minH 0.03, leave { small, moving, title, scene, faint, end } (all true), onStatus(text, part 0…1), stopped()
// Returns { m, dec (still open: the caller closes it), pts, posAt, final, leftOut, groups, samples, scanMs, refineMs,
//   refineN, totalMs, tm, end, step, W, H } — final / leftOut pieces: inT, outT, box {x,y,w,h}, lh, lines, move, moveN,
//   cutIn, cutOut, look {contrast, sharp}, firstP, approx, why (left out).
const TEXT_RULES = { v: 1, step: 2, small: 0.03, moving: 0.01, titleH: 0.08, hugeH: 0.14, cut: 20, subZone: 0.75,
  faint: { contrast: 140, sharp: 30 }, endGap: 8, staticMax: 20, minLength: 0.5 };
async function findText(file, o = {}) {
  const R = TEXT_RULES;
  const det = o.det || 'model', step = o.step || R.step, msz = o.msize || 640;
  const lv = Object.assign({ small: true, moving: true, title: true, scene: true, faint: true, end: true }, o.leave || {});
  const minH = o.minH || R.small;
  const status = o.onStatus || (() => {}), stopped = o.stopped || (() => false);
  const halt = () => { if (stopped()) throw new Error('stopped'); };
  const W = det === 'model' ? msz : 640, H = det === 'model' ? (msz === 640 ? 352 : 544) : 360;
  if (det === 'model') await loadModel(o.ep || 'auto');
  bytesRead = 0; readMs = 0; readCount = 0;
  const T0 = now();
  const m = await parseMovie(file);
  const dec = m.kind === 'prores' ? new ProresDecoder(m) : (m.kind === 'h264' || m.kind === 'hevc') ? new WcDecoder(m) : null;
  if (!dec) throw new Error(`This video can't be read here (${m.fourcc})`);
  await dec.open();
  const pts = m.order.map(s => (m.cts[s] - m.mediaTime) / m.timescale);
  const posAt = t => { let lo = 0, hi = pts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (pts[mid] <= t + 1e-6) lo = mid; else hi = mid - 1; } return lo; };
  const end = o.end ? Math.min(m.duration, o.end) : m.duration;
  const tm = { frame: 0, image: 0, detect: 0, n: 0 };
  // A 32 × 18 brightness thumbnail of every frame looked at, to tell whether the picture cuts where text comes or goes.
  const lumaThumbs = new Map();
  const thumbOf = img => {
    const t = new Float32Array(32 * 18), n = new Uint16Array(32 * 18), d = img.data;
    for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) {
      const k = Math.floor(y * 18 / img.height) * 32 + Math.floor(x * 32 / img.width), q = 4 * (y * img.width + x);
      t[k] += (d[q] * 54 + d[q + 1] * 183 + d[q + 2] * 19) >> 8; n[k]++;
    }
    for (let k = 0; k < t.length; k++) t[k] /= n[k] || 1;
    return t;
  };
  // timed = false: fetched in the background; only the time spent waiting for it is counted (as "get the frame")
  const grab = async (p, timed = true) => {
    let t = now(); const r = await dec.frameAt(p); if (timed) tm.frame += now() - t;
    if (!r.frame) return null;
    t = now(); const img = frameToImage(r.frame, W, H); if (timed) tm.image += now() - t;
    if (r.frame.close) r.frame.close();
    if (!lumaThumbs.has(p)) lumaThumbs.set(p, thumbOf(img));
    return img;
  };
  // How much the picture changes between two frames, outside the text (mean brightness difference, 0–255).
  // A cut changes everything (typically 30+); a fade, a dissolve or text popping on over a steady shot, very little.
  const outside = (t, box, f) => {
    const g = { x: box.x - 0.03, y: box.y - 0.03, w: box.w + 0.06, h: box.h + 0.06 };
    let sum = 0, cnt = 0;
    for (let y = 0; y < 18; y++) for (let x = 0; x < 32; x++) {
      const cx = (x + 0.5) / 32, cy = (y + 0.5) / 18;
      if (cx > g.x && cx < g.x + g.w && cy > g.y && cy < g.y + g.h) continue;
      sum += f(y * 32 + x); cnt++;
    }
    return cnt ? sum / cnt : 0;
  };
  const changeBetween = async (pa, pb, box) => {
    if (pa < 0 || pb >= pts.length) return 0;
    if (!lumaThumbs.has(pa)) await grab(pa); if (!lumaThumbs.has(pb)) await grab(pb);
    const a = lumaThumbs.get(pa), b = lumaThumbs.get(pb);
    return a && b ? outside(a, box, i => Math.abs(a[i] - b[i])) : 0;
  };
  const find = async (img, thr, near) => {
    if (!img) return [];
    const t = now(); const boxes = det === 'model' ? await detectModel(img, near) : detectImage(img, thr); tm.detect += now() - t;
    tm.n++;
    return blocks(boxes);
  };
  const findAt = async (p, thr, near) => find(await grab(p), thr, near);

  // 1. scan (the next frame is fetched while the model looks at this one)
  const cards = []; let active = [], prevP = null, samples = 0;
  const times = []; for (let t = 0; t < end; t += step) times.push(t);
  let next = grab(posAt(0), false);
  for (const [k, t] of times.entries()) {
    halt();
    const p = posAt(t), tw = now(), img = await next; tm.frame += now() - tw;
    next = k + 1 < times.length ? grab(posAt(times[k + 1]), false) : null;
    const found = await find(img); samples++;
    const still = [], used = new Set();
    for (const c of active) {
      const j = found.findIndex((b, i) => !used.has(i) && overlap(c.box, b) > 0.5);
      if (j >= 0) { used.add(j); c.lastP = p; c.obs.push(found[j]); c.lh = Math.max(c.lh, found[j].lh); c.lines = Math.max(c.lines, found[j].n || 1); if (found[j].w * found[j].h > c.box.w * c.box.h) c.box = found[j]; still.push(c); }
      else { c.afterP = p; cards.push(c); }
    }
    found.forEach((b, i) => { if (!used.has(i)) still.push({ box: b, firstP: p, lastP: p, beforeP: prevP, afterP: null, lh: b.lh, lines: b.n || 1, obs: [b] }); });
    active = still; prevP = p;
    if (samples % 10 === 0) status(`looking for text: ${Math.round(t)} of ${Math.round(end)} s, ${cards.length + active.length} pieces so far`, 0.7 * t / end);
  }
  cards.push(...active);
  const scanMs = now() - T0, scanN = tm.n;

  // End credits: walking back from the end of the video, credit-like pieces (2+ lines over a black background) join
  // the run while each is on screen within 8 s of the run's start. The first piece that isn't credit-like ends it, so
  // "To be continued…" (one line) just before the credits stays. Logos after the credits go with them. Only when the
  // run reaches the last minute and has 3+ credit-like pieces (videos of 10 minutes or more); otherwise nothing is
  // left out (end credits staying in is harmless).
  const endRun = new Set();
  const darkAround = c => { const t = lumaThumbs.get(c.firstP); return !!t && outside(t, c.box, i => t[i]) < 30; };
  const creditLike = c => c.lines >= 2 && darkAround(c);
  if (lv.end && m.duration >= 600) {
    const ends = cards.filter(c => pts[c.lastP] - pts[c.firstP] <= R.staticMax).map(c => ({ c, a: pts[c.firstP], b: Math.min(m.duration, pts[c.lastP] + step) }))
      .sort((x, y) => y.b - x.b);
    let edge = m.duration - 60 + R.endGap;   // the run must reach the last minute
    const run = [], after = [];
    for (const e of ends) {
      if (e.b < edge - R.endGap || e.a < m.duration - 300) break;
      if (creditLike(e.c)) { run.push(e.c); edge = Math.min(edge, e.a); }
      else if (!run.length || e.a >= edge) after.push(e);   // after the credits (or alongside them): end logos
      else break;                                            // before the credits and not credit-like: stop here
    }
    if (run.length >= 3) { run.forEach(c => endRun.add(c)); after.filter(e => e.a >= edge).forEach(e => endRun.add(e.c)); }
  }
  // large text: main titles and big logos (a subtitle can't avoid them, so they don't matter here). A title sits in the
  // middle of the picture both ways (big credits along the bottom are credits, not titles), or is huge.
  const isTitle = c => c.lh >= R.hugeH || (c.lh >= R.titleH && Math.abs(c.box.x + c.box.w / 2 - 0.5) < 0.12 && Math.abs(c.box.y + c.box.h / 2 - 0.5) < 0.2);
  const leftOut = [];
  const kept = cards.filter(c => {
    if (pts[c.lastP] - pts[c.firstP] > R.staticMax) return false;   // logos, burnt-in timecode
    // left out before the in / out step (times from the scan only): end credits, small text, titles
    const why = endRun.has(c) ? 'end credits' : lv.small && c.lh < minH ? 'small' : lv.title && isTitle(c) ? 'title' : '';
    if (why) { leftOut.push(Object.assign(c, { why, approx: true, inT: pts[c.firstP], outT: Math.min(m.duration, pts[c.lastP] + step) })); return false; }
    return true;
  });
  // pieces seen on exactly the same frames, touching: one card, so its in and out are found once
  const touch = (a, b) => overlap({ x: a.x - 0.02, y: a.y - 0.02, w: a.w + 0.04, h: a.h + 0.04 }, b) > 0;
  const groups = [];
  for (const c of kept) {
    const g = groups.find(g => g.firstP === c.firstP && g.lastP === c.lastP && g.parts.some(q => touch(q, c.box)));
    if (g) { g.parts.push(c.box); g.box = union(g.box, c.box); g.lh = Math.max(g.lh, c.lh); } else groups.push({ ...c, parts: [c.box], obs: [...c.obs] });
  }

  // 2. in and out to the frame
  const T1 = now();
  for (const [gi, c] of groups.entries()) {
    halt();
    if (gi % 5 === 0) status(`finding in and out: ${gi} of ${groups.length} pieces of text`, 0.7 + 0.25 * gi / Math.max(1, groups.length));
    // image checks: more sensitive here (we know where to look), so faint text in a fade counts
    const present = async p => {
      const bs = await findAt(p, 30, c.box), main = bs.find(b => overlap(c.parts[0], b) > 0.3);
      if (main) c.obs.push(main);
      return !!main || bs.some(b => c.parts.some(q => overlap(q, b) > 0.3));
    };
    let lo = c.beforeP == null ? -1 : c.beforeP, hi = c.firstP;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (await present(mid)) hi = mid; else lo = mid; }
    c.inP = hi;
    c.cutIn = await changeBetween(lo, hi, c.box);           // the picture just before the text vs. its first frame
    lo = c.lastP; let hi2 = c.afterP == null ? pts.length : c.afterP;
    while (hi2 - lo > 1) { const mid = (lo + hi2) >> 1; if (await present(mid)) lo = mid; else hi2 = mid; }
    c.cutOut = await changeBetween(lo, hi2, c.box);         // its last frame vs. the picture just after
    // comes and goes on cuts: part of the shot. Kept all the same when it reaches into the bottom quarter, where
    // subtitles go, and is at least 30% of the picture wide (a news insert filling the picture; not a badge on a vest).
    c.scene = c.cutIn >= R.cut && c.cutOut >= R.cut && !(c.box.y + c.box.h > R.subZone && c.box.w >= 0.3);
    c.outT = hi2 < pts.length ? pts[hi2] : m.duration; c.inT = pts[c.inP];
  }
  const refineMs = now() - T1, refineN = tm.n - scanN;
  // How far it moves while on screen: graphics stay put; text in the scene drifts with the camera. Measured on whichever
  // edge is steadiest (left, centre or right; top, middle or bottom), so text that grows as it's typed on still counts as
  // still. Only whole sightings count (partly seen text in a fade or a dissolve gives a smaller box that seems to move),
  // and with 5 or more, the most extreme one each way is ignored.
  const spread = vals => { const v = [...vals].sort((a, b) => a - b); return v.length >= 5 ? v[v.length - 2] - v[1] : v[v.length - 1] - v[0]; };
  for (const c of [...groups, ...leftOut]) {
    const areas = c.obs.map(b => b.w * b.h), big = median(areas);
    const ob = c.obs.filter((b, i) => areas[i] >= big * 0.7);
    c.moveN = ob.length;
    c.move = ob.length < 2 ? 0 : Math.max(
      Math.min(spread(ob.map(b => b.x)), spread(ob.map(b => b.x + b.w / 2)), spread(ob.map(b => b.x + b.w))),
      Math.min(spread(ob.map(b => b.y)), spread(ob.map(b => b.y + b.h / 2)), spread(ob.map(b => b.y + b.h))));
  }
  // shorter than half a second: a flicker, not text on screen
  let final = groups.filter(c => c.outT - c.inT >= R.minLength).sort((a, b) => a.inT - b.inT);
  // pieces of one card (on screen together, touching or overlapping): joined into one
  const grown = b => ({ x: b.x - 0.02, y: b.y - 0.02, w: b.w + 0.04, h: b.h + 0.04 });
  for (let i = 0; i < final.length; i++) for (let j = i + 1; j < final.length; j++) {
    const c = final[i], q = final[j], both = Math.min(q.outT, c.outT) - Math.max(q.inT, c.inT);
    if (both < Math.min(c.outT - c.inT, q.outT - q.inT) * 0.7 || !overlap(grown(c.box), q.box)) continue;
    c.box = union(c.box, q.box); c.inT = Math.min(c.inT, q.inT); c.outT = Math.max(c.outT, q.outT); c.lh = Math.max(c.lh, q.lh); c.move = Math.min(c.move, q.move); c.scene = c.scene && q.scene; c.cutIn = Math.min(c.cutIn, q.cutIn); c.cutOut = Math.min(c.cutOut, q.cutOut); final.splice(j, 1); j = i;
  }
  if (lv.scene) final = final.filter(c => !c.scene || !leftOut.push(Object.assign(c, { why: 'scene' })));
  if (lv.moving) final = final.filter(c => c.move <= R.moving || !leftOut.push(Object.assign(c, { why: 'moving' })));
  // Contrast and sharpness inside each piece's box, on the full-size frame where it was seen. Contrast: brightest minus
  // darkest (2nd–98th percentile, 0–255). Sharp: how steep the edges are compared with that contrast (crisp graphics ≈ 45%).
  for (const [i, c] of [...final, ...leftOut].entries()) {
    halt();
    if (i % 10 === 0) status(`measuring contrast: ${i} of ${final.length + leftOut.length}`, 0.95 + 0.05 * i / Math.max(1, final.length + leftOut.length));
    const r = await dec.frameAt(c.firstP);   // a frame where it was seen (the middle of a merged piece can fall between cards)
    if (!r.frame) continue;
    c.look = lookOf(r.frame, c.box);
    if (r.frame.close) r.frame.close();
  }
  // faint: low contrast or soft lettering (made to be read it isn't: a sign, a screen, a poster in the background)
  if (lv.faint) final = final.filter(c => !(c.look && (c.look.contrast < R.faint.contrast || c.look.sharp < R.faint.sharp)) || !leftOut.push(Object.assign(c, { why: 'faint' })));
  leftOut.sort((a, b) => a.inT - b.inT);
  const totalMs = now() - T0;
  return { m, dec, pts, posAt, final, leftOut, groups, samples, scanMs, refineMs, refineN, totalMs, tm, end, step, W, H };
}
