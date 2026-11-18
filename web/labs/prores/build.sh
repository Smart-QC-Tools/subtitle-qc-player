#!/bin/bash
# Builds prores.wasm: FFmpeg's ProRes decoder only (libavcodec + libavutil, no other codecs, no threads),
# for the browser, with wasi-sdk (https://github.com/WebAssembly/wasi-sdk, tested with 25.0).
#   WASI_SDK=/path/to/wasi-sdk-25.0  FFMPEG_SRC=/path/to/FFmpeg (tag n7.1)  bash build.sh
set -euo pipefail
cd "$(dirname "$0")"; HERE="$(pwd)"; W="${WASI_SDK:?}"; SRC="${FFMPEG_SRC:?}"
WORK="$(mktemp -d)"; mkdir -p "$WORK/build"; cd "$WORK/build"
CC="$W/bin/clang --target=wasm32-wasip1 --sysroot=$W/share/wasi-sysroot"
"$SRC/configure" --prefix="$WORK/out" --enable-cross-compile --target-os=none --arch=wasm32 \
  --cc="$CC" --ar="$W/bin/llvm-ar" --ranlib="$W/bin/llvm-ranlib" --nm="$W/bin/llvm-nm" \
  --disable-everything --enable-decoder=prores --disable-programs --disable-doc --disable-avformat --disable-avfilter \
  --disable-avdevice --disable-swresample --disable-swscale --disable-network --disable-pthreads --disable-w32threads \
  --disable-os2threads --disable-asm --disable-inline-asm --disable-x86asm --disable-debug --disable-runtime-cpudetect \
  --disable-autodetect --extra-cflags="-O3 -msimd128 -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS" >/dev/null
make -j8 >/dev/null && make install >/dev/null
$CC -O3 -msimd128 -mexec-model=reactor -D_WASI_EMULATED_PROCESS_CLOCKS -I"$WORK/out/include" "$HERE/prores_wasm.c" \
  "$WORK/out/lib/libavcodec.a" "$WORK/out/lib/libavutil.a" -lm -lwasi-emulated-process-clocks -lwasi-emulated-signal \
  -Wl,--strip-all -Wl,-z,stack-size=1048576 -Wl,--initial-memory=33554432 -Wl,--max-memory=1073741824 -o "$HERE/prores.wasm"
ls -la "$HERE/prores.wasm"
