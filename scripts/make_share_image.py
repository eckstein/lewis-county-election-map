"""Draw site/share.png, the 1200x630 preview image shown when the map's link is
shared on social media, from the precinct boundaries in site/data/.

The precinct shading is decorative, not data: platforms cache preview images
for days, so real numbers in it would go stale.

Usage:
  python scripts/make_share_image.py
"""

import hashlib
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
GEOJSON = ROOT / "site" / "data" / "20261103.geojson"
OUT = ROOT / "site" / "share.png"

W, H = 1200, 630
SCALE = 2  # draw at 2x and downsample for smooth edges

BG = "#f7f7f5"
TEXT = "#1f2328"
MUTED = "#646a73"
ACCENT = "#1d5c8f"
SHADES = ["#dbe8f4", "#a8c8e4", "#6fa3d0", "#3a7bb8"]  # the map's own blue ramp

FONT_DIR = Path("C:/Windows/Fonts")


def font(name, size):
    try:
        return ImageFont.truetype(str(FONT_DIR / name), size * SCALE)
    except OSError:
        return ImageFont.load_default(size * SCALE)


def mercator(lon, lat):
    return lon, math.degrees(math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)))


def rings(geom):
    polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
    return [[mercator(*pt) for pt in poly[0]] for poly in polys]  # outer rings only


def ring_area(ring):
    return abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]))) / 2


def shade(name):
    # Stable per precinct, weighted toward the lighter shades.
    h = int(hashlib.md5(name.encode()).hexdigest(), 16)
    return SHADES[[0, 0, 1, 1, 1, 2, 2, 3][h % 8]]


def main():
    features = json.loads(GEOJSON.read_text(encoding="utf-8"))["features"]
    shapes = [(f["properties"]["name"], r) for f in features for r in rings(f["geometry"])]

    xs = [x for _, r in shapes for x, _ in r]
    ys = [y for _, r in shapes for _, y in r]
    box = (60, 236, W - 60, H - 44)  # map area
    k = min((box[2] - box[0]) / (max(xs) - min(xs)), (box[3] - box[1]) / (max(ys) - min(ys)))
    ox = box[0] + ((box[2] - box[0]) - k * (max(xs) - min(xs))) / 2
    oy = box[1] + ((box[3] - box[1]) - k * (max(ys) - min(ys))) / 2

    def px(pt):
        x, y = pt
        return ((ox + k * (x - min(xs))) * SCALE, (oy + k * (max(ys) - y)) * SCALE)

    img = Image.new("RGB", (W * SCALE, H * SCALE), BG)
    draw = ImageDraw.Draw(img)

    # Largest first, so precincts that sit inside another are drawn on top.
    shapes.sort(key=lambda s: -ring_area(s[1]))
    for name, ring in shapes:
        draw.polygon([px(p) for p in ring], fill=shade(name))
    for _, ring in shapes:
        pts = [px(p) for p in ring]
        draw.line(pts + pts[:1], fill="#ffffff", width=int(1.5 * SCALE), joint="curve")

    x = 60 * SCALE
    draw.text((x, 52 * SCALE), "WASHINGTON  ·  2026 GENERAL ELECTION", font=font("segoeuib.ttf", 21), fill=ACCENT)
    draw.text((x, 84 * SCALE), "Lewis County Election Map", font=font("segoeuib.ttf", 60), fill=TEXT)
    draw.text((x, 166 * SCALE), "Ballots received and live results, precinct by precinct", font=font("segoeui.ttf", 30), fill=MUTED)

    img.resize((W, H), Image.LANCZOS).save(OUT, optimize=True)
    print(f"wrote {OUT} ({OUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
