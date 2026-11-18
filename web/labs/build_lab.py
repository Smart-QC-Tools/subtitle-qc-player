#!/usr/bin/env python3
"""Builds the feasibility test page (one self-contained file): web/labs/dist/analysis-feasibility.html.
The ProRes decoder (prores/prores.wasm, see prores/build.sh) is embedded in it."""
import base64, os
here = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(here, 'analysis-feasibility.src.html'), encoding='utf-8').read()
wasm = base64.b64encode(open(os.path.join(here, 'prores', 'prores.wasm'), 'rb').read()).decode()
os.makedirs(os.path.join(here, 'dist'), exist_ok=True)
out = os.path.join(here, 'dist', 'analysis-feasibility.html')
open(out, 'w', encoding='utf-8').write(src.replace('__PRORES_WASM_B64__', wasm))
print(out, os.path.getsize(out))
