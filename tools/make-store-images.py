"""Builds the Chrome Web Store images in docs/store/: five 1280x800
screenshots, the 440x280 small promo tile and the 1400x560 marquee tile.
Each screenshot puts a headline over the browser window: the side panel on the
left and the page next to it, from the captures in docs/store/raw/ that
tools/demo/capture.mjs saves (real sites, at twice the size), with the cursor
where it was. The tiles show the panel alone.
Needs Pillow and the Inter font. The store wants images without transparency,
so everything is saved as plain RGB."""
import json
import os
import sys
import textwrap
from PIL import Image, ImageDraw, ImageFilter, ImageFont

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'demo'))
from frame import Window, forest, ghost, make_cursor, pointer, rounded_mask, shadow_for  # noqa: E402

ROOT = os.path.join(os.path.dirname(__file__), '..')
OUT = os.path.join(ROOT, 'docs/store')
RAW = os.path.join(OUT, 'raw')
FONTS = '/usr/share/fonts/opentype/inter/'
THEMES = {
    'light': dict(bg=(240, 244, 249), title=(31, 31, 31), text=(71, 71, 71), card=(255, 255, 255), shadow=60, trees=0.7),
    'dark': dict(bg=(31, 31, 31), title=(227, 227, 227), text=(196, 199, 197), card=(40, 42, 44), shadow=140, trees=0.35),
}
SHOTS = [
    ('nest', 'Vertical tabs, as a tree',
     'Open a link in a new tab and it shows up right under the page you opened it from.'),
    ('drag', 'Drag to reorganize',
     'Drop a tab onto another to nest it. Its whole branch comes along, and Chrome’s tab strip keeps the same order.'),
    ('collapse', 'Collapse what you’re not using',
     'Point at a tab and its icon turns into an arrow. A collapsed tree shows how many tabs it hides.'),
    ('menu', 'Quick actions for every tab',
     'Right-click to duplicate, move a tree to a new window, close a branch and more.'),
    ('dark', 'Looks like part of Chrome',
     'Chrome’s own colors, fonts and shapes, in light and dark mode. Tab groups keep their colors too.'),
]
KEYFRAMES = json.load(open(os.path.join(RAW, 'keyframes.json')))
WINDOW = Window(0.8)
# Pixel art trees in the corners: (sprite, x of its left edge, pixel size).
TREES = [
    ('pine', 22, 4), ('round', 64, 3), ('bush', 100, 3),
    ('bush', 1150, 3), ('round', 1176, 3), ('pine', 1214, 4),
]


def font(name, size):
    return ImageFont.truetype(os.path.join(FONTS, name), size)


def icon(size):
    # The 128px icon has 16px of padding; crop it off before scaling.
    image = Image.open(os.path.join(ROOT, 'icons/icon128.png')).convert('RGBA')
    return image.crop((16, 16, 112, 112)).resize((size, size), Image.LANCZOS)


def card(canvas, panel, colors, x, y, width, radius):
    """Pastes the panel capture as a rounded card with a soft shadow, running off the bottom."""
    W, H = canvas.size
    panel = panel.resize((width, int(panel.height * width / panel.width)), Image.LANCZOS)
    height = H - y + 40
    shadow = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((x, y + 8, x + width, y + height + 8), radius=radius, fill=(0, 0, 0, colors['shadow']))
    canvas = Image.alpha_composite(canvas.convert('RGBA'), shadow.filter(ImageFilter.GaussianBlur(18))).convert('RGB')
    face = Image.new('RGB', (width, height), colors['card'])
    face.paste(panel.crop((0, 0, width, min(panel.height, height))), (0, 0))
    mask = Image.new('L', (width, height), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, width - 1, height - 1), radius=radius, fill=255)
    canvas.paste(face, (x, y), mask)
    return canvas


