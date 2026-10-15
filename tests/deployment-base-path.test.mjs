import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync('index.html', 'utf8');
const manifest = JSON.parse(readFileSync('manifest.webmanifest', 'utf8'));
const worker = readFileSync('sw.js', 'utf8');
const bases = [
  'https://quote-flow-five-phi.vercel.app/',
  'https://plusalphasapporo.github.io/PlusAlphaQuoteFlow/'
];

function harness(base, windows = []) {
  const handlers = {}, notifications = [], opened = [];
  const self = {
    location: { href: new URL('sw.js', base).href, origin: new URL(base).origin },
    registration: { scope: base, showNotification: async (title, options) => notifications.push({ title, options }) },
    clients: { matchAll: async () => windows, openWindow: async url => opened.push(url), claim: async () => {} },
    skipWaiting() {},
    addEventListener: (name, handler) => { handlers[name] = handler; }
  };
  runInNewContext(worker, { self, URL });
  return {
    notifications, opened,
    async dispatch(name, event) {
      let pending;
      handlers[name]({ ...event, waitUntil(promise) { pending = promise; } });
      await pending;
    }
  };
}

for (const base of bases) {
  test('browser assets resolve within deployment: ' + base, () => {
    const refs = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
      .map(match => match[1]).filter(ref => /^(?:\.\/|\/)?(?:assets\/|manifest\.webmanifest)/.test(ref));
    assert.ok(refs.length >= 7, 'all logo, stylesheet, manifest and runtime references must be checked');
    for (const ref of refs) {
      const local = ref.replace(/^\.?\//, '');
      assert.ok(existsSync(local), 'missing deployed asset: ' + local);
      assert.equal(new URL(ref, base).href, new URL(local, base).href, 'asset escapes deployment directory: ' + ref);
    }
  });

  test('service worker registration stays within deployment: ' + base, () => {
    const match = html.match(/navigator\.serviceWorker\.register\(['"]([^'"]+)['"]/);
    assert.ok(match, 'service worker registration exists');
    assert.equal(new URL(match[1], base).href, new URL('sw.js', base).href);
  });

  test('installed application launches within deployment: ' + base, () => {
    const manifestUrl = new URL('manifest.webmanifest', base);
    for (const key of ['id', 'start_url', 'scope']) {
      assert.equal(new URL(manifest[key], manifestUrl).href, base, key + ' escapes deployment directory');
    }
    for (const icon of manifest.icons) {
      assert.equal(new URL(icon.src, manifestUrl).href, new URL('assets/quoteflow-mark.png', base).href);
    }
  });

  test('notification assets and fallback navigation stay within deployment: ' + base, async () => {
    const h = harness(base);
    await h.dispatch('push', { data: { json: () => ({ title: 'Test', url: 'https://example.org/' }) } });
    const options = h.notifications[0].options;
    assert.equal(new URL(options.icon, base).href, new URL('assets/quoteflow-mark.png', base).href);
    assert.equal(new URL(options.badge, base).href, new URL('assets/quoteflow-mark.png', base).href);
    assert.equal(new URL(options.data.url, base).href, base);
    await h.dispatch('notificationclick', { notification: { close() {} } });
    assert.equal(new URL(h.opened[0], base).href, base);
  });
}

test('notification click does not focus another GitHub Pages application', async () => {
  const base = bases[1];
  const focused = [];
  const h = harness(base, [
    { url: 'https://plusalphasapporo.github.io/OtherApplication/', focus: async () => focused.push('other') },
    { url: base + '?ticket=123', focus: async () => focused.push('quoteflow') }
  ]);
  await h.dispatch('notificationclick', { notification: { close() {} } });
  assert.deepEqual(focused, ['quoteflow']);
  assert.equal(h.opened.length, 0);
});
