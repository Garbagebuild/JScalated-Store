"""Check the built-in catalogue against the URL contract of Store 1.2.4."""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGE_PREFIX = (
    "https://github.com/Garbagebuild/JScalated-Store/"
    "releases/download/jscalated-apps-1/"
)


def main() -> None:
    catalog = json.loads((ROOT / "webapps.json").read_text(encoding="utf-8"))
    if catalog.get("schema") != 1 or not isinstance(catalog.get("apps"), list):
        raise ValueError("Unsupported webapps.json catalogue")

    seen_folders: set[str] = set()
    seen_packages: set[str] = set()
    for app in catalog["apps"]:
        folder = app.get("folder")
        if not isinstance(folder, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", folder):
            raise ValueError(f"Invalid app folder: {folder!r}")
        if folder in seen_folders:
            raise ValueError(f"Duplicate app folder: {folder}")
        seen_folders.add(folder)

        package_url = app.get("package_url")
        if not isinstance(package_url, str) or not package_url.startswith(PACKAGE_PREFIX):
            raise ValueError(f"{folder}: package_url must use the shared jscalated-apps-1 release")
        asset_name = package_url[len(PACKAGE_PREFIX):]
        if not asset_name or "/" in asset_name or "?" in asset_name or "#" in asset_name or not asset_name.endswith(".zip"):
            raise ValueError(f"{folder}: invalid release asset name")
        if package_url in seen_packages:
            raise ValueError(f"{folder}: duplicate release asset URL")
        seen_packages.add(package_url)

        update_path = ROOT / "Apps-directory" / folder / "update.webmanifest"
        update = json.loads(update_path.read_text(encoding="utf-8"))
        if update.get("package_path") != package_url:
            raise ValueError(f"{folder}: update.webmanifest package_path differs from webapps.json")
        version = app.get("version")
        if not isinstance(version, str) or not version or update.get("version") != version or update.get("b2g_features", {}).get("version") != version:
            raise ValueError(f"{folder}: catalogue and update manifest versions differ")
        if not isinstance(update.get("packaged_size"), int) or update["packaged_size"] <= 0:
            raise ValueError(f"{folder}: invalid packaged_size")
        if not re.fullmatch(r"[0-9a-f]{64}", app.get("sha256", "")):
            raise ValueError(f"{folder}: invalid SHA-256")

    print(f"Validated {len(seen_folders)} release-backed app entries")


if __name__ == "__main__":
    main()
