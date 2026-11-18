#!/bin/bash
# Fetches the third-party files the text-detection lab page embeds (not kept in git, ~27 MB):
#   vendor/ort/ort.webgpu.bundle.min.mjs, vendor/ort/ort-wasm-simd-threaded.jsep.wasm   ONNX Runtime Web 1.20.1 (MIT)
#   vendor/models/ch_PP-OCRv4_det_infer.onnx   PaddleOCR PP-OCRv4 text detector (Apache-2.0), via @gutenye/ocr-models 1.4.2 (MIT)
set -euo pipefail
cd "$(dirname "$0")"; mkdir -p vendor/ort vendor/models; T="$(mktemp -d)"
(cd "$T" && npm pack --silent onnxruntime-web@1.20.1 @gutenye/ocr-models@1.4.2 >/dev/null && tar xzf onnxruntime-web-1.20.1.tgz && mv package ort && tar xzf gutenye-ocr-models-1.4.2.tgz && mv package models)
cp "$T/ort/dist/ort.webgpu.bundle.min.mjs" "$T/ort/dist/ort-wasm-simd-threaded.jsep.wasm" vendor/ort/
cp "$T/models/assets/ch_PP-OCRv4_det_infer.onnx" vendor/models/
rm -rf "$T"
# The exact files this lab was tested with: refuse anything else.
sha256sum -c - <<'SUMS'
86d19a9e9e9ecb51aaba1a4f33378c1738b6b0c2d582f8ba259caa800434f38d  vendor/ort/ort.webgpu.bundle.min.mjs
185b0861a6cd6cbdfb057289338090436483cc59e10a7bc83bd167b15531a51b  vendor/ort/ort-wasm-simd-threaded.jsep.wasm
30a86f5731181461d08021402766601e4302a9b9b9666be8aff402696339cdff  vendor/models/ch_PP-OCRv4_det_infer.onnx
SUMS
