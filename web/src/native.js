/* ==========================================================================
   Native Mac app bridge. When the page runs inside the Subtitle QC Player app
   (WKWebView), folders, files, video playback, waveforms and settings go
   through the native side (AVFoundation etc.). In a normal browser NATIVE is
   false and nothing here is used.
   ========================================================================== */
const NATIVE = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.native);

const Native = (() => {
  if (!NATIVE) return null;
  document.documentElement.classList.add('native');
  const handler = window.webkit.messageHandlers.native;
  const call = (cmd, args = {}) => handler.postMessage(Object.assign({ cmd }, args));
  const post = (cmd, args = {}) => { call(cmd, args).catch(() => {}); };

  // ---- events from the native side
  const listeners = {};
  const on = (type, fn) => (listeners[type] = listeners[type] || []).push(fn);
  window.__nativeEvent = (type, data) => {
    for (const fn of listeners[type] || []) { try { fn(data); } catch (e) { console.error(e); } }
  };

  // ---- log errors to ~/Library/Logs/Subtitle QC Player/app.log (helps when something goes wrong on a Mac)
  const log = (level, msg) => post('log', { level, msg: String(msg).slice(0, 4000) });
  window.addEventListener('error', e => log('error', `${e.message} @ ${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', e => log('error', 'Unhandled: ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason)));
  const origErr = console.error.bind(console);
  console.error = (...a) => { origErr(...a); log('error', a.map(x => x && x.stack || String(x)).join(' ')); };

  const b64ToBuffer = (b64) => {
    const bin = atob(b64 || ''), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  };

  // ---- files and folders (shaped like the browser's File and directory-handle objects)
  class NFile {
    constructor(info) { this.name = info.name; this.path = info.path; this.size = info.size; this.lastModified = info.mtime || 0; this.type = ''; }
    async _read(start, end) {
      if (end <= start) return new ArrayBuffer(0);
      try { return b64ToBuffer(await call('read', { path: this.path, start, end })); }
      catch (e) { const err = new Error(String(e && e.message || e)); err.name = 'NotFoundError'; throw err; }
    }
    slice(start = 0, end = this.size) {
      start = Math.max(0, Math.min(this.size, start)); end = Math.max(start, Math.min(this.size, end == null ? this.size : end));
      const f = this;
      return { size: end - start, arrayBuffer: () => f._read(start, end), text: async () => new TextDecoder().decode(await f._read(start, end)) };
    }
    arrayBuffer() { return this._read(0, this.size); }
    async text() { return new TextDecoder().decode(await this.arrayBuffer()); }
  }
  class NDir {
    constructor(path) { this.path = path; this.name = path.split('/').filter(Boolean).pop() || path; this.kind = 'directory'; }
    async *entries() {
      const list = await call('listFolder', { path: this.path });
      for (const f of list) yield [f.name, { kind: 'file', getFile: async () => new NFile(f) }];
    }
    async queryPermission() { return 'granted'; }
    async requestPermission() { return 'granted'; }
  }
  async function pickFolder(kind, startPath) {
    const path = await call('pickFolder', { kind, start: startPath || '' });
    return path ? new NDir(path) : null;
  }

  // ---- settings: kept by the app (survive restarts regardless of WebKit storage)
  const store = Object.assign({}, window.__nativeStore || {});
  const Settings = {
    get: (k) => (k in store ? store[k] : null),
    set: (k, v) => { store[k] = String(v); post('storeSet', { key: k, value: String(v) }); },
    del: (k) => { delete store[k]; post('storeDel', { key: k }); },
  };

  // ---- video: a <div> that behaves like a <video> element; the picture itself is drawn by
  // AVFoundation in a native layer kept exactly under this element.
  let videoEl = null;
  function createVideo() {
    const el = document.createElement('div');
    el.className = 'native-video';
    const st = { src: '', t: 0, at: 0, rate: 0, paused: true, duration: NaN, w: 0, h: 0, seeking: false, error: null,
                 volume: 1, muted: false, ready: 0, wantRate: 1, canReverse: false, canFastReverse: false, loadId: 0, seq: 0 };
    const clampT = (v) => Math.max(0, isFinite(st.duration) ? Math.min(st.duration, +v || 0) : (+v || 0));
    const fire = (type) => el.dispatchEvent(new Event(type));
    // Between the native time updates (30 a second) the position is estimated from the speed, but
    // never more than 0.12 s ahead: if playback stalls (fast reverse on H.264 does), the playhead waits.
    const now = () => {
      if (st.paused || st.seeking || !st.rate) return clampT(st.t);
      const dt = Math.min(0.12, (performance.now() - st.at) / 1000);
      return clampT(st.t + st.rate * dt);
    };
    const def = (name, get, set) => Object.defineProperty(el, name, { get, set: set || (() => {}), configurable: true });
    def('currentTime', now, (v) => {
      v = Math.max(0, +v || 0);
      if (isFinite(st.duration)) v = Math.min(st.duration, v);
      st.t = v; st.at = performance.now(); st.seeking = true;
      post('videoSeek', { t: v, seq: ++st.seq });
      fire('seeking'); fire('timeupdate');
    });
    def('paused', () => st.paused);
    def('ended', () => isFinite(st.duration) && st.t >= st.duration - 0.001);
    def('duration', () => st.duration);
    def('seeking', () => st.seeking);
    def('videoWidth', () => st.w);
    def('videoHeight', () => st.h);
    def('readyState', () => st.ready);
    def('error', () => st.error);
    def('currentSrc', () => st.src);
    def('src', () => st.src, (v) => {
      st.src = String(v || ''); st.error = null; st.ready = 0; st.duration = NaN; st.w = st.h = 0;
      st.t = 0; st.paused = true; st.rate = 0; st.seeking = false; st.loadId++;
      document.documentElement.classList.toggle('has-native-video', !!st.src);
      if (st.src) post('videoLoad', { path: st.src, id: st.loadId }); else post('videoUnload');
      fire('emptied');
    });
    def('controls', () => false);
    def('canPlayReverse', () => st.canReverse);
    def('canPlayFastReverse', () => st.canFastReverse);
    // Seek to the nearest earlier keyframe: quick, for shuttling (not frame-exact).
    el.fastSeek = (v) => {
      v = clampT(v); st.t = v; st.at = performance.now(); st.seeking = true;
      post('videoSeek', { t: v, fast: true, seq: ++st.seq });
      fire('seeking'); fire('timeupdate');
    };
    def('playbackRate', () => st.wantRate, (v) => {
      v = +v || 1; st.wantRate = v;
      if (!st.paused) { st.t = now(); st.at = performance.now(); st.rate = v; post('videoRate', { rate: v }); }
      fire('ratechange');
    });
    def('volume', () => st.volume, (v) => { st.volume = Math.max(0, Math.min(1, +v)); post('videoVolume', { volume: st.volume, muted: st.muted }); fire('volumechange'); });
    def('muted', () => st.muted, (v) => { st.muted = !!v; post('videoVolume', { volume: st.volume, muted: st.muted }); fire('volumechange'); });
    el.play = () => {
      if (!st.src) return Promise.resolve();
      // At the very end, playing forward starts again from the beginning (like any player).
      if (st.paused && st.wantRate > 0 && isFinite(st.duration) && st.t >= st.duration - 0.05) el.currentTime = 0;
      if (st.paused) {
        st.t = now(); st.at = performance.now(); st.paused = false; st.rate = st.wantRate;
        post('videoPlay', { rate: st.wantRate });
        fire('play'); fire('playing');
      }
      return Promise.resolve();
    };
    el.pause = () => {
      if (!st.paused) {
        st.t = now(); st.at = performance.now(); st.paused = true; st.rate = 0;
        post('videoPause');
        fire('pause');
      }
    };
    el.load = () => {};
    const origRemove = el.removeAttribute.bind(el);
    el.removeAttribute = (name) => { if (name === 'src') el.src = ''; else origRemove(name); };

    on('videoMeta', (d) => {
      if (d.id !== st.loadId) return;
      st.duration = d.duration; st.w = d.width; st.h = d.height; st.canReverse = !!d.canReverse; st.canFastReverse = !!d.canFastReverse; st.ready = 4;
      fire('durationchange'); fire('loadedmetadata'); fire('loadeddata'); fire('canplay'); fire('canplaythrough');
    });
    on('videoError', (d) => {
      if (d.id !== st.loadId) return;
      st.error = { code: 4, message: d.message || 'This file could not be played.' };
      fire('error');
    });
    on('videoTime', (d) => {
      if (st.seeking) return;
      st.t = clampT(d.t); st.at = performance.now();
      if (!st.paused) st.rate = d.rate || st.rate;
      fire('timeupdate');
    });
    on('videoSeeked', (d) => {
      // Only the report for the latest seek counts: an older one arriving late would pull the playhead
      // back a frame (and the next frame step would count from there).
      if (d.seq != null && d.seq !== st.seq) return;
      st.seeking = false; st.t = clampT(d.t); st.at = performance.now();
      fire('seeked'); fire('timeupdate');
    });
    on('videoState', (d) => {   // playback stopped or started on the native side (end of file, start reached in reverse …)
      if (!st.seeking) { st.t = clampT(d.t); st.at = performance.now(); }   // a seek on its way decides the position
      if (d.paused && !st.paused) { st.paused = true; st.rate = 0; fire('pause'); if (d.ended) fire('ended'); }
      else if (!d.paused && st.paused) { st.paused = false; st.rate = d.rate || 1; fire('play'); fire('playing'); }
    });
    videoEl = el;
    return el;
  }

  // Keep the native picture exactly under the stage / video element.
  let lastLayout = '';
  function reportLayout() {
    requestAnimationFrame(reportLayout);
    const stage = document.getElementById('stage');
    const visible = !!(videoEl && videoEl.isConnected && videoEl.currentSrc && document.body.dataset.tab === 'player' && stage && stage.offsetParent);
    let msg = { visible };
    if (visible) {
      const r = (e) => { const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
      msg.stage = r(stage); msg.video = r(videoEl);
    }
    const key = JSON.stringify(msg);
    if (key !== lastLayout) { lastLayout = key; post('layout', msg); }
  }
  requestAnimationFrame(reportLayout);

  // ---- waveform: same messages as the browser's background worker
  let waveSeq = 0;
  function waveWorker() {
    const id = ++waveSeq;
    const w = { onmessage: null, onerror: null, _id: id };
    on('wave', (m) => {
      if (m.id !== id || !w.onmessage) return;
      if (m.type === 'peaks') m = { type: 'peaks', start: m.start, data: new Float32Array(b64ToBuffer(m.data)), rms: new Float32Array(b64ToBuffer(m.rms)) };
      w.onmessage({ data: m });
    });
    w.postMessage = ({ file, prefs }) => post('waveStart', { id, path: file.path, prefs: prefs || {} });
    w.terminate = () => post('waveCancel', { id });
    return w;
  }

  // ---- folders / files dropped on the window (from Finder)
  on('drop', async (d) => { if (window.onNativeDrop) window.onNativeDrop(d.items || []); });

  return { call, post, on, NFile, NDir, pickFolder, Settings, createVideo, waveWorker, listFolder: (path) => call('listFolder', { path }) };
})();
