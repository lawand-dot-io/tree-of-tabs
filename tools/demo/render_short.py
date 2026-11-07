"""Renders a vertical version of the demo (1080x1920) for YouTube Shorts from
the captures that tools/demo/capture.mjs saves: the headline at the top, a
close-up of the page that follows the cursor, and the tree panel, large, below
it. Arrows point from each link opened down to its new row in the tree. It starts on the first link
opening and fades from its end back into its start, since Shorts loop.
Everything important stays clear of the bottom and right edges, where YouTube
shows its title, buttons and progress bar. Its music comes from music.py, made
to the video's length so both loop together. Writes docs/demo/tree-of-tabs-short.mp4.

With --second it renders the second Short, tree-of-tabs-short-2.mp4: the same,
but it opens on the problem, to stop people scrolling (a real tab strip filling
up with tabs until they're unreadable, from capture_tabs.mjs), and its header
shows the "Available in the Chrome Web Store" badge, so it's clear at a glance
that this is a Chrome extension, not another browser. Google's branding
guidelines allow the badge without approval, resized but otherwise unmodified
(chrome-web-store-badge.png, from developer.chrome.com/docs/webstore/branding).
Needs Pillow, numpy, scipy, ffmpeg and the Inter font.
Usage: python3 tools/demo/render_short.py <capture folder> [--second]"""
import json
import os
import subprocess
import sys
from functools import lru_cache
from PIL import Image, ImageChops, ImageDraw, ImageFilter
from frame import (ACCENT, BG, CHROME, GREEN_TINT, TEXT, TITLE, arrow, curve, font, ghost, gradient, icon, landscape,
                   make_cursor, note_alpha, outline, pointer, rounded_mask, shadow_for)

ROOT = os.path.join(os.path.dirname(__file__), '../..')
OUT = os.path.join(ROOT, 'docs/demo')
CAPTURES = sys.argv[1]
SECOND = '--second' in sys.argv[2:]
W, H, FPS = 1080, 1920, 30

