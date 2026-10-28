"""Drawing shared by the demo video (render.py) and the store screenshots
(tools/make-store-images.py): the window with the side panel on the left and
the page next to it, the cursor, the dragged tab and the pixel art trees.
Captures come from tools/demo/capture.mjs at twice their size."""
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.join(os.path.dirname(__file__), '../..')
FONTS = '/usr/share/fonts/opentype/inter/'
BG = (240, 244, 249)
TITLE = (31, 31, 31)
TEXT = (71, 71, 71)
ACCENT = (11, 87, 208)
# The side panel's header and the lines around it, in each color scheme.
CHROME = {
    'light': dict(bg=(255, 255, 255), text=(31, 31, 31), divider=(227, 227, 227)),
    'dark': dict(bg=(40, 42, 44), text=(227, 227, 227), divider=(68, 71, 70)),
}
# The capture's sizes in CSS pixels (see capture.mjs).
PAGE_CSS = (900, 700)
PANEL_CSS = (320, 666)


def font(name, size):
    return ImageFont.truetype(os.path.join(FONTS, name), size)


def icon(size):
    # The 128px icon has 16px of padding; crop it off before scaling.
    image = Image.open(os.path.join(ROOT, 'icons/icon128.png')).convert('RGBA')
    return image.crop((16, 16, 112, 112)).resize((size, size), Image.LANCZOS)


# --- The window ----------------------------------------------------------------------

