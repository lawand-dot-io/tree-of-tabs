"""Renders the extension icons: indented rows on a rounded blue square."""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), '..', 'icons')
BLUE = (11, 87, 208, 255)
WHITE = (255, 255, 255, 255)


def render(size):
    s = 8  # Supersampling factor.
    n = size * s
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, n - 1, n - 1], radius=n * 0.22, fill=BLUE)
    bar_h = n * 0.13
    rows = [(0.22, 0.20), (0.44, 0.34), (0.66, 0.34)]  # (top, left) as fractions.
    for top, left in rows:
        y = n * top
        x = n * left
        d.rounded_rectangle([x, y, n * 0.80, y + bar_h], radius=bar_h / 2, fill=WHITE)
    # Tree guide connecting the parent row to its children.
    gx = n * 0.25
    w = n * 0.05
    d.rectangle([gx, n * 0.30, gx + w, n * 0.66 + bar_h / 2], fill=WHITE)
    for top, _ in rows[1:]:
        cy = n * top + bar_h / 2
        d.rectangle([gx, cy - w / 2, n * 0.34, cy + w / 2], fill=WHITE)
    return img.resize((size, size), Image.LANCZOS)


for size in (16, 32, 48, 128):
    render(size).save(os.path.join(OUT, f'icon{size}.png'))
