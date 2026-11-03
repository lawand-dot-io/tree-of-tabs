"""Renders the demo video from the captures that tools/demo/capture.mjs saves:
the side panel on the left (where people who want vertical tabs put it) next
to the page, a cursor, and a caption under them, with
a title card at the start and the end. Writes docs/demo/tree-of-tabs-demo.mp4
(1920x1080, for YouTube and the store listing), docs/demo/demo.gif (for the
README) and docs/demo/demo-loop.mp4 (for social feeds like Reddit and X, which
loop silent videos: it starts right on the first link opening, under a bold
headline for its first two seconds, to catch people scrolling past). Needs Pillow, ffmpeg and the Inter font.
Usage: python3 tools/demo/render.py <capture folder>"""
import json
import os
import subprocess
import sys
from functools import lru_cache
from PIL import Image, ImageDraw, ImageFilter
from frame import (ACCENT, BG, GREEN_TINT, TEXT, TITLE, Window, font, ghost, gradient, icon, landscape, make_cursor,
                   pointer, rounded_mask, shadow_for)

ROOT = os.path.join(os.path.dirname(__file__), '../..')
OUT = os.path.join(ROOT, 'docs/demo')
CAPTURES = sys.argv[1]

W, H, FPS = 1920, 1080, 30
WINDOW = Window(1.2)
X0 = (W - WINDOW.width) // 2
Y0 = 64
CAPTION_Y = Y0 + WINDOW.height + 76
CAPTION_FONT = font('Inter-SemiBold.otf', 40)
# The title cards' little forest: (sprite, x of its left edge, pixel size).
# The demo itself has no trees, so nothing competes with the recording.
TREES = [('pine', 300, 8), ('round', 400, 7), ('pine', 520, 6), ('round', 640, 5),
         ('round', 1180, 5), ('pine', 1290, 6), ('round', 1380, 7), ('pine', 1510, 8)]


def ease(t):
    return 4 * t * t * t if t < 0.5 else 1 - (-2 * t + 2) ** 3 / 2


# --- The window: the side panel and the page --------------------------------------

def background():
    canvas = gradient((W, H), BG, GREEN_TINT)
    return shadow_for(canvas, (X0, Y0, X0 + WINDOW.width, Y0 + WINDOW.height), radius=18)


BACKGROUND = background()
MASK = rounded_mask((WINDOW.width, WINDOW.height), 18)
SCHEMES = []  # Light or dark, for each capture; read from steps.json.


def capture(kind, shot):
    return os.path.join(CAPTURES, f'{kind}-{shot}.png')


@lru_cache(maxsize=8)
def scene(shot):
    canvas = BACKGROUND.copy()
    canvas.paste(WINDOW.draw(capture('page', shot), capture('panel', shot), SCHEMES[shot]), (X0, Y0), MASK)
    return canvas


def to_screen(point):
    return WINDOW.to_screen(point, (X0, Y0))


# --- Title cards ---------------------------------------------------------------------

def card(lines):
    canvas = landscape(gradient((W, H), BG, GREEN_TINT), TREES)
    draw = ImageDraw.Draw(canvas)
    logo = icon(168)
    total = 168 + 48 + 96 + sum(gap + size for _, size, gap, _ in lines)
    # Centered in the sky above the hill.
    y = (H - 140 - total) // 2
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

CURSOR = make_cursor()


@lru_cache(maxsize=4)
def dragged(shot, x, y, width, height):
    return ghost(capture('panel', shot), dict(x=x, y=y, width=width, height=height), WINDOW.scale)


def overlay(frame, position, click=None, drag=None):
    x, y = position
    if click is not None:
        frame = frame.convert('RGBA')
        ring = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        radius = 8 + 22 * click
        alpha = round(150 * (1 - click))
        ImageDraw.Draw(ring).ellipse((x - radius, y - radius, x + radius, y + radius), outline=ACCENT + (alpha,), width=4)
        frame = Image.alpha_composite(frame, ring)
    image = drag and dragged(drag['shot'], drag['x'], drag['y'], drag['width'], drag['height'])
    return pointer(frame, position, CURSOR, image)


# --- A link flying into the tree, and the new row lighting up -----------------------

LABEL_FONT = font('Inter-Medium.otf', 22)


