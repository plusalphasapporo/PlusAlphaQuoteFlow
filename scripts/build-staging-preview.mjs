import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The staging preview is a static website. Publish only explicit browser assets.
// Never copy sql/, supabase/, scripts/, .github/, or other repository content.
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = join(projectRoot, 'public');
const allowedFiles = [
  'index.html',
  'assets/quoteflow-mark.png',
  'assets/operations-ui.css',
  'assets/support-ticket-tabs.js'
];

const validation = spawnSync(
  process.execPath,
  [join(projectRoot, 'scripts/validate-static.mjs')],
  { cwd: projectRoot, stdio: 'inherit' }
);
if (validation.error) throw validation.error;
if (validation.status !== 0) {
  throw new Error('Cannot build staging preview because static validation failed.');
}

for (const file of allowedFiles) {
  const src = join(projectRoot, file);
  if (!existsSync(src) || !statSync(src).isFile()) {
    throw new Error(`Staging preview is missing required browser asset: ${file}`);
  }
}

// Generate the output from scratch so stale or private files cannot be deployed.
rmSync(outputRoot, { recursive: true, force: true });
for (const file of allowedFiles) {
  const dst = join(outputRoot, file);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(join(projectRoot, file), dst);
}
console.log(`QuoteFlow staging preview built: ${allowedFiles.length} public files.`);
