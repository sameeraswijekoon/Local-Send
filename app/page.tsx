'use client';
import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, ArrowUpRight, Check, CheckCircle2, CircleHelp, Copy, File, FileText, FolderUp, Globe2, Laptop, Link, LoaderCircle, MessageSquare, Monitor, Pencil, Plus, QrCode, Radio, Send, ShieldCheck, Smartphone, Wifi, X } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Progress } from '@/components/ui/progress';
import { OnlineConnection } from '@/online/connection';

type Peer = { id: string; name: string; kind: 'phone' | 'computer'; ready?: boolean };
type Transfer = { id: string; sender: Peer; receiver: Peer; kind: 'files' | 'text'; files: { name: string; size: number }[]; text?: string; total: number; bytes: number; status: string; message?: string; created: number; downloads?: { name: string; url: string }[] };
const terminal = (s: string) => ['complete', 'failed', 'cancelled', 'declined'].includes(s);
const formatSize = (b: number) => { if (!b) return '0 B'; const u = Math.min(Math.floor(Math.log(b) / Math.log(1024)), 4); return `${(b / 1024 ** u).toFixed(u ? 1 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][u]}`; };
const newId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((n) => n.toString(16).padStart(2, '0')).join('');
const deviceKind = () => /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? 'phone' : 'computer';
const defaultName = () => `${/iPhone/i.test(navigator.userAgent) ? 'iPhone' : /Android/i.test(navigator.userAgent) ? 'Android' : /Macintosh/i.test(navigator.userAgent) ? 'Mac' : /Windows/i.test(navigator.userAgent) ? 'Windows PC' : 'My device'} ${Math.floor(Math.random() * 90 + 10)}`;

