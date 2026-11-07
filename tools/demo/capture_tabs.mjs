// Captures the opening of the second Short: a real Chromium window whose tab
// strip fills up with more and more tabs until they are unreadable. Headless
// browsers have no tab strip, so this runs a normal window on a virtual
// display and photographs the screen after each new tab (strip-<count>.png in
// the capture folder). Needs Playwright, Xvfb and ImageMagick's `import`, and
// network access.
// Usage: xvfb-run -a -s "-screen 0 1200x800x24" node tools/demo/capture_tabs.mjs <capture folder>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
const OUT = process.argv[2];
if (!OUT) throw new Error('Usage: node tools/demo/capture_tabs.mjs <capture folder>');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const wiki = (title) => `https://en.wikipedia.org/wiki/${title}`;
const URLS = [
  wiki('Lisbon'),
  wiki('Alfama'),
  'https://github.com/lawand-dot-io/tree-of-tabs',
  wiki('Bel%C3%A9m_Tower'),
  'https://www.openstreetmap.org/',
  wiki('Fado'),
  'https://en.wikivoyage.org/wiki/Lisbon',
  'https://developer.chrome.com/docs/extensions/reference/api/sidePanel',
  wiki('Sintra'),
  'https://developer.mozilla.org/en-US/docs/Web/HTML',
  wiki('Porto'),
  'https://github.com/lawand-dot-io/tree-of-tabs/issues',
  wiki('Tagus'),
  'https://commons.wikimedia.org/wiki/Category:Ocean%C3%A1rio_de_Lisboa',
  'https://docs.python.org/3/',
  wiki('Pastel_de_nata'),
  'https://news.ycombinator.com/',
  wiki('Lisbon_Cathedral'),
  'https://www.w3.org/',
  wiki('S%C3%A3o_Jorge_Castle'),
  'https://archive.org/',
  wiki('Tram_28'),
  'https://stackoverflow.com/questions/tagged/javascript',
  wiki('Azulejo'),
  'https://www.gutenberg.org/',
  wiki('Douro'),
  'https://en.wikivoyage.org/wiki/Porto',
  wiki('Coimbra'),
  'https://developer.chrome.com/docs/extensions',
  wiki('Madeira'),
];

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'strip-'));
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  channel: 'chromium',
  viewport: null,
  args: ['--force-device-scale-factor=2', '--window-position=0,0', '--window-size=540,330', '--no-first-run',
    '--hide-crash-restore-bubble', '--disable-features=TranslateUI'],
});
const shoot = (count) => execFileSync('import', ['-window', 'root', path.join(OUT, `strip-${count}.png`)]);
const load = async (page, url) => {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await sleep(900); // Let the icon and title arrive and the strip settle.
};
let page = context.pages()[0];
await load(page, URLS[0]);
shoot(1);
for (let i = 1; i < URLS.length; i++) {
  page = await context.newPage();
  await load(page, URLS[i]);
  shoot(i + 1);
  console.log(i + 1, URLS[i]);
}
await context.close();
