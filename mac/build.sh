#!/bin/bash
# Builds "Subtitle QC Player.app" (universal: Apple Silicon + Intel, macOS 13+) and zips it.
# Runs on GitHub's Mac build machines (see .github/workflows/build.yml); also works on any Mac
# with the Xcode command-line tools.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
# The version lives in web/src/config.js (APP_VERSION).
VERSION="${VERSION:-$(sed -nE "s/^const APP_VERSION = '([^']+)';.*/\1/p" web/src/config.js)}"
BUILD="${BUILD_NUMBER:-1}"
APP="$ROOT/build/Subtitle QC Player.app"

rm -rf "$ROOT/build"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# Runs a step; on failure reports each error as a GitHub annotation (readable without the full log).
run() {
  local log="$ROOT/build/step.log"
  if "$@" >"$log" 2>&1; then cat "$log"; return 0; fi
  cat "$log"
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    grep -E "error:" "$log" | head -45 | while IFS= read -r line; do
      f="$(echo "$line" | sed -nE 's#^.*/([^/:]+):([0-9]+):([0-9]+): error: .*#\1:\2#p')"
      m="$(echo "$line" | sed -E 's#^.*: error: ##')"
      echo "::error::${f:+$f }$m"
    done
    echo "::error::Last lines: $(tail -15 "$log" | tr '\n' '|' | cut -c1-3000)"
  fi
  exit 1
}

# 1. The interface (same single page as the web version)
run bash -c "cd '$ROOT/web' && python3 build.py"
cp "$ROOT/web/dist/Subtitle_QC_Player.html" "$APP/Contents/Resources/index.html"

# 2. The native shell, once per CPU type, then joined into one universal binary
#    ARCHS / EXTRA_SWIFT_FLAGS are only used by the self-test build (see .github/workflows/selftest.yml).
SDK="$(xcrun --show-sdk-path --sdk macosx)"
ARCHS="${ARCHS:-arm64 x86_64}"
for ARCH in $ARCHS; do
  run xcrun swiftc -O -swift-version 5 -module-name SubtitleQC -target "$ARCH-apple-macos13.0" -sdk "$SDK" ${EXTRA_SWIFT_FLAGS:-} \
    "$ROOT"/mac/Sources/*.swift -o "$ROOT/build/SubtitleQC-$ARCH"
done
lipo -create $(for ARCH in $ARCHS; do echo "$ROOT/build/SubtitleQC-$ARCH"; done) -output "$APP/Contents/MacOS/SubtitleQC"

# 3. Info.plist and icon
sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$BUILD/" "$ROOT/mac/Info.plist" > "$APP/Contents/Info.plist"
ICONSET="$ROOT/build/AppIcon.iconset"
mkdir -p "$ICONSET"
cp "$ROOT"/mac/icon/icon_*.png "$ICONSET/"
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

# 4. Ad-hoc signature (required to run on Apple Silicon; not an Apple Developer ID), with the
#    hardened runtime so no other software can inject code into the app.
codesign --force --deep --options runtime --sign - "$APP"

# 5. Zip for download
(cd "$ROOT/build" && ditto -c -k --keepParent "Subtitle QC Player.app" "Subtitle-QC-Player.zip")
echo "Built $APP ($VERSION, build $BUILD)"