export default function Home() {
  const [self, setSelf] = useState<Peer | null>(null), [peers, setPeers] = useState<Peer[]>([]);
  const [connected, setConnected] = useState(false), [connecting, setConnecting] = useState(true);
  const [name, setName] = useState('My device'), [code, setCode] = useState('');
  const [urls, setUrls] = useState<string[]>([]), [selectedUrl, setSelectedUrl] = useState('');
  const [files, setFiles] = useState<File[]>([]), [text, setText] = useState(''), [tab, setTab] = useState('files'), [recipient, setRecipient] = useState('');
  const [transfers, setTransfers] = useState<Transfer[]>([]), [links, setLinks] = useState<Record<string, string>>({});
  const [dragging, setDragging] = useState(false), [shareOpen, setShareOpen] = useState(false), [renameOpen, setRenameOpen] = useState(false), [helpOpen, setHelpOpen] = useState(false);
  const [notice, setNotice] = useState(''), [accepting, setAccepting] = useState(false);
  const socket = useRef<WebSocket | OnlineConnection | null>(null), token = useRef('');
  const pendingFiles = useRef(new Map<string, File[]>()), uploads = useRef(new Map<string, XMLHttpRequest>());
  const fileInput = useRef<HTMLInputElement>(null), reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), mounted = useRef(true);
  const connectRef = useRef<(c: string, n: string) => void>(() => {});
  function send(message: object) { if (socket.current?.readyState !== WebSocket.OPEN) { setNotice('Connection lost. Please reconnect.'); return false; } socket.current.send(JSON.stringify(message)); return true; }
  const onlineMode = typeof window !== 'undefined' && !!window.NEARSHARE_CONFIG;
  function handleMessage(event: { data: string }) {
    const msg = JSON.parse(event.data);
    if (msg.type === 'joined') { token.current = msg.token || ''; setSelf(msg.self); setConnected(true); setConnecting(false); sessionStorage.setItem('nearshare-code', code); localStorage.setItem('nearshare-name', name); return; }
    if (msg.type === 'peers') { setPeers(msg.peers); setSelf((current) => msg.peers.find((p: Peer) => p.id === current?.id) || current); return; }
    if (msg.type === 'error') { setNotice(msg.message); if (msg.id) pendingFiles.current.delete(msg.id); return; }
    if (msg.type === 'transfer') {
      const t: Transfer = msg.transfer;
      setTransfers((old) => [t, ...old.filter((a) => a.id !== t.id)].sort((a, b) => b.created - a.created).slice(0, 50));
      if (terminal(t.status)) { pendingFiles.current.delete(t.id); if (t.status !== 'complete') uploads.current.get(t.id)?.abort(); uploads.current.delete(t.id); }
      return;
    }
    if (msg.type === 'upload') {
      const file = pendingFiles.current.get(msg.id)?.[msg.index];
      if (!file) { socket.current?.send(JSON.stringify({ type: 'cancel', id: msg.id })); setNotice('File unavailable. Please send it again.'); return; }
      const xhr = new XMLHttpRequest(); uploads.current.set(msg.id, xhr);
      xhr.open('PUT', msg.url); xhr.setRequestHeader('Authorization', `Bearer ${token.current}`);
      xhr.onload = () => { if (xhr.status !== 200) { send({ type: 'cancel', id: msg.id }); setNotice('Upload failed. Please send again.'); } };
      xhr.onerror = () => { send({ type: 'cancel', id: msg.id }); setNotice('Upload interrupted. Check your connection.'); };
      xhr.send(file);
    }
  }
  function connect(joinCode: string, deviceName: string) {
    clearTimeout(reconnectTimer.current);
    if (socket.current) { socket.current.onclose = null; socket.current.close(); }
    setConnecting(true);
    if (onlineMode) {
      if (!window.NEARSHARE_CONFIG?.signalingUrl.trim()) {
        setConnecting(false);
        setNotice('Online sharing needs a signaling URL. Set it in config.js, then refresh.');
        return;
      }
      try {
        const ws = new OnlineConnection(joinCode, window.NEARSHARE_CONFIG!, (transferId) => pendingFiles.current.get(transferId)); socket.current = ws;
        ws.onopen = () => ws.send(JSON.stringify({ type: 'join', name: deviceName, kind: deviceKind() }));
        ws.onmessage = handleMessage;
        ws.onerror = () => setNotice('Online sharing is not configured. Follow ONLINE-SETUP.md to add the signaling URL.');
        ws.onclose = () => { if (!mounted.current) return; setConnected(false); setConnecting(false); setPeers([]); };
      } catch (error) { setConnecting(false); setNotice(error instanceof Error ? error.message : 'Online sharing is not configured.'); }
      return;
    }
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`); socket.current = ws;
    let joined = false;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'join', code: joinCode, name: deviceName, kind: deviceKind() }));
    ws.onmessage = handleMessage;
    ws.onclose = () => {
      if (!mounted.current) return;
      setConnected(false); setConnecting(false); setPeers([]); token.current = '';
      for (const xhr of uploads.current.values()) xhr.abort(); uploads.current.clear(); pendingFiles.current.clear();
      setTransfers((old) => old.map((t) => terminal(t.status) ? t : { ...t, status: 'failed', message: 'Connection lost. Please send again.' }));
      if (joined) reconnectTimer.current = setTimeout(() => connectRef.current(joinCode, localStorage.getItem('nearshare-name') || deviceName), 2000);
    };
    ws.onerror = () => setNotice('Cannot reach the local server. Make sure it is running.');
  }
  connectRef.current = connect;
  useEffect(() => {
    mounted.current = true; const deviceName = localStorage.getItem('nearshare-name') || defaultName(); setName(deviceName);
    if (onlineMode) {
      const room = new URLSearchParams(location.hash.slice(1)).get('room') || sessionStorage.getItem('nearshare-code') || newId();
      if (location.hash) history.replaceState(null, '', location.pathname);
      setCode(room); setUrls([location.origin + location.pathname]); setSelectedUrl(location.origin + location.pathname); connectRef.current(room, deviceName); return;
    }
    fetch('/api/config').then((r) => { if (!r.ok) throw new Error(); return r.json(); }).then((config) => {
      if (!mounted.current) return;
      const joinCode = new URLSearchParams(location.hash.slice(1)).get('code') || config.roomCode || sessionStorage.getItem('nearshare-code') || '';
      if (location.hash) history.replaceState(null, '', location.pathname);
      setCode(joinCode); setUrls(config.urls); setSelectedUrl(config.urls[0] || location.origin);
      if (joinCode) connectRef.current(joinCode, deviceName); else setConnecting(false);
    }).catch(() => { if (mounted.current) { setConnecting(false); setNotice('Cannot reach the local server. Start it and refresh this page.'); } });
    return () => { mounted.current = false; clearTimeout(reconnectTimer.current); if (socket.current) { socket.current.onclose = null; socket.current.close(); } for (const xhr of uploads.current.values()) xhr.abort(); };
  }, []);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 6500); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => {
    if (onlineMode) return;
    const refreshAddress = () => {
      fetch('/api/config', { signal: AbortSignal.timeout(5000) }).then((r) => {
        if (!r.ok) throw new Error('Server unavailable');
        return r.json();
      }).then((config: { urls: string[] }) => {
        if (!mounted.current) return;
        setUrls(config.urls);
        setSelectedUrl((previous) => config.urls.includes(previous) ? previous : config.urls[0] || '');
      }).catch(() => {});
    };
    const timer = setInterval(refreshAddress, 10000);
    window.addEventListener('focus', refreshAddress);
    window.addEventListener('online', refreshAddress);
    return () => { clearInterval(timer); window.removeEventListener('focus', refreshAddress); window.removeEventListener('online', refreshAddress); };
  }, []);
  const nearby = peers.filter((p) => p.id !== self?.id), selected = nearby.find((p) => p.id === recipient);
  const incoming = transfers.find((t) => t.receiver.id === self?.id && t.status === 'waiting');
  const joinUrl = onlineMode ? `${selectedUrl || location.origin + location.pathname}#room=${code}` : `${selectedUrl || location.origin}/#code=${code}`;
  async function copy(value: string) {
    try { if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(value);
      else { const input = document.createElement('textarea'); input.value = value; input.style.position = 'fixed'; input.style.opacity = '0'; document.body.append(input); input.select(); const ok = document.execCommand('copy'); input.remove(); if (!ok) throw new Error(); }
      setNotice('Copied to clipboard');
    } catch { setNotice('Select the text and copy it manually. Clipboard access is unavailable.'); }
  }
  function addFiles(next: File[]) { setFiles((old) => { const combined = [...old]; for (const f of next) if (!combined.some((a) => a.name === f.name && a.size === f.size && a.lastModified === f.lastModified)) combined.push(f); if (combined.length > 100) setNotice('You can send up to 100 files at once.'); return combined.slice(0, 100); }); setTab('files'); }
  function offer() {
    if (!selected || !connected || (tab === 'files' ? !files.length : !text.trim())) return;
    const transferId = newId(); if (tab === 'files') pendingFiles.current.set(transferId, [...files]);
    if (send({ type: 'offer', id: transferId, to: selected.id, kind: tab, files: files.map((f) => ({ name: f.name, size: f.size })), text })) { if (tab === 'files') setFiles([]); else setText(''); setNotice(`Request sent to ${selected.name}`); } else pendingFiles.current.delete(transferId);
  }
  async function accept(t: Transfer) {
    setAccepting(true);
    try { if (onlineMode && socket.current instanceof OnlineConnection) { await socket.current.accept(t.id); return; } const response = await fetch(`/api/transfers/${t.id}/accept`, { method: 'POST', headers: { Authorization: `Bearer ${token.current}` } }); const result = await response.json(); if (!response.ok) throw new Error(result.error);
      if (result.downloadUrl) { setLinks((old) => ({ ...old, [t.id]: result.downloadUrl })); const a = document.createElement('a'); a.href = result.downloadUrl; a.download = t.files.length > 1 ? 'NearShare-files.zip' : t.files[0].name; document.body.append(a); a.click(); a.remove(); }
    } catch (e) { setNotice(e instanceof Error ? e.message : 'Could not accept the transfer.'); } finally { setAccepting(false); }
  }
  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="./"><span className="brand-mark"><Send size={23} /></span>NearShare<span className="brand-label">LOCAL SHARING</span></a><div className="header-actions"><span className={`connection-pill ${connected ? '' : 'offline'}`}><i />{connected ? 'Connected to your room' : connecting ? 'Connecting…' : 'Not connected'}</span><button className="icon-button" onClick={() => setHelpOpen(true)} aria-label="How sharing works"><CircleHelp size={21} /></button></div></header>
    <main className="main"><div className="page-heading"><div><div className="eyebrow"><Wifi size={15} /> A LITTLE CLOSER. A LOT EASIER.</div><h1>Your files. Just a hop away.</h1><p>Share with your other devices, right here on your network.</p></div><button className="button secondary join-button" disabled={!connected} onClick={() => setShareOpen(true)}><Plus size={18} />Connect a device</button></div>
      {!connected && <section className="join-banner"><div><strong>{connecting ? 'Connecting to your sharing room…' : 'Join your sharing room'}</strong><p>Enter the six-digit code shown on the host computer.</p></div><form onSubmit={(e) => { e.preventDefault(); connect(code, name); }}><input aria-label="Room code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} placeholder="000000" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required /><button className="button primary" disabled={connecting || code.length !== 6}>{connecting ? <LoaderCircle className="spin" size={18} /> : 'Join room'}</button></form></section>}
      <div className="workspace"><section className="send-panel panel"><div className="section-title"><div className="title-with-icon"><span className="small-icon"><ArrowUpRight size={20} /></span><h2>Send something</h2></div><span className="step-label">01 / SELECT</span></div>
        <Tabs value={tab} onValueChange={(value) => setTab(String(value))} className="send-tabs"><TabsList className="file-tabs"><TabsTrigger value="files"><File size={16} />Files</TabsTrigger><TabsTrigger value="text"><MessageSquare size={16} />Text & links</TabsTrigger></TabsList>
        <TabsContent value="files"><input ref={fileInput} type="file" multiple className="sr-only" tabIndex={-1} onChange={(e) => { addFiles(Array.from(e.target.files || [])); e.target.value = ''; }} /><button className={`dropzone ${dragging ? 'dragging' : ''}`} onClick={() => fileInput.current?.click()} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(Array.from(e.dataTransfer.files)); }}><span className="upload-icon"><FolderUp size={33} strokeWidth={1.5} /></span><strong>{dragging ? 'Drop them here' : 'Drop files here'}</strong><span>or <b>browse your device</b></span><small>Photos, videos, documents. Anything you need to send.</small></button>
        {!!files.length && <div className="selected-files"><div className="files-heading"><span>{files.length} files · {formatSize(files.reduce((s, f) => s + f.size, 0))}</span><button className="text-button" onClick={() => setFiles([])}>Clear all</button></div>{files.map((f, i) => <div className="file-row" key={`${f.name}-${i}`}><FileText size={18} /><span>{f.name}<small>{formatSize(f.size)}</small></span><button className="icon-button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((old) => old.filter((_, n) => n !== i))}><X size={16} /></button></div>)}</div>}</TabsContent>
        <TabsContent value="text"><div className="text-compose"><label htmlFor="message">A note, a link, or a little inspiration</label><textarea id="message" maxLength={16000} placeholder="Paste or type something to share…" value={text} onChange={(e) => setText(e.target.value)} /><span>{text.length.toLocaleString()} / 16,000</span></div></TabsContent></Tabs>
        <div className="devices-heading"><h3>Send to</h3><span className="step-label">02 / CHOOSE A DEVICE</span></div>
        {nearby.length ? <div className="device-grid">{nearby.map((p, i) => <button disabled={p.ready === false} className={`device-card ${recipient === p.id ? 'selected' : ''}`} key={p.id} onClick={() => setRecipient(p.id)}><span className={`device-icon color-${i % 3}`}>{p.kind === 'phone' ? <Smartphone size={25} /> : <Laptop size={25} />}</span><span><strong>{p.name}</strong><small>{p.kind === 'phone' ? 'Phone / tablet' : 'Computer'} · {p.ready === false ? 'Connecting…' : 'Ready'}</small></span><span className="selection-dot">{recipient === p.id && <Check size={12} />}</span></button>)}</div> : <div className="empty-devices"><Radio size={26} /><div><strong>{connected ? 'Your next device goes here' : 'Devices will appear when you join'}</strong><p>Open NearShare on another device and join this room.</p></div>{connected && <button className="text-button" onClick={() => setShareOpen(true)}>Show QR code <ArrowRight size={15} /></button>}</div>}
        <div className="send-footer"><span>{files.length > 1 && tab === 'files' ? 'Multiple files arrive as one ZIP.' : 'The recipient approves before receiving.'}</span><button className="button primary" onClick={offer} disabled={!connected || !selected || (tab === 'files' ? !files.length : !text.trim())}><Send size={17} />{selected ? `Send to ${selected.name}` : 'Send'}</button></div></section>
        <aside className="side-column"><section className="identity-panel"><div className="identity-top"><span className="eyebrow">THIS DEVICE</span><span className={connected ? 'live-dot' : 'muted-dot'} /></div><div className="own-device-icon">{self?.kind === 'phone' ? <Smartphone size={37} strokeWidth={1.5} /> : <Monitor size={37} strokeWidth={1.5} />}</div><div className="device-name"><h2>{self?.name || name}</h2><button className="icon-button" onClick={() => setRenameOpen(true)} aria-label="Rename this device"><Pencil size={15} /></button></div><p>This is how others see you.</p><div className="identity-status"><span><i className={connected ? 'live-dot' : 'muted-dot'} />{connected ? 'Visible in your room' : 'Waiting to connect'}</span><Wifi size={16} /></div></section>
        <section className="connect-panel panel"><span className="small-icon neutral"><QrCode size={20} /></span><h3>Bring your devices together.</h3><p>Same Wi-Fi. Same room.<br />No app installation needed.</p><button className="button secondary wide" disabled={!connected} onClick={() => setShareOpen(true)}><QrCode size={17} />Show connection details</button></section><div className="local-note"><ShieldCheck size={19} /><p><strong>Stays on your network.</strong> Files pass through the host computer and are never stored by NearShare.</p></div></aside></div>
      <section className="activity-panel panel"><div className="section-title"><div className="title-with-icon"><span className="small-icon neutral"><ArrowDownToLine size={19} /></span><h2>Transfers</h2><span className="count-badge">{transfers.length}</span></div>{transfers.some((t) => terminal(t.status)) && <button className="text-button" onClick={() => { if (socket.current instanceof OnlineConnection) socket.current.clearCompleted(); setTransfers((old) => old.filter((t) => !terminal(t.status))); }}>Clear finished</button>}</div>
      {!transfers.length ? <div className="activity-empty"><span className="empty-transfer-icon"><ArrowUpRight size={17} /><ArrowDownToLine size={17} /></span><div><strong>A clean slate, ready to share.</strong><p>Your sent and received items will appear here.</p></div><span className="session-label">THIS SESSION</span></div> : <div className="transfer-list">{transfers.map((t) => { const receiving = t.receiver.id === self?.id, pct = t.status === 'complete' ? 100 : t.total ? Math.min(99, Math.round(t.bytes / t.total * 100)) : 0; return <div className="transfer" key={t.id}><div className={`transfer-icon ${t.status === 'complete' ? 'complete' : ''}`}>{t.status === 'complete' ? <CheckCircle2 size={22} /> : t.kind === 'text' ? <MessageSquare size={22} /> : <FileText size={22} />}</div><div className="transfer-main"><div className="transfer-line"><strong>{t.kind === 'text' ? 'Text message' : t.files.length > 1 ? `${t.files.length} files` : t.files[0]?.name}</strong><span className={`transfer-status status-${t.status}`}>{t.status === 'waiting' ? 'Waiting for approval' : t.status === 'accepted' ? 'Starting download' : t.status === 'transferring' ? `${pct}%` : t.status === 'complete' ? 'Delivered' : t.status}</span></div><p>{receiving ? 'From' : 'To'} {receiving ? t.sender.name : t.receiver.name}{t.kind === 'files' && ` · ${formatSize(t.total)}`}{t.message && ` · ${t.message}`}</p>{t.status === 'transferring' && <Progress value={pct} aria-label="Transfer progress" />}{t.status === 'accepted' && receiving && links[t.id] && <a className="text-button" href={links[t.id]} download>Download hasn’t started? Click here.</a>}{t.status === 'complete' && t.downloads?.map((d) => <a className="text-button" key={d.url} href={d.url} download={d.name}><ArrowDownToLine size={15} />Save {d.name}</a>)}{t.kind === 'text' && t.status === 'complete' && <div className="received-text"><p>{t.text}</p><button className="icon-button" onClick={() => copy(t.text || '')} aria-label="Copy received text"><Copy size={16} /></button></div>}</div>{!terminal(t.status) && <button className="icon-button" aria-label="Cancel transfer" onClick={() => send({ type: 'cancel', id: t.id })}><X size={17} /></button>}</div>; })}</div>}</section>
      <footer className="footer"><span><Globe2 size={14} />No accounts. No cloud. Just nearby.</span><span>Local HTTP · Use a trusted network</span></footer></main>
    <Dialog open={shareOpen} onOpenChange={setShareOpen}><DialogContent className="app-dialog"><DialogTitle>Connect another device</DialogTitle><DialogDescription>{onlineMode ? 'Share this private room link. Devices can join from any network.' : 'Connect to the same Wi-Fi, then scan this code with your phone’s camera.'}</DialogDescription><div className="qr-box"><QRCodeSVG value={joinUrl} size={190} level="M" marginSize={2} /></div>{urls.length > 1 && <div className="address-choices"><span>Choose this computer’s Wi-Fi address:</span>{urls.map((url) => <button key={url} className={`button secondary ${url === selectedUrl ? 'chosen-address' : ''}`} onClick={() => setSelectedUrl(url)}>{url}</button>)}</div>}<div className="join-details"><span>Or open this address</span><code>{onlineMode ? joinUrl : selectedUrl || location.origin}</code>{!onlineMode && <><span>Room code</span><strong className="room-code">{code}</strong></>}</div><button className="button primary wide" onClick={() => copy(joinUrl)}><Link size={17} />Copy invitation link</button><p className="dialog-note">Keep both pages open while sharing. Share this link only with people you trust.</p></DialogContent></Dialog>
    <Dialog open={renameOpen} onOpenChange={setRenameOpen}><DialogContent className="app-dialog"><DialogTitle>Give your device a name</DialogTitle><DialogDescription>Make it easy to spot in your sharing room.</DialogDescription><form onSubmit={(e) => { e.preventDefault(); const value = name.trim(); if (!value) return; localStorage.setItem('nearshare-name', value); if (connected) send({ type: 'rename', name: value }); setRenameOpen(false); }}><label htmlFor="device-name">Device name</label><input id="device-name" className="name-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required /><button className="button primary wide">Save name</button></form></DialogContent></Dialog>
    <Dialog open={!!incoming} onOpenChange={(open) => { if (!open && incoming && !accepting) send({ type: 'reject', id: incoming.id }); }}><DialogContent className="app-dialog"><DialogTitle>{incoming?.sender.name} wants to share</DialogTitle><DialogDescription>{incoming?.kind === 'text' ? 'Accept to receive a text message.' : `${incoming?.files.length} file(s) · ${formatSize(incoming?.total || 0)}. Accept to download to this device.`}</DialogDescription><div className="incoming-files">{incoming?.kind === 'text' ? <p>Text message · {incoming.text?.length} characters</p> : incoming?.files.map((f, i) => <div className="file-row" key={i}><FileText size={18} /><span>{f.name}<small>{formatSize(f.size)}</small></span></div>)}</div><div className="dialog-actions"><button className="button secondary" disabled={accepting} onClick={() => incoming && send({ type: 'reject', id: incoming.id })}>Decline</button><button className="button primary" disabled={accepting} onClick={() => incoming && accept(incoming)}>{accepting ? <LoaderCircle className="spin" size={17} /> : <ArrowDownToLine size={17} />}Accept{incoming?.kind === 'files' ? ' & download' : ''}</button></div></DialogContent></Dialog>
    <Dialog open={helpOpen} onOpenChange={setHelpOpen}><DialogContent className="app-dialog"><DialogTitle>A few steps. A shorter distance.</DialogTitle><DialogDescription>NearShare connects browsers through a computer on your local network.</DialogDescription><ol className="help-steps"><li><strong>Start on the same network.</strong><p>Keep NearShare running on the host computer. Join the same Wi-Fi on each device.</p></li><li><strong>Join the room.</strong><p>Use “Connect a device” to scan a QR code or open the address and enter the room code.</p></li><li><strong>Choose, send, accept.</strong><p>Pick files or text, select a device, and send. The recipient accepts before a download starts.</p></li></ol><p className="dialog-note">If devices cannot connect, allow the server through the host’s firewall on private networks. Guest Wi-Fi may block devices from reaching each other. Keep pages in the foreground during transfers. HTTP transfers are not encrypted; use trusted Wi-Fi. NearShare connects browsers, not native LocalSend clients.</p></DialogContent></Dialog>
    {notice && <div className="notice" role="status"><span>{notice}</span><button aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={16} /></button></div>}
  </div>;
}
