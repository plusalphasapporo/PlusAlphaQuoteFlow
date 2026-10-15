import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Executes the real UI code using headless Chrome and a deterministic synthetic
// ticket. The browser fixture is never copied to the Vercel staging bundle.
const fixture = pathToFileURL(resolve('tests/support-ticket-tabs.browser.html')).href;
const browser = process.env.CHROME_BIN || 'google-chrome';
const result = spawnSync(browser, [
  '--headless',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-background-networking',
  '--disable-extensions',
  '--no-first-run',
  '--no-default-browser-check',
  '--virtual-time-budget=5000',
  '--window-size=1440,900',
  '--dump-dom',
  fixture
], {
  encoding: 'utf8',
  timeout: 60000,
  maxBuffer: 4 * 1024 * 1024
});

if (result.error) {
  console.error('Could not launch Chrome browser test:', result.error.message);
  process.exit(1);
}
const output = result.stdout || '';
const didPass = /<body[^>]*data-test-result="pass"/i.test(output);
const details = output.match(/<pre id="browserCheckResult"[^>]*>([\s\S]*?)<\/pre>/i);
if (result.status !== 0 || !didPass) {
  console.error('QuoteFlow Chrome browser test failed.');
  console.error('Browser exit code:', result.status);
  console.error('Result:', details?.[1] || 'No browser result marker');
  console.error((result.stderr || '').slice(-2000));
  process.exit(1);
}
console.log('QuoteFlow Chrome browser test passed:', details?.[1] || 'PASS');
