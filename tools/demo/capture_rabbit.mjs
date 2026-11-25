// Drives the real extension through the third Short's story, a Wikipedia
// rabbit hole: from Octopus to the Kraken, Jules Verne, Twenty Thousand Leagues
// Under the Seas and Captain Nemo, with a few side branches. It saves a capture
// of the page and the panel after every step and a timeline (steps.json), in
// the same form as capture.mjs, for tools/demo/render_short.py --rabbit. The
// Short opens on the same rabbit hole as a plain tab strip: run
// `capture_tabs.mjs <folder> rabbit` into the same folder for that. Needs
// network access; the Wikipedia pages are CC BY-SA, so credit them where the
// video is published.
// Usage: node tools/demo/capture_rabbit.mjs <output folder>
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = process.argv[2];
if (!OUT) throw new Error('Usage: node tools/demo/capture_rabbit.mjs <output folder>');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const WIKI = 'https://en.wikipedia.org/wiki/';

const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'rabbit-')), {
  headless: true,
  channel: 'chromium', // The headless shell cannot load extensions.
  deviceScaleFactor: 2,
  viewport: { width: 900, height: 700 },
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});
// Hide donation banners, maintenance boxes and link preview pop-ups, which
// come and go and would distract from the tree.
await context.addInitScript(() => {
  if (!/wikipedia\.org$/.test(location.hostname)) return;
  document.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = '#siteNotice, #centralNotice, .frb, .ambox, .mwe-popups { display: none !important; }';
    document.head.append(style);
  });
});
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
await worker.evaluate(async () => {
  while (!(await chrome.storage.session.get('tree')).tree) await new Promise((resolve) => setTimeout(resolve, 50));
});

const pages = new Map();
const settle = (page) => page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
const tabId = (name) =>
  worker.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url).id, pages.get(name).url());

// The rabbit hole starts on Octopus; two other trees sit below it.
const first = context.pages()[0];
await first.goto(WIKI + 'Octopus');
await settle(first);
pages.set('Octopus', first);
for (const [name, url] of [
  ['Repo', 'https://github.com/lawand-dot-io/tree-of-tabs'],
  ['Map', 'https://www.openstreetmap.org/#map=16/38.7118/-9.1300'],
]) {
  const [page] = await Promise.all([
    context.waitForEvent('page'),
    worker.evaluate((url) => chrome.tabs.create({ url, active: false }), url),
  ]);
  await settle(page);
  pages.set(name, page);
}

const windowId = await worker.evaluate(async () => (await chrome.windows.getLastFocused()).id);
const extensionId = new URL(worker.url()).host;
const [panel] = await Promise.all([
  context.waitForEvent('page'),
  worker.evaluate(
    (url) => chrome.windows.create({ url, type: 'popup', width: 320, height: 700 }),
    `chrome-extension://${extensionId}/src/sidepanel/sidepanel.html?windowId=${windowId}`,
  ),
]);
await panel.waitForLoadState();
await panel.setViewportSize({ width: 320, height: 666 });

let active = 'Octopus';
const activate = async (name) => {
  await worker.evaluate(async (id) => chrome.tabs.update(id, { active: true }), await tabId(name));
  active = name;
};
await activate(active);
await sleep(1500);

// --- The timeline, as in capture.mjs -------------------------------------------

const steps = [];
const schemes = [];
let shots = 0;
async function shot(wait = 350) {
  await sleep(wait);
  const id = shots++;
  schemes.push('light');
  await pages.get(active).screenshot({ path: path.join(OUT, `page-${id}.png`) });
  await panel.screenshot({ path: path.join(OUT, `panel-${id}.png`) });
  return id;
}
let current = await shot();
const step = (s) => steps.push({ shot: current, ...s });
const hold = (seconds) => step({ type: 'hold', seconds });
const caption = (text) => steps.push({ type: 'caption', text });

