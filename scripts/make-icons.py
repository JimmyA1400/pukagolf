"""Draw the PukaGolf app icons: a flagstick on a green, in the clubhouse palette.

Pillow is not installed, so this writes the PNGs itself. Supersampled 4x and
box-filtered down, which is what keeps the diagonals of the pennant from
looking like a staircase at 192px.
"""

import pathlib
import struct
import zlib

FOREST_DEEP = (0x1D, 0x35, 0x21)
CREAM = (0xFA, 0xF7, 0xEC)
CLAY = (0xB0, 0x39, 0x2C)
BIRDIE = (0x4A, 0x7C, 0x4E)

OUT = pathlib.Path(__file__).resolve().parent.parent / "public"

SS = 4  # supersample factor


def png(path, pixels, width, height):
    """Write 8-bit RGB PNG. `pixels` is a flat list of (r, g, b)."""
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type 0
        for x in range(width):
            raw.extend(pixels[y * width + x])

    def chunk(tag, data):
        body = tag + data
        return (
            struct.pack(">I", len(data))
            + body
            + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def inside_triangle(px, py, a, b, c):
    def sign(p, q, r):
        return (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1])

    d1 = sign((px, py), a, b)
    d2 = sign((px, py), b, c)
    d3 = sign((px, py), c, a)
    neg = d1 < 0 or d2 < 0 or d3 < 0
    pos = d1 > 0 or d2 > 0 or d3 > 0

    return not (neg and pos)


def draw(size, inset):
    """One icon at `size`, with artwork confined to the central `inset` share.

    `inset` is what makes a maskable icon safe: Android may crop the outer 20%
    to whatever shape the launcher uses, so nothing that matters can live there.
    """
    big = size * SS
    px = [FOREST_DEEP] * (big * big)

    # Everything below is in 0..1 of the artwork box, then mapped into the inset.
    lo = (1 - inset) / 2

    def to_px(u, v):
        return (lo + u * inset) * big, (lo + v * inset) * big

    # The green: a shallow ellipse the flag stands on.
    gcx, gcy = to_px(0.5, 0.78)
    grx = 0.40 * inset * big
    gry = 0.13 * inset * big

    # Flagstick.
    sx, _ = to_px(0.44, 0)
    stick_w = max(1.0, 0.035 * inset * big)
    _, stick_top = to_px(0, 0.16)
    _, stick_bottom = to_px(0, 0.79)

    # Pennant, pointing right off the stick.
    pa = to_px(0.455, 0.17)
    pb = to_px(0.78, 0.27)
    pc = to_px(0.455, 0.37)

    # The ball, sitting on the green.
    bcx, bcy = to_px(0.63, 0.735)
    br = 0.055 * inset * big

    for y in range(big):
        for x in range(big):
            cx, cy = x + 0.5, y + 0.5
            colour = None

            if ((cx - gcx) / grx) ** 2 + ((cy - gcy) / gry) ** 2 <= 1:
                colour = BIRDIE

            if inside_triangle(cx, cy, pa, pb, pc):
                colour = CLAY

            if abs(cx - sx) <= stick_w / 2 and stick_top <= cy <= stick_bottom:
                colour = CREAM

            if (cx - bcx) ** 2 + (cy - bcy) ** 2 <= br * br:
                colour = CREAM

            if colour is not None:
                px[y * big + x] = colour

    # Box filter back down to `size`.
    out = []
    area = SS * SS
    for y in range(size):
        for x in range(size):
            r = g = b = 0
            for dy in range(SS):
                row = (y * SS + dy) * big + x * SS
                for dx in range(SS):
                    pr, pg, pb = px[row + dx]
                    r += pr
                    g += pg
                    b += pb
            out.append((r // area, g // area, b // area))

    return out, size


if __name__ == "__main__":
    for size, inset, name in [
        (192, 0.82, "icon-192.png"),
        (512, 0.82, "icon-512.png"),
        # Maskable: the artwork shrinks so a circular or squircle crop cannot
        # cut the flag off.
        (512, 0.62, "icon-maskable-512.png"),
        (180, 0.86, "apple-touch-icon.png"),
    ]:
        pixels, w = draw(size, inset)
        png(OUT / name, pixels, w, w)
        print("wrote", name, w)
