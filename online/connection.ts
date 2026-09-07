// Adapts WebRTC to the existing application's room/transfer event interface.
export const ONLINE_LIMIT = 128 * 1024 * 1024;
type Peer = { id: string; name: string; kind: string; ready?: boolean };
type Meta = { name: string; size: number };
type Transfer = { id: string; sender: Peer; receiver: Peer; kind: string; files: Meta[]; text?: string; total: number; bytes: number; status: string; message?: string; created: number; downloads?: { name: string; url: string }[] };
type Active = { t: Transfer; peer: string; files?: File[]; chunks: Uint8Array[][]; sizes: number[]; accepted: boolean; received: number; acked: number; updated: number; wake?: () => void };
type Link = { pc: RTCPeerConnection; dc?: RTCDataChannel; candidates: RTCIceCandidateInit[]; timer: ReturnType<typeof setTimeout>; queue: Promise<void> };
export type OnlineConfig = { signalingUrl: string; iceServers?: RTCIceServer[] };
declare global { interface Window { NEARSHARE_CONFIG?: OnlineConfig } }
const finished = (s: string) => ['complete', 'failed', 'cancelled', 'declined'].includes(s);
export class OnlineConnection {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private ws: WebSocket;
  private self?: Peer;
  private peers: Peer[] = [];
  private links = new Map<string, Link>();
  private transfers = new Map<string, Active>();
  private downloads = new Map<string, { urls: string[]; bytes: number }>();
  private timer: ReturnType<typeof setInterval>;
  private reserved = 0;
  private closed = false;
  constructor(room: string, private config: OnlineConfig, private getFiles: (id: string) => File[] | undefined) {
    const url = new URL(config.signalingUrl);
    if (url.protocol !== 'https:' || !/^[a-f0-9]{32}$/.test(room)) throw new Error('Configure a valid HTTPS signaling URL and room link.');
    url.protocol = 'wss:'; url.pathname = `/room/${room}`; url.search = ''; url.hash = '';
    this.ws = new WebSocket(url);
    this.ws.onopen = () => { this.readyState = 1; this.onopen?.(); };
    this.ws.onerror = () => this.onerror?.();
    this.ws.onclose = () => { this.dispose(); this.onclose?.(); };
    this.ws.onmessage = (event) => {
      if (event.data === 'pong') return;
      const msg = JSON.parse(event.data);
      if (msg.type === 'joined') { this.self = msg.self; this.emit(msg); }
      else if (msg.type === 'peers') { this.peers = msg.peers; this.syncPeers(); }
      else if (msg.type === 'signal') {
        const link = this.links.get(msg.from);
        if (link) link.queue = link.queue.then(() => this.signal(msg.from, msg.payload)).catch(() => this.failPeer(msg.from, 'Could not connect to this device.'));
      } else this.emit(msg);
    };
    this.timer = setInterval(() => {
      if (this.ws.readyState === 1) this.ws.send('ping');
      for (const a of this.transfers.values()) if (Date.now() - a.updated > 120000) this.end(a, 'failed', 'Transfer timed out. Send again.');
    }, 15000);
  }
  private emit(value: object) { this.onmessage?.({ data: JSON.stringify(value) }); }
  private update(a: Active) { this.emit({ type: 'transfer', transfer: a.t }); }
  private signalSend(to: string, payload: object) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: 'signal', to, payload })); }
  private peerList() { this.emit({ type: 'peers', peers: this.peers.map((p) => ({ ...p, ready: p.id === this.self?.id || this.links.get(p.id)?.dc?.readyState === 'open' })) }); }
  private syncPeers() {
    if (!this.self) return;
    for (const p of this.peers) {
      if (p.id === this.self.id || this.links.has(p.id)) continue;
      const pc = new RTCPeerConnection({ iceServers: this.config.iceServers || [] });
      const link: Link = { pc, candidates: [], queue: Promise.resolve(), timer: setTimeout(() => {
        if (link.dc?.readyState !== 'open') this.failPeer(p.id, 'Direct connection failed. Use the same Wi-Fi, or ask the site owner to configure STUN/TURN.');
      }, 30000) };
      this.links.set(p.id, link);
      pc.onicecandidate = (event) => { if (event.candidate) this.signalSend(p.id, { candidate: event.candidate.toJSON() }); };
      pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') this.failPeer(p.id, 'Direct connection failed. Rejoin the room to try again.'); };
      pc.ondatachannel = (event) => this.channel(p.id, event.channel);
      if (this.self.id < p.id) {
        this.channel(p.id, pc.createDataChannel('nearshare', { ordered: true }));
        link.queue = pc.createOffer().then((offer) => pc.setLocalDescription(offer)).then(() => this.signalSend(p.id, { description: pc.localDescription })).catch(() => this.failPeer(p.id, 'Could not start a direct connection.'));
      }
    }
    for (const id of this.links.keys()) if (!this.peers.some((p) => p.id === id)) this.failPeer(id, 'Device disconnected.', false);
    this.peerList();
  }
  private async signal(from: string, payload: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }) {
    const link = this.links.get(from); if (!link) return;
    if (payload.description) {
      await link.pc.setRemoteDescription(payload.description);
      for (const candidate of link.candidates.splice(0)) await link.pc.addIceCandidate(candidate);
      if (payload.description.type === 'offer') { await link.pc.setLocalDescription(await link.pc.createAnswer()); this.signalSend(from, { description: link.pc.localDescription }); }
    } else if (payload.candidate) { if (link.pc.remoteDescription) await link.pc.addIceCandidate(payload.candidate); else link.candidates.push(payload.candidate); }
  }
  private channel(peer: string, dc: RTCDataChannel) {
    const link = this.links.get(peer)!; link.dc = dc; dc.binaryType = 'arraybuffer';
    dc.onopen = () => { clearTimeout(link.timer); this.peerList(); };
    dc.onclose = () => { if (this.links.has(peer)) this.failPeer(peer, 'Direct connection closed.', false); };
    dc.onerror = () => this.failPeer(peer, 'File connection failed.');
    dc.onmessage = (event) => {
      try { this.receive(peer, event.data); }
      catch { this.failPeer(peer, 'Invalid or oversized transfer received.'); }
    };
  }
  private control(peer: string, msg: object) { const dc = this.links.get(peer)?.dc; if (!dc || dc.readyState !== 'open') throw new Error('This device is not ready yet.'); dc.send(JSON.stringify(msg)); }
  private end(a: Active, status: string, message: string, tell = true) {
    if (!this.transfers.has(a.t.id)) return;
    if (tell) { try { this.control(a.peer, { type: 'end', id: a.t.id, status, message }); } catch {} }
    this.transfers.delete(a.t.id); a.wake?.(); a.t.status = status; a.t.message = message;
    if (a.accepted && a.t.receiver.id === this.self?.id && status !== 'complete') this.reserved -= a.t.total;
    a.chunks = []; a.files = undefined; this.update(a);
  }
  private failPeer(peer: string, message: string, notice = true) {
    const link = this.links.get(peer); this.links.delete(peer);
    if (link) { clearTimeout(link.timer); link.pc.close(); }
    for (const a of this.transfers.values()) if (a.peer === peer) this.end(a, 'failed', message, false);
    this.peerList(); if (notice) this.emit({ type: 'error', message });
  }
  send(raw: string) {
    const msg = JSON.parse(raw);
    if (['join', 'rename'].includes(msg.type)) { this.ws.send(JSON.stringify({ type: msg.type, name: msg.name, kind: msg.kind })); return; }
    if (msg.type === 'offer') {
      try {
        const recipient = this.peers.find((p) => p.id === msg.to);
        if (!this.self || !recipient || this.transfers.size >= 8) throw new Error('Device unavailable or too many active transfers.');
        const total = msg.kind === 'files' ? msg.files.reduce((s: number, f: Meta) => s + f.size, 0) : 0;
        if (total > ONLINE_LIMIT) throw new Error('Online transfers are limited to 128 MB. Choose fewer or smaller files.');
        const t: Transfer = { id: msg.id, sender: this.self, receiver: recipient, kind: msg.kind, files: msg.kind === 'files' ? msg.files : [], text: msg.text, total, bytes: 0, status: 'waiting', created: Date.now() };
        const a: Active = { t, peer: recipient.id, files: this.getFiles(t.id), chunks: [], sizes: [], accepted: false, received: 0, acked: 0, updated: Date.now() };
        this.control(recipient.id, { type: 'offer', id: t.id, kind: t.kind, files: t.files });
        this.transfers.set(t.id, a); this.update(a);
      } catch (error) { this.emit({ type: 'error', id: msg.id, message: error instanceof Error ? error.message : 'Could not send request.' }); }
    } else if (msg.type === 'cancel' || msg.type === 'reject') {
      const a = this.transfers.get(msg.id); if (a) this.end(a, msg.type === 'reject' ? 'declined' : 'cancelled', msg.type === 'reject' ? 'Receiver declined' : 'Transfer cancelled');
    }
  }
  async accept(id: string) {
    const a = this.transfers.get(id);
    if (!a || a.t.receiver.id !== this.self?.id || a.accepted) throw new Error('This request is unavailable.');
    if (this.reserved + a.t.total > ONLINE_LIMIT * 2) throw new Error('Clear finished transfers first to free browser memory.');
    this.reserved += a.t.total; a.accepted = true; a.t.status = 'transferring'; a.updated = Date.now(); this.update(a);
    try { this.control(a.peer, { type: 'accept', id }); } catch (error) { this.end(a, 'failed', 'Device disconnected.'); throw error; }
    return {} as { downloadUrl?: string };
  }
  private receive(peer: string, data: string | ArrayBuffer) {
    if (data instanceof ArrayBuffer) {
      if (data.byteLength < 20 || data.byteLength > 16404) throw new Error('Invalid frame');
      const frame = new Uint8Array(data), id = [...frame.subarray(0, 16)].map((n) => n.toString(16).padStart(2, '0')).join('');
      const a = this.transfers.get(id), index = new DataView(data).getUint32(16);
      if (!a || !a.accepted || a.peer !== peer || a.t.receiver.id !== this.self?.id || !a.t.files[index]) throw new Error('Unsolicited file');
      const chunk = frame.slice(20); a.sizes[index] += chunk.byteLength;
      if (a.sizes[index] > a.t.files[index].size) throw new Error('Oversized file');
      a.chunks[index].push(chunk); a.received += chunk.byteLength; a.t.bytes = a.received; a.updated = Date.now();
      this.control(peer, { type: 'ack', id, bytes: a.received });
      if (a.received % (256 * 1024) === 0 || a.received === a.t.total) this.update(a);
      return;
    }
    if (typeof data !== 'string' || data.length > 40000) throw new Error('Invalid control');
    const msg = JSON.parse(data);
    if (!/^[a-f0-9]{32}$/.test(msg.id)) throw new Error('Invalid ID');
    if (msg.type === 'offer') {
      if (this.transfers.has(msg.id) || this.transfers.size >= 8 || !['files', 'text'].includes(msg.kind)) throw new Error('Invalid request');
      const sender = this.peers.find((p) => p.id === peer); if (!sender || !this.self) return;
      if (!Array.isArray(msg.files) || msg.files.length > 100 || (msg.kind === 'files' && !msg.files.length)) throw new Error('Invalid files');
      const files: Meta[] = msg.files.map((f: Meta) => {
        if (typeof f.name !== 'string' || f.name.length > 255 || !Number.isSafeInteger(f.size) || f.size < 0) throw new Error('Invalid file');
        return { name: f.name.replace(/[\\/\x00-\x1f]/g, '_'), size: f.size };
      });
      const total = files.reduce((s, f) => s + f.size, 0); if (total > ONLINE_LIMIT) throw new Error('Transfer too large');
      const t: Transfer = { id: msg.id, sender, receiver: this.self, kind: msg.kind, files, total, bytes: 0, status: 'waiting', created: Date.now() };
      const a: Active = { t, peer, chunks: files.map(() => []), sizes: files.map(() => 0), accepted: false, received: 0, acked: 0, updated: Date.now() };
      this.transfers.set(t.id, a); this.update(a); return;
    }
    const a = this.transfers.get(msg.id); if (!a || a.peer !== peer) return;
    a.updated = Date.now();
    if (msg.type === 'accept' && a.t.sender.id === this.self?.id && !a.accepted) {
      a.accepted = true; a.t.status = 'transferring'; this.update(a);
      this.upload(a).catch(() => this.end(a, 'failed', 'Transfer interrupted. Please send again.'));
    } else if (msg.type === 'ack' && a.t.sender.id === this.self?.id && Number.isSafeInteger(msg.bytes) && msg.bytes >= a.acked && msg.bytes <= a.t.total) {
      a.acked = msg.bytes; a.t.bytes = msg.bytes; a.wake?.(); if (msg.bytes % (256 * 1024) === 0 || msg.bytes === a.t.total) this.update(a);
    } else if (msg.type === 'complete' && a.accepted && a.t.receiver.id === this.self?.id) {
      if (a.t.kind === 'text') { if (typeof msg.text !== 'string' || msg.text.length > 16000) throw new Error('Invalid text'); a.t.text = msg.text; }
      else {
        if (a.sizes.some((size, i) => size !== a.t.files[i].size)) throw new Error('Incomplete files');
        a.t.downloads = a.t.files.map((f, i) => ({ name: f.name, url: URL.createObjectURL(new Blob(a.chunks[i] as BlobPart[], { type: 'application/octet-stream' })) }));
        this.downloads.set(a.t.id, { urls: a.t.downloads.map((d) => d.url), bytes: a.t.total });
      }
      this.control(peer, { type: 'received', id: a.t.id }); this.end(a, 'complete', a.t.kind === 'text' ? 'Text received' : 'Received. Use Save to download.', false);
    } else if (msg.type === 'received' && a.accepted && a.t.sender.id === this.self?.id) this.end(a, 'complete', 'Received by the other browser', false);
    else if (msg.type === 'end' && ['cancelled', 'declined', 'failed'].includes(msg.status)) this.end(a, msg.status, String(msg.message || 'Transfer ended').slice(0, 160), false);
  }
  private async upload(a: Active) {
    const dc = this.links.get(a.peer)?.dc; if (!dc) throw new Error('Disconnected');
    let sent = 0;
    for (let index = 0; index < (a.files?.length || 0); index++) {
      const file = a.files![index];
      for (let offset = 0; offset < file.size; offset += 16384) {
        if (!this.transfers.has(a.t.id) || dc.readyState !== 'open') throw new Error('Cancelled');
        const chunk = new Uint8Array(await file.slice(offset, offset + 16384).arrayBuffer());
        if (!this.transfers.has(a.t.id)) throw new Error('Cancelled');
        const frame = new Uint8Array(20 + chunk.length);
        frame.set(a.t.id.match(/../g)!.map((s) => parseInt(s, 16))); new DataView(frame.buffer).setUint32(16, index); frame.set(chunk, 20); dc.send(frame.buffer); sent += chunk.length;
        if (sent - a.acked >= 256 * 1024 || dc.bufferedAmount > 512 * 1024) await this.waitAck(a, sent);
      }
    }
    if (sent > a.acked) await this.waitAck(a, sent);
    if (!this.transfers.has(a.t.id)) throw new Error('Cancelled');
    this.control(a.peer, { type: 'complete', id: a.t.id, ...(a.t.kind === 'text' ? { text: a.t.text } : {}) });
  }
  private waitAck(a: Active, bytes: number) {
    if (a.acked >= bytes) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { a.wake = undefined; reject(new Error('Acknowledgment timed out')); }, 30000);
      a.wake = () => { if (!this.transfers.has(a.t.id) || a.acked >= bytes) { clearTimeout(timeout); a.wake = undefined; if (a.acked >= bytes) resolve(); else reject(new Error('Cancelled')); } };
    });
  }
  clearCompleted() { for (const entry of this.downloads.values()) { entry.urls.forEach((url) => URL.revokeObjectURL(url)); this.reserved -= entry.bytes; } this.downloads.clear(); }
  private dispose() { if (this.closed) return; this.closed = true; this.readyState = 3; clearInterval(this.timer); for (const peer of [...this.links.keys()]) this.failPeer(peer, 'Disconnected.', false); this.clearCompleted(); }
  close() { this.dispose(); this.ws.close(); }
}
