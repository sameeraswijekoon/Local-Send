// Creates a GitHub Pages-ready build. Pages serves the docs directory directly.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
await promisify(execFile)(process.execPath, ['scripts/build.mjs'], { cwd: root });
const build = path.join(root, 'dist', 'lan');
const docs = path.join(root, 'docs');
const pageFiles = ['app.js', 'app.css'];

// Support both GitHub Pages source choices: branch root and /docs.
for (const output of [root, docs]) {
  if (output === docs) await mkdir(output, { recursive: true });
  for (const filename of pageFiles) {
    await cp(path.join(build, filename), path.join(output, filename));
  }
  let html = await readFile(path.join(build, 'index.html'), 'utf8');
  html = html
    .replace('</head>', '<script src="./config.js"></script></head>')
    .replace(/src="\/app\.js/g, 'src="./app.js')
    .replace(/href="\/app\.css/g, 'href="./app.css');
  await writeFile(path.join(output, 'index.html'), html);
  await cp(path.join(root, 'online', 'config.js'), path.join(output, 'config.js'));
  await writeFile(path.join(output, '.nojekyll'), '');
}
console.log('GitHub Pages build ready in the repository root and docs');
