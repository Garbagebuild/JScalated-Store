"""Check the built-in catalogue against the URL contract of Store 1.2.4."""

from __future__ import annotations

import json
import re
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
PACKAGE_PREFIX = (
    "https://github.com/Garbagebuild/JScalated-Store/"
    "releases/download/jscalated-apps-1/"
)


def validate_stable_https_url(folder: str, field: str, value: object) -> None:
    if not isinstance(value, str) or not value or re.search(r"[\\\s]", value):
        raise ValueError(f"{folder}: invalid {field}")
    try:
        url = urlsplit(value)
        valid = (
            url.scheme == "https"
            and bool(url.hostname)
            and url.username is None
            and url.password is None
            and not url.query
            and not url.fragment
            and bool(url.path)
        )
    except ValueError:
        valid = False
    if not valid:
        raise ValueError(f"{folder}: {field} must be a stable HTTPS URL")


def main() -> None:
    catalog = json.loads((ROOT / "webapps.json").read_text(encoding="utf-8"))
    if catalog.get("schema") != 1 or not isinstance(catalog.get("apps"), list):
        raise ValueError("Unsupported webapps.json catalogue")

    seen_folders: set[str] = set()
    seen_packages: set[str] = set()
    hosted_count = 0
    for app in catalog["apps"]:
        folder = app.get("folder")
        if not isinstance(folder, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", folder):
            raise ValueError(f"Invalid app folder: {folder!r}")
        if folder in seen_folders:
            raise ValueError(f"Duplicate app folder: {folder}")
        seen_folders.add(folder)

        if app.get("type") == "pwa":
            for field in ("manifest_url", "source_url"):
                validate_stable_https_url(folder, field, app.get(field))
            if not isinstance(app.get("id"), str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", app["id"]):
                raise ValueError(f"{folder}: invalid hosted app id")
            if not isinstance(app.get("version"), str) or not app["version"]:
                raise ValueError(f"{folder}: invalid hosted app version")
            if "package_url" in app or "sha256" in app:
                raise ValueError(f"{folder}: hosted app must use its manifest URL, not a ZIP")
            app_dir = ROOT / "Apps-directory" / folder
            source = app_dir / "SOURCE.md"
            if not source.is_file() or app["source_url"] not in source.read_text(encoding="utf-8"):
                raise ValueError(f"{folder}: SOURCE.md must credit the upstream repository")
            icon = app_dir / "icon-56.png"
            if not icon.is_file():
                raise ValueError(f"{folder}: missing 56x56 icon")
            data = icon.read_bytes()
            if data[:16] != b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" or int.from_bytes(data[16:20], "big") != 56 or int.from_bytes(data[20:24], "big") != 56:
                raise ValueError(f"{folder}: icon-56.png must be a 56x56 PNG")
            hosted_count += 1
            continue
        if app.get("type", "packaged") != "packaged":
            raise ValueError(f"{folder}: unsupported app type")

        if "update_url" in app:
            validate_stable_https_url(folder, "update_url", app["update_url"])
            if not (ROOT / "Apps-directory" / folder / "SOURCE.md").is_file():
                raise ValueError(f"{folder}: developer-maintained app needs SOURCE.md")

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

    print(f"Validated {len(seen_folders) - hosted_count} release-backed and {hosted_count} hosted app entries")


if __name__ == "__main__":
    main()
