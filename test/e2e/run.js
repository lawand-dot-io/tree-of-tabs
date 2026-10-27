// End-to-end check: loads the unpacked extension into Chromium, drives real
// tabs, and checks the tree the background keeps plus what the panel renders.
// Usage: node test/e2e/run.js [screenshot-dir]
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

// require() also finds a globally installed Playwright.
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(import.meta.dirname, '../..');
const shots = process.argv[2];

// Pages with links, so tabs get a real opener like they do for users.
const server = createServer((req, res) => {
  const name = decodeURIComponent(req.url.slice(1)) || 'home';
  res.setHeader('content-type', 'text/html');
  res.end(`<title>Page ${name}</title><h1>${name}</h1>
    <a id="child" href="${req.url}-child" target="_blank">open child</a>`);
});
await new Promise((resolve) => server.listen(0, resolve));
const base = `http://localhost:${server.address().port}`;

const context = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'tab-tree-')), {
  headless: true,
  channel: 'chromium', // The headless shell cannot load extensions.
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  viewport: { width: 320, height: 640 },
});

let failures = 0;
async function check(name, fn) {
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 15000)),
    ]);
    console.log(`ok - ${name}`);
  } catch (error) {
    failures++;
    console.log(`not ok - ${name}\n  ${error.stack.split('\n').slice(0, 12).join('\n  ')}`);
  }
}

