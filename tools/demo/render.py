"""Renders the demo video from the captures that tools/demo/capture.mjs saves:
the page and the panel side by side, a cursor, and a caption under them, with
a title card at the start and the end. Writes docs/demo/tree-of-tabs-demo.mp4
(1920x1080, for YouTube and the store listing) and docs/demo/demo.gif (for the
README). Needs Pillow, ffmpeg and the Inter font.
Usage: python3 tools/demo/render.py <capture folder>"""
import json
import os
import subprocess
import sys
from functools import lru_cache
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.join(os.path.dirname(__file__), '../..')
OUT = os.path.join(ROOT, 'docs/demo')
FONTS = '/usr/share/fonts/opentype/inter/'
CAPTURES = sys.argv[1]

W, H, FPS = 1920, 1080, 30
BG = (240, 244, 249)
TITLE = (31, 31, 31)
TEXT = (71, 71, 71)
ACCENT = (11, 87, 208)
DIVIDER = (227, 227, 227)
SCALE = 0.6  # Captures are at twice the size; 0.6 shows them at 1.2x.

PAGE_W, PAGE_H = 1080, 768
PANEL_W = 384
HEADER = PAGE_H - round(606 * 2 * SCALE)
WIN_W = PAGE_W + 1 + PANEL_W
X0 = (W - WIN_W) // 2
Y0 = 92
CAPTION_Y = Y0 + PAGE_H + 64


def font(name, size):
    return ImageFont.truetype(os.path.join(FONTS, name), size)


def icon(size):
    # The 128px icon has 16px of padding; crop it off before scaling.
    image = Image.open(os.path.join(ROOT, 'icons/icon128.png')).convert('RGBA')
    return image.crop((16, 16, 112, 112)).resize((size, size), Image.LANCZOS)


def ease(t):
    return 4 * t * t * t if t < 0.5 else 1 - (-2 * t + 2) ** 3 / 2


# --- The window: page and panel side by side -------------------------------------

def background():
    canvas = Image.new('RGBA', (W, H), BG + (255,))
    shadow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((X0, Y0 + 10, X0 + WIN_W, Y0 + PAGE_H + 10), radius=18, fill=(0, 0, 0, 55))
    return Image.alpha_composite(canvas, shadow.filter(ImageFilter.GaussianBlur(24))).convert('RGB')


BACKGROUND = background()
MASK = Image.new('L', (WIN_W, PAGE_H), 0)
ImageDraw.Draw(MASK).rounded_rectangle((0, 0, WIN_W - 1, PAGE_H - 1), radius=18, fill=255)


def load(kind, shot):
    image = Image.open(os.path.join(CAPTURES, f'{kind}-{shot}.png')).convert('RGB')
    return image.resize((round(image.width * SCALE), round(image.height * SCALE)), Image.LANCZOS)


