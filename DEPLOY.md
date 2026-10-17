# Putting OJB Cube online

The whole app is one Node.js server that serves the website and runs the live games. Pick one of these options.

## Option A: Render (free, easiest)

1. Go to https://render.com and sign in with GitHub.
2. Click **New → Blueprint**, pick this repository, and click **Apply**. It reads `render.yaml`.
3. Wait for the build (a few minutes). Render gives you a URL like `https://ojb-cube.onrender.com`. Share it with your friends.

Notes:
- Free Render services **go to sleep after ~15 minutes with nobody connected**. The first visit after that takes ~30–60 seconds to wake up.
- Sleeping or redeploying **clears rooms**, because free services have no permanent disk. Finish a draft and its games in one sitting, or export your decks (XMage/text) before you leave.
- For rooms that survive restarts, use a paid instance with a persistent disk mounted at `/data` and set the env var `DATA_DIR=/data`.

## Option B: Your own computer + a free tunnel (rooms are saved)

1. Install Node.js 20+ and run:
   ```bash
   npm install
   npm run build
   npm start
   ```
2. Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) and run:
   ```bash
   cloudflared tunnel --url http://localhost:3001
   ```
3. It prints a `https://….trycloudflare.com` link. Send it to your friends. The site is online while your computer and both commands are running. Rooms are saved in `data-store/rooms.json`.

## Option C: Docker (any host: Fly.io, Railway, a VPS…)

```bash
docker build -t ojb-cube .
docker run -p 3001:3001 -v ojb-data:/data ojb-cube
```

The server listens on `$PORT` (default 3001) and stores rooms in `$DATA_DIR` (default `/data` in Docker).

## Upgrading card images to Scryfall's CDN

The committed card data was built without internet access to Scryfall, so card images default to the print-and-play scans. On any computer with internet, run:

```bash
npm run build-cube
```

Then commit the updated `shared/data/cube.json` and redeploy. Images will then come straight from Scryfall's CDN in high resolution, and token and card details will match Scryfall exactly.
