// Drives the real extension through the demo video's story with made-up tabs
// and saves a capture of the page and the panel after every step, plus a
// timeline (steps.json) that tools/demo/render.py turns into the video.
// Usage: node tools/demo/capture.mjs <output folder>
import http from 'node:http';
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

// Plain letter icons, so no real site shows up.
const COLORS = ['#1a73e8', '#d93025', '#188038', '#e37400', '#9334e6', '#007b83', '#c5221f', '#5f6368'];
function iconFor(name) {
  const color = COLORS[[...name].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % COLORS.length];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${color}"/>` +
    `<text x="16" y="22.5" font-family="Inter,Arial" font-size="18" font-weight="700" fill="#fff" text-anchor="middle">${name[0]}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

// The pages the story opens links from; every other page is a placeholder.
const LINKS = {
  'Trip to Lisbon: planning notes': ['Flights from Berlin to Lisbon', 'Hotels in Alfama', 'Things to do in Lisbon'],
  'Hotels in Alfama': ['Casa do Fado: reviews', 'Rooftop guesthouse: photos'],
};
const INTRO = {
  'Trip to Lisbon: planning notes': 'Four days in May. Book flights first, then a place to stay near the old town.',
  'Hotels in Alfama': 'Small guesthouses close to the viewpoints, all within walking distance of the tram.',
};

function pageHtml(name) {
  const links = (LINKS[name] ?? [])
    .map((link) => `<li><a href="/${encodeURIComponent(link)}" target="_blank">${link}</a></li>`)
    .join('');
  const body = LINKS[name]
    ? `<p>${INTRO[name]}</p><h2>Links</h2><ul>${links}</ul><h2>Notes</h2>` +
      '<div class="line"></div><div class="line"></div><div class="line short"></div>'
    : '<div class="line"></div><div class="line"></div><div class="line short"></div>';
  return `<!doctype html><meta charset="utf-8"><title>${name}</title><link rel="icon" href="${iconFor(name)}">
<style>
  body { margin: 0; padding: 56px 72px; font: 18px/1.6 Inter, system-ui, sans-serif; color: #1f1f1f; background: #fff; }
  h1 { margin: 0 0 16px; font-size: 34px; font-weight: 700; letter-spacing: -0.01em; }
  h2 { margin: 32px 0 8px; font-size: 20px; font-weight: 600; }
  p { margin: 0; color: #474747; max-width: 640px; }
  ul { margin: 0; padding-left: 24px; }
  li { margin: 6px 0; }
  a { color: #0b57d0; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .line { height: 14px; margin: 18px 0; border-radius: 7px; background: #eef1f5; max-width: 640px; }
  .short { max-width: 380px; }
  @media (prefers-color-scheme: dark) {
    body { color: #e3e3e3; background: #202124; }
    p { color: #c4c7c5; }
    a { color: #a8c7fa; }
    .line { background: #2d2f31; }
  }
</style>
<h1>${name}</h1>${body}`;
}

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(pageHtml(decodeURIComponent(req.url.slice(1))));
});
await new Promise((resolve) => server.listen(0, resolve));
const base = `http://localhost:${server.address().port}`;

const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'demo-')), {
  headless: true,
  channel: 'chromium', // The headless shell cannot load extensions.
  deviceScaleFactor: 2,
  viewport: { width: 900, height: 700 },
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
await worker.evaluate(async () => {
  while (!(await chrome.storage.session.get('tree')).tree) await new Promise((resolve) => setTimeout(resolve, 50));
});

const pages = new Map();
const rootTab = async (name) => {
  const [page] = await Promise.all([
    context.waitForEvent('page'),
    worker.evaluate((url) => chrome.tabs.create({ url, active: false }), `${base}/${encodeURIComponent(name)}`),
  ]);
  await page.waitForLoadState();
  pages.set(name, page);
};
const tabId = (title) =>
  worker.evaluate(async (title) => (await chrome.tabs.query({})).find((t) => t.title === title).id, title);

// The starting window: two pinned tabs, the trip notes, a tab group and a
// collapsed tree further down.
const first = context.pages()[0];
await first.goto(`${base}/Mail`);
pages.set('Mail', first);
for (const name of ['Calendar', 'Trip to Lisbon: planning notes', 'Recipes for the weekend']) await rootTab(name);
const openChild = async (parent, name) => {
  const page = pages.get(parent);
  await page.evaluate((href) => {
    const a = Object.assign(document.createElement('a'), { href, target: '_blank', id: 'setup-link', textContent: '.' });
    document.body.append(a);
  }, `/${encodeURIComponent(name)}`);
  const [child] = await Promise.all([context.waitForEvent('page'), page.click('#setup-link', { button: 'middle' })]);
  await page.evaluate(() => document.getElementById('setup-link').remove());
  await child.waitForLoadState();
  pages.set(name, child);
};
await openChild('Recipes for the weekend', 'Weeknight lemon pasta');
await openChild('Recipes for the weekend', 'Pastéis de nata at home');
await rootTab('Q4 roadmap');
await openChild('Q4 roadmap', 'Design review');
await openChild('Q4 roadmap', 'Release checklist');
await rootTab('Weather in Lisbon');
await sleep(800);
await worker.evaluate(
  async (ids) => {
    await chrome.tabs.update(ids.mail, { pinned: true });
    await chrome.tabs.update(ids.calendar, { pinned: true });
    const group = await chrome.tabs.group({ tabIds: ids.recipes });
    await chrome.tabGroups.update(group, { color: 'green', title: 'Cooking' });
  },
  {
    mail: await tabId('Mail'),
    calendar: await tabId('Calendar'),
    recipes: [await tabId('Recipes for the weekend'), await tabId('Weeknight lemon pasta'), await tabId('Pastéis de nata at home')],
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
await panel.evaluate((id) => chrome.runtime.sendMessage({ type: 'set-collapsed', tabId: id, collapsed: true }), await tabId('Q4 roadmap'));

let active = 'Trip to Lisbon: planning notes';
const activate = async (name) => {
  await worker.evaluate(async (id) => chrome.tabs.update(id, { active: true }), await tabId(name));
  active = name;
};
await activate(active);
await sleep(1200);

// --- The timeline -----------------------------------------------------------

const steps = [];
const schemes = []; // Light or dark, for each capture.
let scheme = 'light';
let shots = 0;
async function shot() {
  await sleep(350);
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

const row = (name) => panel.locator('.tab', { hasText: name }).first();
const centerOf = async (locator, on, dx = 0) => {
  const box = await locator.boundingBox();
  return { on, x: box.x + Math.min(box.width / 2, 60) + dx, y: box.y + box.height / 2 };
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

steps.push({ type: 'card', card: 'intro', seconds: 2.6 });

caption('Tabs you open from a page nest under it');
hold(1.6);
for (const name of LINKS['Trip to Lisbon: planning notes']) {
  const link = pages.get(active).locator('a', { hasText: name });
  await moveTo(await centerOf(link, 'page'));
  const [child] = await Promise.all([context.waitForEvent('page'), link.click({ button: 'middle' })]);
  await child.waitForLoadState();
  pages.set(name, child);
  current = await shot();
  step({ type: 'click', seconds: 0.25 });
  hold(0.9);
}
await moveTo(await centerOf(row('Hotels in Alfama'), 'panel'));
step({ type: 'click', seconds: 0.25 });
await activate('Hotels in Alfama');
current = await shot();
hold(0.9);
for (const name of LINKS['Hotels in Alfama']) {
  const link = pages.get(active).locator('a', { hasText: name });
  await moveTo(await centerOf(link, 'page'));
  const [child] = await Promise.all([context.waitForEvent('page'), link.click({ button: 'middle' })]);
  await child.waitForLoadState();
  pages.set(name, child);
  current = await shot();
  step({ type: 'click', seconds: 0.25 });
  hold(0.9);
}
hold(1.4);

caption('Drag tabs to reorganize them');
const source = await centerOf(row('Weather in Lisbon'), 'panel');
await moveTo(source);
hold(0.3);
// A drag the way the panel sees it, onto the middle of "Things to do in Lisbon".
const dragTo = async (name, drop) =>
  panel.evaluate(
    ({ from, to, drop }) => {
      const find = (text) => [...document.querySelectorAll('.tab')].find((el) => el.textContent.includes(text));
      const target = find(to ?? from);
      const rect = target.getBoundingClientRect();
      const at = { clientX: rect.left + 60, clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true };
      window.demoDrag ??= new DataTransfer();
      const dataTransfer = window.demoDrag;
      if (!window.demoDragging) {
        find(from).dispatchEvent(new DragEvent('dragstart', { ...at, dataTransfer }));
        window.demoDragging = true;
      }
      if (!to) return;
      target.dispatchEvent(new DragEvent('dragover', { ...at, dataTransfer }));
      if (drop) {
        target.dispatchEvent(new DragEvent('drop', { ...at, dataTransfer }));
        dispatchEvent(new DragEvent('dragend', { bubbles: true }));
      }
    },
    { from: 'Weather in Lisbon', to: name, drop },
  );
const ghost = { shot: current, ...(await row('Weather in Lisbon').boundingBox()) };
await dragTo(null, false);
current = await shot();
await dragTo('Things to do in Lisbon', false);
const dropAt = await centerOf(row('Things to do in Lisbon'), 'panel');
step({ type: 'move', to: dropAt, seconds: 0.9, ghost });
await panel.mouse.move(dropAt.x, dropAt.y);
current = await shot();
step({ type: 'hold', seconds: 0.5, ghost });
await dragTo('Things to do in Lisbon', true);
await panel.mouse.move(dropAt.x, dropAt.y + 1);
current = await shot();
step({ type: 'click', seconds: 0.25 });
hold(1.6);

caption('Collapse what you’re not using');
await moveTo(await centerOf(row('Recipes for the weekend'), 'panel'));
step({ type: 'click', seconds: 0.25 });
await activate('Recipes for the weekend');
current = await shot();
hold(0.5);
const trip = row('Trip to Lisbon');
await moveTo(await centerOf(trip, 'panel', 30));
hold(0.5);
const twisty = await centerOf(trip.locator('.icon'), 'panel');
await moveTo(twisty, 0.5);
await trip.locator('.twisty').click();
current = await shot();
step({ type: 'click', seconds: 0.25 });
hold(2);

caption('Right-click a tab for quick actions');
const recipes = await centerOf(row('Recipes for the weekend'), 'panel');
await moveTo(recipes);
hold(0.3);
await panel.mouse.click(recipes.x, recipes.y, { button: 'right' });
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
await moveTo({ on: 'page', x: 700, y: 520 }, 0.8);
const before = current;
scheme = 'dark';
await panel.emulateMedia({ colorScheme: 'dark' });
await pages.get(active).emulateMedia({ colorScheme: 'dark' });
current = await shot();
step({ type: 'fade', from: before, seconds: 0.8 });
hold(2.4);

steps.push({ type: 'card', card: 'outro', seconds: 3.4 });

fs.writeFileSync(path.join(OUT, 'steps.json'), JSON.stringify({ steps, schemes }, null, 2));
console.log(`${shots} captures, ${steps.length} steps`);
await context.close();
server.close();
