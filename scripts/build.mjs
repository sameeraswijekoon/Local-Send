// Portable build: no platform-specific native executables are required.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild-wasm';
import { compile } from 'tailwindcss';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'dist/lan');
await mkdir(output, { recursive: true });
const candidates = new Set();
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await scan(full);
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      for (const candidate of (await readFile(full, 'utf8')).matchAll(/[^\s"'`<>]+/g)) candidates.add(candidate[0]);
    }
  }
}
await scan(path.join(root, 'app')); await scan(path.join(root, 'components/ui'));
const css = await readFile(path.join(root, 'app/globals.css'), 'utf8');
const compiler = await compile(css, {
  base: path.join(root, 'app'),
  async loadStylesheet(id, base) {
    const req = createRequire(path.join(base, '__resolve.cjs'));
    const known = { tailwindcss: 'tailwindcss/index.css', 'tw-animate-css': 'tw-animate-css/dist/tw-animate.css' };
    const full = known[id] ? path.join(root, 'node_modules', known[id]) : id.startsWith('.') ? path.resolve(base, id) : req.resolve(id);
    return { content: await readFile(full, 'utf8'), base: path.dirname(full), path: full };
  },
});
await build({
  absWorkingDir: root, entryPoints: ['app/main.tsx'], outfile: 'dist/lan/app.js', bundle: true,
  minify: true, format: 'esm', platform: 'browser', target: ['chrome100', 'firefox100', 'safari15.4'], jsx: 'automatic',
  tsconfig: 'tsconfig.lan.json', define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'compiled-tailwind', setup(api) { api.onLoad({ filter: /globals\.css$/ }, () => ({ contents: compiler.build([...candidates]), loader: 'css' })); } }],
  logLevel: 'info',
});
// Deliver styling in the HTML itself so LAN clients cannot render an unstyled
// page if a separate stylesheet request fails. Version JS to avoid stale clients.
const builtCss = await readFile(path.join(output, 'app.css'), 'utf8');
const builtJs = await readFile(path.join(output, 'app.js'));
const version = createHash('sha256').update(builtJs).digest('hex').slice(0, 12);
const html = (await readFile(path.join(root, 'index.template.html'), 'utf8'))
  .replace('</head>', `<style id="nearshare-styles">${builtCss.replace(/<\/style/gi, '<\\/style')}</style></head>`)
  .replace('<script type="module" src="/app/main.tsx"></script>', `<script type="module" src="/app.js?v=${version}"></script>`);
await writeFile(path.join(output, 'index.html'), html);
console.log('NearShare production build ready in dist/lan');
