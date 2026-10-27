// Renders the extension icons: a tree whose leaves are browser tabs.
// Draws the SVG here and rasterizes it with Playwright's Chromium.
// Usage: node tools/make-icons.mjs [preview.html]
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Same lookup as test/e2e/run.js, so a global Playwright install works too.
const { chromium } = createRequire(import.meta.url)('playwright');

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'icons');

const TRUNK = '#93603d';
const LEAVES = ['#1e8e3e', '#34a853', '#188038'];
const LINES = '#e6f4ea';

// A browser tab sitting on (cx, base): rounded top corners and small
// flared feet where it meets the tab strip.
function tab(cx, base, w, h, r, f) {
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const top = base - h;
  return (
    `M${x0 - f} ${base} A${f} ${f} 0 0 0 ${x0} ${base - f} ` +
    `L${x0} ${top + r} A${r} ${r} 0 0 1 ${x0 + r} ${top} ` +
    `L${x1 - r} ${top} A${r} ${r} 0 0 1 ${x1} ${top + r} ` +
    `L${x1} ${base - f} A${f} ${f} 0 0 0 ${x1 + f} ${base} Z`
  );
}

// detail: draw a favicon and title inside each tab (only at larger sizes).
// bold: thicker wood, so it stays visible at 16 and 32 pixels.
function svg({ detail, bold }) {
  const w = 40;
  const h = 27;
  const t = bold ? 7 : 4; // Half the trunk's width at the top.
  const branch = bold ? 11 : 7;
  const tabs = [
    { cx: 64, base: 46, color: LEAVES[1] },
    { cx: 27, base: 78, color: LEAVES[0] },
    { cx: 101, base: 78, color: LEAVES[2] },
  ];
  const leaves = tabs
    .map(({ cx, base, color }) => {
      let out = `<path d="${tab(cx, base, w, h, 7, 5)}" fill="${color}"/>`;
      if (detail) {
        const x0 = cx - w / 2;
        const mid = base - h / 2 + 1;
        out +=
          `<circle cx="${x0 + 10}" cy="${mid}" r="4" fill="${LINES}"/>` +
          `<rect x="${x0 + 18}" y="${mid - 2.5}" width="${w - 25}" height="5" rx="2.5" fill="${LINES}" opacity="0.85"/>`;
      }
      return out;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <path d="M${48 - t} 122 C${56 - t} 114 ${60 - t} 100 ${64 - t} 44 L${64 + t} 44 C${68 + t} 100 ${72 + t} 114 ${80 + t} 122 Z" fill="${TRUNK}"/>
  <path d="M63 98 C50 94 32 92 28 76 M65 98 C78 94 96 92 100 76" stroke="${TRUNK}" stroke-width="${branch}" stroke-linecap="round" fill="none"/>
  ${leaves}
</svg>`;
}

// The store wants 96px of artwork with 16px of transparent padding at 128px.
const SIZES = [
  { size: 16, detail: false, bold: true, pad: 0 },
  { size: 32, detail: false, bold: true, pad: 0 },
  { size: 48, detail: true, bold: false, pad: 0 },
  { size: 128, detail: true, bold: false, pad: 16 },
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const { size, detail, bold, pad } of SIZES) {
  const inner = size - pad * 2;
  const src = `data:image/svg+xml;base64,${Buffer.from(svg({ detail, bold })).toString('base64')}`;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<body style="margin:0;background:transparent"><img src="${src}" width="${inner}" height="${inner}" style="display:block;margin:${pad}px"></body>`,
  );
  await page.locator('img').evaluate((img) => img.decode());
  await page.screenshot({ path: path.join(OUT, `icon${size}.png`), omitBackground: true });
}
await browser.close();

// Optional preview of every size on light and dark backgrounds.
const preview = process.argv[2];
if (preview) {
  const cell = (bg) =>
    `<div style="background:${bg};padding:16px;display:flex;gap:24px;align-items:end">` +
    SIZES.map(({ size }) => `<img src="${path.join(OUT, `icon${size}.png`)}" width="${size}" height="${size}">`).join('') +
    SIZES.map(({ size }) => `<img src="${path.join(OUT, `icon${size}.png`)}" width="${size * 4}" height="${size * 4}" style="image-rendering:pixelated">`).slice(0, 2).join('') +
    `</div>`;
  writeFileSync(preview, `<body style="margin:0">${cell('#ffffff')}${cell('#dfe3e7')}${cell('#3c3c3c')}${cell('#202124')}</body>`);
}
