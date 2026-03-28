#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-${ORBITDECK_VERSION:-0.0.0}}"
ARCH="${ORBITDECK_DEB_ARCH:-arm64}"
PYTHON_VERSION="${ORBITDECK_DEB_PYTHON_VERSION:-311}"
PYTHON_ABI="${ORBITDECK_DEB_PYTHON_ABI:-cp311}"
TARGET_PLATFORM="${ORBITDECK_DEB_PLATFORM:-manylinux2014_aarch64}"
BUILD_DIR="$ROOT_DIR/dist/debian"
PKG_ROOT="$BUILD_DIR/pkgroot"
VENDOR_DIR="$PKG_ROOT/opt/orbitdeck/vendor/wheels"
OUTPUT_PATH="$ROOT_DIR/dist/orbitdeck_${VERSION}_${ARCH}.deb"

cd "$ROOT_DIR"
rm -rf "$BUILD_DIR" "$OUTPUT_PATH"
mkdir -p "$PKG_ROOT/opt/orbitdeck" "$VENDOR_DIR"

python3 -m pip download \
  --dest "$VENDOR_DIR" \
  --platform "$TARGET_PLATFORM" \
  --python-version "$PYTHON_VERSION" \
  --implementation cp \
  --abi "$PYTHON_ABI" \
  --only-binary=:all: \
  -r requirements.txt

cp -R app "$PKG_ROOT/opt/orbitdeck/"
cp -R data "$PKG_ROOT/opt/orbitdeck/"
cp -R scripts "$PKG_ROOT/opt/orbitdeck/"
cp requirements.txt README.md "$PKG_ROOT/opt/orbitdeck/"
mkdir -p "$PKG_ROOT/opt/orbitdeck/references/icom-lan"
cp references/icom-lan/LICENSE "$PKG_ROOT/opt/orbitdeck/references/icom-lan/LICENSE"
cp -R references/icom-lan/src "$PKG_ROOT/opt/orbitdeck/references/icom-lan/"
cp -R packaging/debian/DEBIAN "$PKG_ROOT/"
mkdir -p "$PKG_ROOT/usr/lib/systemd/system" "$PKG_ROOT/etc/xdg/autostart"
cp packaging/debian/usr/lib/systemd/system/orbitdeck.service "$PKG_ROOT/usr/lib/systemd/system/orbitdeck.service"
cp packaging/debian/etc/xdg/autostart/orbitdeck-kiosk.desktop "$PKG_ROOT/etc/xdg/autostart/orbitdeck-kiosk.desktop"

sed -i.bak "s/__VERSION__/${VERSION}/g" "$PKG_ROOT/DEBIAN/control"
rm -f "$PKG_ROOT/DEBIAN/control.bak"
chmod 0755 "$PKG_ROOT/DEBIAN/postinst" "$PKG_ROOT/DEBIAN/prerm"

find "$PKG_ROOT" -name '.DS_Store' -delete
find "$PKG_ROOT" -name '__pycache__' -type d -prune -exec rm -rf {} +
find "$PKG_ROOT" -name '*.pyc' -delete

if ! command -v dpkg-deb >/dev/null 2>&1; then
  echo "dpkg-deb is required to build the Debian package. Run this script on Debian/Ubuntu or in CI." >&2
  exit 127
fi

dpkg-deb --build "$PKG_ROOT" "$OUTPUT_PATH"
echo "$OUTPUT_PATH"
