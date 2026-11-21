import pathlib, re
import subprocess; subprocess.run(["python3","tools_make_player.py"],check=True)
R=pathlib.Path
ref=R('ref/player_v2.5.html').read_text()
css=ref.split('<style>')[1].split('</style>')[0]
css=re.sub(r'\n  body \{.*?\n  \}', '', css, flags=re.S)
css=re.sub(r'\n  h1 \{.*?\n  \}', '', css, flags=re.S)
order=['imsc_bundle.js','native.js','util.js','config.js','detector.js','match.js','tctrack.js','vtt.js','sidecar.js','qc.js','player.js','ui.js','textdetect.js','analysis.js']
# On-screen text (Video Analysis, web version): the lab's engine plus the model, ONNX Runtime Web and the ProRes decoder
# (about 35 MB) only with TEXT_MODEL=1 (fetch them first: web/labs/fetch_assets.sh). Otherwise TextDetect is null
# (the Mac app's page: its analysis is native).
import os, base64
def textdetect():
    if os.environ.get('TEXT_MODEL') != '1': return 'const TextDetect = null;'
    b64 = lambda p: base64.b64encode(R(p).read_bytes()).decode()
    t = R('src/textdetect.js').read_text()
    for inc in ('lab-video.js', 'text-engine.js'): t = t.replace('/*@include %s*/' % inc, R('labs/' + inc).read_text())
    return (t.replace('__PRORES_WASM_B64__', b64('labs/prores/prores.wasm'))
             .replace('__ORT_MJS_B64__', b64('labs/vendor/ort/ort.webgpu.bundle.min.mjs'))
             .replace('__ORT_WASM_B64__', b64('labs/vendor/ort/ort-wasm-simd-threaded.jsep.wasm'))
             .replace('__DET_MODEL_B64__', b64('labs/vendor/models/ch_PP-OCRv4_det_infer.onnx')))
src_of = lambda f: textdetect() if f == 'textdetect.js' else R('src/'+f).read_text()
js='const WAVE_WORKER_SRC = ' + __import__('json').dumps(R('src/wave_worker.js').read_text()) + ';\n' + '\n'.join(src_of(f).replace("if (typeof module !== 'undefined') module.exports = Detector;",'').replace("if (typeof module !== 'undefined') module.exports = Match;",'') for f in order)
s=R('src/template.html').read_text().replace('/*__PLAYER_CSS__*/',css).replace('/*__JS__*/',js)
R('dist').mkdir(exist_ok=True)
R('dist/Subtitle_QC_Player.html').write_text(s)
print(len(s), 'body{' in css, 'h1 {' in css)
