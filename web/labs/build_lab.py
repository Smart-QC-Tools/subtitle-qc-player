#!/usr/bin/env python3
"""Builds the lab pages (each one self-contained file) into web/labs/dist/:
  analysis-feasibility.html  reading and decoding frames in Chrome, timed
  text-detection.html        finding on-screen text without reading it, timed and checked against the test episode
Shared code (lab-video.js) is inlined; the ProRes decoder (prores/prores.wasm, see prores/build.sh) is embedded.
text-detection also embeds the text detector (PP-OCRv4 det) and ONNX Runtime Web, fetched by fetch_assets.sh."""
import base64, os
here = os.path.dirname(os.path.abspath(__file__))
b64 = lambda p: base64.b64encode(open(os.path.join(here, p), 'rb').read()).decode()

def build(name, extra=None):
    src = open(os.path.join(here, name + '.src.html'), encoding='utf-8').read()
    src = src.replace('/*@include lab-video.js*/', open(os.path.join(here, 'lab-video.js'), encoding='utf-8').read())
    src = src.replace('__PRORES_WASM_B64__', b64('prores/prores.wasm'))
    # labs.yml sets the build number; a local build says so
    src = src.replace('__LAB_BUILD__', 'BUILD ' + os.environ['LAB_BUILD'] if os.environ.get('LAB_BUILD') else 'local build')
    for k, v in (extra or {}).items():
        src = src.replace(k, v)
    os.makedirs(os.path.join(here, 'dist'), exist_ok=True)
    out = os.path.join(here, 'dist', name + '.html')
    open(out, 'w', encoding='utf-8').write(src)
    print(out, round(os.path.getsize(out) / 1048576, 1), 'MB')

build('analysis-feasibility')
if os.path.exists(os.path.join(here, 'text-detection.src.html')):
    build('text-detection', {
        '__ORT_MJS_B64__': b64('vendor/ort/ort.webgpu.bundle.min.mjs'),
        '__ORT_WASM_B64__': b64('vendor/ort/ort-wasm-simd-threaded.jsep.wasm'),
        '__DET_MODEL_B64__': b64('vendor/models/ch_PP-OCRv4_det_infer.onnx'),
    })
