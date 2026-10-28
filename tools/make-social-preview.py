"""Builds docs/social-preview*.png (1280x640): the icon, name and tagline next
to the panel screenshot in docs/screenshot-*.png. The light one is the
repository's social preview; the README shows the one matching the theme.
Needs Pillow and the Inter font."""
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.join(os.path.dirname(__file__), '..')
FONTS = '/usr/share/fonts/opentype/inter/'
W, H = 1280, 640
THEMES = {
    'light': dict(bg=(240, 244, 249), title=(31, 31, 31), text=(71, 71, 71), accent=(11, 87, 208), card=(255, 255, 255), shadow=60),
    'dark': dict(bg=(31, 31, 31), title=(227, 227, 227), text=(196, 199, 197), accent=(168, 199, 250), card=(40, 42, 44), shadow=140),
}


def font(name, size):
    return ImageFont.truetype(os.path.join(FONTS, name), size)


def build(scheme, colors):
    image = Image.new('RGB', (W, H), colors['bg'])
    draw = ImageDraw.Draw(image)
    # The 128px icon has 16px of padding; crop it off before scaling up.
    icon = Image.open(os.path.join(ROOT, 'icons/icon128.png')).convert('RGBA')
    icon = icon.crop((16, 16, 112, 112)).resize((132, 132), Image.LANCZOS)
    image.paste(icon, (96, 150), icon)
    draw.text((96, 310), 'Tree of Tabs', font=font('InterDisplay-Bold.otf', 84), fill=colors['title'])
    for i, line in enumerate(['Vertical tabs as a tree', 'in Chrome’s side panel.']):
        draw.text((98, 420 + 46 * i), line, font=font('Inter-Regular.otf', 34), fill=colors['text'])
    draw.text((98, 540), 'Free and open source', font=font('Inter-Medium.otf', 26), fill=colors['accent'])

    # The panel in a rounded card with a soft shadow, running off the bottom.
    shot = Image.open(os.path.join(ROOT, f'docs/screenshot-{scheme}.png')).convert('RGB')
    width = 520
    shot = shot.resize((width, int(shot.height * width / shot.width)), Image.LANCZOS)
    x, y = W - width - 90, 70
    height = H - y + 40
    shadow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((x, y + 8, x + width, y + height + 8), radius=24, fill=(0, 0, 0, colors['shadow']))
    image = Image.alpha_composite(image.convert('RGBA'), shadow.filter(ImageFilter.GaussianBlur(18))).convert('RGB')
    card = Image.new('RGB', (width, height), colors['card'])
    card.paste(shot.crop((0, 0, width, min(shot.height, height))), (0, 0))
    mask = Image.new('L', (width, height), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, width - 1, height - 1), radius=24, fill=255)
    image.paste(card, (x, y), mask)
    suffix = '' if scheme == 'light' else '-dark'
    image.save(os.path.join(ROOT, f'docs/social-preview{suffix}.png'), optimize=True)


for scheme, colors in THEMES.items():
    build(scheme, colors)
