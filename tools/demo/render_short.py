"""Renders a vertical version of the demo (1080x1920) for YouTube Shorts from
the captures that tools/demo/capture.mjs saves: the headline at the top, a
close-up of the page that follows the cursor, and the tree panel, large, below
it. Links fly from the page down into the tree. It starts on the first link
opening and fades from its end back into its start, since Shorts loop.
Everything important stays clear of the bottom and right edges, where YouTube
shows its title, buttons and progress bar. Writes docs/demo/tree-of-tabs-short.mp4.
Needs Pillow, ffmpeg and the Inter font.
Usage: python3 tools/demo/render_short.py <capture folder>"""
import json
import os
import subprocess
import sys
from functools import lru_cache
from PIL import Image, ImageDraw, ImageFilter
from frame import (ACCENT, BG, CHROME, GREEN_TINT, TEXT, TITLE, font, ghost, gradient, icon, landscape,
                   make_cursor, pointer, rounded_mask, shadow_for)

ROOT = os.path.join(os.path.dirname(__file__), '../..')
OUT = os.path.join(ROOT, 'docs/demo')
CAPTURES = sys.argv[1]
W, H, FPS = 1080, 1920, 30

# The page close-up: a part of the page, at PAGE_SCALE times its CSS size.
PAGE_BOX = (60, 330, 1020, 830)
PAGE_SCALE = 1.45
CROP = ((PAGE_BOX[2] - PAGE_BOX[0]) / PAGE_SCALE, (PAGE_BOX[3] - PAGE_BOX[1]) / PAGE_SCALE)
# The panel: its top part, with Chrome's side panel header above it.
PANEL_SCALE = 1.9
PANEL_W = round(320 * PANEL_SCALE)
HEADER = round(34 * PANEL_SCALE)
PANEL_BOX = ((W - PANEL_W) // 2, 960, (W + PANEL_W) // 2, 1640)
CAPTION_Y = 895
TREES = [('pine', 70, 6), ('round', 150, 5), ('round', 830, 5), ('pine', 910, 6)]


def ease(t):
    return 4 * t * t * t if t < 0.5 else 1 - (-2 * t + 2) ** 3 / 2


def background():
    canvas = landscape(gradient((W, H), BG, GREEN_TINT), TREES)
    for box, radius in ((PAGE_BOX, 22), (PANEL_BOX, 22)):
        canvas = shadow_for(canvas, box, radius=radius)
    draw = ImageDraw.Draw(canvas)
    logo = icon(64)
    title_font = font('InterDisplay-Bold.otf', 80)
    title = 'Vertical tabs, as a tree'
    canvas.paste(logo, ((W - 64) // 2, 70), logo)
    draw.text((W // 2, 170), title, font=title_font, fill=TITLE, anchor='mt')
    draw.text((W // 2, 268), 'Tree of Tabs, a free Chrome extension', font=font('Inter-Medium.otf', 34), fill=ACCENT,
              anchor='mt')
    return canvas


BACKGROUND = background()
SCHEMES = []


@lru_cache(maxsize=16)
def capture(kind, shot):
    return Image.open(os.path.join(CAPTURES, f'{kind}-{shot}.png')).convert('RGB')


@lru_cache(maxsize=8)
def panel_card(shot):
    colors = CHROME[SCHEMES[shot]]
    width, height = PANEL_BOX[2] - PANEL_BOX[0], PANEL_BOX[3] - PANEL_BOX[1]
    card = Image.new('RGB', (width, height), colors['bg'])
    draw = ImageDraw.Draw(card)
    logo = icon(round(HEADER * 0.5))
    card.paste(logo, (round(HEADER * 0.34), (HEADER - logo.height) // 2), logo)
    draw.text((round(HEADER * 1.07), HEADER // 2), 'Tree of Tabs', font=font('Inter-Medium.otf', round(HEADER * 0.41)),
              fill=colors['text'], anchor='lm')
    draw.line((0, HEADER - 1, width, HEADER - 1), fill=colors['divider'])
    panel = capture('panel', shot)
    panel = panel.resize((width, round(panel.height * width / panel.width)), Image.LANCZOS)
    card.paste(panel.crop((0, 0, width, height - HEADER)), (0, HEADER))
    return card


def page_card(shot, camera):
    page = capture('page', shot)
    x, y = camera
    crop = page.crop((round(x * 2), round(y * 2), round((x + CROP[0]) * 2), round((y + CROP[1]) * 2)))
    return crop.resize((PAGE_BOX[2] - PAGE_BOX[0], PAGE_BOX[3] - PAGE_BOX[1]), Image.LANCZOS)


def scene(shot, camera):
    canvas = BACKGROUND.copy()
    for box, card in ((PAGE_BOX, page_card(shot, camera)), (PANEL_BOX, panel_card(shot))):
        canvas.paste(card, box[:2], rounded_mask(card.size, 22))
    return canvas


def to_screen(point, camera):
    """Where a point in the page's or the panel's CSS pixels lands."""
    if point['on'] == 'page':
        return (PAGE_BOX[0] + (point['x'] - camera[0]) * PAGE_SCALE,
                PAGE_BOX[1] + (point['y'] - camera[1]) * PAGE_SCALE)
    return PANEL_BOX[0] + point['x'] * PANEL_SCALE, PANEL_BOX[1] + HEADER + point['y'] * PANEL_SCALE


def camera_for(point):
    """The part of the page to show so `point` sits a little left of center."""
    x = min(max(point['x'] - CROP[0] * 0.55, 0), 900 - CROP[0])
    y = min(max(point['y'] - CROP[1] * 0.5, 0), 700 - CROP[1])
    return x, y


# --- Overlays ----------------------------------------------------------------------------

CURSOR = make_cursor(1.4)
LABEL_FONT = font('Inter-Medium.otf', 30)


@lru_cache(maxsize=16)
def label_image(text):
    width = round(LABEL_FONT.getlength(text)) + 74
    height, pad = 58, 18
    image = Image.new('RGBA', (width + pad * 2, height + pad * 2), (0, 0, 0, 0))
    shadow = Image.new('RGBA', image.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((pad, pad + 5, pad + width, pad + height + 5), radius=16, fill=(0, 0, 0, 80))
    image = Image.alpha_composite(image, shadow.filter(ImageFilter.GaussianBlur(7)))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((pad, pad, pad + width, pad + height), radius=16, fill=(255, 255, 255, 255),
                           outline=ACCENT + (255,), width=3)
    draw.ellipse((pad + 20, pad + 21, pad + 36, pad + 37), fill=ACCENT + (255,))
    draw.text((pad + 52, pad + height / 2), text, font=LABEL_FONT, fill=TITLE + (255,), anchor='lm')
    return image


def row_box(box, camera):
    x0, y0 = to_screen({'on': 'panel', 'x': box['x'], 'y': box['y']}, camera)
    x1, y1 = to_screen({'on': 'panel', 'x': box['x'] + box['width'], 'y': box['y'] + box['height']}, camera)
    return x0, y0, x1, y1


def fly(frame, step, t, camera):
    image = label_image(step['label'])
    x0, y0 = to_screen(step['from'], camera)
    bx0, by0, bx1, by1 = row_box(step['to'], camera)
    x1, y1 = bx0 + 30, (by0 + by1) / 2
    x = x0 + (x1 - x0) * t + 140 * 4 * t * (1 - t)  # A gentle curve to the right.
    y = y0 + (y1 - y0) * t
    scale = 1 - 0.15 * t
    image = image.resize((round(image.width * scale), round(image.height * scale)), Image.LANCZOS)
    frame = frame.convert('RGBA')
    frame.alpha_composite(image, (round(x - 18 * scale), round(y - image.height / 2)))
    return frame.convert('RGB')


def glow(frame, box, age, camera):
    strength = max(0.0, 1 - age / (1.2 * FPS))
    if strength <= 0:
        return frame
    x0, y0, x1, y1 = row_box(box, camera)
    x1 = min(x1, PANEL_BOX[2] - 4)
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(layer).rounded_rectangle((x0 - 3, y0 - 3, x1 + 3, y1 + 3), radius=16,
                                            fill=ACCENT + (round(40 * strength),),
                                            outline=ACCENT + (round(230 * strength),), width=4)
    halo = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(halo).rounded_rectangle((x0 - 7, y0 - 7, x1 + 7, y1 + 7), radius=18,
                                           outline=ACCENT + (round(120 * strength),), width=10)
    frame = Image.alpha_composite(frame.convert('RGBA'), halo.filter(ImageFilter.GaussianBlur(7)))
    return Image.alpha_composite(frame, layer).convert('RGB')


def click_ring(frame, position, t):
    x, y = position
    frame = frame.convert('RGBA')
    ring = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    radius = 10 + 28 * t
    ImageDraw.Draw(ring).ellipse((x - radius, y - radius, x + radius, y + radius),
                                 outline=ACCENT + (round(150 * (1 - t)),), width=5)
    return Image.alpha_composite(frame, ring).convert('RGB')


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


# --- The timeline --------------------------------------------------------------------------

def frames():
    timeline = json.load(open(os.path.join(CAPTURES, 'steps.json')))
    steps = timeline['steps']
    SCHEMES[:] = timeline['schemes']
    position = None  # The cursor, as a point in the page's or the panel's CSS pixels.
    camera = target = None
    text, caption_age = None, 0
    glowing = None
    started = False
    for index, step in enumerate(steps):
        kind = step['type']
        if kind == 'click' and index + 1 < len(steps) and steps[index + 1]['type'] == 'fly':
            started = True
        if kind == 'caption':
            text, caption_age = step['text'], 0
            continue
        if kind == 'card':
            continue  # The headline at the top stands in for the title cards.
        if kind == 'move' and position is None:
            position = step['to']  # Before the start: just follow along.
        if kind == 'move':
            if step['to']['on'] == 'page':
                target = camera_for(step['to'])
        if not started:
            if kind == 'move':
                position = step['to']
                camera = target
            continue
        count = max(1, round(step['seconds'] * FPS))
        start = position
        for i in range(count):
            # The close-up glides toward the cursor's spot on the page.
            camera = target if camera is None else (camera[0] + (target[0] - camera[0]) * 0.12,
                                                    camera[1] + (target[1] - camera[1]) * 0.12)
            base = scene(step['shot'], camera)
            if kind == 'fade':
                base = Image.blend(scene(step['from'], camera), base, ease((i + 1) / count))
            if kind == 'fly':
                base = fly(base, step, ease((i + 1) / count), camera)
            if i == 0 and step.get('glow'):
                glowing = [step['glow'], 0]
            if glowing:
                base = glow(base, glowing[0], glowing[1], camera)
                glowing[1] += 1
            here = to_screen(start, camera)
            if kind == 'move':
                there = to_screen(step['to'], camera)
                t = ease((i + 1) / count)
                here = (here[0] + (there[0] - here[0]) * t, here[1] + (there[1] - here[1]) * t)
            if kind == 'click':
                base = click_ring(base, here, i / count)
            drag = step.get('ghost')
            dragged = drag and ghost(os.path.join(CAPTURES, f'panel-{drag["shot"]}.png'), drag, PANEL_SCALE)
            frame = pointer(base, here, CURSOR, dragged)
            caption_age += 1
            yield with_caption(frame, text, min(1, caption_age / 10))
        if kind == 'move':
            position = step['to']


def main():
    os.makedirs(OUT, exist_ok=True)
    video = os.path.join(OUT, 'tree-of-tabs-short.mp4')
    encoder = subprocess.Popen(
        ['ffmpeg', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS),
         '-i', '-', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'slow', '-movflags', '+faststart',
         video],
        stdin=subprocess.PIPE)
    count, first, last = 0, None, None
    for frame in frames():
        encoder.stdin.write(frame.tobytes())
        count += 1
        first, last = first or frame, frame
    BACK = 18
    for i in range(1, BACK + 1):
        encoder.stdin.write(Image.blend(last, first, ease(i / BACK)).tobytes())
    encoder.stdin.close()
    encoder.wait()
    print(f'{video}: {(count + BACK) / FPS:.1f} seconds, {os.path.getsize(video) / 1e6:.1f} MB')


main()
