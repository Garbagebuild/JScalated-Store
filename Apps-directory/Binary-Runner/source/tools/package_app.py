"""Build a self-contained KaiOS application.zip from this project."""

from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

from build_catalog import main as build_catalog
from build_binary_xpi import main as build_binary_xpi

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
OUTPUT = DIST / "application.zip"
APP_FILES = (
    ROOT / "manifest.webmanifest",
    ROOT / "manifest.en-US.webmanifest",
    ROOT / "index.html",
    ROOT / "style.css",
    ROOT / "runner.js",
    ROOT / "icons" / "icon-112.png",
    ROOT / "payloads" / "catalog.json",
    ROOT / "payloads" / "binary-installer.xpi",
    ROOT / "payloads" / "binary-installer-meta.json",
)


def validate_manifest() -> None:
    manifest = json.loads((ROOT / "manifest.webmanifest").read_text(encoding="utf-8"))
    features = manifest.get("b2g_features", {})
    permissions = features.get("permissions", {})
    if features.get("core") is not True:
        raise ValueError("manifest.webmanifest must set b2g_features.core to true")
    if permissions.get("webapps-manage") is None:
        raise ValueError("manifest.webmanifest must request webapps-manage")
    if permissions.get("device-storage:apps", {}).get("access") != "readwrite":
        raise ValueError("manifest.webmanifest must request read/write apps storage")
    if manifest.get("start_url") != "/index.html":
        raise ValueError("manifest.webmanifest must launch /index.html")
    if manifest.get("version") != features.get("version"):
        raise ValueError("Top-level and b2g_features versions must match")


def main() -> None:
    build_catalog()
    build_binary_xpi()
    validate_manifest()
    missing = [path.relative_to(ROOT).as_posix() for path in APP_FILES if not path.is_file()]
    if missing:
        raise FileNotFoundError("Missing app files: " + ", ".join(missing))

    payload_entries = json.loads((ROOT / "payloads" / "catalog.json").read_text(encoding="utf-8"))
    payload_files = []
    for entry in payload_entries:
        payload = ROOT / entry["path"]
        if payload.is_symlink() or not payload.is_file():
            raise ValueError(f"Catalog payload is not a regular file: {entry['path']}")
        payload_files.append(payload)

    DIST.mkdir(exist_ok=True)
    with zipfile.ZipFile(OUTPUT, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for folder in ("payloads/binaries/", "payloads/scripts/"):
            archive.writestr(folder, "")
        for path in (*APP_FILES, *payload_files):
            archive.write(path, path.relative_to(ROOT).as_posix())

    with zipfile.ZipFile(OUTPUT) as archive:
        bad_entry = archive.testzip()
        if bad_entry:
            raise zipfile.BadZipFile(f"Package entry failed CRC check: {bad_entry}")
        if "manifest.webmanifest" not in archive.namelist():
            raise zipfile.BadZipFile("Package is missing its root manifest")
    print(f"Built {OUTPUT} ({len(payload_files)} bundled payloads)")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Package build failed: {error}", file=sys.stderr)
        raise