class Window:
    """The page and the side panel at `scale` times their CSS size."""

    def __init__(self, scale):
        self.scale = scale
        self.panel_w = round(PANEL_CSS[0] * scale)
        self.page_w = round(PAGE_CSS[0] * scale)
        self.height = round(PAGE_CSS[1] * scale)
        self.header = self.height - round(PANEL_CSS[1] * scale)
        self.width = self.panel_w + 1 + self.page_w

    def _load(self, path):
        image = Image.open(path).convert('RGB')
        return image.resize((round(image.width * self.scale / 2), round(image.height * self.scale / 2)), Image.LANCZOS)

    def draw(self, page_path, panel_path, scheme):
        colors = CHROME[scheme]
        window = Image.new('RGB', (self.width, self.height), colors['bg'])
        draw = ImageDraw.Draw(window)
        # The side panel's header, as Chrome draws it: the extension's icon and name.
        size = round(self.header * 0.5)
        logo = icon(size)
        window.paste(logo, (round(self.header * 0.34), (self.header - size) // 2), logo)
        draw.text((round(self.header * 1.07), self.header // 2), 'Tree of Tabs',
                  font=font('Inter-Medium.otf', round(self.header * 0.41)), fill=colors['text'], anchor='lm')
        draw.line((0, self.header - 1, self.panel_w, self.header - 1), fill=colors['divider'])
        window.paste(self._load(panel_path), (0, self.header))
        draw.line((self.panel_w, 0, self.panel_w, self.height), fill=colors['divider'])
        window.paste(self._load(page_path), (self.panel_w + 1, 0))
        return window

    def to_screen(self, point, origin):
        """Where a point in the page's or the panel's CSS pixels lands on the canvas."""
        x, y = origin
        if point['on'] == 'page':
            return x + self.panel_w + 1 + point['x'] * self.scale, y + point['y'] * self.scale
        return x + point['x'] * self.scale, y + self.header + point['y'] * self.scale


def shadow_for(canvas, box, radius, strength=55, blur=24):
    """The soft shadow under the window."""
    canvas = canvas.convert('RGBA')
    shadow = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
    x0, y0, x1, y1 = box
    ImageDraw.Draw(shadow).rounded_rectangle((x0, y0 + 10, x1, y1 + 10), radius=radius, fill=(0, 0, 0, strength))
    return Image.alpha_composite(canvas, shadow.filter(ImageFilter.GaussianBlur(blur))).convert('RGB')


def rounded_mask(size, radius):
    mask = Image.new('L', size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius=radius, fill=255)
    return mask


# --- Cursor and the dragged tab --------------------------------------------------------

def make_cursor(scale=1.25):
    """A classic arrow cursor: dark with a white outline, drawn at 4x and scaled down.
    Its tip is at (4, 3)."""
    points = [(0, 0), (0, 25), (6, 19.5), (10.5, 29), (14.5, 27.2), (10.2, 18), (18, 18)]
    big = 4
    shape = [(16 + x * scale * big, 12 + y * scale * big) for x, y in points]
    size = (round(32 * scale), round(38 * scale))
    image = Image.new('RGBA', (size[0] * big, size[1] * big), (0, 0, 0, 0))
    ImageDraw.Draw(image).polygon(shape, fill=(20, 20, 20, 255), outline=(255, 255, 255, 255), width=2 * big)
    shadow = Image.new('RGBA', image.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).polygon([(x + 4, y + 8) for x, y in shape], fill=(0, 0, 0, 90))
    image = Image.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(8)), image)
    return image.resize(size, Image.LANCZOS)


def ghost(panel_path, box, scale):
    """The dragged tab as a small translucent label, like Chrome's drag image."""
    panel = Image.open(panel_path).convert('RGB')
    x, y, height = box['x'], box['y'], box['height']
    width = min(box['width'], 215)
    row = panel.crop((round(x * 2), round(y * 2), round((x + width) * 2), round((y + height) * 2)))
    row = row.resize((round(row.width * scale / 2), round(row.height * scale / 2)), Image.LANCZOS)
    pad = 12
    image = Image.new('RGBA', (row.width + pad * 2, row.height + pad * 2), (0, 0, 0, 0))
    shadow = Image.new('L', image.size, 0)
    ImageDraw.Draw(shadow).rounded_rectangle((pad, pad + 3, pad + row.width, pad + row.height + 3), radius=10, fill=70)
    image.putalpha(shadow.filter(ImageFilter.GaussianBlur(5)))
    mask = rounded_mask(row.size, 10).point(lambda a: a * 225 // 255)
    image.paste(row, (pad, pad), mask)
    return image


def pointer(canvas, position, cursor, dragged=None):
    """Draws the cursor at `position`, with the dragged tab under it if there is one."""
    canvas = canvas.convert('RGBA')
    x, y = position
    if dragged:
        canvas.alpha_composite(dragged, (round(x - 12), round(y + 10)))
    canvas.alpha_composite(cursor, (round(x - 4), round(y - 3)))
    return canvas.convert('RGB')


# --- Pixel art trees along the bottom ------------------------------------------------

SPRITES = {
    'round': '''
        ....LLL....
        ..LLGGGGG..
        .LLGGGGGGG.
        LLGGGGGGGGG
        LGGGGGGGGDG
        GGGGGGGGDDG
        .GGGGGGDDG.
        ..GGGDDDD..
        ....TT.....
        ....TT.....
        ...TTTT....''',
    'pine': '''
        ....L....
        ...LGD...
        ..LGGGD..
        ...GGD...
        ..LGGGD..
        .LGGGGGD.
        ...GGGD..
        ..LGGGGD.
        .LGGGGGGD
        LGGGGGGGD
        ....T....
        ....T....''',
    # A tiny Tree of Tabs: three tabs as leaves.
    'tabs': '''
        ....GGGGG....
        ....GLLLG....
        ....GGGGG....
        GGGGG.T.GGGGG
        GLLLG.T.GLLLG
        GGGGGTTTGGGGG
        ....TTTTT....
        .....TTT.....
        .....TTT.....
        ....TTTTT....''',
    'bush': '''
        ..LLL..
        .LGGGG.
        LGGGGDG
        .GGDDD.''',
}
PIXEL_COLORS = {'L': (176, 213, 168), 'G': (139, 190, 136), 'D': (108, 160, 114), 'T': (176, 150, 128)}


def forest(canvas, trees, ground, strength=0.7):
    """Draws `trees`, a list of (sprite, x of its left edge, pixel size), standing on `ground`."""
    canvas = canvas.convert('RGBA')
    layer = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    for name, left, size in trees:
        rows = [line.strip() for line in SPRITES[name].strip('\n').splitlines()]
        top = ground - len(rows) * size
        for r, line in enumerate(rows):
            for c, ch in enumerate(line):
                if ch in PIXEL_COLORS:
                    x, y = left + c * size, top + r * size
                    draw.rectangle((x, y, x + size - 1, y + size - 1), fill=PIXEL_COLORS[ch] + (255,))
    # Subtle: the trees are drawn at partial strength over the background.
    layer.putalpha(layer.getchannel('A').point(lambda a: a * strength))
    return Image.alpha_composite(canvas, layer).convert('RGB')
