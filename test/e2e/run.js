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
  // Any uncaught error in the panel fails the run (checked at the end).
  const panelErrors = [];
  panel.on('pageerror', (error) => panelErrors.push(error.message));
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

  await check('turning collapsing off expands trees and removes the collapse controls', async () => {
    const collapsedIds = async () => (await worker.evaluate(() => chrome.storage.session.get('tree'))).tree.collapsed;
    const parentRow = panel.locator('.tab', { hasText: 'Page A' }).first();
    await parentRow.locator('.twisty').click();
    await settle();
    assert.equal((await collapsedIds()).length, 1, 'collapsed before the change');

    await worker.evaluate(() => chrome.storage.sync.set({ disableCollapsing: true }));
    await settle();
    assert.deepEqual(await collapsedIds(), [], 'collapsed trees expand');
    const titles = await panel.$$eval('.tab .title', (els) => els.map((e) => e.textContent));
    assert.ok(titles.includes('Page A-child-child'), 'hidden tabs are shown again');
    assert.equal(await panel.locator('.twisty:visible').count(), 0, 'no arrows');

    await parentRow.click({ button: 'right' });
    const labels = await panel.$$eval('.menu-item', (items) => items.map((item) => item.textContent));
    await panel.keyboard.press('Escape');
    assert.ok(!labels.some((label) => /collapse|expand/i.test(label)), labels.join(', '));

    // Nothing else can collapse a tree either: not the keyboard, not a message.
    await parentRow.focus();
    await panel.keyboard.press('ArrowLeft');
    const id = Number(await parentRow.getAttribute('data-id'));
    await panel.evaluate((id) => chrome.runtime.sendMessage({ type: 'set-collapsed', tabId: id, collapsed: true }), id);
    await panel.evaluate((windowId) => chrome.runtime.sendMessage({ type: 'set-all-collapsed', windowId, collapsed: true }), mainWindowId);
    await settle();
    assert.deepEqual(await collapsedIds(), []);

    await worker.evaluate(() => chrome.storage.sync.set({ disableCollapsing: false }));
    await settle();
    assert.equal(await parentRow.locator('.twisty').isVisible(), true, 'arrows come back');
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

  await check('with "Close its children too", closing a parent closes its whole branch', async () => {
    await worker.evaluate(() => chrome.storage.sync.set({ onCloseParent: 'closeAll' }));
    const ids = await worker.evaluate(async ({ base, windowId }) => {
      const open = (path, openerTabId) =>
        chrome.tabs.create({ windowId, url: base + path, openerTabId, active: false }).then((t) => t.id);
      const parent = await open('/Close parent');
      const child = await open('/Close child', parent);
      const grandchild = await open('/Close grandchild', child);
      const sibling = await open('/Close sibling', parent);
      const bystander = await open('/Bystander');
      return { parent, child, grandchild, sibling, bystander };
    }, { base, windowId: mainWindowId });
    await settle();
    await worker.evaluate((id) => chrome.tabs.remove(id), ids.parent);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const alive = await worker.evaluate(
      async (ids) => Object.fromEntries(await Promise.all(
        Object.entries(ids).map(async ([name, id]) => [name, !!(await chrome.tabs.get(id).catch(() => null))]),
      )),
      ids,
    );
    assert.deepEqual(alive, { parent: false, child: false, grandchild: false, sibling: false, bystander: true });
    await worker.evaluate(async (id) => {
      await chrome.tabs.remove(id);
      await chrome.storage.sync.remove('onCloseParent');
    }, ids.bystander);
    await settle();
  });

  await check('pinned tabs leave the tree and show in the pinned bar', async () => {
    await worker.evaluate(async (id) => chrome.tabs.update(id, { pinned: true }), await idOf('about:blank'));
    await settle();
    assert.equal(await panel.locator('.pinned-tab').count(), 1);
    assert.ok((await outline()).startsWith('[pinned] about:blank'));
  });

  await check('the menu offers to mute just the tab', async () => {
    await panel.locator('.tab').first().click({ button: 'right' });
    const labels = await panel.$$eval('.menu-item', (items) => items.map((item) => item.textContent));
    await panel.keyboard.press('Escape');
    assert.ok(labels.includes('Mute tab'), labels.join(', '));
    assert.ok(!labels.some((label) => label.includes('site')));
  });

  await check('clicking a tab that just closed is not an error', async () => {
    const id = await worker.evaluate(async (windowId) => {
      const tab = await chrome.tabs.create({ windowId, url: 'about:blank#closing', active: false });
      return tab.id;
    }, mainWindowId);
    await settle();
    const row = panel.locator(`.tab[data-id="${id}"]`);
    // Remove the tab behind the panel's back, then click its row before the
    // panel has caught up.
    await row.evaluate((el, id) => {
      chrome.tabs.remove(id);
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      el.querySelector('.close').click();
    }, id);
    await settle();
    assert.deepEqual(panelErrors, []);
  });

  await check('the new tab button opens a tree, or a child when middle-clicked', async () => {
    const newest = () =>
      worker.evaluate(async (windowId) => {
        const tabs = await chrome.tabs.query({ windowId });
        const tab = tabs.reduce((a, b) => (b.id > a.id ? b : a));
        const { tree } = await chrome.storage.session.get('tree');
        return { id: tab.id, parent: new Map(tree.parents).get(tab.id) };
      }, mainWindowId);
    const activeId = await worker.evaluate(
      async (windowId) => (await chrome.tabs.query({ windowId, active: true }))[0].id,
      mainWindowId,
    );
    const before = (await newest()).id;

    await panel.click('#new-tab', { button: 'middle' });
    await settle();
    const child = await newest();
    assert.notEqual(child.id, before);
    assert.equal(child.parent, activeId, 'middle click: child of the active tab');
    await worker.evaluate((id) => chrome.tabs.remove(id), child.id);
    await settle();

    await panel.click('#new-tab');
    await settle();
    const root = await newest();
    assert.notEqual(root.id, child.id);
    assert.equal(root.parent, null, 'left click: a new tree');
    await worker.evaluate((id) => chrome.tabs.remove(id), root.id);
    await settle();
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

  // Here the panel runs as a tab without ?windowId=, like the real side
  // panel, so it watches its own window. Playwright pins the page size, so
  // the page gets no real resize events; tests send the one Chrome would.
  const plainPanelUrl = panelUrl.replace(/\?.*/, '');
  const fullscreenWindow = await worker.evaluate(
    (url) => chrome.windows.create({ url: ['about:blank', url], width: 900, height: 600 }).then((w) => w.id),
    plainPanelUrl,
  );
  const openOwnPanel = async () => {
    const before = new Set(context.pages());
    await worker.evaluate(
      ({ windowId, url }) => chrome.tabs.create({ windowId, url }),
      { windowId: fullscreenWindow, url: plainPanelUrl },
    );
    let page;
    for (let i = 0; i < 50 && !page; i++) {
      page = context.pages().find((p) => !before.has(p) && p.url() === plainPanelUrl);
      if (!page) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await page.waitForLoadState();
    await page.waitForSelector('.tab');
    return page;
  };
  const setState = (state) =>
    worker.evaluate(({ id, state }) => chrome.windows.update(id, { state }), { id: fullscreenWindow, state });
  const resize = (page) => page.evaluate(() => dispatchEvent(new Event('resize'))).catch(() => {});
  const noticeShown = (page) => page.locator('#fullscreen-notice').isVisible();
  const settled = () => new Promise((resolve) => setTimeout(resolve, 400));
  const fullscreenSettings = () =>
    worker.evaluate(() => chrome.storage.sync.get(['hideInFullscreen', 'fullscreenChoiceMade']));

  await check('the first full screen explains the choice instead of closing the panel', async () => {
    const own = context.pages().find((p) => p.url() === plainPanelUrl) ?? (await openOwnPanel());
    await own.waitForSelector('.tab');
    await worker.evaluate((id) => chrome.windows.update(id, { width: 800 }), fullscreenWindow);
    await resize(own);
    await settled();
    assert.equal(await noticeShown(own), false, 'an ordinary resize changes nothing');

    await setState('fullscreen');
    await resize(own);
    await settled();
    assert.equal(own.isClosed(), false);
    assert.equal(await noticeShown(own), true, 'the notice replaces the tree');
    assert.equal(await own.locator('#scroller').isVisible(), false);
    // The notice names the shortcut Chrome has assigned, if there is one.
    const shortcut = await worker.evaluate(
      async () => (await chrome.commands.getAll()).find((c) => c.name === '_execute_action').shortcut,
    );
    const text = await own.locator('#fullscreen-notice').textContent();
    assert.ok(text.includes(shortcut ? `toolbar button or ${shortcut}.` : 'toolbar button.'), text);
    if (shots) {
      for (const scheme of ['light', 'dark']) {
        await own.emulateMedia({ colorScheme: scheme });
        await own.screenshot({ path: path.join(shots, `fullscreen-notice-${scheme}.png`) });
      }
    }

    await setState('normal');
    await resize(own);
    await settled();
    assert.equal(await noticeShown(own), false, 'leaving full screen unanswered brings the tree back');
    assert.equal(await own.locator('#scroller').isVisible(), true);

    await setState('fullscreen');
    await resize(own);
    await settled();
    await Promise.all([own.waitForEvent('close', { timeout: 5000 }), own.click('#fullscreen-hide')]);
    assert.deepEqual(await fullscreenSettings(), { hideInFullscreen: true, fullscreenChoiceMade: true });
  });

  await check('after choosing to hide, full screen closes the panel without asking', async () => {
    await setState('normal');
    const own = await openOwnPanel();
    await setState('fullscreen');
    await Promise.all([own.waitForEvent('close', { timeout: 5000 }), resize(own)]);
  });

  await check('choosing to keep it open leaves the panel open in full screen', async () => {
    await setState('normal');
    await worker.evaluate(() => chrome.storage.sync.set({ fullscreenChoiceMade: false }));
    const own = await openOwnPanel();
    await setState('fullscreen');
    await resize(own);
    await settled();
    await own.click('#fullscreen-keep');
    await settled();
    assert.equal(await noticeShown(own), false);
    assert.equal(await own.locator('#scroller').isVisible(), true);
    assert.deepEqual(await fullscreenSettings(), { hideInFullscreen: false, fullscreenChoiceMade: true });
    await resize(own);
    await settled();
    assert.equal(own.isClosed(), false, 'later full screens leave it open too');
    assert.equal(await noticeShown(own), false);
    await worker.evaluate(async (id) => {
      await chrome.windows.remove(id);
      await chrome.storage.sync.remove(['hideInFullscreen', 'fullscreenChoiceMade']);
    }, fullscreenWindow);
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
  await check('the panel reported no errors', async () => {
    assert.deepEqual(panelErrors, []);
  });
} finally {
  await context.close();
  server.close();
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
