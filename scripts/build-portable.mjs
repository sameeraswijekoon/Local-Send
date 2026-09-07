// Produces a no-install Windows package containing Node, the server, and its
// small runtime dependencies. Users only extract the ZIP and start the CMD file.
import { cp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const stage = path.join(root, 'portable');
const app = path.join(stage, 'NearShare');
const runtimeNode = path.join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe');
if (!runtimeNode) throw new Error('Portable Node runtime was not found.');

await rm(stage, { recursive: true, force: true });
await mkdir(path.join(app, 'runtime'), { recursive: true });
await cp(runtimeNode, path.join(app, 'runtime', 'node.exe'));
await cp(path.join(root, 'server'), path.join(app, 'server'), { recursive: true });
await cp(path.join(root, 'dist', 'lan'), path.join(app, 'dist', 'lan'), { recursive: true });
for (const dependency of ['ws', 'yazl', 'buffer-crc32']) {
  const source = await realpath(path.join(root, 'node_modules', dependency));
  await cp(source, path.join(app, 'node_modules', dependency), { recursive: true });
}
await writeFile(path.join(app, 'Start NearShare.cmd'), `@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\necho NearShare is starting...\r\nstart "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:3344'"\r\n"%~dp0runtime\\node.exe" "%~dp0server\\index.mjs"\r\nif errorlevel 1 pause\r\n`);
await writeFile(path.join(app, 'README.txt'), 'NearShare Portable\r\n\r\n1. Double-click Start NearShare.cmd.\r\n2. Your browser opens on the host PC.\r\n3. Scan the QR code from another device on the same Wi-Fi or hotspot.\r\n4. Keep the NearShare window open while sharing.\r\n');
await mkdir(path.join(root, 'release'), { recursive: true });
await exec('tar.exe', ['-a', '-c', '-f', path.join(root, 'release', 'NearShare-Portable.zip'), '-C', stage, 'NearShare']);
console.log('Portable package ready: release/NearShare-Portable.zip');