@lru_cache(maxsize=8)
def scene(shot):
    window = Image.new('RGB', (WIN_W, PAGE_H), (255, 255, 255))
    window.paste(load('page', shot), (0, 0))
    draw = ImageDraw.Draw(window)
    draw.line((PAGE_W, 0, PAGE_W, PAGE_H), fill=DIVIDER)
    # The side panel's header, as Chrome draws it: the extension's icon and name.
    left = PAGE_W + 1
    logo = icon(20)
    window.paste(logo, (left + 14, (HEADER - 20) // 2), logo)
    draw.text((left + 44, HEADER // 2), 'Tree of Tabs', font=font('Inter-Medium.otf', 17), fill=TITLE, anchor='lm')
    draw.line((left, HEADER - 1, WIN_W, HEADER - 1), fill=DIVIDER)
    window.paste(load('panel', shot), (left, HEADER))
    canvas = BACKGROUND.copy()
    canvas.paste(window, (X0, Y0), MASK)
    return canvas


def to_screen(point):
    if point['on'] == 'page':
        return X0 + point['x'] * 2 * SCALE, Y0 + point['y'] * 2 * SCALE
    return X0 + PAGE_W + 1 + point['x'] * 2 * SCALE, Y0 + HEADER + point['y'] * 2 * SCALE


# --- Title cards ---------------------------------------------------------------------

def card(lines):
    canvas = Image.new('RGB', (W, H), BG)
    draw = ImageDraw.Draw(canvas)
    logo = icon(168)
    total = 168 + 48 + 96 + sum(gap + size for _, size, gap, _ in lines)
    y = (H - total) // 2
    canvas.paste(logo, ((W - 168) // 2, y), logo)
    y += 168 + 48
    draw.text((W // 2, y), 'Tree of Tabs', font=font('InterDisplay-Bold.otf', 96), fill=TITLE, anchor='mt')
    y += 96
    for text, size, gap, style in lines:
        y += gap
        name, color = ('Inter-Medium.otf', ACCENT) if style == 'accent' else ('Inter-Regular.otf', TEXT)
        draw.text((W // 2, y), text, font=font(name, size), fill=color, anchor='mt')
        y += size
    return canvas


CARDS = {
    'intro': card([('Vertical tabs as a tree in Chrome’s side panel', 44, 40, 'text')]),
    'outro': card([
        ('Vertical tabs as a tree in Chrome’s side panel', 44, 40, 'text'),
        ('Free and open source, on the Chrome Web Store', 36, 40, 'accent'),
    ]),
}


# --- Cursor, clicks and the dragged tab --------------------------------------------------

def make_cursor():
    points = [(0, 0), (0, 25), (6, 19.5), (10.5, 29), (14.5, 27.2), (10.2, 18), (18, 18)]
    scale = 1.25
    image = Image.new('RGBA', (40, 48), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    shifted = [(4 + x * scale, 3 + y * scale) for x, y in points]
    draw.polygon(shifted, fill=(255, 255, 255, 255))
    small = [(4 + 2.2 + (x - 2.2) * scale * 0.82, 3 + 3.6 + (y - 3.6) * scale * 0.82) for x, y in points]
    draw.polygon(small, fill=(20, 20, 20, 255))
    shadow = Image.new('RGBA', image.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).polygon([(x + 1, y + 2) for x, y in shifted], fill=(0, 0, 0, 90))
    return Image.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(2)), image)


CURSOR = make_cursor()


@lru_cache(maxsize=4)
def ghost_image(shot, x, y, width, height):
    """The dragged tab as a small translucent label, like Chrome's drag image."""
    panel = Image.open(os.path.join(CAPTURES, f'panel-{shot}.png')).convert('RGB')
    width = min(width, 170)
    row = panel.crop((round(x * 2), round(y * 2), round((x + width) * 2), round((y + height) * 2)))
    row = row.resize((round(row.width * SCALE), round(row.height * SCALE)), Image.LANCZOS)
    pad = 12
    image = Image.new('RGBA', (row.width + pad * 2, row.height + pad * 2), (0, 0, 0, 0))
    shadow = Image.new('L', image.size, 0)
    ImageDraw.Draw(shadow).rounded_rectangle((pad, pad + 3, pad + row.width, pad + row.height + 3), radius=10, fill=70)
    image.putalpha(shadow.filter(ImageFilter.GaussianBlur(5)))
    mask = Image.new('L', row.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, row.width - 1, row.height - 1), radius=10, fill=225)
    image.paste(row, (pad, pad), mask)
    return image


def overlay(frame, position, click=None, ghost=None):
    frame = frame.convert('RGBA')
    x, y = position
    if ghost:
        image = ghost_image(ghost['shot'], ghost['x'], ghost['y'], ghost['width'], ghost['height'])
        frame.alpha_composite(image, (round(x - 12), round(y + 10)))
    if click is not None:
        ring = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        radius = 8 + 22 * click
        alpha = round(150 * (1 - click))
        ImageDraw.Draw(ring).ellipse((x - radius, y - radius, x + radius, y + radius), outline=ACCENT + (alpha,), width=4)
        frame = Image.alpha_composite(frame, ring)
    frame.alpha_composite(CURSOR, (round(x - 4), round(y - 3)))
    return frame.convert('RGB')


# --- Captions ------------------------------------------------------------------------------

@lru_cache(maxsize=8)
def caption_layer(text):
    layer = Image.new('RGBA', (W, 80), (0, 0, 0, 0))
    ImageDraw.Draw(layer).text((W // 2, 40), text, font=font('Inter-SemiBold.otf', 40), fill=TITLE + (255,), anchor='mm')
    return layer


def with_caption(frame, text, alpha):
    if not text or alpha <= 0:
        return frame
    layer = caption_layer(text)
    if alpha < 1:
        layer = layer.copy()
        layer.putalpha(layer.getchannel('A').point(lambda a: round(a * alpha)))
    frame = frame.convert('RGBA')
    frame.alpha_composite(layer, (0, CAPTION_Y - 40))
    return frame.convert('RGB')


# --- The timeline ----------------------------------------------------------------------------

def frames():
    steps = json.load(open(os.path.join(CAPTURES, 'steps.json')))
    position = (X0 + PAGE_W * 0.55, Y0 + PAGE_H * 0.75)
    text, caption_age = None, 0
    previous = None  # The last frame shown, to fade from after a title card.
    fade_from, fade_left = None, 0
    FADE = 12

    def emit(frame):
        nonlocal fade_left, previous
        if fade_left:
            frame = Image.blend(fade_from, frame, 1 - fade_left / FADE)
            fade_left -= 1
        previous = frame
        return frame

    for step in steps:
        kind = step['type']
        if kind == 'caption':
            text, caption_age = step['text'], 0
            continue
        count = max(1, round(step['seconds'] * FPS))
        if kind == 'card':
            if previous is not None:
                fade_from, fade_left = previous, FADE
            for _ in range(count):
                yield emit(CARDS[step['card']])
            fade_from, fade_left = previous, FADE
            continue
        start = position
        end = to_screen(step['to']) if kind == 'move' else position
        for i in range(count):
            t = ease((i + 1) / count) if kind == 'move' else 1
            position = (start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t)
            click = i / count if kind == 'click' else None
            frame = overlay(scene(step['shot']), position, click, step.get('ghost'))
            caption_age += 1
            yield emit(with_caption(frame, text, min(1, caption_age / 10)))


def main():
    os.makedirs(OUT, exist_ok=True)
    video = os.path.join(OUT, 'tree-of-tabs-demo.mp4')
    encoder = subprocess.Popen(
        ['ffmpeg', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS),
         '-i', '-', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'slow', '-movflags', '+faststart',
         video],
        stdin=subprocess.PIPE)
    count = 0
    for frame in frames():
        encoder.stdin.write(frame.tobytes())
        count += 1
    encoder.stdin.close()
    encoder.wait()
    print(f'{video}: {count / FPS:.1f} seconds')

    # The README's GIF: smaller and slower, with its own palette.
    gif = os.path.join(OUT, 'demo.gif')
    subprocess.run(
        ['ffmpeg', '-loglevel', 'error', '-y', '-i', video, '-vf',
         'fps=15,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];'
         '[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', gif],
        check=True)
    print(f'{gif}: {os.path.getsize(gif) / 1e6:.1f} MB')


main()
