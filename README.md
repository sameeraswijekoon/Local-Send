# NearShare

A browser app for sharing files and text between devices on the same local network. One computer runs the Node.js server; other computers, Android devices, iPhones, and tablets join through a browser. No client EXE or APK is needed.

## Run

Requires Node.js 22.13+ and pnpm. Install dependencies once with internet access:

```sh
pnpm install
pnpm build
pnpm start
```

Open **http://localhost:3344** on the host computer. Choose **Connect a device**, then scan its QR code from another device on the same Wi-Fi. Alternatively, open the network address printed by the server and enter its six-digit room code.

On Windows, after setup you can also double-click `Start-NearShare.cmd`. Keep its terminal open while sharing. Press Ctrl+C in the terminal to stop the server.

1. Select files or enter text.
2. Select a connected device and press Send.
3. Accept the request on the receiving device.

Single files retain their original names. Multiple files download as one ZIP, with numbered filenames to avoid collisions. Use your browser's downloads panel to locate received files. Keep both browser pages open and in the foreground while sharing.

After installation and building, internet access is not needed. The app loads its scripts, styles, icons, and QR generation locally. To rebuild after source changes, run `pnpm build` and refresh the browser. `pnpm dev` builds and starts the local server; it does not use hot reload.

## Configuration

The default port is 3344. `PORT` changes it. The room code is random on each server start; `ROOM_CODE` may be set to exactly six digits to use a fixed code. Do not commit a private room code.

PowerShell example:

```powershell
$env:PORT = '3344'
pnpm start
```

If Windows asks, allow Node.js on your **private network**. If the phone cannot reach the server, check the host's firewall and confirm both devices are on the same network. Guest Wi-Fi/client isolation and some VPNs prevent communication. If several network addresses appear, select the actual Wi-Fi/LAN address in the connection dialog. The host's IP address can change after reconnecting to Wi-Fi.

When the computer is connected to your phone's hotspot, open the **computer's current network address** in the phone browser. A previously copied link can stop working when the hotspot reconnects or the computer switches networks. NearShare refreshes its connection dialog every 10 seconds and when the host page regains focus; the server also updates its accepted addresses without a restart. Keep the host page at `http://localhost:3344` and copy a fresh invitation after switching networks. A phone showing 5G while providing a hotspot is not by itself a sign of an incorrect setup.

## How it works

- React interface with responsive layouts and accessible Base UI dialogs, tabs, and progress bars.
- WebSockets provide room membership, live device discovery, transfer offers, progress, and cancellation.
- HTTP streams carry file data through the host. Backpressure bounds memory usage; file data is never written to the host's disk or uploaded to a cloud service.
- Multiple files are ZIP-streamed using yazl, without buffering the entire archive.
- Browser-native downloads avoid keeping whole received files in browser JavaScript memory.
- Room codes, per-client tokens, scoped upload/download tokens, origin/host checks, size validation, timeouts, and receiver approval protect the transfer flow.

## Limits and privacy

This local version uses **HTTP, not encrypted HTTPS**. The room code controls joining; it does not encrypt traffic. Use a trusted network. The host computer handles file bytes in memory and can observe traffic. Do not expose this server directly to the internet. For an encrypted production deployment, add trusted HTTPS and WSS.

Up to 100 files and a total of 1 TB may be offered at once; actual limits depend on storage, browsers, and network conditions. Text is limited to 16,000 characters. Inactive requests and stalled transfers expire after approximately two minutes. Interrupted transfers must be resent; resume and folder transfer are not implemented. “Delivered” means the server finished sending to the browser, not confirmation that the browser saved the file to disk. Session history resets when the page is refreshed.

This is an independent app inspired by LocalSend, not an implementation of the native LocalSend protocol. Native LocalSend clients do not appear in NearShare.

## Development and checks

```sh
pnpm typecheck
pnpm test
pnpm build
```

The portable build uses esbuild WebAssembly and Tailwind's JavaScript compiler so it can build without platform-specific native binaries. The original Sites/Vite scaffold and component catalog are retained; the LAN app uses the Node server and `dist/lan` output instead of a cloud deployment.

The integration suite checks authentication, discovery, Unicode text, exact file bytes, empty files, ZIP contents, rejection, cancellation, origin enforcement, and disconnections. A real phone-to-computer trial on your Wi-Fi is still needed to confirm device/browser and firewall behavior.