@lru_cache(maxsize=16)
def label_image(text):
    """The clicked link as a small card, like a tab on its way into the tree."""
    width = round(LABEL_FONT.getlength(text)) + 58
    height, pad = 44, 16
    image = Image.new('RGBA', (width + pad * 2, height + pad * 2), (0, 0, 0, 0))
    shadow = Image.new('RGBA', image.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((pad, pad + 4, pad + width, pad + height + 4), radius=12, fill=(0, 0, 0, 70))
    image = Image.alpha_composite(image, shadow.filter(ImageFilter.GaussianBlur(6)))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((pad, pad, pad + width, pad + height), radius=12, fill=(255, 255, 255, 255),
                           outline=ACCENT + (255,), width=2)
    draw.ellipse((pad + 16, pad + 16, pad + 28, pad + 28), fill=ACCENT + (255,))
    draw.text((pad + 40, pad + height / 2), text, font=LABEL_FONT, fill=TITLE + (255,), anchor='lm')
    return image


def row_box(box):
    """A row's box in the panel (CSS pixels) on the canvas."""
    x0, y0 = to_screen({'on': 'panel', 'x': box['x'], 'y': box['y']})
    x1, y1 = to_screen({'on': 'panel', 'x': box['x'] + box['width'], 'y': box['y'] + box['height']})
    return x0, y0, x1, y1


def fly(frame, step, t):
    """The label on its way from the link to the new row, on a gentle arc."""
    image = label_image(step['label'])
    x0, y0 = to_screen(step['from'])
    bx0, by0, bx1, by1 = row_box(step['to'])
    x1, y1 = bx0 + 24, (by0 + by1) / 2
    x = x0 + (x1 - x0) * t
    y = y0 + (y1 - y0) * t - 120 * 4 * t * (1 - t)
    # It starts at full size and shrinks a little as it lands.
    scale = 1 - 0.2 * t
    image = image.resize((round(image.width * scale), round(image.height * scale)), Image.LANCZOS)
    frame = frame.convert('RGBA')
    frame.alpha_composite(image, (round(x - 16 * scale), round(y - image.height / 2)))
    return frame.convert('RGB')


def glow(frame, box, age):
    """A soft highlight around the row that just appeared, fading out."""
    strength = max(0.0, 1 - age / (1.2 * FPS))
    if strength <= 0:
        return frame
    x0, y0, x1, y1 = row_box(box)
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    draw.rounded_rectangle((x0 - 3, y0 - 3, x1 + 3, y1 + 3), radius=12, fill=ACCENT + (round(40 * strength),),
                           outline=ACCENT + (round(230 * strength),), width=3)
    halo = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(halo).rounded_rectangle((x0 - 6, y0 - 6, x1 + 6, y1 + 6), radius=14,
                                           outline=ACCENT + (round(120 * strength),), width=8)
    frame = Image.alpha_composite(frame.convert('RGBA'), halo.filter(ImageFilter.GaussianBlur(6)))
    return Image.alpha_composite(frame, layer).convert('RGB')


# --- The social version's opening headline ------------------------------------------

HOOK = round(2.2 * FPS)  # How long the headline shows, fading out at the end.


@lru_cache(maxsize=1)
def hook_card():
    title, line = 'Vertical tabs, as a tree', 'Free Chrome extension'
    title_font, line_font = font('InterDisplay-Bold.otf', 72), font('Inter-Medium.otf', 32)
    width = round(max(title_font.getlength(title), line_font.getlength(line))) + 120
    height, pad = 200, 30
    image = Image.new('RGBA', (width + pad * 2, height + pad * 2), (0, 0, 0, 0))
    shadow = Image.new('RGBA', image.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((pad, pad + 10, pad + width, pad + height + 10), radius=28, fill=(0, 0, 0, 90))
    image = Image.alpha_composite(image, shadow.filter(ImageFilter.GaussianBlur(16)))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((pad, pad, pad + width, pad + height), radius=28, fill=(255, 255, 255, 250))
    draw.text((pad + width / 2, pad + 80), title, font=title_font, fill=TITLE + (255,), anchor='mm')
    draw.text((pad + width / 2, pad + 150), line, font=line_font, fill=ACCENT + (255,), anchor='mm')
    return image


def with_hook(frame, age):
    """The headline over the page, for the first seconds of the social version."""
    if age >= HOOK:
        return frame
    image = hook_card()
    fade = min(1, (HOOK - age) / (0.4 * FPS))
    if fade < 1:
        image = image.copy()
        image.putalpha(image.getchannel('A').point(lambda a: round(a * fade)))
    x = X0 + WINDOW.panel_w + 1 + WINDOW.page_w // 2 - image.width // 2
    frame = frame.convert('RGBA')
    # Low on the page, clear of the path from the links up to the tree.
    frame.alpha_composite(image, (x, Y0 + WINDOW.height - image.height - 30))
    return frame.convert('RGB')


# --- Captions ------------------------------------------------------------------------------

@lru_cache(maxsize=8)
def caption_layer(text):
    layer = Image.new('RGBA', (W, 80), (0, 0, 0, 0))
    ImageDraw.Draw(layer).text((W // 2, 40), text, font=CAPTION_FONT, fill=TITLE + (255,), anchor='mm')
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
    timeline = json.load(open(os.path.join(CAPTURES, 'steps.json')))
    steps = timeline['steps']
    SCHEMES[:] = timeline['schemes']
    position = (X0 + WINDOW.panel_w + WINDOW.page_w * 0.45, Y0 + WINDOW.height * 0.75)
    text, caption_age = None, 0
    previous = None  # The last frame shown, to fade from after a title card.
    fade_from, fade_left = None, 0
    FADE = 12
    glowing = None  # The row lighting up, and for how many frames so far.
    hooked = False  # From the first link opening on: where the social version starts.

    def emit(frame, card=False):
        """The frame, whether it shows a title card (or a fade to one), and
        whether the social version includes it."""
        nonlocal fade_left, previous
        if fade_left:
            frame = Image.blend(fade_from, frame, 1 - fade_left / FADE)
            fade_left -= 1
            card = True
        previous = frame
        return frame, card, hooked and not card

    for index, step in enumerate(steps):
        kind = step['type']
        if kind == 'click' and index + 1 < len(steps) and steps[index + 1]['type'] == 'fly':
            hooked = True
        if kind == 'caption':
            text, caption_age = step['text'], 0
            continue
        count = max(1, round(step['seconds'] * FPS))
        if kind == 'card':
            if previous is not None:
                fade_from, fade_left = previous, FADE
            for _ in range(count):
                yield emit(CARDS[step['card']], card=True)
            fade_from, fade_left = previous, FADE
            continue
        start = position
        end = to_screen(step['to']) if kind == 'move' else position
        for i in range(count):
            t = ease((i + 1) / count) if kind == 'move' else 1
            position = (start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t)
            click = i / count if kind == 'click' else None
            base = scene(step['shot'])
            if kind == 'fade':
                base = Image.blend(scene(step['from']), base, ease((i + 1) / count))
            if kind == 'fly':
                base = fly(base, step, ease((i + 1) / count))
            if i == 0 and step.get('glow'):
                glowing = [step['glow'], 0]
            if glowing:
                base = glow(base, glowing[0], glowing[1])
                glowing[1] += 1
            frame = overlay(base, position, click, step.get('ghost'))
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
    # The README's GIF leaves out the title cards (the README already says what
    # this is) and fades from the last frame back into the first, so its loop
    # doesn't jump. Its frames go to a lossless file first.
    loop = os.path.join(CAPTURES, 'gif-frames.mkv')
    looper = subprocess.Popen(
        ['ffmpeg', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS),
         '-i', '-', '-c:v', 'ffv1', loop],
        stdin=subprocess.PIPE)
    # The social version: from the first link opening, with the headline first.
    loop_video = os.path.join(OUT, 'demo-loop.mp4')
    social = subprocess.Popen(
        ['ffmpeg', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS),
         '-i', '-', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'slow', '-movflags', '+faststart',
         loop_video],
        stdin=subprocess.PIPE)
    count, first, last = 0, None, None
    social_count, social_first, social_last = 0, None, None
    for frame, card, in_social in frames():
        encoder.stdin.write(frame.tobytes())
        count += 1
        if not card:
            looper.stdin.write(frame.tobytes())
            first, last = first or frame, frame
        if in_social:
            frame = with_hook(frame, social_count)
            social.stdin.write(frame.tobytes())
            social_count += 1
            social_first, social_last = social_first or frame, frame
    encoder.stdin.close()
    encoder.wait()
    print(f'{video}: {count / FPS:.1f} seconds')
    # Both loops fade from their last frame back into their first.
    BACK = 18
    for i in range(1, BACK + 1):
        looper.stdin.write(Image.blend(last, first, ease(i / BACK)).tobytes())
        social.stdin.write(Image.blend(social_last, social_first, ease(i / BACK)).tobytes())
    looper.stdin.close()
    looper.wait()
    social.stdin.close()
    social.wait()
    print(f'{loop_video}: {(social_count + BACK) / FPS:.1f} seconds, {os.path.getsize(loop_video) / 1e6:.1f} MB')

    # Smaller and slower than the video, with its own palette.
    gif = os.path.join(OUT, 'demo.gif')
    subprocess.run(
        ['ffmpeg', '-loglevel', 'error', '-y', '-i', loop, '-vf',
         'fps=12,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];'
         '[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', gif],
        check=True)
    print(f'{gif}: {os.path.getsize(gif) / 1e6:.1f} MB')


main()
