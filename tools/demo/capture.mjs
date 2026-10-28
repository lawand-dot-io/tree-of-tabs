// Drives the real extension through the demo video's story, browsing real
// Wikipedia articles about Lisbon, and saves a capture of the page and the
// panel after every step, plus a timeline (steps.json) that
// tools/demo/render.py turns into the video. Needs network access to
// Wikipedia; the articles are CC BY-SA, so credit Wikipedia where the video is
// published.
// Usage: node tools/demo/capture.mjs <output folder>
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

// require() also finds a globally installed Playwright.
const { chromium } = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = process.argv[2];
if (!OUT) throw new Error('Usage: node tools/demo/capture.mjs <output folder>');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const WIKI = 'https://en.wikipedia.org/wiki/';

const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'demo-')), {
  headless: true,
  channel: 'chromium', // The headless shell cannot load extensions.
  deviceScaleFactor: 2,
  viewport: { width: 900, height: 700 },
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});
// Hide donation banners, maintenance boxes and link preview pop-ups, which
// come and go and would distract from the tree.
await context.addInitScript(() => {
  if (!location.hostname.endsWith('.org')) return;
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

// Pages by article name ("Lisbon"), whatever site they're on.
const pages = new Map();
const settle = (page) => page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
const rootTab = async (name, url = WIKI + name.replaceAll(' ', '_')) => {
  const [page] = await Promise.all([
    context.waitForEvent('page'),
    worker.evaluate((url) => chrome.tabs.create({ url, active: false }), url),
  ]);
  await settle(page);
  pages.set(name, page);
};
// Opens an article from a page with a middle click, the way the story does.
const openChild = async (parent, name) => {
  const page = pages.get(parent);
  await page.evaluate((href) => {
    const a = Object.assign(document.createElement('a'), { href, id: 'setup-link', textContent: '.' });
    document.body.prepend(a);
  }, WIKI + name.replaceAll(' ', '_'));
  const [child] = await Promise.all([context.waitForEvent('page'), page.click('#setup-link', { button: 'middle' })]);
  await page.evaluate(() => document.getElementById('setup-link').remove());
  await settle(child);
  pages.set(name, child);
};
// Tab titles are "<article> - Wikipedia" (or Wikivoyage).
const titleOf = (name) => new RegExp(`^${name} [-–] Wiki`);
const tabId = (name) =>
  worker.evaluate(
    async (source) => (await chrome.tabs.query({})).find((t) => new RegExp(source).test(t.title)).id,
    titleOf(name).source,
  );

// The starting window: two pinned tabs, the Lisbon article, a tab group about
// food and a collapsed tree further down.
const first = context.pages()[0];
await first.goto(`${WIKI}Main_Page`);
await settle(first);
pages.set('Main Page', first);
await rootTab('Lisbon guide', 'https://en.wikivoyage.org/wiki/Lisbon');
await rootTab('Lisbon');
await rootTab('Portuguese cuisine');
await openChild('Portuguese cuisine', 'Pastel de nata');
await openChild('Portuguese cuisine', 'Bacalhau');
await rootTab('Portuguese language');
await openChild('Portuguese language', 'Saudade');
await openChild('Portuguese language', 'Portuguese orthography');
await rootTab('Lisbon Oceanarium');
await sleep(800);
await worker.evaluate(
  async (ids) => {
    await chrome.tabs.update(ids.main, { pinned: true });
    await chrome.tabs.update(ids.guide, { pinned: true });
    const group = await chrome.tabs.group({ tabIds: ids.food });
    await chrome.tabGroups.update(group, { color: 'green', title: 'Food' });
  },
  {
    // The Main Page's title is "Wikipedia, the free encyclopedia".
    main: await worker.evaluate(async () => (await chrome.tabs.query({ url: '*://en.wikipedia.org/wiki/Main_Page' }))[0].id),
    guide: await worker.evaluate(async () => (await chrome.tabs.query({ url: '*://en.wikivoyage.org/*' }))[0].id),
    food: [await tabId('Portuguese cuisine'), await tabId('Pastel de nata'), await tabId('Bacalhau')],
  },
);

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
await panel.evaluate(
  (id) => chrome.runtime.sendMessage({ type: 'set-collapsed', tabId: id, collapsed: true }),
  await tabId('Portuguese language'),
);

let active = 'Lisbon';
const activate = async (name) => {
  await worker.evaluate(async (id) => chrome.tabs.update(id, { active: true }), await tabId(name));
  active = name;
};
await activate(active);
await sleep(1500);

// --- The timeline -----------------------------------------------------------

const steps = [];
const schemes = []; // Light or dark, for each capture.
let scheme = 'light';
let shots = 0;
async function shot(wait = 350) {
  await sleep(wait);
  const id = shots++;
  schemes.push(scheme);
  await pages.get(active).screenshot({ path: path.join(OUT, `page-${id}.png`) });
  await panel.screenshot({ path: path.join(OUT, `panel-${id}.png`) });
  return id;
}
let current = await shot();
const step = (s) => steps.push({ shot: current, ...s });
const hold = (seconds) => step({ type: 'hold', seconds });
const caption = (text) => steps.push({ type: 'caption', text });

const row = (name) => panel.locator('.tab').filter({ has: panel.locator('.title', { hasText: titleOf(name) }) });
const centerOf = async (locator, on, dx = 0) => {
  const box = await locator.boundingBox();
  return { on, x: box.x + Math.min(box.width / 2, 60) + dx, y: box.y + box.height / 2 };
};
// The link to an article that's visible on the page right now.
const linkTo = async (name) => {
  const box = await pages.get(active).evaluate((name) => {
    const visible = [...document.querySelectorAll('#mw-content-text a[title]')]
      .filter((a) => a.title === name)
      // A link that wraps has a box per line; aim at the first.
      .map((a) => a.getClientRects()[0])
      .find((r) => r?.width && r.top > 0 && r.bottom < innerHeight - 4);
    return visible && { x: visible.x, y: visible.y, width: visible.width, height: visible.height };
  }, name);
  if (!box) throw new Error(`No visible link to ${name}`);
  return { on: 'page', x: box.x + Math.min(box.width / 2, 50), y: box.y + box.height / 2 };
};
// Moves the drawn cursor and the real mouse, so hover styles show.
async function moveTo(target, seconds = 0.85) {
  step({ type: 'move', to: target, seconds });
  // The other side loses its hover, as it would with one real mouse.
  const [page, other, away] =
    target.on === 'panel' ? [panel, pages.get(active), [5, 690]] : [pages.get(active), panel, [310, 660]];
  await other.mouse.move(...away);
  await page.mouse.move(target.x, target.y);
  current = await shot();
}
async function middleClick(name) {
  const target = await linkTo(name);
  await moveTo(target);
  const page = pages.get(active);
  const [child] = await Promise.all([
    context.waitForEvent('page'),
    page.mouse.click(target.x, target.y, { button: 'middle' }),
  ]);
  await settle(child);
  pages.set(name, child);
  current = await shot(600);
  step({ type: 'click', seconds: 0.25 });
  hold(0.9);
}
// A smooth scroll, captured in small steps.
async function scroll(pixels, count = 8) {
  for (let i = 0; i < count; i++) {
    await pages.get(active).mouse.wheel(0, pixels / count);
    current = await shot(120);
    hold(1 / 15);
  }
}

steps.push({ type: 'card', card: 'intro', seconds: 2.6 });

caption('Tabs you open from a page nest under it');
hold(1.4);
await moveTo({ on: 'page', x: 300, y: 480 });
await scroll(150);
hold(0.4);
for (const name of ['Alfama', 'Belém Tower', 'Lisbon Cathedral']) await middleClick(name);
await moveTo(await centerOf(row('Alfama'), 'panel'));
step({ type: 'click', seconds: 0.25 });
await activate('Alfama');
current = await shot(600);
hold(0.9);
for (const name of ['São Jorge Castle', 'Fado']) await middleClick(name);
hold(1.4);

caption('Drag tabs to reorganize them');
await moveTo(await centerOf(row('Lisbon Oceanarium'), 'panel'));
hold(0.3);
// A drag the way the panel sees it, onto the middle of the "Lisbon" row.
const dragTo = async (targetId, drop) =>
  panel.evaluate(
    ({ sourceId, targetId, drop }) => {
      const find = (id) => document.querySelector(`.tab[data-id="${id}"]`);
      const target = find(targetId ?? sourceId);
      const rect = target.getBoundingClientRect();
      const at = { clientX: rect.left + 60, clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true };
      window.demoDrag ??= new DataTransfer();
      const dataTransfer = window.demoDrag;
      if (!window.demoDragging) {
        find(sourceId).dispatchEvent(new DragEvent('dragstart', { ...at, dataTransfer }));
        window.demoDragging = true;
      }
      if (!targetId) return;
      target.dispatchEvent(new DragEvent('dragover', { ...at, dataTransfer }));
      if (drop) {
        target.dispatchEvent(new DragEvent('drop', { ...at, dataTransfer }));
        dispatchEvent(new DragEvent('dragend', { bubbles: true }));
      }
    },
    { sourceId: await tabId('Lisbon Oceanarium'), targetId, drop },
  );
const ghost = { shot: current, ...(await row('Lisbon Oceanarium').boundingBox()) };
await dragTo(null, false);
current = await shot();
const lisbonId = await tabId('Lisbon');
await dragTo(lisbonId, false);
const dropAt = await centerOf(row('Lisbon'), 'panel');
step({ type: 'move', to: dropAt, seconds: 1, ghost });
await panel.mouse.move(dropAt.x, dropAt.y);
current = await shot();
step({ type: 'hold', seconds: 0.5, ghost });
await dragTo(lisbonId, true);
await panel.mouse.move(dropAt.x, dropAt.y + 1);
current = await shot(600);
step({ type: 'click', seconds: 0.25 });
hold(1.6);

caption('Collapse what you’re not using');
await moveTo(await centerOf(row('Portuguese cuisine'), 'panel'));
step({ type: 'click', seconds: 0.25 });
await activate('Portuguese cuisine');
current = await shot(600);
hold(0.6);
const lisbon = row('Lisbon');
await moveTo(await centerOf(lisbon, 'panel', 30));
hold(0.5);
await moveTo(await centerOf(lisbon.locator('.icon'), 'panel'), 0.5);
await lisbon.locator('.twisty').click();
current = await shot();
step({ type: 'click', seconds: 0.25 });
hold(2);

caption('Right-click a tab for quick actions');
const cuisine = await centerOf(row('Portuguese cuisine'), 'panel');
await moveTo(cuisine);
hold(0.3);
await panel.mouse.click(cuisine.x, cuisine.y, { button: 'right' });
current = await shot();
step({ type: 'click', seconds: 0.25 });
hold(0.8);
for (const label of ['Duplicate', 'Collapse tree', 'Move tree to new window']) {
  await moveTo(await centerOf(panel.locator('.menu-item', { hasText: label }), 'panel'), 0.6);
  hold(0.6);
}
hold(0.6);
await panel.keyboard.press('Escape');
await panel.mouse.move(310, 660);
current = await shot();
hold(0.6);

caption('Looks like part of Chrome, in light and dark mode');
await moveTo({ on: 'page', x: 700, y: 560 }, 0.8);
const before = current;
scheme = 'dark';
await panel.emulateMedia({ colorScheme: 'dark' });
const page = pages.get(active);
await page.emulateMedia({ colorScheme: 'dark' });
// Wikipedia's own night theme, as a reader with dark mode would see it.
await page.evaluate(() => {
  document.documentElement.classList.remove('skin-theme-clientpref-day', 'skin-theme-clientpref-os');
  document.documentElement.classList.add('skin-theme-clientpref-night');
});
current = await shot(600);
step({ type: 'fade', from: before, seconds: 0.8 });
hold(2.4);

steps.push({ type: 'card', card: 'outro', seconds: 3.4 });

fs.writeFileSync(path.join(OUT, 'steps.json'), JSON.stringify({ steps, schemes }, null, 2));
console.log(`${shots} captures, ${steps.length} steps`);
await context.close();
