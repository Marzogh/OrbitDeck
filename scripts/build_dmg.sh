#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-${ORBITDECK_VERSION:-0.0.0}}"
BUILD_DIR="$ROOT_DIR/dist/macos"
APP_DIR="$ROOT_DIR/dist/OrbitDeck.app"
DMG_NAME="OrbitDeck-${VERSION}-macos-arm64.dmg"
DMG_PATH="$ROOT_DIR/dist/${DMG_NAME}"
STAGE_DIR="$BUILD_DIR/dmg-stage"
CLEAN_APP_DIR="$BUILD_DIR/OrbitDeck-clean.app"
ICON_ICNS="$ROOT_DIR/packaging/macos/OrbitDeck.icns"
ICON_PNG="$ROOT_DIR/packaging/macos/OrbitDeck.png"
GENERATED_ICON_ICNS="$BUILD_DIR/OrbitDeck-generated.icns"
GENERATED_ICONSET_DIR="$BUILD_DIR/OrbitDeck.iconset"
MASTER_ICON_PNG="$BUILD_DIR/OrbitDeck-master.png"

rewrite_static_asset_versions() {
  local bundle="$1"
  local static_root="$bundle/Contents/Resources/app/static"
  if [[ ! -d "$static_root" ]]; then
    return
  fi
  ORBITDECK_STATIC_ROOT="$static_root" python3 <<'PY'
from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path

static_root = Path(os.environ["ORBITDECK_STATIC_ROOT"])
asset_files = sorted(
    path for path in static_root.rglob("*") if path.is_file() and path.suffix in {".js", ".css"}
)
digest = hashlib.sha256()
for path in asset_files:
    digest.update(path.relative_to(static_root).as_posix().encode("utf-8"))
    digest.update(b"\0")
    digest.update(path.read_bytes())
token = digest.hexdigest()[:12]

pattern = re.compile(r'((?:src|href)=["\'])(/static/[^"\']+\.(?:js|css))(?:\?v=[^"\']*)?(["\'])')
for html_path in sorted(static_root.rglob("*.html")):
    original = html_path.read_text(encoding="utf-8")
    updated = pattern.sub(rf"\1\2?v={token}\3", original)
    if updated != original:
        html_path.write_text(updated, encoding="utf-8")
PY
}

clear_xattrs() {
  local target="$1"
  if [[ ! -e "$target" ]]; then
    return
  fi
  xattr -cr "$target" 2>/dev/null || true
  xattr -d com.apple.FinderInfo "$target" 2>/dev/null || true
  xattr -d "com.apple.fileprovider.fpfs#P" "$target" 2>/dev/null || true
  xattr -d com.apple.provenance "$target" 2>/dev/null || true
  xattr -d com.apple.quarantine "$target" 2>/dev/null || true
  xattr -d com.apple.macl "$target" 2>/dev/null || true
  xattr -d com.apple.metadata:kMDItemWhereFroms "$target" 2>/dev/null || true
  xattr -d com.apple.lastuseddate#PS "$target" 2>/dev/null || true
}

clear_bundle_root_xattrs() {
  local bundle="$1"
  if [[ ! -e "$bundle" ]]; then
    return
  fi
  xattr -d com.apple.FinderInfo "$bundle" 2>/dev/null || true
  xattr -d 'com.apple.fileprovider.fpfs#P' "$bundle" 2>/dev/null || true
  xattr -d com.apple.provenance "$bundle" 2>/dev/null || true
}

strip_bundle_metadata() {
  local bundle="$1"
  if [[ ! -e "$bundle" ]]; then
    return
  fi
  xattr -cr "$bundle" 2>/dev/null || true
  xattr -r -d com.apple.FinderInfo "$bundle" 2>/dev/null || true
  xattr -r -d 'com.apple.fileprovider.fpfs#P' "$bundle" 2>/dev/null || true
  xattr -r -d com.apple.provenance "$bundle" 2>/dev/null || true
  xattr -r -d com.apple.quarantine "$bundle" 2>/dev/null || true
  xattr -r -d com.apple.ResourceFork "$bundle" 2>/dev/null || true
  find "$bundle" -exec xattr -c {} + 2>/dev/null || true
  find "$bundle" -exec xattr -d com.apple.FinderInfo {} + 2>/dev/null || true
  find "$bundle" -exec xattr -d 'com.apple.fileprovider.fpfs#P' {} + 2>/dev/null || true
  find "$bundle" -exec xattr -d com.apple.provenance {} + 2>/dev/null || true
  find "$bundle" -exec xattr -d com.apple.quarantine {} + 2>/dev/null || true
  find "$bundle" -exec xattr -d com.apple.ResourceFork {} + 2>/dev/null || true
}

cd "$ROOT_DIR"
rm -rf build "$APP_DIR" "$DMG_PATH"
if [[ -d "$BUILD_DIR" ]]; then
  find "$BUILD_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  rm -rf "$BUILD_DIR"/.[!.]* "$BUILD_DIR"/..?* 2>/dev/null || true
  rmdir "$BUILD_DIR" 2>/dev/null || true
fi
mkdir -p "$BUILD_DIR" "$ROOT_DIR/build/OrbitDeck"
clear_xattrs "$ICON_ICNS"
clear_xattrs "$ICON_PNG"
if [[ -f "$ICON_PNG" ]]; then
  rm -rf "$GENERATED_ICONSET_DIR"
  mkdir -p "$GENERATED_ICONSET_DIR"
  python3 <<'PY'
from pathlib import Path

from PIL import Image, ImageOps

src = Path("packaging/macos/OrbitDeck.png")
master = Path("dist/macos/OrbitDeck-master.png")
master.parent.mkdir(parents=True, exist_ok=True)

img = Image.open(src).convert("RGBA")
alpha = img.getchannel("A")
bbox = alpha.getbbox()
trimmed = img.crop(bbox) if bbox else img
fitted = ImageOps.fit(trimmed, (1024, 1024), method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))
fitted.save(master)
PY
  clear_xattrs "$MASTER_ICON_PNG"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$MASTER_ICON_PNG" --out "$GENERATED_ICONSET_DIR/icon_${size}x${size}.png" >/dev/null
    double_size=$((size * 2))
    sips -z "$double_size" "$double_size" "$MASTER_ICON_PNG" --out "$GENERATED_ICONSET_DIR/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$GENERATED_ICONSET_DIR" -o "$GENERATED_ICON_ICNS"
  clear_xattrs "$GENERATED_ICONSET_DIR"
  clear_xattrs "$GENERATED_ICON_ICNS"
  export ORBITDECK_ICON_PATH="$GENERATED_ICON_ICNS"
fi
ORBITDECK_VERSION="$VERSION" python3 -m PyInstaller packaging/macos/OrbitDeck.spec --noconfirm
rewrite_static_asset_versions "$APP_DIR"
clear_xattrs "$APP_DIR"
clear_bundle_root_xattrs "$APP_DIR"
strip_bundle_metadata "$APP_DIR"
rm -rf "$CLEAN_APP_DIR"
ditto --norsrc --noqtn "$APP_DIR" "$CLEAN_APP_DIR"
strip_bundle_metadata "$CLEAN_APP_DIR"
codesign --force --deep --sign - "$CLEAN_APP_DIR"

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"
ditto --norsrc --noqtn "$CLEAN_APP_DIR" "$STAGE_DIR/OrbitDeck.app"
ln -s /Applications "$STAGE_DIR/Applications"

hdiutil create \
  -volname "OrbitDeck" \
  -srcfolder "$STAGE_DIR" \
  -ov -format UDZO \
  "$DMG_PATH"

echo "$DMG_PATH"
