// Publishes the download page to both supported GitHub Pages source folders.
import { cp, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const docs = path.join(root, 'docs');
await promisify(execFile)(process.execPath, ['scripts/build.mjs'], { cwd: root });
await mkdir(docs, { recursive: true });
for (const output of [root, docs]) await cp(path.join(root, 'site', 'index.html'), path.join(output, 'index.html'));
console.log('GitHub Pages download page ready in the repository root and docs');
