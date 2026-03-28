# -*- mode: python ; coding: utf-8 -*-
import os

from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata

block_cipher = None
version = os.environ.get("ORBITDECK_VERSION", "0.0.0")
project_root = os.path.abspath(os.getcwd())
icom_lan_src_root = os.path.join(project_root, "references", "icom-lan", "src")

datas = collect_data_files("app") + copy_metadata("pywebview")
seeded_data_root = os.path.join(project_root, "data")
seeded_data_files = [
    os.path.join(seeded_data_root, "frequency_guides.json"),
]
for seeded_file in seeded_data_files:
    if os.path.isfile(seeded_file):
        datas.append((seeded_file, os.path.relpath(os.path.dirname(seeded_file), project_root)))
if os.path.isdir(icom_lan_src_root):
    for root, _, files in os.walk(icom_lan_src_root):
        rel_root = os.path.relpath(root, project_root)
        for filename in files:
            if filename == ".DS_Store":
                continue
            datas.append((os.path.join(root, filename), rel_root))
hiddenimports = (
    collect_submodules("app")
    + collect_submodules("uvicorn")
    + collect_submodules("webview")
    + ["CoreLocation"]
)


a = Analysis(
    [os.path.join(project_root, "app", "desktop_main.py")],
    pathex=[project_root],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="OrbitDeck",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="OrbitDeck",
)
app = BUNDLE(
    coll,
    name="OrbitDeck.app",
    icon=os.environ.get("ORBITDECK_ICON_PATH", os.path.join(project_root, "packaging", "macos", "OrbitDeck.icns")),
    bundle_identifier="com.orbitdeck.app",
    info_plist={
        "CFBundleName": "OrbitDeck",
        "CFBundleDisplayName": "OrbitDeck",
        "CFBundleShortVersionString": version,
        "CFBundleVersion": version,
        "LSMinimumSystemVersion": "12.0",
        "NSLocationWhenInUseUsageDescription": "OrbitDeck uses your location to resolve station coordinates for pass predictions and APRS features.",
        "NSLocationUsageDescription": "OrbitDeck uses your location to resolve station coordinates for pass predictions and APRS features.",
    },
)
