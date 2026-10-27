"""Builds the Chrome Web Store images in docs/store/: five 1280x800
screenshots and the 440x280 promo tile. Each screenshot puts a headline next
to a capture of the panel from docs/store/raw/ (taken at twice the size).
Headlines break where the \\n are; the text below them wraps by itself.
Needs Pillow and the Inter font. The store wants images without transparency,
so everything is saved as plain RGB."""
import os
import textwrap
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.join(os.path.dirname(__file__), '..')
OUT = os.path.join(ROOT, 'docs/store')
FONTS = '/usr/share/fonts/opentype/inter/'
THEMES = {
    'light': dict(bg=(240, 244, 249), title=(31, 31, 31), text=(71, 71, 71), card=(255, 255, 255), shadow=60),
    'dark': dict(bg=(31, 31, 31), title=(227, 227, 227), text=(196, 199, 197), card=(40, 42, 44), shadow=140),
}
SHOTS = [
    ('nest', 'light', 'Tabs nest under the\npage they came from',
     'Open a link in a new tab and it shows up right under the page you opened it from. '
     'Tabs you open yourself start their own tree.'),
    ('drag', 'light', 'Drag to\nreorganize',
     'Drop a tab onto another to nest it, or between tabs to move it. Its whole branch comes '
     'along, and Chrome’s tab strip stays in the same order.'),
    ('collapse', 'light', 'Collapse what\nyou’re not using',
     'Point at a tab and its icon turns into an arrow. A collapsed tree shows how many tabs it hides.'),
    ('menu', 'light', 'Quick actions\nfor every tab',
     'Right-click for a new tab inside a tree, duplicating, moving a tree to a new window, '
     'closing a branch and more.'),
    ('dark', 'dark', 'Looks like\npart of Chrome',
     'Chrome’s own colors, fonts and shapes, in light and dark mode. Tab groups keep their colors too.'),
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


def screenshot(number, name, scheme, headline, body):
    colors = THEMES[scheme]
    W, H = 1280, 800
    canvas = Image.new('RGB', (W, H), colors['bg'])
    panel = Image.open(os.path.join(OUT, f'raw/panel-{name}.png')).convert('RGB')
    canvas = card(canvas, panel, colors, x=W - 440 - 96, y=64, width=440, radius=24)
    draw = ImageDraw.Draw(canvas)
    logo = icon(48)
    canvas.paste(logo, (96, 96), logo)
    draw.text((158, 104), 'Tree of Tabs', font=font('Inter-SemiBold.otf', 26), fill=colors['title'])
    y = 250
    for line in headline.split('\n'):
        draw.text((96, y), line, font=font('InterDisplay-Bold.otf', 56), fill=colors['title'])
        y += 68
    y += 24
    for line in textwrap.wrap(body, 38):
        draw.text((98, y), line, font=font('Inter-Regular.otf', 26), fill=colors['text'])
        y += 38
    canvas.save(os.path.join(OUT, f'screenshot-{number}-{name}.png'), optimize=True)


def promo_tile():
    colors = THEMES['light']
    W, H = 440, 280
    canvas = Image.new('RGB', (W, H), colors['bg'])
    panel = Image.open(os.path.join(OUT, 'raw/panel-nest.png')).convert('RGB')
    # Just the first rows of the tree, from below the pinned tabs.
    canvas = card(canvas, panel.crop((0, 90, 640, 1200)), colors, x=250, y=40, width=260, radius=14)
    draw = ImageDraw.Draw(canvas)
    logo = icon(56)
    canvas.paste(logo, (28, 52), logo)
    draw.text((28, 128), 'Tree of', font=font('InterDisplay-Bold.otf', 38), fill=colors['title'])
    draw.text((28, 170), 'Tabs', font=font('InterDisplay-Bold.otf', 38), fill=colors['title'])
    draw.text((29, 222), 'Your tabs as a tree', font=font('Inter-Regular.otf', 17), fill=colors['text'])
    canvas.save(os.path.join(OUT, 'promo-tile.png'), optimize=True)


for number, shot in enumerate(SHOTS, 1):
    screenshot(number, *shot)
promo_tile()
