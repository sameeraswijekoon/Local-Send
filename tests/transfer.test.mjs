import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import { get } from 'node:http';
import { createLanServer } from '../server/index.mjs';

let app, base;
before(async () => { app = await createLanServer({ port: 0, host: '127.0.0.1', roomCode: '123456' }); base = `http://127.0.0.1:${app.server.address().port}`; });
after(async () => { await app.close(); });
test('network addresses and host checks update after switching Wi-Fi', async () => {
  let addresses = ['10.1.1.2'];
  const dynamic = await createLanServer({ port: 0, host: '127.0.0.1', getAddresses: () => addresses });
  try {
    const port = dynamic.server.address().port;
    const endpoint = `http://127.0.0.1:${port}`;
    assert.deepEqual((await (await fetch(endpoint + '/api/config')).json()).urls, [`http://10.1.1.2:${port}`]);
    addresses = ['10.2.2.3'];
    assert.deepEqual((await (await fetch(endpoint + '/api/config')).json()).urls, [`http://10.2.2.3:${port}`]);
    // Node fetch normalizes Host, so use HTTP directly to exercise host validation.
    const hostStatus = (address) => new Promise((resolve, reject) => {
      get(endpoint + '/api/health', { headers: { Host: `${address}:${port}` } }, (response) => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      }).on('error', reject);
    });
    assert.equal(await hostStatus('10.2.2.3'), 200);
    assert.equal(await hostStatus('10.1.1.2'), 403);
    assert.deepEqual(dynamic.urls, [`http://10.2.2.3:${port}`]);
  } finally { await dynamic.close(); }
});
function peer(name, code = '123456') {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { origin: base });
  const messages = [], waiters = [];
  ws.on('message', (raw) => { const msg = JSON.parse(raw.toString()); messages.push(msg); for (const check of [...waiters]) check(); });
  const wait = (predicate) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.splice(waiters.indexOf(check), 1); reject(new Error(`Timed out waiting for ${name}: ${messages.map((m) => m.type).join(', ')}`)); }, 6000);
    const check = () => { const index = messages.findIndex(predicate); if (index < 0) return; clearTimeout(timer); const w = waiters.indexOf(check); if (w >= 0) waiters.splice(w, 1); resolve(messages.splice(index, 1)[0]); };
    waiters.push(check); check();
  });
  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', code, name, kind: 'computer' })));
  return { ws, wait, send: (msg) => ws.send(JSON.stringify(msg)) };
}
async function joined(name) { const p = peer(name); const msg = await p.wait((m) => m.type === 'joined'); return { ...p, ...msg }; }
const tid = () => randomBytes(16).toString('hex');
async function accept(p, id) { return fetch(`${base}/api/transfers/${id}/accept`, { method: 'POST', headers: { Authorization: `Bearer ${p.token}` } }); }
async function requestFiles(a, b, buffers, names = buffers.map((_, i) => `file-${i}.bin`)) {
  const id = tid(); a.send({ type: 'offer', id, to: b.self.id, kind: 'files', files: buffers.map((buf, i) => ({ name: names[i], size: buf.length })) });
  await b.wait((m) => m.type === 'transfer' && m.transfer.id === id && m.transfer.status === 'waiting');
  return id;
}
test('room code rejects strangers and discovery shows only joined clients', async () => {
  const stranger = peer('stranger', '000000'); assert.match((await stranger.wait((m) => m.type === 'error')).message, /Incorrect/); stranger.ws.close();
  const a = await joined('Laptop'), b = await joined('Phone');
  try { const update = await a.wait((m) => m.type === 'peers' && m.peers.some((p) => p.id === b.self.id)); assert.equal(update.peers.some((p) => p.name === 'stranger'), false); }
  finally { a.ws.close(); b.ws.close(); }
});
test('text needs receiver consent and supports Unicode', async () => {
  const a = await joined('Sender'), b = await joined('Receiver');
  try { const id = tid(), text = 'Hello · ආයුබෝවන් 👋'; a.send({ type: 'offer', id, to: b.self.id, kind: 'text', text }); await b.wait((m) => m.type === 'transfer' && m.transfer.id === id); assert.equal((await accept(a, id)).status, 403); assert.equal((await accept(b, id)).status, 200); const done = await b.wait((m) => m.type === 'transfer' && m.transfer.status === 'complete'); assert.equal(done.transfer.text, text); }
  finally { a.ws.close(); b.ws.close(); }
});
for (const size of [0, 1048576 + 37]) test(`streams a ${size}-byte file unchanged`, async () => {
  const a = await joined('Sender'), b = await joined('Receiver');
  try {
    const input = randomBytes(size), id = await requestFiles(a, b, [input], ['photo 👋.bin']);
    const accepted = await (await accept(b, id)).json();
    const download = fetch(base + accepted.downloadUrl).then(async (r) => { assert.equal(r.status, 200); assert.match(r.headers.get('content-disposition'), /attachment/); return Buffer.from(await r.arrayBuffer()); });
    const upload = await a.wait((m) => m.type === 'upload' && m.id === id);
    assert.equal((await fetch(base + upload.url, { method: 'PUT', headers: { Authorization: `Bearer ${a.token}` }, body: input })).status, 200);
    const result = await download; assert.equal(createHash('sha256').update(result).digest('hex'), createHash('sha256').update(input).digest('hex'));
    await b.wait((m) => m.type === 'transfer' && m.transfer.id === id && m.transfer.status === 'complete');
    assert.equal((await fetch(base + accepted.downloadUrl)).status, 404);
  } finally { a.ws.close(); b.ws.close(); }
});
test('multiple files stream into a valid ZIP with correct bytes and safe names', async () => {
  const a = await joined('Sender'), b = await joined('Receiver');
  try {
    const inputs = [Buffer.from('first file'), Buffer.alloc(0), randomBytes(70001)];
    const id = await requestFiles(a, b, inputs, ['../same.txt', 'same.txt', 'unicode-සි.bin']);
    const accepted = await (await accept(b, id)).json(); const download = fetch(base + accepted.downloadUrl).then(async (r) => Buffer.from(await r.arrayBuffer()));
    for (let i = 0; i < inputs.length; i++) { const upload = await a.wait((m) => m.type === 'upload' && m.id === id && m.index === i); assert.equal((await fetch(base + upload.url, { method: 'PUT', headers: { Authorization: `Bearer ${a.token}` }, body: inputs[i] })).status, 200); }
    const zip = await download; const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); assert.ok(end > 0); assert.equal(zip.readUInt16LE(end + 10), 3); let central = zip.readUInt32LE(end + 16);
    for (const input of inputs) { assert.equal(zip.readUInt32LE(central), 0x02014b50); const nameLength = zip.readUInt16LE(central + 28), extraLength = zip.readUInt16LE(central + 30), commentLength = zip.readUInt16LE(central + 32), local = zip.readUInt32LE(central + 42); const name = zip.subarray(central + 46, central + 46 + nameLength).toString(); assert.ok(!name.includes('/')); const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28); assert.deepEqual(zip.subarray(start, start + input.length), input); central += 46 + nameLength + extraLength + commentLength; }
  } finally { a.ws.close(); b.ws.close(); }
});
test('decline and cancellation terminate requests', async () => {
  const a = await joined('Sender'), b = await joined('Receiver');
  try { for (const action of ['reject', 'cancel']) { const id = await requestFiles(a, b, [Buffer.from('hello')]); b.send({ type: action, id }); const state = await a.wait((m) => m.type === 'transfer' && m.transfer.id === id && ['declined', 'cancelled'].includes(m.transfer.status)); assert.equal(state.transfer.status, action === 'reject' ? 'declined' : 'cancelled'); assert.equal((await accept(b, id)).status, 403); } }
  finally { a.ws.close(); b.ws.close(); }
});
test('rejects cross-origin requests and unauthorized acceptance', async () => {
  assert.equal((await fetch(base + '/api/config', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await fetch(base + '/api/transfers/' + tid() + '/accept', { method: 'POST' })).status, 403);
});
test('disconnect fails pending transfers', async () => {
  const a = await joined('Sender'), b = await joined('Receiver');
  try { const id = await requestFiles(a, b, [Buffer.from('hello')]); a.ws.close(); const failed = await b.wait((m) => m.type === 'transfer' && m.transfer.id === id && m.transfer.status === 'failed'); assert.match(failed.transfer.message, /disconnected/); }
  finally { b.ws.close(); }
});
test('cancelling an active download closes its stream', async () => {
  const a = await joined('Sender'), b = await joined('Receiver');
  try {
    const id = await requestFiles(a, b, [Buffer.alloc(1024)]);
    const accepted = await (await accept(b, id)).json();
    const download = fetch(base + accepted.downloadUrl).then((r) => r.arrayBuffer()).then(() => false, () => true);
    await a.wait((m) => m.type === 'upload' && m.id === id);
    b.send({ type: 'cancel', id });
    await a.wait((m) => m.type === 'transfer' && m.transfer.id === id && m.transfer.status === 'cancelled');
    assert.equal(await download, true);
  } finally { a.ws.close(); b.ws.close(); }
});
test('a changed file size fails instead of completing a corrupt download', async () => {
  const a = await joined('Sender'), b = await joined('Receiver');
  try {
    const id = await requestFiles(a, b, [Buffer.alloc(1024)]);
    const accepted = await (await accept(b, id)).json();
    const download = fetch(base + accepted.downloadUrl).then((r) => r.arrayBuffer()).then(() => false, () => true);
    const upload = await a.wait((m) => m.type === 'upload' && m.id === id);
    assert.equal((await fetch(base + upload.url, { method: 'PUT', headers: { Authorization: `Bearer ${a.token}` }, body: Buffer.from('short') })).status, 400);
    assert.equal(await download, true);
    await b.wait((m) => m.type === 'transfer' && m.transfer.id === id && m.transfer.status === 'failed');
  } finally { a.ws.close(); b.ws.close(); }
});