const row = async (name) => panel.locator(`.tab[data-id="${await tabId(name)}"]`);
const centerOf = async (locator, on, dx = 0) => {
  const box = await locator.boundingBox();
  return { on, x: box.x + Math.min(box.width / 2, 60) + dx, y: box.y + box.height / 2 };
};
const linkTo = async (name) => {
  const box = await pages.get(active).evaluate((name) => {
    const visible = [...document.querySelectorAll('#mw-content-text p a[title]')]
      .filter((a) => a.title === name)
      .map((a) => a.getClientRects()[0])
      .find((r) => r?.width && r.top > 0 && r.bottom < innerHeight - 4);
    return visible && { x: visible.x, y: visible.y, width: visible.width, height: visible.height };
  }, name);
  if (!box) throw new Error(`No visible link to ${name} on ${active}`);
  return { on: 'page', x: box.x + Math.min(box.width / 2, 50), y: box.y + box.height / 2 };
};
async function moveTo(target, seconds = 0.85) {
  step({ type: 'move', to: target, seconds });
  const [page, other, away] =
    target.on === 'panel' ? [panel, pages.get(active), [5, 690]] : [pages.get(active), panel, [310, 660]];
  await other.mouse.move(...away);
  await page.mouse.move(target.x, target.y);
  current = await shot();
}
async function middleClick(name) {
  const target = await linkTo(name);
  await moveTo(target, 0.7);
  const before = current;
  const page = pages.get(active);
  const [child] = await Promise.all([
    context.waitForEvent('page'),
    page.mouse.click(target.x, target.y, { button: 'middle' }),
  ]);
  await settle(child);
  pages.set(name, child);
  current = await shot(600);
  const box = await (await row(name)).boundingBox();
  steps.push({ shot: before, type: 'click', seconds: 0.25 });
  steps.push({ shot: before, type: 'fly', seconds: 0.6, from: target, to: { on: 'panel', ...box }, label: name });
  step({ type: 'hold', seconds: 0.7, glow: { on: 'panel', ...box } });
}
async function scroll(pixels, count = 6) {
  for (let i = 0; i < count; i++) {
    await pages.get(active).mouse.wheel(0, pixels / count);
    current = await shot(120);
    hold(1 / 15);
  }
}
// Goes to a tab by clicking its row in the tree, then scrolls its page to the links.
async function follow(name) {
  await moveTo(await centerOf(await row(name), 'panel'), 0.7);
  step({ type: 'click', seconds: 0.25 });
  await activate(name);
  current = await shot(600);
  hold(0.3);
  await moveTo({ on: 'page', x: 420, y: 420 }, 0.5);
  await scroll(150);
}

caption('Every link you follow nests under its page');
hold(0.6);
await moveTo({ on: 'page', x: 420, y: 420 }, 0.5);
await scroll(150);
for (const name of ['Kraken', 'Squid']) await middleClick(name);
await follow('Kraken');
for (const name of ['Giant squid', 'Jules Verne']) await middleClick(name);
await follow('Jules Verne');
for (const name of ['Twenty Thousand Leagues Under the Seas', 'Around the World in Eighty Days']) await middleClick(name);
await follow('Twenty Thousand Leagues Under the Seas');
await middleClick('Captain Nemo');

caption('So you can always see how you got there');
await moveTo(await centerOf(await row('Captain Nemo'), 'panel'), 0.7);
step({ type: 'click', seconds: 0.25 });
await activate('Captain Nemo');
current = await shot(600);
// The path from Octopus down to Captain Nemo, one row after another.
const trail = [];
for (const name of ['Octopus', 'Kraken', 'Jules Verne', 'Twenty Thousand Leagues Under the Seas', 'Captain Nemo']) {
  trail.push({ on: 'panel', ...(await (await row(name)).boundingBox()) });
}
step({ type: 'hold', seconds: 2.6, path: trail });

caption('Done? Collapse the whole rabbit hole');
const octopus = await row('Octopus');
await moveTo(await centerOf(octopus, 'panel', 30), 0.7);
await moveTo(await centerOf(octopus.locator('.icon'), 'panel'), 0.4);
await octopus.locator('.twisty').click();
step({ type: 'click', seconds: 0.25 });
current = await shot(600);
hold(0.3);
await panel.mouse.move(310, 660);
current = await shot();
hold(2.4);

fs.writeFileSync(path.join(OUT, 'steps.json'), JSON.stringify({ steps, schemes }, null, 2));
console.log(`${shots} captures, ${steps.length} steps`);
await context.close();
