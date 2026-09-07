// Creates a GitHub Pages-ready build. Pages serves the docs directory directly.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
await promisify(execFile)(process.execPath, ['scripts/build.mjs'], { cwd: root });
const docs = path.join(root, 'docs');
await mkdir(docs, { recursive: true });
await cp(path.join(root, 'dist', 'lan'), docs, { recursive: true });
let html = await readFile(path.join(docs, 'index.html'), 'utf8');
html = html.replace('</head>', '<script src="./config.js"></script></head>').replace(/src="\/app\.js/g, 'src="./app.js').replace(/href="\/app\.css/g, 'href="./app.css');
await writeFile(path.join(docs, 'index.html'), html);
await cp(path.join(root, 'online', 'config.js'), path.join(docs, 'config.js'));
await writeFile(path.join(docs, '.nojekyll'), '');
console.log('GitHub Pages build ready in docs');
