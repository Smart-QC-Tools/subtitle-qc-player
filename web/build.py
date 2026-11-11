import pathlib, re
import subprocess; subprocess.run(["python3","tools_make_player.py"],check=True)
R=pathlib.Path
ref=R('ref/player_v2.5.html').read_text()
css=ref.split('<style>')[1].split('</style>')[0]
css=re.sub(r'\n  body \{.*?\n  \}', '', css, flags=re.S)
css=re.sub(r'\n  h1 \{.*?\n  \}', '', css, flags=re.S)
order=['imsc_bundle.js','native.js','util.js','config.js','detector.js','match.js','tctrack.js','vtt.js','sidecar.js','qc.js','player.js','ui.js','analysis.js']
js='const WAVE_WORKER_SRC = ' + __import__('json').dumps(R('src/wave_worker.js').read_text()) + ';\n' + '\n'.join(R('src/'+f).read_text().replace("if (typeof module !== 'undefined') module.exports = Detector;",'').replace("if (typeof module !== 'undefined') module.exports = Match;",'') for f in order)
s=R('src/template.html').read_text().replace('/*__PLAYER_CSS__*/',css).replace('/*__JS__*/',js)
R('dist').mkdir(exist_ok=True)
R('dist/Subtitle_QC_Player.html').write_text(s)
print(len(s), 'body{' in css, 'h1 {' in css)
