"""Build the static on-phone payload list from the bundled files."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PAYLOADS = ROOT / "payloads"
MAX_BYTES = 16 * 1024 * 1024


def inspect(path: Path, kind: str) -> dict[str, object]:
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"Only regular files can be bundled: {path}")
    if not path.name or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-" for c in path.name):
        raise ValueError(f"Use a simple ASCII filename: {path.name}")
    data = path.read_bytes()
    if not data or len(data) > MAX_BYTES:
        raise ValueError(f"Payload size must be 1-{MAX_BYTES} bytes: {path.name}")
    if kind == "binary":
        if len(data) < 20 or data[:6] != b"\x7fELF\x01\x01" or int.from_bytes(data[18:20], "little") != 40:
            raise ValueError(f"Expected a 32-bit little-endian ARM ELF: {path.name}")
    elif not data.startswith(b"#!/system/bin/sh\n"):
        raise ValueError(f"Script must start with #!/system/bin/sh: {path.name}")
    return {
        "name": path.name,
        "kind": kind,
        "path": path.relative_to(ROOT).as_posix(),
        "size": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def main() -> None:
    entries = []
    for folder, kind in (("binaries", "binary"), ("scripts", "script")):
        folder_path = PAYLOADS / folder
        if not folder_path.exists():
            continue
        for path in sorted(folder_path.iterdir()):
            if path.name == ".gitkeep":
                continue
            entries.append(inspect(path, kind))
    target = PAYLOADS / "catalog.json"
    target.write_text(json.dumps(entries, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(entries)} payloads to {target}")


if __name__ == "__main__":
    main()
