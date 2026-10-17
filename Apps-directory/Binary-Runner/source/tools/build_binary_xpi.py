"""Build the separate, one-shot Binary Runner profile extension."""

from __future__ import annotations

import hashlib
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "binary-installer-xpi"
OUTPUT = ROOT / "payloads" / "binary-installer.xpi"
METADATA = ROOT / "payloads" / "binary-installer-meta.json"
EXPECTED_NAMES = {"ghostlock_armv7", "ghostlock_nokia2760"}


def main() -> None:
    catalog = json.loads((ROOT / "payloads" / "catalog.json").read_text(encoding="utf-8"))
    binaries = {entry["name"]: {"size": entry["size"], "sha256": entry["sha256"]}
                for entry in catalog if entry["kind"] == "binary"}
    if set(binaries) != EXPECTED_NAMES:
        raise ValueError("The installer allowlist must match the two bundled binaries")

    manifest = (SOURCE / "manifest.json").read_bytes()
    schema = (SOURCE / "schema.json").read_bytes()
    template = (SOURCE / "api.template.js").read_text(encoding="utf-8")
    if template.count("__ALLOWLIST__") != 1:
        raise ValueError("Expected one allowlist placeholder")
    api = template.replace("__ALLOWLIST__", json.dumps(binaries, sort_keys=True))
    if any(token in api for token in ("ctl.restart", "ctl.reboot", "process.runAsync([\"--root-daemon\"")):
        raise ValueError("Installer contains a forbidden service or boot action")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    (ROOT / "dist").mkdir(exist_ok=True)
    (ROOT / "dist" / "binary-installer-api.generated.js").write_text(api, encoding="utf-8")
    with zipfile.ZipFile(OUTPUT, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in (("manifest.json", manifest), ("schema.json", schema),
                              ("api.js", api.encode("utf-8"))):
            info = zipfile.ZipInfo(name, date_time=(2026, 10, 17, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, content)
    with zipfile.ZipFile(OUTPUT) as archive:
        if archive.testzip() is not None:
            raise zipfile.BadZipFile("Binary installer XPI failed ZIP verification")

    data = OUTPUT.read_bytes()
    metadata = {"file": OUTPUT.name, "size": len(data),
                "sha256": hashlib.sha256(data).hexdigest()}
    METADATA.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(f"Built {OUTPUT} ({metadata['sha256']})")


if __name__ == "__main__":
    main()
