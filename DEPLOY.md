# Putting OJB Cube online

The whole app is one Node.js server that serves the website and runs the live games. Pick one of these options.

## Option A: Render (free, easiest)

1. Go to https://render.com and sign in with GitHub.
2. Click **New → Blueprint**, pick this repository, and click **Apply**. It reads `render.yaml`.
3. Wait for the build (a few minutes). Render gives you a URL like `https://ojb-cube.onrender.com`. Share it with your friends.

4. **Set `ROOM_SECRET`** (once): in the Render dashboard open the service → **Environment** → **Add Environment Variable**, key `ROOM_SECRET`, value a long random string (for example the output of `openssl rand -base64 32`), then **Save changes**. New Blueprint deploys create it automatically (`generateValue` in `render.yaml`); check it is there. Never change it afterwards.

Notes:
- Free Render services **go to sleep after ~15 minutes with nobody connected**. The first visit after that takes ~30–60 seconds to wake up.
- Sleeping, restarting or redeploying wipes the server's disk, but **rooms come back**: every player's browser keeps an encrypted, signed copy of the room (settings, cube list, seats, draft/auction, picks, decks and games). When the server has forgotten a room, the first player to reconnect sends that copy back, the room returns under the same code, and everyone else rejoins automatically. Undo history inside a game is not kept.
- This needs a stable `ROOM_SECRET` (step 4). Without it the server makes a random secret on every start, so copies saved before a restart can't be read after it, and rooms are lost as before.
- Saved cubes and decks live in each browser's own storage and are never affected by restarts.
- A paid instance with a persistent disk mounted at `/data` and `DATA_DIR=/data` also keeps rooms on the server.

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
