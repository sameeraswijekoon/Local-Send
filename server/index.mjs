import http from 'node:http';
import { networkInterfaces } from 'node:os';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { PassThrough, Transform, pipeline } from 'node:stream';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import yazl from 'yazl';

const root = fileURLToPath(new URL('..', import.meta.url));
const secret = () => randomBytes(24).toString('hex');
const cleanName = (name) => String(name).replace(/[\\/\x00-\x1f\x7f]/g, '_').slice(0, 180).toWellFormed().trim() || 'file';
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const publicPeer = (p) => ({ id: p.id, name: p.name, kind: p.kind });
const currentAddresses = () => [...new Set(Object.values(networkInterfaces()).flat()
  .filter((n) => n && n.family === 'IPv4' && !n.internal && !n.address.startsWith('169.254.'))
  .map((n) => n.address))];

export async function createLanServer({ port = 3344, host = '0.0.0.0', roomCode = process.env.ROOM_CODE || String(randomInt(100000, 1000000)), dev = false, getAddresses = currentAddresses } = {}) {
  if (!/^\d{6}$/.test(roomCode)) throw new Error('ROOM_CODE must contain exactly 6 digits.');
  const clients = new Map();
  const transfers = new Map();
  const attempts = new Map();
  // Refresh on each request: a laptop can switch Wi-Fi/hotspots without a restart.
  const networkUrls = () => getAddresses().map((ip) => `http://${ip}:${server.address().port}`);
  const send = (p, message) => { if (p?.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify(message)); };
  const broadcastPeers = () => { for (const p of clients.values()) send(p, { type: 'peers', peers: [...clients.values()].map(publicPeer) }); };
  const summary = (t) => ({ id: t.id, sender: t.sender, receiver: t.receiver, files: t.files, text: t.text, kind: t.kind, total: t.total, bytes: t.bytes, status: t.status, message: t.message, created: t.created });
  const notify = (t) => { for (const id of [t.sender.id, t.receiver.id]) send(clients.get(id), { type: 'transfer', transfer: summary(t) }); };
  function finish(t, status, message) {
    if (!transfers.has(t.id)) return;
    t.status = status; t.message = message;
    transfers.delete(t.id);
    notify(t);
    if (status !== 'complete') {
      t.zip?.outputStream.destroy();
      t.stream?.destroy(new Error(message));
      t.upload?.destroy();
      t.response?.destroy();
    }
  }
  function safeRequest(req) {
    try {
      const base = new URL(`http://${req.headers.host}`);
      const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', ...getAddresses()]);
      if (!allowedHosts.has(base.hostname) || Number(base.port || 80) !== server.address().port) return false;
      return !req.headers.origin || req.headers.origin === base.origin;
    } catch { return false; }
  }
  const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  function authenticated(req) {
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    return [...clients.values()].find((p) => equal(token, p.token));
  }
  let vite;
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'DENY');
    if (!safeRequest(req)) return json(res, 403, { error: 'Unrecognized host or origin.' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/api/config') {
      const isLocal = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      return json(res, 200, { urls: networkUrls(), roomCode: isLocal ? roomCode : undefined });
    }
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true });
    const acceptMatch = url.pathname.match(/^\/api\/transfers\/([a-f0-9]+)\/accept$/);
    if (req.method === 'POST' && acceptMatch) {
      const client = authenticated(req), t = transfers.get(acceptMatch[1]);
      if (!client || !t || client.id !== t.receiver.id) return json(res, 403, { error: 'This request is unavailable.' });
      if (t.status !== 'waiting') return json(res, 409, { error: 'Request already handled.' });
      t.updated = Date.now();
      if (t.kind === 'text') { finish(t, 'complete', 'Text received'); return json(res, 200, { ok: true }); }
      t.status = 'accepted'; t.downloadToken = secret(); notify(t);
      return json(res, 200, { downloadUrl: `/api/download/${t.id}/${t.downloadToken}` });
    }
    const downloadMatch = url.pathname.match(/^\/api\/download\/([a-f0-9]+)\/([a-f0-9]+)$/);
    if (req.method === 'GET' && downloadMatch) {
      const t = transfers.get(downloadMatch[1]);
      if (!t || t.status !== 'accepted' || !equal(downloadMatch[2], t.downloadToken)) return json(res, 404, { error: 'Download expired or already started.' });
      t.status = 'transferring'; t.updated = Date.now(); t.response = res; notify(t);
      const archive = t.files.length > 1;
      const filename = archive ? 'NearShare-files.zip' : t.files[0].name;
      res.writeHead(200, { 'Content-Type': archive ? 'application/zip' : 'application/octet-stream', 'Content-Disposition': `attachment; filename="download${archive ? '.zip' : ''}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16))}`, ...(archive ? {} : { 'Content-Length': t.total }) });
      res.on('finish', () => finish(t, 'complete', 'Delivered to browser downloads'));
      res.on('close', () => { if (!res.writableFinished) finish(t, 'cancelled', 'Download interrupted'); });
      const requestFile = (index) => {
        t.index = index; t.uploadToken = secret(); t.uploadStarted = false;
        const stream = new PassThrough({ highWaterMark: 256 * 1024 });
        t.stream = stream;
        stream.on('error', () => finish(t, 'failed', 'File transfer interrupted'));
        send(clients.get(t.sender.id), { type: 'upload', id: t.id, index, url: `/api/upload/${t.id}/${t.uploadToken}` });
        return stream;
      };
      if (archive) {
        const zip = new yazl.ZipFile(); t.zip = zip;
        zip.on('error', () => finish(t, 'failed', 'Could not create the download'));
        t.files.forEach((file, index) => zip.addReadStreamLazy(`${index + 1}-${file.name}`, { size: file.size, compress: false }, (callback) => callback(null, requestFile(index))));
        zip.outputStream.pipe(res); zip.end();
      } else requestFile(0).pipe(res);
      return;
    }
    const uploadMatch = url.pathname.match(/^\/api\/upload\/([a-f0-9]+)\/([a-f0-9]+)$/);
    if (req.method === 'PUT' && uploadMatch) {
      const t = transfers.get(uploadMatch[1]), client = authenticated(req);
      if (!t || !client || client.id !== t.sender.id || t.status !== 'transferring' || t.uploadStarted || !equal(uploadMatch[2], t.uploadToken)) return json(res, 403, { error: 'Upload is not authorized.' });
      const expected = t.files[t.index].size;
      if (req.headers['content-length'] !== undefined && Number(req.headers['content-length']) !== expected) { json(res, 400, { error: 'File size changed.' }); finish(t, 'failed', 'File size changed'); return; }
      t.uploadStarted = true; t.upload = req;
      let received = 0, lastNotice = 0;
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          if (received > expected) return callback(new Error('File exceeds announced size'));
          t.bytes += chunk.length; t.updated = Date.now();
          if (Date.now() - lastNotice > 200) { notify(t); lastNotice = Date.now(); }
          callback(null, chunk);
        },
        flush(callback) { callback(received === expected ? null : new Error('Incomplete upload')); },
      });
      pipeline(req, meter, t.stream, (error) => {
        if (error) { finish(t, 'failed', 'Upload interrupted'); if (!res.destroyed) json(res, 400, { error: 'Upload interrupted.' }); }
        else { if (!res.destroyed) json(res, 200, { ok: true }); }
      });
      return;
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found.' });
    if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed.' });
    if (vite) return vite.middlewares(req, res, () => { res.writeHead(404); res.end('Not found'); });
    const publicRoot = path.join(root, 'dist', 'lan');
    let file;
    try { file = path.resolve(publicRoot, '.' + decodeURIComponent(url.pathname)); } catch { return json(res, 400, { error: 'Invalid path.' }); }
    if (file !== publicRoot && !file.startsWith(publicRoot + path.sep)) return json(res, 403, { error: 'Invalid path.' });
    if (file === publicRoot) file = path.join(publicRoot, 'index.html');
    if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end('Not found. Run pnpm build before starting.'); return; }
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    if (req.method === 'HEAD') return res.end();
    const stream = createReadStream(file); stream.on('error', () => res.destroy()); stream.pipe(res);
  });
  server.requestTimeout = 0;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws' || !safeRequest(req) || wss.clients.size >= 100) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws, req) => {
    let client;
    let alive = true;
    const joinTimer = setTimeout(() => { if (!client) ws.close(1008, 'Join timed out'); }, 15000);
    ws.on('pong', () => { alive = true; });
    ws.isAlive = () => alive; ws.markPing = () => { alive = false; };
    ws.on('error', () => {});
    ws.on('message', (raw) => {
      let messageId;
      try {
        const msg = JSON.parse(raw.toString());
        messageId = typeof msg.id === 'string' ? msg.id.slice(0, 48) : undefined;
        if (!client) {
          const ip = req.socket.remoteAddress, now = Date.now();
          let attempt = attempts.get(ip);
          if (!attempt || now - attempt.since > 60000) { attempt = { since: now, count: 0 }; attempts.set(ip, attempt); }
          if (++attempt.count > 20 || msg.type !== 'join' || !equal(msg.code, roomCode)) { ws.send(JSON.stringify({ type: 'error', message: 'Incorrect room code, or too many attempts. Check the code and try again shortly.' })); ws.close(1008); return; }
          client = { id: secret(), token: secret(), name: cleanName(msg.name || 'Nearby device').slice(0, 40), kind: msg.kind === 'phone' ? 'phone' : 'computer', ws };
          clearTimeout(joinTimer); clients.set(client.id, client);
          send(client, { type: 'joined', self: publicPeer(client), token: client.token }); broadcastPeers(); return;
        }
        if (msg.type === 'rename') { client.name = cleanName(msg.name || 'Nearby device').slice(0, 40); broadcastPeers(); return; }
        if (msg.type === 'offer') {
          if (!/^[a-f0-9]{32}$/.test(msg.id) || transfers.has(msg.id)) throw new Error('Invalid transfer ID.');
          const receiver = clients.get(msg.to);
          if (!receiver || receiver.id === client.id) throw new Error('This device is no longer available.');
          if (transfers.size >= 100 || [...transfers.values()].filter((t) => t.sender.id === client.id || t.receiver.id === receiver.id).length >= 8) throw new Error('Too many pending transfers. Finish or cancel one first.');
          let files = [], text;
          if (msg.kind === 'text') {
            if (typeof msg.text !== 'string' || !msg.text.trim() || msg.text.length > 16000) throw new Error('Text must contain 1–16,000 characters.');
            text = msg.text;
          } else {
            if (!Array.isArray(msg.files) || !msg.files.length || msg.files.length > 100) throw new Error('Choose between 1 and 100 files.');
            files = msg.files.map((f) => {
              if (typeof f.name !== 'string' || !Number.isSafeInteger(f.size) || f.size < 0 || f.size > 1e12) throw new Error('Invalid file.');
              return { name: cleanName(f.name), size: f.size };
            });
          }
          const total = files.reduce((sum, f) => sum + f.size, 0);
          if (total > 1e12) throw new Error('Transfer is too large.');
          const t = { id: msg.id, sender: publicPeer(client), receiver: publicPeer(receiver), kind: text !== undefined ? 'text' : 'files', text, files, total, bytes: 0, status: 'waiting', created: Date.now(), updated: Date.now() };
          transfers.set(t.id, t); notify(t); return;
        }
        if (msg.type === 'cancel' || msg.type === 'reject') {
          const t = transfers.get(msg.id);
          if (!t || ![t.sender.id, t.receiver.id].includes(client.id)) return;
          if (msg.type === 'reject' && (client.id !== t.receiver.id || t.status !== 'waiting')) return;
          finish(t, msg.type === 'reject' ? 'declined' : 'cancelled', msg.type === 'reject' ? 'Receiver declined' : 'Transfer cancelled');
        }
      } catch (e) { if (client) send(client, { type: 'error', message: e.message, id: messageId }); }
    });
    ws.on('close', () => {
      clearTimeout(joinTimer);
      if (!client) return;
      clients.delete(client.id);
      for (const t of transfers.values()) if ([t.sender.id, t.receiver.id].includes(client.id)) finish(t, 'failed', 'A device disconnected');
      broadcastPeers();
    });
  });
  const timer = setInterval(() => {
    for (const t of transfers.values()) if (Date.now() - t.updated > 120000) finish(t, 'failed', 'Transfer timed out. Please send again.');
    for (const [ip, value] of attempts) if (Date.now() - value.since > 60000) attempts.delete(ip);
    for (const ws of wss.clients) { if (!ws.isAlive()) ws.terminate(); else { ws.markPing(); ws.ping(); } }
  }, 15000);
  timer.unref();
  if (dev) {
    const { createServer } = await import('vite');
    vite = await createServer({ configFile: path.join(root, 'vite.lan.config.ts'), server: { middlewareMode: true, hmr: false } });
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return {
    server, roomCode, get urls() { return networkUrls(); },
    async close() { clearInterval(timer); for (const t of transfers.values()) finish(t, 'cancelled', 'Server stopped'); for (const ws of wss.clients) ws.terminate(); wss.close(); await vite?.close(); await new Promise((resolve) => server.close(resolve)); },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createLanServer({ port: Number(process.env.PORT || 3344), dev: process.argv.includes('--dev') });
  console.log(`\nNearShare is ready\nLocal: http://localhost:${app.server.address().port}\n${app.urls.map((url) => `Network: ${url}`).join('\n')}\nRoom code: ${app.roomCode}\nKeep this server running while sharing.\n`);
  if (process.argv.includes('--open')) {
    const localUrl = `http://localhost:${app.server.address().port}`;
    if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', '', localUrl], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else if (process.platform === 'darwin') spawn('open', [localUrl], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [localUrl], { detached: true, stdio: 'ignore' }).unref();
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
}
