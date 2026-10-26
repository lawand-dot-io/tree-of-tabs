// End-to-end check of docked mode: the tree in a narrow window attached to
// the side of the browser window. Usage: node test/e2e/dock.js [screenshot-dir]
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

// require() also finds a globally installed Playwright.
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(import.meta.dirname, '../..');
const shots = process.argv[2];

const context = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'tab-tree-dock-')), {
  headless: true,
  channel: 'chromium', // The headless shell cannot load extensions.
  args: [
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    '--screen-info={1920x1080}', // A screen big enough to put windows side by side.
  ],
  viewport: null,
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
    console.log(`not ok - ${name}\n  ${error.stack.split('\n').slice(0, 8).join('\n  ')}`);
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `fn` stops throwing, so window moves have time to land. */
async function eventually(fn, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (Date.now() > end) throw error;
      await wait(100);
    }
  }
}

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const call = (fn, arg) => worker.evaluate(fn, arg);
  const page = context.pages()[0];
  await page.goto('data:text/html,<title>First</title>');
  const mainId = await call(async () => (await chrome.windows.getLastFocused()).id);
  await call(async (id) => {
    await chrome.tabs.create({ windowId: id, url: 'data:text/html,<title>Second</title>', active: false });
    await chrome.windows.update(id, { state: 'normal' });
    await chrome.windows.update(id, { left: 400, top: 50, width: 1000, height: 700 });
  }, mainId);

  const docks = () =>
    call(async () => {
      const wins = await chrome.windows.getAll({ populate: true });
      return wins.filter((w) => w.type === 'popup' && w.tabs.some((t) => t.url.includes('docked=1')));
    });
  const bounds = (id) =>
    call(async (id) => {
      const { left, top, width, height, state } = await chrome.windows.get(id);
      return { left, top, width, height, state };
    }, id);

  let dockId;
  let dockPage;

  await check('switching to docked mode opens a dock beside the browser window', async () => {
    await call(() => chrome.storage.sync.set({ displayMode: 'docked' }));
    await eventually(async () => {
      dockPage = context.pages().find((p) => p.url().includes('docked=1'));
      assert.ok(dockPage);
      const list = await docks();
      assert.equal(list.length, 1);
      dockId = list[0].id;
      const dock = await bounds(dockId);
      const main = await bounds(mainId);
      assert.equal(dock.left + dock.width, main.left);
      assert.equal(dock.top, main.top);
      assert.equal(dock.height, main.height);
      assert.equal(dock.width, 220);
    });
  });

  await check('the dock shows the browser window tabs', async () => {
    await dockPage.waitForLoadState();
    await eventually(async () => {
      const titles = await dockPage.$$eval('.tab .title', (els) => els.map((e) => e.textContent));
      assert.deepEqual(titles, ['First', 'Second']);
    });
  });

  await check('the dock follows the browser window when it moves', async () => {
    await call((id) => chrome.windows.update(id, { left: 500, top: 80 }), mainId);
    await eventually(async () => {
      const dock = await bounds(dockId);
      assert.deepEqual([dock.left, dock.top], [500 - 220, 80]);
    });
  });

  await check('resizing the dock moves the browser window edge and is remembered', async () => {
    const before = await bounds(mainId);
    await call((id) => chrome.windows.update(id, { width: 160 }), dockId);
    await eventually(async () => {
      const dock = await bounds(dockId);
      const main = await bounds(mainId);
      assert.equal(dock.width, 160);
      assert.equal(main.left, dock.left + dock.width);
      assert.equal(main.left + main.width, before.left + before.width);
      assert.equal((await call(() => chrome.storage.sync.get('dockWidth'))).dockWidth, 160);
    });
  });

  await check('a dock dragged away snaps back', async () => {
    await call((id) => chrome.windows.update(id, { left: 20, top: 300 }), dockId);
    await eventually(async () => {
      const dock = await bounds(dockId);
      const main = await bounds(mainId);
      assert.deepEqual([dock.left + dock.width, dock.top], [main.left, main.top]);
    });
  });

  await check('maximizing fills the screen next to the dock instead of covering it', async () => {
    await call((id) => chrome.windows.update(id, { state: 'maximized' }), mainId);
    await eventually(async () => {
      const dock = await bounds(dockId);
      const main = await bounds(mainId);
      assert.equal(main.state, 'normal');
      assert.equal(dock.left + dock.width, main.left);
      assert.equal(dock.height, main.height);
    });
  });

  if (shots) {
    await dockPage.screenshot({ path: path.join(shots, 'dock.png') });
    await dockPage.locator('.tab').first().click({ button: 'right' });
    await dockPage.screenshot({ path: path.join(shots, 'dock-menu.png') });
    await dockPage.keyboard.press('Escape');
  }

  await check('clicking a tab in the dock activates it', async () => {
    await dockPage.locator('.tab', { hasText: 'Second' }).click();
    await eventually(async () => {
      const [active] = await call((id) => chrome.tabs.query({ windowId: id, active: true }), mainId);
      assert.equal(active.title, 'Second');
    });
  });

  await check('closing the dock gives the browser window its space back', async () => {
    await call((id) => chrome.windows.remove(id), dockId);
    await eventually(async () => {
      assert.equal((await docks()).length, 0);
      assert.equal((await bounds(mainId)).state, 'maximized');
    });
  });

  await check('new browser windows get a dock, closing the window closes it', async () => {
    const win = await call(() => chrome.windows.create({ url: 'data:text/html,<title>Other</title>', left: 600, top: 100, width: 800, height: 600 }));
    await eventually(async () => {
      const list = await docks();
      assert.equal(list.length, 1);
    });
    await call((id) => chrome.windows.remove(id), win.id);
    await eventually(async () => assert.equal((await docks()).length, 0));
  });

  await check('switching back to the side panel closes the docks', async () => {
    await call(async (id) => {
      await chrome.windows.update(id, { state: 'normal' });
      await chrome.storage.sync.set({ displayMode: 'sidePanel' });
    }, mainId);
    await wait(300);
    // Turning docked mode on again reopens docks the user had closed.
    await call(() => chrome.storage.sync.set({ displayMode: 'docked' }));
    await eventually(async () => assert.equal((await docks()).length, 1));
    await call(() => chrome.storage.sync.set({ displayMode: 'sidePanel' }));
    await eventually(async () => assert.equal((await docks()).length, 0));
  });
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
