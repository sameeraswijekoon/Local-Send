# Publish NearShare online

GitHub Pages hosts the app. The included Cloudflare Worker helps browsers in the same private room establish an encrypted WebRTC connection. It never receives file or text contents.

## 1. Publish the website

The `docs` directory is the production website. On GitHub, open the repository **Settings → Pages**, choose **Deploy from a branch**, then select **master** and **/docs**. Save it. GitHub will publish `https://sameeraswijekoon.github.io/Local-Send/` after a short delay.

## 2. Publish the signaling worker

Use any personal computer with Node.js and the Cloudflare Wrangler CLI. From this project, sign in and deploy:

```sh
npx wrangler login
npx wrangler deploy --config online/wrangler.jsonc
```

Cloudflare will print a URL ending in `.workers.dev`. In `online/wrangler.jsonc`, replace `https://YOUR-GITHUB-USERNAME.github.io` with `https://sameeraswijekoon.github.io`, then deploy again. If your Pages site uses another domain, use that exact origin instead.

## 3. Connect the two parts

Edit `docs/config.js` on GitHub (or edit `online/config.js`, run `pnpm run build:pages`, then push):

```js
window.NEARSHARE_CONFIG = {
  signalingUrl: "https://YOUR-WORKER.workers.dev",
  iceServers: [],
};
```

After GitHub Pages updates, open the site and use **Connect a device** to create a room link. Devices using that link can see each other. The 128 MB limit is intentional because received files are held in browser memory before saving.

## Internet connectivity

WebRTC files are encrypted in transit. Some office, school, mobile, and corporate networks block direct WebRTC between devices. For reliable sharing across unrelated networks, configure a TURN relay in `iceServers`; a free GitHub Pages site alone cannot provide one. The Cloudflare Worker has origin checks and only relays short WebRTC connection descriptions.
