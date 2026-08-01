#!/usr/bin/env python3
"""
Draws standalone/icon.icns, the app icon used by the .app bundle.

Written without image libraries so it runs anywhere: the shapes are rasterised
with 3x supersampling, encoded as PNGs by hand and packed into an ICNS
container. Run it only when the icon design changes — the result is checked in.

    python3 standalone/make-icon.py
"""

import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent / "icon.icns"

# Rounded-square background, amber, slightly darker towards the bottom.
BG_TOP = (180, 83, 9)
BG_BOTTOM = (124, 45, 18)
PAPER = (250, 250, 249)
FOLD = (214, 211, 209)
LINE = (168, 162, 158)
ACCENT = (180, 83, 9)

CORNER_RADIUS = 0.2237  # close to the macOS squircle
DOC = [(0.28, 0.19), (0.60, 0.19), (0.73, 0.32), (0.73, 0.81), (0.28, 0.81)]
FOLD_TRI = [(0.60, 0.19), (0.73, 0.32), (0.60, 0.32)]
BARS = [  # x0, x1, y0, y1, colour
    (0.35, 0.66, 0.40, 0.445, LINE),
    (0.35, 0.66, 0.50, 0.545, ACCENT),
    (0.35, 0.58, 0.60, 0.645, LINE),
    (0.35, 0.52, 0.70, 0.745, LINE),
]


def in_rounded_rect(x, y, r=CORNER_RADIUS):
    cx = min(max(x, r), 1 - r)
    cy = min(max(y, r), 1 - r)
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= r * r


def in_convex(x, y, poly):
    """Point-in-polygon for convex, counter-clockwise-or-clockwise polygons."""
    sign = None
    for i in range(len(poly)):
        ax, ay = poly[i]
        bx, by = poly[(i + 1) % len(poly)]
        cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax)
        if cross == 0:
            continue
        current = cross > 0
        if sign is None:
            sign = current
        elif sign != current:
            return False
    return True


def sample(x, y):
    """Colour at a normalised point, or None where the icon is transparent."""
    if not in_rounded_rect(x, y):
        return None
    for x0, x1, y0, y1, colour in BARS:
        if x0 <= x <= x1 and y0 <= y <= y1 and in_convex(x, y, DOC):
            return colour
    if in_convex(x, y, FOLD_TRI):
        return FOLD
    if in_convex(x, y, DOC):
        return PAPER
    t = y
    return tuple(round(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3))


def render(size, ss=3):
    """RGBA bytes for one icon size, supersampled ss x ss per pixel."""
    rows = []
    step = 1.0 / (size * ss)
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r = g = b = a = 0
            for sy in range(ss):
                y = (py * ss + sy + 0.5) * step
                for sx in range(ss):
                    x = (px * ss + sx + 0.5) * step
                    colour = sample(x, y)
                    if colour is not None:
                        r += colour[0]
                        g += colour[1]
                        b += colour[2]
                        a += 255
            n = ss * ss
            covered = a // 255
            if covered == 0:
                row += b"\x00\x00\x00\x00"
            else:
                row += bytes((r // covered, g // covered, b // covered, a // n))
        rows.append(bytes(row))
    return rows


def png(size, rows):
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


# icns type -> pixel size. Equal sizes share one rendering.
TYPES = {
    b"icp4": 16,
    b"icp5": 32,
    b"ic11": 32,
    b"icp6": 64,
    b"ic12": 64,
    b"ic07": 128,
    b"ic13": 256,
    b"ic08": 256,
    b"ic09": 512,
    b"ic14": 512,
}


def main():
    cache = {}
    entries = b""
    for tag, size in TYPES.items():
        if size not in cache:
            print(f"  rendere {size}x{size}…", flush=True)
            cache[size] = png(size, render(size, ss=2 if size >= 512 else 3))
        data = cache[size]
        entries += tag + struct.pack(">I", len(data) + 8) + data

    icns = b"icns" + struct.pack(">I", len(entries) + 8) + entries
    OUT.write_bytes(icns)
    print(f"Geschrieben: {OUT} ({len(icns) // 1024} KB, {len(TYPES)} Varianten)")


if __name__ == "__main__":
    main()
