// Self-test for the Mac app (test build only). Runs inside the real interface, drives it the way a
// person would (folders, episode list, keys, clicks) and records timings and anything odd.
(async () => {
  const CFG = window.__selftest || {};
  const R = { started: new Date().toISOString(), ua: navigator.userAgent, steps: [], problems: [], errors: [] };
  const T0 = performance.now();
  const now = () => performance.now();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const round = (x, d = 3) => (x == null || !isFinite(x)) ? x : +x.toFixed(d);
  const step = (name, data = {}) => {
    const s = { name, at: round((now() - T0) / 1000, 1), ...data };
    R.steps.push(s);
    Native.post('log', { level: 'selftest', msg: JSON.stringify(s).slice(0, 3000) });
    return s;
  };
  const problem = (what, data = {}) => { R.problems.push({ what, ...data }); step('PROBLEM ' + what, data); };
  window.addEventListener('error', e => R.errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', e => R.errors.push('rejection: ' + String(e.reason && (e.reason.message || e.reason))));
  const origErr = console.error;
  console.error = (...a) => { R.errors.push(a.map(String).join(' ').slice(0, 500)); origErr(...a); };

  const until = async (fn, ms = 20000, every = 25) => { const t = now(); while (now() - t < ms) { try { if (fn()) return now() - t; } catch (e) {} await sleep(every); } return null; };
  const key = (k, extra = {}) => {
    const code = k === ' ' ? 'Space' : k.length === 1 ? 'Key' + k.toUpperCase() : k;
    const o = { key: k, code, bubbles: true, cancelable: true, ...extra };
    document.body.dispatchEvent(new KeyboardEvent('keydown', o));
    document.body.dispatchEvent(new KeyboardEvent('keyup', o));
  };
  const V = () => document.getElementById('mainVideo');
  const stats = (reset = false) => Native.call('selftestStats', { reset });
  const ws = () => Player.waveState();

  // native event timing: how evenly the time updates arrive while playing (gaps = the page or app stalled)
  let tl = [];
  Native.on('videoTime', d => tl.push([now(), d.t, d.rate]));
  const timeline = () => { const x = tl; tl = []; return x; };
  const gapsOf = x => { let max = 0; for (let i = 1; i < x.length; i++) max = Math.max(max, x[i][0] - x[i - 1][0]); return max; };
  // page frame rate (requestAnimationFrame): long frames = the interface froze
  let raf = [], rafOn = true;
  (function loop(t) { raf.push(t); if (raf.length > 20000) raf.shift(); if (rafOn) requestAnimationFrame(loop); })(now());
  const rafWorst = (since) => { const x = raf.filter(t => t >= since); let max = 0; for (let i = 1; i < x.length; i++) max = Math.max(max, x[i] - x[i - 1]); return round(max, 0); };

  try {
    await until(() => typeof useDir === 'function' && typeof state === 'object' && window.Player && Player.currentVideo, 15000);
    await sleep(800);
    step('start', { cfg: CFG, native: typeof NATIVE !== 'undefined' && NATIVE });

    // ---------------------------------------------------------------- folders
    let t = now();
    await useDir('videos', new Native.NDir(CFG.videos));
    step('videos folder loaded', { ms: round(now() - t, 0), videos: state.videos.map(v => ({ file: v.name, codec: v.codec && v.codec.name, fps: v.probe && round(v.probe.fps), dur: v.probe && round(v.probe.duration, 1), size: v.file.size })), ignored: state.ignoredVideos.map(v => v.name + ': ' + v.reason) });
    t = now();
    await useDir('subs', new Native.NDir(CFG.subs));
    step('subtitles folder loaded', { ms: round(now() - t, 0), subs: state.subs.length });
    setTab('player');
    await sleep(500);

    const order = [...state.videos];
    for (const v of order) {
      const fps = (v.probe && v.probe.fps) || 24;
      const F = { file: v.name };
      // ---------------------------------------------------------------- open
      t = now();
      await selectVideo(v.name);
      const loadMs = await until(() => V() && (V().readyState >= 1 || V().error), 30000);
      if (V().error) { problem('video failed to open', { file: v.name, err: V().error.message }); continue; }
      const tcMs = await until(() => ws().tc && !/^-/.test(ws().tc), 3000);
      { // the native picture must sit exactly under the page's video element (with the page zoomed)
        await sleep(300); const s = await stats(false), r = V().getBoundingClientRect(), z = s.zoom || 1;
        const want = [r.left, r.top, r.width, r.height].map(x => x * z), off = s.layer ? Math.max(...s.layer.map((x, i) => Math.abs(x - want[i]))) : null;
        step('picture position', { file: v.name, zoom: round(z, 3), window: s.window, layer: s.layer && s.layer.map(x => round(x, 1)), page: want.map(x => round(x, 1)), offPt: round(off, 1) });
        if (off == null || off > 2) problem('picture not under the page video', { file: v.name, off }); }
      step('opened', { file: v.name, loadMs: round(loadMs, 0), totalMs: round(now() - t, 0), duration: round(V().duration, 2), w: V().videoWidth, h: V().videoHeight, offset: document.getElementById('offsetInput').value, sub: Player.currentSubtitle() });
      if (loadMs == null || loadMs > 3000) problem('slow to open', { file: v.name, loadMs: round(loadMs, 0) });

      // ---------------------------------------------------------------- waveform (measure while playing)
      const wt = now();
      // ---------------------------------------------------------------- normal playback
      await stats(true); timeline();
      const p0 = V().currentTime;
      key(' ');
      const k0 = now();
      // start-up delay: until the native side reports the position moving
      const startMs = await until(() => tl.some(e => e[1] > p0 + 0.5 / fps), 5000, 5);
      await sleep(1000);
      await stats(true); timeline();
      const r0 = now(), q0 = V().currentTime;
      await sleep(7000);
      const tlx = timeline(), st = await stats(true);
      const p1 = V().currentTime, wall = (now() - r0) / 1000, p0s = q0;
      key(' ');
      await until(() => V().paused, 2000);
      const speed = (p1 - p0s) / wall;
      step('play (start-up, then 7 s steady)', { file: v.name, startMs: round(startMs, 0), playheadSpeed: round(speed), events: tlx.length, worstEventGapMs: round(gapsOf(tlx), 0), worstPageFrameMs: rafWorst(r0), delivered: st.delivered, timeControl: st.timeControl, waiting: st.waiting, wave: ws().state });
      if (startMs == null || startMs > 400) problem('slow to start playing', { file: v.name, startMs: round(startMs, 0) });
      if (Math.abs(speed - 1) > 0.03) problem('playhead speed off while playing', { file: v.name, speed: round(speed) });
      if (st.delivered && st.delivered.fps < fps * 0.9) problem('frames not keeping up', { file: v.name, deliveredFps: round(st.delivered.fps, 1), fps: round(fps, 3), maxFrameGapMs: round(st.delivered.maxFrameGapMs, 0) });
      if (gapsOf(tlx) > 250) problem('time updates stalled', { file: v.name, worstGapMs: round(gapsOf(tlx), 0) });

      // second start, from a different place (after a seek while paused)
      V().currentTime = V().duration / 3; await until(() => !V().seeking, 5000); await sleep(800);
      { const q = V().currentTime; timeline(); key(' '); const ms2 = await until(() => tl.some(e => e[1] > q + 0.5 / fps), 5000, 5); key(' '); await until(() => V().paused, 2000);
        step('start again after a seek', { file: v.name, startMs: round(ms2, 0) });
        if (ms2 == null || ms2 > 250) problem('slow to start after a seek', { file: v.name, startMs: round(ms2, 0) }); }
      // waveform finished?
      const wDone = await until(() => ws().state === 'ready' || ws().state === 'error', 120000, 100);
      step('waveform', { file: v.name, state: ws().state, msg: ws().msg, sinceOpenS: round((now() - wt) / 1000, 1), channels: ws().total, sel: ws().sel });
      if (ws().state !== 'ready') problem('waveform not done', { file: v.name, state: ws().state, msg: ws().msg });

      // ---------------------------------------------------------------- exact seek storm (scrubbing)
      t = now();
      const D = V().duration;
      let last = 0;
      for (let i = 0; i < 120; i++) { last = Math.round(Math.random() * (D - 2) * fps) / fps; V().currentTime = last; await sleep(16); }
      const settle = await until(() => !V().seeking, 15000);
      await sleep(150);
      const err = Math.abs(V().currentTime - last) * fps;
      step('seek storm (120 seeks at 60/s)', { file: v.name, settleMs: round(settle, 0), worstPageFrameMs: rafWorst(t), offByFrames: round(err, 2) });
      if (settle == null || settle > 1500) problem('slow to settle after scrubbing', { file: v.name, settleMs: round(settle, 0) });
      if (err > 0.5) problem('wrong position after scrubbing', { file: v.name, offByFrames: round(err, 2) });

      // ---------------------------------------------------------------- frame stepping
      V().currentTime = Math.round(30 * fps) / fps;
      await until(() => !V().seeking, 5000); await sleep(200);
      const f0 = ws().frame;
      t = now();
      for (let i = 0; i < 48; i++) { key('ArrowRight'); await sleep(33); }
      await until(() => !V().seeking, 5000); await sleep(300);
      const f1 = ws().frame;
      for (let i = 0; i < 24; i++) { key('ArrowLeft'); await sleep(33); }
      await until(() => !V().seeking, 5000); await sleep(300);
      const f2 = ws().frame;
      step('frame steps (48 → , 24 ←, held key speed)', { file: v.name, from: f0, after48: f1, after24back: f2, ms: round(now() - t, 0), tc: ws().tc });
      if (f1 - f0 !== 48 || f1 - f2 !== 24) problem('frame steps miscounted', { file: v.name, f0, f1, f2 });

      // ---------------------------------------------------------------- shuttle J / K / L
      const shuttle = [];
      const sample = async (label, ms) => { const a = V().currentTime, b0 = now(); timeline(); await sleep(ms); const b = V().currentTime; const tx = timeline(); shuttle.push({ label, speed: round((b - a) / ((now() - b0) / 1000), 2), badge: document.getElementById('speedBadge').hidden ? '' : document.getElementById('speedBadge').textContent, worstGapMs: round(gapsOf(tx), 0), tc: ws().tc }); };
      V().currentTime = D / 2; await until(() => !V().seeking, 5000);
      key('l'); await sample('L', 1500);
      key('l'); await sample('L L (2x)', 1500);
      key('l'); await sample('L L L (4x)', 1500);
      key('l'); await sample('4×L (6x)', 1500);
      key('k'); await sleep(300);
      key('j'); await sample('J (-2x)', 2000);
      key('j'); await sample('J J (-4x)', 2000);
      key('j'); await sample('J J J (-6x)', 2000);
      key('k'); await sleep(400);
      const st2 = await stats(false);
      step('shuttle', { file: v.name, shuttle, canReverse: V().canPlayReverse, canFastReverse: V().canPlayFastReverse, after: { paused: V().paused, rate: st2.rate } });
      const expect = [1, 2, 4, 6, -2, -4, -6];
      shuttle.forEach((s, i) => { if (Math.abs(s.speed - expect[i]) > Math.max(0.35, Math.abs(expect[i]) * 0.25)) problem('shuttle speed off', { file: v.name, label: s.label, speed: s.speed, expected: expect[i] }); });
      if (!V().paused || st2.rate !== 0) problem('K did not stop playback', { file: v.name, rate: st2.rate });

      // ---------------------------------------------------------------- reverse into the start
      V().currentTime = 2; await until(() => !V().seeking, 5000);
      key('j'); await sleep(2500);
      const tcs = []; for (let i = 0; i < 10; i++) { tcs.push(ws().tc); await sleep(50); }
      step('reverse into the start', { file: v.name, t: round(V().currentTime), paused: V().paused, tcs: [...new Set(tcs)] });
      if (tcs.some(x => /-/.test(x))) problem('negative timecode at the start', { file: v.name, tcs });
      if (V().currentTime > 0.1) problem('reverse did not reach the start', { file: v.name, t: V().currentTime });
      key('k'); await sleep(300);

      // ---------------------------------------------------------------- play to the end, then play again
      V().currentTime = D - 1.5; await until(() => !V().seeking, 5000);
      key(' ');
      const endMs = await until(() => V().paused, 6000);
      await sleep(300);
      const atEnd = { paused: V().paused, t: round(V().currentTime), D: round(D) };
      key(' '); await sleep(1200);
      const again = { paused: V().paused, t: round(V().currentTime) };
      key('k'); await sleep(300);
      step('end of file', { file: v.name, endMs: round(endMs, 0), atEnd, pressPlayAgain: again });
      if (!atEnd.paused) problem('did not stop at the end', { file: v.name });
      if (again.paused === false && again.t > D - 0.2) problem('play at the end: playing but not moving', { file: v.name, again });

      // ---------------------------------------------------------------- expand the event table while playing
      V().currentTime = 20; await until(() => !V().seeking, 5000);
      key(' '); await sleep(500); timeline();
      t = now();
      key('e'); await sleep(700); key('e'); await sleep(700);
      const tlE = timeline();
      key(' '); await sleep(200);
      step('expand/collapse table while playing', { file: v.name, worstPageFrameMs: rafWorst(t), worstEventGapMs: round(gapsOf(tlE), 0) });
    }

    // ---------------------------------------------------------------- switching episodes quickly while playing
    if (order.length > 1) {
      await selectVideo(order[0].name); await until(() => V().readyState >= 1, 20000);
      key(' '); await sleep(1000);
      t = now();
      const seq = [];
      for (let i = 0; i < 12; i++) { const v = order[(i + 1) % order.length]; seq.push(v.name); selectVideo(v.name); await sleep(i % 3 === 0 ? 50 : 350); }
      const lastName = seq[seq.length - 1];
      const ok = await until(() => Player.currentVideoFile() && Player.currentVideoFile().name === lastName && V().readyState >= 1, 20000);
      await sleep(500);
      const a = V().currentTime; key(' '); await sleep(2000); const b = V().currentTime; key(' ');
      step('rapid episode switching (12 switches)', { ms: round(now() - t, 0), settledMs: round(ok, 0), expected: lastName, got: Player.currentVideoFile() && Player.currentVideoFile().name, duration: round(V().duration, 2), playsAfter: round(b - a, 2), worstPageFrameMs: rafWorst(t), errors: R.errors.length });
      if (ok == null) problem('did not settle on the last episode', { expected: lastName });
      if (b - a < 1.5) problem('not playing properly after switching', { moved: round(b - a, 2) });
      const exp = state.videos.find(v => v.name === lastName);
      if (exp && exp.probe && Math.abs(V().duration - exp.probe.duration) > 0.5) problem('duration belongs to another episode', { got: V().duration, expected: exp.probe.duration });
    }

    // ---------------------------------------------------------------- big subtitle file: list + table
    const big = state.subs.find(r => /_GER_/.test(r.name));   // the 1,500-event file
    if (big) {
      t = now(); await openSubtitle(big); await sleep(50);
      const items = await until(() => document.querySelectorAll('#cueListContainer .cue-item').length > 1000, 10000);
      step('open 1,500-event subtitle', { ms: round(now() - t, 0), listed: document.querySelectorAll('#cueListContainer .cue-item').length, worstPageFrameMs: rafWorst(t) });
      t = now(); key('e'); await sleep(600);
      step('expand table (1,500 rows)', { ms: round(now() - t, 0), rows: document.querySelectorAll('#evTable tbody tr').length, worstPageFrameMs: rafWorst(t) });
      t = now(); const inp = document.getElementById('searchInput'); inp.value = 'the'; inp.dispatchEvent(new Event('input', { bubbles: true })); await sleep(400);
      step('search while expanded', { ms: round(now() - t, 0), worstPageFrameMs: rafWorst(t) });
      inp.value = ''; inp.dispatchEvent(new Event('input', { bubbles: true }));
      key('e'); await sleep(400);
    }
    step('memory', { jsHeapMB: performance.memory ? round(performance.memory.usedJSHeapSize / 1e6, 1) : null });
  } catch (e) {
    problem('test script crashed', { err: String(e && (e.stack || e.message) || e) });
  }
  rafOn = false;
  R.finished = new Date().toISOString();
  step('done', { problems: R.problems.length, errors: R.errors.length });
  Native.call('selftestDone', { json: JSON.stringify(R, null, 1) });
})();
