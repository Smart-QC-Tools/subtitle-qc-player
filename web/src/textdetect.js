/* ==========================================================================
   On-screen text for Video Analysis (web version): the lab's engine (web/labs/text-engine.js, rules and all),
   packed in at build time together with the text-detection model (PaddleOCR PP-OCRv4 detector), ONNX Runtime Web
   and the ProRes decoder. Built only with TEXT_MODEL=1 (web/build.py; fetch the model first with
   web/labs/fetch_assets.sh); otherwise TextDetect is null and the web version can't look for text.
   The lab page (web/labs/text-detection.src.html) uses the same engine: change the rules there and both follow.
   ========================================================================== */
const TextDetect = (() => {
  const PRORES_WASM_B64 = '__PRORES_WASM_B64__';
  const ORT_MJS_B64 = '__ORT_MJS_B64__', ORT_WASM_B64 = '__ORT_WASM_B64__', DET_MODEL_B64 = '__DET_MODEL_B64__';
  const log = (...a) => console.log('[text detection]', ...a);
  const now = () => performance.now();
  const fmtMs = ms => ms < 1 ? ms.toFixed(2) + ' ms' : ms < 100 ? ms.toFixed(1) + ' ms' : Math.round(ms) + ' ms';
  const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  const b64bytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

/*@include lab-video.js*/

/*@include text-engine.js*/

  // One video: every piece of text that matters for subtitles, and what was left out (with why). Times in seconds
  // from the first frame; boxes [x, y, w, h] as parts of the picture (0…1, from the top left).
  // step: seconds between the frames looked at (2, or 1 for the dense setting).
  async function run(file, { onProgress, stopped, step } = {}) {
    const res = await findText(file, { step: step || TEXT_RULES.step, onStatus: (t, p) => onProgress && onProgress(Math.min(1, p || 0), t), stopped });
    try { res.dec.close(); } catch (e) { /* closed already */ }
    const r3 = x => Math.round(x * 1000) / 1000;
    const piece = c => Object.assign({ in: r3(c.inT), out: r3(c.outT), box: [r3(c.box.x), r3(c.box.y), r3(c.box.w), r3(c.box.h)], height: r3(c.lh), move: r3(c.move || 0) },
      c.look ? { contrast: c.look.contrast, sharp: c.look.sharp } : {}, c.graphic ? { graphic: true } : {});
    return {
      fps: res.m.fps, scannedTo: r3(res.end), seconds: Math.round(res.totalMs / 1000), device: sessionEp === 'webgpu' ? 'graphics chip' : 'processor', step: res.step, sharpLimit: res.sharpLimit,
      pieces: res.final.map(c => Object.assign(piece(c), c.approx ? { approx: true } : {})),
      leftOut: res.leftOut.map(c => Object.assign(piece(c), { why: c.why }, c.approx ? { approx: true } : {})),
    };
  }
  return { run, rules: TEXT_RULES };
})();