try {
  let worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

  // Snapshot of the window as [title, depth] pairs in native tab order.
  const outline = () =>
    worker.evaluate(async () => {
      const { tree } = await chrome.storage.session.get('tree');
      const parents = new Map(tree.parents);
      const tabs = (await chrome.tabs.query({ windowId: self.mainWindowId })).sort((a, b) => a.index - b.index);
      const depth = (id) => {
        let d = 0;
        for (let p = parents.get(id); p != null; p = parents.get(p)) d++;
        return d;
      };
      return tabs.map((t) => `${' '.repeat(depth(t.id))}${t.pinned ? '[pinned] ' : ''}${t.title}`).join('\n');
    });
  const idOf = (title) =>
    worker.evaluate(async (title) => (await chrome.tabs.query({ title }))[0]?.id, title);

  // Wait for the worker to finish initializing.
  await worker.evaluate(async () => {
    while (!(await chrome.storage.session.get('tree')).tree) await new Promise((r) => setTimeout(r, 50));
  });

  const first = context.pages()[0];
  await first.goto(`${base}/A`);
  // The panel runs in its own popup window showing the main window, so
  // activating tabs never hides it.
  const mainWindowId = await worker.evaluate(async () => (await chrome.windows.getLastFocused()).id);
  await worker.evaluate((id) => (self.mainWindowId = id), mainWindowId);
  const panelUrl = `chrome-extension://${extensionId}/src/sidepanel/sidepanel.html?windowId=${mainWindowId}`;
  const [panel] = await Promise.all([
    context.waitForEvent('page'),
    worker.evaluate((url) => chrome.windows.create({ url, type: 'popup', width: 320, height: 640 }), panelUrl),
  ]);
  await panel.setViewportSize({ width: 320, height: 640 });
  await panel.waitForLoadState();
  await settle();
  // Playwright's mouse-driven drag stalls on extension pages, so dispatch the
  // HTML5 drag events directly. `fraction` is where on the target row to drop.
  const drag = (sourceText, targetSelector, fraction = 0.5) =>
    panel.evaluate(
      ({ sourceText, targetSelector, fraction }) => {
        const source = [...document.querySelectorAll('.tab')].find(
          (el) => el.querySelector('.title').textContent === sourceText,
        );
        const target = document.querySelector(targetSelector);
        const rect = target.getBoundingClientRect();
        const at = { clientX: rect.left + 40, clientY: rect.top + rect.height * fraction, bubbles: true };
        const dataTransfer = new DataTransfer();
        source.dispatchEvent(new DragEvent('dragstart', { ...at, dataTransfer }));
        target.dispatchEvent(new DragEvent('dragover', { ...at, dataTransfer, cancelable: true }));
        target.dispatchEvent(new DragEvent('drop', { ...at, dataTransfer, cancelable: true }));
        source.dispatchEvent(new DragEvent('dragend', { ...at, dataTransfer }));
      },
      { sourceText, targetSelector, fraction },
    );
  const rowSelector = (text) =>
    panel.evaluate((text) => {
      const rows = [...document.querySelectorAll('.tab')];
      return `.tab[data-id="${rows.find((el) => el.querySelector('.title').textContent === text).dataset.id}"]`;
    }, text);

  // Headless Chromium uses the active tab as the opener of every new tab, so
  // focus the page before clicking its link.
  const clickLink = async (page) => {
    await page.bringToFront();
    const [opened] = await Promise.all([context.waitForEvent('page'), page.click('#child')]);
    await opened.waitForLoadState();
    return opened;
  };

  await check('a link opened from a tab becomes its child', async () => {
    const child = await clickLink(first);
    await clickLink(child);
    await clickLink(first);
    await settle();
    assert.equal(
      await outline(),
      ['Page A', ' Page A-child', '  Page A-child-child', ' Page A-child'].join('\n'),
    );
  });

  await check('a blank new tab starts its own tree', async () => {
    await worker.evaluate(() => chrome.tabs.create({ url: 'about:blank', active: false }));
    await settle();
    const lines = (await outline()).split('\n');
    assert.equal(lines.at(-1), 'about:blank');
  });

  await check('the panel renders the tree with indentation', async () => {
    await settle();
    const rows = await panel.$$eval('.tab', (els) =>
      els.map((el) => `${' '.repeat(Number(el.style.getPropertyValue('--depth')))}${el.querySelector('.title').textContent}`),
    );
    assert.deepEqual(rows.slice(0, 4), ['Page A', ' Page A-child', '  Page A-child-child', ' Page A-child']);
  });

  await check('collapsing hides descendants and shows a count', async () => {
    await panel.locator('.tab', { hasText: 'Page A' }).first().locator('.twisty').click();
    await settle();
    const titles = await panel.$$eval('.tab .title', (els) => els.map((e) => e.textContent));
    assert.ok(!titles.includes('Page A-child'));
    assert.equal(await panel.locator('.tab.collapsed .badge').first().textContent(), '3');
    await panel.locator('.tab', { hasText: 'Page A' }).first().locator('.twisty').click();
    await settle();
  });

  await check('dragging a tab onto another makes it a child', async () => {
    await drag('about:blank', await rowSelector('Page A-child-child'), 0.5);
    await settle();
    assert.equal(
      await outline(),
      ['Page A', ' Page A-child', '  Page A-child-child', '   about:blank', ' Page A-child'].join('\n'),
    );
  });

  await check('dragging a subtree to the empty area makes it a root', async () => {
    await drag('Page A-child', '#new-tab');
    await settle();
    assert.equal(
      await outline(),
      ['Page A', ' Page A-child', 'Page A-child', ' Page A-child-child', '  about:blank'].join('\n'),
    );
  });

  await check('dropping above a tab inserts before it as a sibling', async () => {
    await drag('about:blank', '.tab', 0.1);
    await settle();
    assert.equal(
      await outline(),
      ['about:blank', 'Page A', ' Page A-child', 'Page A-child', ' Page A-child-child'].join('\n'),
    );
  });

  await check('moving a parent in the tab strip brings its subtree along', async () => {
    const id = await idOf('Page A');
    await worker.evaluate((id) => chrome.tabs.move(id, { index: -1 }), id);
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(
      await outline(),
      ['about:blank', 'Page A-child', ' Page A-child-child', 'Page A', ' Page A-child'].join('\n'),
    );
  });

  await check('closing a parent promotes its first child', async () => {
    // Give "Page A" a second child first.
    await clickLink(first);
    await settle();
    await worker.evaluate(async (id) => chrome.tabs.remove(id), await idOf('Page A'));
    await settle();
    assert.equal(
      await outline(),
      ['about:blank', 'Page A-child', ' Page A-child-child', 'Page A-child', ' Page A-child'].join('\n'),
    );
  });

  await check('pinned tabs leave the tree and show in the pinned bar', async () => {
    await worker.evaluate(async (id) => chrome.tabs.update(id, { pinned: true }), await idOf('about:blank'));
    await settle();
    assert.equal(await panel.locator('.pinned-tab').count(), 1);
    assert.ok((await outline()).startsWith('[pinned] about:blank'));
  });

  await check('the panel reflects the tree after a reload', async () => {
    await panel.reload();
    await settle();
    const depths = await panel.$$eval('.tab', (els) => els.map((el) => el.style.getPropertyValue('--depth')));
    assert.deepEqual(depths, ['0', '1', '0', '1']);
  });

  await check('moving a tree to a new window keeps its structure', async () => {
    const id = await idOf('Page A-child-child');
    const parentId = await worker.evaluate(async (id) => {
      const { tree } = await chrome.storage.session.get('tree');
      return new Map(tree.parents).get(id);
    }, id);
    await panel.evaluate((id) => chrome.runtime.sendMessage({ type: 'move-to-new-window', ids: [id] }), parentId);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const moved = await worker.evaluate(async (ids) => {
      const { tree } = await chrome.storage.session.get('tree');
      const parents = new Map(tree.parents);
      const [a, b] = await Promise.all(ids.map((id) => chrome.tabs.get(id)));
      return { sameWindow: a.windowId === b.windowId, newWindow: a.windowId !== self.mainWindowId, parent: parents.get(b.id) };
    }, [parentId, id]);
    assert.deepEqual(moved, { sameWindow: true, newWindow: true, parent: parentId });
    assert.equal(await outline(), ['[pinned] about:blank', 'Page A-child', ' Page A-child'].join('\n'));
  });

  await check('tabs opened in quick succession keep their parents', async () => {
    await worker.evaluate(async ({ base, windowId }) => {
      const open = (path, openerTabId) =>
        chrome.tabs.create({ windowId, url: base + path, openerTabId, active: false });
      const docs = await open('/Project docs');
      const spec = await open('/Design spec', docs.id);
      await open('/Review comments', spec.id);
      await open('/Meeting notes', docs.id);
      const news = await open('/News');
      await open('/Article about browsers', news.id);
      await open('/Another article', news.id);
    }, { base, windowId: mainWindowId });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const lines = (await outline()).split('\n').slice(3);
    assert.deepEqual(lines, [
      'Page Project docs',
      ' Page Design spec',
      '  Page Review comments',
      ' Page Meeting notes',
      'Page News',
      ' Page Article about browsers',
      ' Page Another article',
    ]);
  });

  await check('the tree is rebuilt from the snapshot when session state is lost', async () => {
    const newsId = await idOf('Page News');
    await panel.evaluate((id) => chrome.runtime.sendMessage({ type: 'set-collapsed', tabId: id, collapsed: true }), newsId);
    const before = await outline();
    await new Promise((resolve) => setTimeout(resolve, 1500)); // Let the snapshot save.
    // Same as an extension update: session storage is gone, the worker restarts.
    await worker.evaluate(() => chrome.storage.session.clear());
    const cdp = await context.newCDPSession(panel);
    await cdp.send('ServiceWorker.enable');
    await worker.evaluate(() => (self.marker = 'old worker'));
    await cdp.send('ServiceWorker.stopAllWorkers');
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'get-tree' }));
    worker = context.serviceWorkers().at(-1);
    assert.equal(await worker.evaluate(() => self.marker), undefined);
    await worker.evaluate((id) => (self.mainWindowId = id), mainWindowId);
    await worker.evaluate(async () => {
      while (!(await chrome.storage.session.get('tree')).tree) await new Promise((r) => setTimeout(r, 50));
    });
    assert.equal(await outline(), before);
    const { tree } = await worker.evaluate(() => chrome.storage.session.get('tree'));
    assert.ok(tree.collapsed.includes(newsId));
  });

  await check('the panel closes when its window goes full screen', async () => {
    // Here the panel runs as a tab without ?windowId=, like the real side
    // panel, so it watches its own window.
    const url = panelUrl.replace(/\?.*/, '');
    const [own] = await Promise.all([
      context.waitForEvent('page'),
      worker.evaluate((url) => chrome.windows.create({ url: [url, 'about:blank'], width: 900, height: 600 }), url),
    ]);
    await own.waitForLoadState();
    const windowId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].windowId, url);
    // Playwright pins the page size, so the page gets no real resize events
    // here; send the one Chrome would send.
    const resized = () => own.evaluate(() => dispatchEvent(new Event('resize')));
    await worker.evaluate((id) => chrome.windows.update(id, { width: 800 }), windowId);
    await resized();
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(own.isClosed(), false, 'an ordinary resize keeps the panel open');
    await worker.evaluate((id) => chrome.windows.update(id, { state: 'fullscreen' }), windowId);
    await Promise.all([own.waitForEvent('close', { timeout: 5000 }), resized().catch(() => {})]);
    await worker.evaluate((id) => chrome.windows.remove(id), windowId);
  });

  if (shots) {
    await worker.evaluate(async (id) => chrome.tabs.update(id, { active: true }), await idOf('Page Design spec'));
    await settle();
    await panel.bringToFront();
    for (const scheme of ['light', 'dark']) {
      await panel.emulateMedia({ colorScheme: scheme });
      await panel.locator('.tab').nth(4).hover();
      await panel.screenshot({ path: path.join(shots, `panel-${scheme}.png`) });
    }
    await panel.locator('.tab').nth(3).click({ button: 'right' });
    await panel.screenshot({ path: path.join(shots, 'panel-menu-dark.png') });
    await panel.keyboard.press('Escape');
  }
} finally {
  await context.close();
  server.close();
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
