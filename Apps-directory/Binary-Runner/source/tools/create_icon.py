"""Create the small monochrome app icon using only Python's standard library."""

from __future__ import annotations

import struct
import zlib
from pathlib import Path


def chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def main() -> None:
    size = 112
    pixels = [[(0, 0, 0) for _ in range(size)] for _ in range(size)]

    def thick_line(start: tuple[int, int], end: tuple[int, int], radius: int = 4) -> None:
        x1, y1 = start
        x2, y2 = end
        dx, dy = abs(x2 - x1), abs(y2 - y1)
        sx, sy = (1 if x1 < x2 else -1), (1 if y1 < y2 else -1)
        error = dx - dy
        while True:
            for y in range(max(0, y1 - radius), min(size, y1 + radius + 1)):
                for x in range(max(0, x1 - radius), min(size, x1 + radius + 1)):
                    pixels[y][x] = (255, 255, 255)
            if x1 == x2 and y1 == y2:
                break
            doubled = 2 * error
            if doubled > -dy:
                error -= dy
                x1 += sx
            if doubled < dx:
                error += dx
                y1 += sy

    thick_line((31, 28), (55, 56))
    thick_line((55, 56), (31, 84))
    thick_line((62, 79), (84, 79))
    raw = b"".join(b"\x00" + bytes(channel for pixel in row for channel in pixel) for row in pixels)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    target = Path(__file__).resolve().parents[1] / "icons" / "icon-112.png"
    target.parent.mkdir(exist_ok=True)
    target.write_bytes(png)
    print(f"Wrote {target}")


if __name__ == "__main__":
    main()