# The page close-up: a part of the page, at PAGE_SCALE times its CSS size.
PAGE_BOX = (60, 330, 1020, 830)
PAGE_SCALE = 1.45
CROP = ((PAGE_BOX[2] - PAGE_BOX[0]) / PAGE_SCALE, (PAGE_BOX[3] - PAGE_BOX[1]) / PAGE_SCALE)
# The panel, with Chrome's side panel header above it. It shows VISIBLE CSS pixels of the tree at a time and
# scrolls to follow the cursor, so drags and menu items lower down stay in view.
PANEL_SCALE = 1.9
PANEL_W = round(320 * PANEL_SCALE)
HEADER = round(34 * PANEL_SCALE)
PANEL_BOX = ((W - PANEL_W) // 2, 960, (W + PANEL_W) // 2, 1640)
VISIBLE = (PANEL_BOX[3] - PANEL_BOX[1] - HEADER) / PANEL_SCALE
CAPTION_Y = 895
TREES = [('pine', 70, 6), ('round', 150, 5), ('round', 830, 5), ('pine', 910, 6)]


def ease(t):
    return 4 * t * t * t if t < 0.5 else 1 - (-2 * t + 2) ** 3 / 2


def background():
    canvas = landscape(gradient((W, H), BG, GREEN_TINT), TREES)
    for box, radius in ((PAGE_BOX, 22), (PANEL_BOX, 22)):
        canvas = shadow_for(canvas, box, radius=radius)
    draw = ImageDraw.Draw(canvas)
    title_font = font('InterDisplay-Bold.otf', 80)
    title = 'Vertical tabs, as a tree'
    if SECOND:
        # The title, the name, and the store badge under them.
        draw.text((W // 2, 44), title, font=title_font, fill=TITLE, anchor='mt')
        draw.text((W // 2, 148), 'Tree of Tabs, a free extension for Google Chrome™', font=font('Inter-Medium.otf', 32),
                  fill=ACCENT, anchor='mt')
        badge = Image.open(os.path.join(os.path.dirname(__file__), 'chrome-web-store-badge.png')).convert('RGBA')
        badge = badge.resize((round(badge.width * 96 / badge.height), 96), Image.LANCZOS)
        canvas.paste(badge, ((W - badge.width) // 2, 214), badge)
        return canvas
    logo = icon(64)
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
def panel_image(shot):
    panel = capture('panel', shot)
    width = PANEL_BOX[2] - PANEL_BOX[0]
    return panel.resize((width, round(panel.height * width / panel.width)), Image.LANCZOS)


@lru_cache(maxsize=64)
def content_height(shot):
    """How far down the panel's content goes, in CSS pixels."""
    panel = capture('panel', shot)
    background = Image.new('RGB', panel.size, panel.getpixel((panel.width - 10, panel.height - 10)))
    box = ImageChops.difference(panel, background).convert('L').point(lambda v: 255 if v > 12 else 0).getbbox()
    return box[3] / 2 if box else 0


def scroll_for(top, y, shot):
    """Scrolls the panel as little as possible so `y` sits in the middle part of the view."""
    if y > top + VISIBLE * 0.72:
        top = y - VISIBLE * 0.72
    elif y < top + VISIBLE * 0.2:
        top = y - VISIBLE * 0.2
    return clamp_scroll(top, shot)


def clamp_scroll(top, shot):
    return min(max(top, 0), max(0, content_height(shot) + 12 - VISIBLE))


def panel_card(shot, scroll):
    colors = CHROME[SCHEMES[shot]]
    width, height = PANEL_BOX[2] - PANEL_BOX[0], PANEL_BOX[3] - PANEL_BOX[1]
    card = Image.new('RGB', (width, height), colors['bg'])
    draw = ImageDraw.Draw(card)
    logo = icon(round(HEADER * 0.5))
    card.paste(logo, (round(HEADER * 0.34), (HEADER - logo.height) // 2), logo)
    draw.text((round(HEADER * 1.07), HEADER // 2), 'Tree of Tabs', font=font('Inter-Medium.otf', round(HEADER * 0.41)),
              fill=colors['text'], anchor='lm')
    draw.line((0, HEADER - 1, width, HEADER - 1), fill=colors['divider'])
    top = round(scroll * PANEL_SCALE)
    card.paste(panel_image(shot).crop((0, top, width, top + height - HEADER)), (0, HEADER))
    return card


def page_card(shot, camera):
    page = capture('page', shot)
    x, y = camera[:2]
    crop = page.crop((round(x * 2), round(y * 2), round((x + CROP[0]) * 2), round((y + CROP[1]) * 2)))
    return crop.resize((PAGE_BOX[2] - PAGE_BOX[0], PAGE_BOX[3] - PAGE_BOX[1]), Image.LANCZOS)


def scene(shot, camera):
    canvas = BACKGROUND.copy()
    for box, card in ((PAGE_BOX, page_card(shot, camera)), (PANEL_BOX, panel_card(shot, camera[2]))):
        canvas.paste(card, box[:2], rounded_mask(card.size, 22))
    return canvas


def to_screen(point, camera):
    """Where a point in the page's or the panel's CSS pixels lands."""
    if point['on'] == 'page':
        return (PAGE_BOX[0] + (point['x'] - camera[0]) * PAGE_SCALE,
                PAGE_BOX[1] + (point['y'] - camera[1]) * PAGE_SCALE)
    return PANEL_BOX[0] + point['x'] * PANEL_SCALE, PANEL_BOX[1] + HEADER + (point['y'] - camera[2]) * PANEL_SCALE


def camera_for(point):
    """The part of the page to show so `point` sits a little left of center."""
    x = min(max(point['x'] - CROP[0] * 0.55, 0), 900 - CROP[0])
    y = min(max(point['y'] - CROP[1] * 0.5, 0), 700 - CROP[1])
    return x, y


# --- Overlays ----------------------------------------------------------------------------

CURSOR = make_cursor(1.4)


def row_box(box, camera):
    x0, y0 = to_screen({'on': 'panel', 'x': box['x'], 'y': box['y']}, camera)
    x1, y1 = to_screen({'on': 'panel', 'x': box['x'] + box['width'], 'y': box['y'] + box['height']}, camera)
    return x0, y0, min(x1, PANEL_BOX[2] - 4), y1


def note(frame, marking, camera):
    """An arrow from beside the link down to just right of its new row, curving out to
    the right, while it draws itself and holds; and the row's marker once the row is
    there. In the real extension the row just appears: these are notes on the video."""
    step, age, drawing = marking['step'], marking['age'], marking['frames']
    alpha = note_alpha(age, drawing, FPS)
    x0, y0 = to_screen(step['from'], camera)
    bx0, by0, bx1, by1 = row_box(step['to'], camera)
    start, end = (x0 + 10, y0 + 34), (bx1 + 18, (by0 + by1) / 2)
    control = (min(max(start[0], end[0]) + 110, W - 90), (start[1] + end[1]) / 2)
    frame = arrow(frame, curve(start, control, end), ease(min(1, (age + 1) / drawing)), alpha, width=7, head=26)
    if age >= drawing:
        frame = outline(frame, (bx0, by0, bx1, by1), alpha, width=5, radius=16)
    return frame


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
    scroll = scroll_target = 0  # How far the panel is scrolled, in CSS pixels.
    text, caption_age = None, 0
    marking = None  # The arrow to the newest row, and for how many frames it has shown.
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
            else:
                scroll_target = scroll_for(scroll_target, step['to']['y'], step['shot'])
        if kind == 'fly':
            box = step['to']
            scroll_target = scroll_for(scroll_for(scroll_target, box['y'] + box['height'], step['shot']), box['y'],
                                       step['shot'])
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
            scroll_target = clamp_scroll(scroll_target, step['shot'])
            scroll += (scroll_target - scroll) * 0.12
            camera = camera[:2] + (scroll,)
            base = scene(step['shot'], camera)
            if kind == 'fade':
                base = Image.blend(scene(step['from'], camera), base, ease((i + 1) / count))
            if kind == 'fly' and i == 0:
                marking = {'step': step, 'age': 0, 'frames': count}
            if marking:
                base = note(base, marking, camera)
                marking['age'] += 1
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


# --- The second Short's opening and end card ------------------------------------

def headline(canvas, title, line=None, y=150, size=96):
    draw = ImageDraw.Draw(canvas)
    draw.text((W // 2, y), title, font=font('InterDisplay-Bold.otf', size), fill=TITLE, anchor='mt')
    if line:
        draw.text((W // 2, y + size + 28), line, font=font('Inter-Medium.otf', 40), fill=ACCENT, anchor='mt')
    return canvas


STRIP = (0, 0, 1080, 660)  # The window, in the capture's pixels: tab strip, toolbar and the top of the page.
STRIP_BOX = (40, 560, 1040, 560 + round(660 * 1000 / 1080))


@lru_cache(maxsize=1)
def intro_background():
    canvas = landscape(gradient((W, H), BG, GREEN_TINT), TREES)
    canvas = shadow_for(canvas, STRIP_BOX, radius=22)
    return headline(canvas, 'Too many tabs?', y=330, size=110)


@lru_cache(maxsize=32)
def strip_card(count):
    window = Image.open(os.path.join(CAPTURES, f'strip-{count}.png')).convert('RGB').crop(STRIP)
    return window.resize((STRIP_BOX[2] - STRIP_BOX[0], STRIP_BOX[3] - STRIP_BOX[1]), Image.LANCZOS)


@lru_cache(maxsize=1)
def intro_line():
    layer = Image.new('RGBA', (W, 90), (0, 0, 0, 0))
    ImageDraw.Draw(layer).text((W // 2, 45), "Can't tell them apart?", font=font('Inter-SemiBold.otf', 54),
                               fill=TITLE + (255,), anchor='mm')
    return layer


def intro(frames=84):
    """The tab strip filling up: a few tabs a second at first, faster and faster,
    then a moment on the full, unreadable strip. The view pushes in on the tabs as
    they pile up, and a second line comes in under the window."""
    counts = sorted(int(f[6:-4]) for f in os.listdir(CAPTURES) if f.startswith('strip-') and f.endswith('.png'))
    first, last = counts.index(6), len(counts) - 1
    fill = round(frames * 0.78)
    for i in range(frames):
        t = min(1, i / fill)
        count = counts[first + round((last - first) * t ** 1.6)]
        canvas = intro_background().copy()
        card = strip_card(count)
        zoom = 1 + 0.45 * ease(i / frames)
        if zoom > 1:  # Toward the tabs, at the top left.
            w, h = card.size
            card = card.crop((0, 0, round(w / zoom), round(h / zoom))).resize((w, h), Image.LANCZOS)
        canvas.paste(card, STRIP_BOX[:2], rounded_mask(card.size, 22))
        appear = (i - frames * 0.4) / 10
        if appear > 0:
            line = intro_line()
            if appear < 1:
                line = line.copy()
                line.putalpha(line.getchannel('A').point(lambda a: round(a * appear)))
            canvas = canvas.convert('RGBA')
            canvas.alpha_composite(line, (0, STRIP_BOX[3] + 70))
            canvas = canvas.convert('RGB')
        yield canvas


def second_frames():
    """The problem, then a crossfade into the first Short's demo."""
    opening = list(intro())
    yield from opening
    demo = frames()
    first = next(demo)
    for i in range(1, 22):
        yield Image.blend(opening[-1], first, ease(i / 21))
    yield first
    yield from demo


def main():
    os.makedirs(OUT, exist_ok=True)
    video = os.path.join(OUT, 'tree-of-tabs-short-2.mp4' if SECOND else 'tree-of-tabs-short.mp4')
    silent = os.path.join(CAPTURES, 'short-silent.mp4')
    encoder = subprocess.Popen(
        ['ffmpeg', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS),
         '-i', '-', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'slow', '-movflags', '+faststart',
         silent],
        stdin=subprocess.PIPE)
    count, first, last = 0, None, None
    for frame in (second_frames() if SECOND else frames()):
        encoder.stdin.write(frame.tobytes())
        count += 1
        first, last = first or frame, frame
    BACK = 18
    for i in range(1, BACK + 1):
        encoder.stdin.write(Image.blend(last, first, ease(i / BACK)).tobytes())
    encoder.stdin.close()
    encoder.wait()
    # The music, as long as the video, at YouTube's loudness.
    music = os.path.join(CAPTURES, 'short-music.wav')
    subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), 'music.py'), str((count + BACK) / FPS), music,
                   ], check=True)
    subprocess.run(
        ['ffmpeg', '-loglevel', 'error', '-y', '-i', silent, '-i', music, '-map', '0:v', '-map', '1:a', '-c:v', 'copy',
         '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '44100', '-c:a', 'aac', '-b:a', '192k', '-shortest',
         '-movflags', '+faststart', video],
        check=True)
    print(f'{video}: {(count + BACK) / FPS:.1f} seconds, {os.path.getsize(video) / 1e6:.1f} MB')


main()
