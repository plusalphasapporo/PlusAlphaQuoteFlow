import fs from 'node:fs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const config = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
assert.equal(config.buildCommand, 'node scripts/build-staging-preview.mjs');
assert.equal(config.outputDirectory, 'dist');

const run = (vercelEnv, overrides = {}) => spawnSync(process.execPath,
  ['scripts/build-staging-preview.mjs'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      VERCEL_ENV: vercelEnv,
      VERCEL_GIT_REPO_SLUG: 'PlusAlphaQuoteFlow',
      VERCEL_GIT_REPO_OWNER: 'plusalphasapporo',
      ...overrides
    }
  }
);

const prod = run('production');
assert.notEqual(prod.status, 0, 'Production must fail closed');
assert.match(prod.stderr, /Only Vercel Preview/);
const missing = run('');
assert.notEqual(missing.status, 0, 'Missing deployment environment must fail closed');
const wrongRepo = run('preview', { VERCEL_GIT_REPO_SLUG: 'QuoteFlow' });
assert.notEqual(wrongRepo.status, 0, 'Wrong GitHub repository must fail closed');

try {
  const preview = run('preview');
  assert.equal(preview.status, 0, 'Staging preview build must pass: ' + preview.stderr);
  assert.deepEqual(fs.readdirSync('dist').sort(), ['assets', 'index.html']);
  assert.deepEqual(fs.readdirSync('dist/assets'), ['operations-ui.css']);
  assert.equal(fs.readFileSync('dist/index.html', 'utf8'), fs.readFileSync('index.html', 'utf8'));
  assert.equal(fs.readFileSync('dist/assets/operations-ui.css', 'utf8'),
    fs.readFileSync('assets/operations-ui.css', 'utf8'));
  assert.match(preview.stdout, /STAGING PREVIEW build ready/);
  console.log('Preview-only Vercel build guard passed (preview / production / unset / wrong repository).');
} finally {
  fs.rmSync('dist', { recursive: true, force: true });
}
