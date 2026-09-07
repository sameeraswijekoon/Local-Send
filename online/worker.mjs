// Cloudflare Worker + Durable Object. Only membership and WebRTC connection
// descriptions pass here. File contents and text messages use the data channel.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'NearShare signaling' });
    const match = url.pathname.match(/^\/room\/([a-f0-9]{32})$/);
    if (!match) return new Response('Not found', { status: 404 });
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!allowed.length) return new Response('Configure ALLOWED_ORIGINS first.', { status: 503 });
    if (!allowed.includes(request.headers.get('Origin'))) return new Response('Origin denied', { status: 403 });
    if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 });
    return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
  },
};

export class Room {
  constructor(ctx) { this.ctx = ctx; this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); }
  sockets() { return this.ctx.getWebSockets().filter((ws) => ws.readyState === 1); }
  send(ws, value) { try { ws.send(JSON.stringify(value)); } catch { ws.close(1011, 'Send failed'); } }
  peers() {
    const peers = this.sockets().map((ws) => ws.deserializeAttachment()).filter((s) => s?.joined).map(({ id, name, kind }) => ({ id, name, kind }));
    for (const ws of this.sockets()) if (ws.deserializeAttachment()?.joined) this.send(ws, { type: 'peers', peers });
  }
  async fetch() {
    if (this.sockets().length >= 16) return new Response('Room is full (16 devices).', { status: 429 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: crypto.randomUUID(), joined: false, since: Date.now(), count: 0 });
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > 24000) { ws.close(1009, 'Signaling message too large'); return; }
    let state = ws.deserializeAttachment();
    if (!state) { ws.close(1008, 'Unknown connection'); return; }
    if (Date.now() - state.since > 60000) { state.since = Date.now(); state.count = 0; }
    if (++state.count > 240) { ws.close(1008, 'Too many signaling messages'); return; }
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'join' || msg.type === 'rename') {
        if (typeof msg.name !== 'string' || !msg.name.trim() || msg.name.length > 40) throw new Error('Choose a name with 1–40 characters.');
        state.name = msg.name.replace(/[\x00-\x1f]/g, '').trim(); state.kind = msg.kind === 'phone' ? 'phone' : 'computer';
        if (!state.name) throw new Error('Device name is required.');
        const first = !state.joined; state.joined = true; ws.serializeAttachment(state);
        if (first) this.send(ws, { type: 'joined', self: { id: state.id, name: state.name, kind: state.kind }, token: '' });
        this.peers(); return;
      }
      ws.serializeAttachment(state);
      if (!state.joined || msg.type !== 'signal') throw new Error('Join before sending connection details.');
      const payload = msg.payload;
      if (!payload || typeof payload !== 'object') throw new Error('Invalid connection details.');
      let sanitized;
      if (payload.description && ['offer', 'answer'].includes(payload.description.type) && typeof payload.description.sdp === 'string' && payload.description.sdp.length <= 20000) sanitized = { description: { type: payload.description.type, sdp: payload.description.sdp } };
      else if (payload.candidate && typeof payload.candidate.candidate === 'string' && payload.candidate.candidate.length <= 4096) sanitized = { candidate: { candidate: payload.candidate.candidate, sdpMid: typeof payload.candidate.sdpMid === 'string' ? payload.candidate.sdpMid.slice(0, 128) : null, sdpMLineIndex: Number.isInteger(payload.candidate.sdpMLineIndex) ? payload.candidate.sdpMLineIndex : null } };
      else throw new Error('Unsupported connection message.');
      const target = this.sockets().find((other) => other !== ws && other.deserializeAttachment()?.joined && other.deserializeAttachment()?.id === msg.to);
      if (target) this.send(target, { type: 'signal', from: state.id, payload: sanitized });
    } catch (error) { this.send(ws, { type: 'error', message: error.message }); }
  }
  webSocketClose(ws) { ws.close(1000, 'Disconnected'); this.peers(); }
  webSocketError(ws) { ws.close(1011, 'Connection error'); this.peers(); }
}