def screenshot(number, name, headline, body):
    frame = KEYFRAMES[name]
    colors = THEMES[frame['scheme']]
    W, H = 1280, 800
    x0, y0 = (W - WINDOW.width) // 2, 196
    canvas = Image.new('RGB', (W, H), colors['bg'])
    canvas = forest(canvas, TREES, H - 14, strength=colors['trees'])
    canvas = shadow_for(canvas, (x0, y0, x0 + WINDOW.width, y0 + WINDOW.height), radius=14,
                        strength=colors['shadow'], blur=18)
    window = WINDOW.draw(os.path.join(RAW, f'{name}-page.png'), os.path.join(RAW, f'{name}-panel.png'), frame['scheme'])
    canvas.paste(window, (x0, y0), rounded_mask(window.size, 14))
    if frame['cursor']:
        dragged = frame.get('ghost') and ghost(os.path.join(RAW, 'drag-source-panel.png'), frame['ghost'], WINDOW.scale)
        canvas = pointer(canvas, WINDOW.to_screen(frame['cursor'], (x0, y0)), make_cursor(0.9), dragged)
    draw = ImageDraw.Draw(canvas)
    draw.text((x0, 52), headline, font=font('InterDisplay-Bold.otf', 46), fill=colors['title'])
    for i, line in enumerate(textwrap.wrap(body, 80)):
        draw.text((x0 + 2, 120 + 32 * i), line, font=font('Inter-Regular.otf', 22), fill=colors['text'])
    # The name, small, at the top right.
    label = font('Inter-SemiBold.otf', 20)
    right = x0 + WINDOW.width
    width = draw.textlength('Tree of Tabs', font=label)
    draw.text((right - width, 66), 'Tree of Tabs', font=label, fill=colors['title'])
    logo = icon(30)
    canvas.paste(logo, (round(right - width - 40), 62), logo)
    canvas.save(os.path.join(OUT, f'screenshot-{number}-{name}.png'), optimize=True)


def promo_tile():
    colors = THEMES['light']
    W, H = 440, 280
    canvas = Image.new('RGB', (W, H), colors['bg'])
    panel = Image.open(os.path.join(OUT, 'raw/nest-panel.png')).convert('RGB')
    # Just the first rows of the tree, from below the pinned tabs.
    canvas = card(canvas, panel.crop((0, 90, 640, 1200)), colors, x=250, y=40, width=260, radius=14)
    draw = ImageDraw.Draw(canvas)
    logo = icon(56)
    canvas.paste(logo, (28, 52), logo)
    draw.text((28, 128), 'Tree of', font=font('InterDisplay-Bold.otf', 38), fill=colors['title'])
    draw.text((28, 170), 'Tabs', font=font('InterDisplay-Bold.otf', 38), fill=colors['title'])
    draw.text((29, 222), 'Vertical tabs as a tree', font=font('Inter-Regular.otf', 17), fill=colors['text'])
    canvas.save(os.path.join(OUT, 'promo-tile.png'), optimize=True)


def marquee_tile():
    """The large tile the store shows if it features the extension, in the banner's style."""
    colors = THEMES['light']
    W, H = 1400, 560
    canvas = Image.new('RGB', (W, H), colors['bg'])
    panel = Image.open(os.path.join(OUT, 'raw/nest-panel.png')).convert('RGB')
    canvas = card(canvas, panel, colors, x=W - 520 - 120, y=60, width=520, radius=24)
    draw = ImageDraw.Draw(canvas)
    logo = icon(112)
    canvas.paste(logo, (120, 96), logo)
    draw.text((118, 236), 'Tree of Tabs', font=font('InterDisplay-Bold.otf', 80), fill=colors['title'])
    for i, line in enumerate(['Vertical tabs as a tree', 'in Chrome\u2019s side panel.']):
        draw.text((121, 344 + 44 * i), line, font=font('Inter-Regular.otf', 32), fill=colors['text'])
    canvas.save(os.path.join(OUT, 'marquee-tile.png'), optimize=True)


for number, shot in enumerate(SHOTS, 1):
    screenshot(number, *shot)
promo_tile()
marquee_tile()
