#!/usr/bin/env python3
"""Generate MemeDrop's app + tray icons (a grinning drop on a pink→purple tile).

Optional dev tool — the generated files are already committed in client/assets.
Requires Pillow:  pip install pillow   then   python scripts/make-icons.py
"""
import math
import os

from PIL import Image, ImageChops, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "..", "assets")
SS = 4  # supersampling factor for smooth edges

PINK = (255, 61, 139)
PURPLE = (123, 47, 247)
INK = (59, 22, 112)


def gradient(size):
    img = Image.new("RGBA", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = tuple(int(PINK[i] + (PURPLE[i] - PINK[i]) * t) for i in range(3)) + (255,)
    return img


def teardrop(cx, cy, r, tip_y, steps=180):
    """Points of a drop: circle centred (cx, cy) radius r with a point at tip_y."""
    d = cy - tip_y
    # Tangent angle from the tip to the circle.
    a = math.asin(min(1.0, r / d))
    start = -math.pi / 2 + (math.pi / 2 - a)
    pts = [(cx, tip_y)]
    sweep = 2 * math.pi - 2 * (math.pi / 2 - a)
    for i in range(steps + 1):
        ang = start + sweep * i / steps
        pts.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
    return pts


def draw_icon(size, padding=0.0, face=True):
    S = size * SS
    tile = gradient(S)
    mask = Image.new("L", (S, S), 0)
    inset = int(S * padding)
    ImageDraw.Draw(mask).rounded_rectangle(
        (inset, inset, S - 1 - inset, S - 1 - inset), radius=int((S - 2 * inset) * 0.24), fill=255
    )
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(tile, (0, 0), mask)

    d = ImageDraw.Draw(out)
    span = S - 2 * inset
    cx = S / 2
    cy = inset + span * 0.6
    r = span * 0.27
    tip = inset + span * 0.13
    d.polygon(teardrop(cx, cy, r, tip), fill=(255, 255, 255, 255))

    if face:
        ew, eh = r * 0.17, r * 0.24
        for ex in (cx - r * 0.38, cx + r * 0.38):
            ey = cy - r * 0.12
            d.ellipse((ex - ew, ey - eh, ex + ew, ey + eh), fill=INK + (255,))
        # Big grin
        gw, gh = r * 0.62, r * 0.5
        gy = cy + r * 0.12
        d.chord((cx - gw, gy - gh, cx + gw, gy + gh), start=0, end=180, fill=INK + (255,))
        tw = r * 0.34
        d.chord((cx - tw, gy + gh * 0.35, cx + tw, gy + gh * 1.0), start=0, end=180, fill=PINK + (255,))

    return out.resize((size, size), Image.LANCZOS)


def muted(img):
    gray = img.convert("LA").convert("RGBA")
    r, g, b, a = gray.split()
    a = a.point(lambda v: int(v * 0.55))
    return Image.merge("RGBA", (r, g, b, a))


def main():
    os.makedirs(ASSETS, exist_ok=True)
    big = draw_icon(512)
    big.save(os.path.join(ASSETS, "icon.png"))
    big.resize((256, 256), Image.LANCZOS).save(os.path.join(ASSETS, "icon-256.png"))

    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [draw_icon(s, face=s >= 24) for s in ico_sizes]
    frames[-1].save(os.path.join(ASSETS, "icon.ico"), sizes=[(s, s) for s in ico_sizes], append_images=frames[:-1])

    # Tray: 16px (+@2x for HiDPI); faces are unreadable at 16px so keep them for @2x only.
    for scale, suffix in ((1, ""), (2, "@2x")):
        size = 16 * scale
        icon = draw_icon(size, padding=0.0, face=scale > 1)
        icon.save(os.path.join(ASSETS, f"tray{suffix}.png"))
        muted(icon).save(os.path.join(ASSETS, f"tray-muted{suffix}.png"))
    print("Icons written to", os.path.normpath(ASSETS))


if __name__ == "__main__":
    main()
