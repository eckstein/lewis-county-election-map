"""Draws site/favicon.ico and site/apple-touch-icon.png to match site/favicon.svg.

Run after changing the SVG's colors or layout: python scripts/make_favicon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

SITE = Path(__file__).resolve().parent.parent / "site"
# (x, y, fill) for each 21x21 tile on the 64x64 canvas, as in favicon.svg.
TILES = [(9, 9, "#dbe8f4"), (34, 9, "#6fa3d0"), (9, 34, "#a8c8e4"), (34, 34, "#ffffff")]


def draw(size, rounded=True):
    big = size * 8  # draw large and downsample for smooth edges
    k = big / 64
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, big - 1, big - 1), radius=12 * k if rounded else 0, fill="#1d5c8f")
    for x, y, fill in TILES:
        d.rounded_rectangle((x * k, y * k, (x + 21) * k, (y + 21) * k), radius=3 * k, fill=fill)
    return img.resize((size, size), Image.LANCZOS)


# iOS rounds the corners itself and shows transparency as black, so no rounding there.
draw(180, rounded=False).convert("RGB").save(SITE / "apple-touch-icon.png")
draw(48).save(SITE / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
print("wrote favicon.ico and apple-touch-icon.png")
