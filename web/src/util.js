/* Small helpers shared by all modules. */
// In the Mac app settings are kept by the app itself; in a browser they live in localStorage.
const Store = {
  get(k) { if (typeof NATIVE !== 'undefined' && NATIVE) return Native.Settings.get(k); try { return localStorage.getItem('slc:' + k); } catch (e) { return null; } },
  set(k, v) { if (typeof NATIVE !== 'undefined' && NATIVE) return Native.Settings.set(k, v); try { localStorage.setItem('slc:' + k, v); } catch (e) { /* storage unavailable */ } },
  del(k) { if (typeof NATIVE !== 'undefined' && NATIVE) return Native.Settings.del(k); try { localStorage.removeItem('slc:' + k); } catch (e) {} },
};
// What to call the video player in messages.
const PLAYER_NAME = (typeof NATIVE !== 'undefined' && NATIVE) ? 'This app' : 'Chrome';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = s => document.querySelector(s);

// ---- Scaling. The interface is designed for 1640 x 840. In a smaller window everything (fonts, controls,
// player) is scaled down together, to at most 80%; a bigger window keeps 100% and the layout uses the
// space. The Mac app does this itself (macOS page zoom); in the browser the page sets CSS zoom.
const DESIGN_W = 1640, DESIGN_H = 840, MIN_ZOOM = 0.8;
function uiZoom() { return (typeof NATIVE !== 'undefined' && NATIVE) ? 1 : (parseFloat(document.documentElement.style.zoom) || 1); }
function applyUiZoom() {
  if (typeof NATIVE !== 'undefined' && NATIVE) return;
  const z = Math.max(MIN_ZOOM, Math.min(1, window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H));
  document.documentElement.style.zoom = z >= 0.999 ? '' : z.toFixed(4);
}
// The window's size in the page's own units (after scaling).
const viewW = () => window.innerWidth / uiZoom(), viewH = () => window.innerHeight / uiZoom();
applyUiZoom();
window.addEventListener('resize', applyUiZoom);
