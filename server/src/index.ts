import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server, type Socket } from 'socket.io';
import type { ClientMsg } from '@ojb/shared';
import { type RoomRecord, Rooms } from './rooms.ts';
import { registerCardDbRoutes } from './carddb-routes.ts';
import { BotDriver } from './botdriver.ts';
import { loadRoomSecret, Restorer, SnapshotCodec } from './snapshot.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3001);
const DATA_DIR = process.env.DATA_DIR ?? path.resolve(__dirname, '../../data-store');
const CLIENT_DIST = path.resolve(__dirname, '../../client/dist');
const ROOM_TTL_MS = 14 * 24 * 3600 * 1000;

const rooms = new Rooms();

// ------------------------------------------------------------ persistence
const storeFile = path.join(DATA_DIR, 'rooms.json');
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile, 'utf8')) as RoomRecord[];
    for (const rec of raw) {
      for (const p of rec.state.players) p.connected = p.isBot && !p.away;
      rooms.rooms.set(rec.state.id, rec);
    }
    console.log(`Loaded ${raw.length} rooms`);
  } catch {
    /* first run */
  }
}
function save() {
  if (!rooms.dirty.size) return;
  rooms.dirty.clear();
  const now = Date.now();
  for (const [rid, rec] of rooms.rooms) if (now - rec.state.updatedAt > ROOM_TTL_MS) rooms.rooms.delete(rid);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${storeFile}.tmp`;
  // Undo history is large and only useful while a game is live, so it isn't saved.
  fs.writeFileSync(tmp, JSON.stringify([...rooms.rooms.values()], (k, v) => (k === 'history' ? [] : v)));
  fs.renameSync(tmp, storeFile);
}
load();
setInterval(save, 5000);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { rooms.dirty.add('x'); save(); process.exit(0); });

// ------------------------------------------------------------ snapshots (server/src/snapshot.ts)
const roomSecret = loadRoomSecret(DATA_DIR);
if (roomSecret.source !== 'env') console.warn('ROOM_SECRET is not set: room snapshots stop working when this server loses DATA_DIR. Set ROOM_SECRET to a long random string.');
const codec = new SnapshotCodec(roomSecret.secret);
const restorer = new Restorer(rooms, codec);
/** Rooms whose members need a fresh snapshot (sent at most every SNAPSHOT_MS per room). */
const snapPending = new Set<string>();
const SNAPSHOT_MS = Number(process.env.SNAPSHOT_MS ?? 2000);

// ------------------------------------------------------------ http
const app = express();
// A member's browser re-creates a room the server lost (restart / spin-down) from its snapshot. Before the 1mb JSON limit.
app.post('/api/rooms/restore', express.json({ limit: '25mb' }), (req, res) => {
  const r = restorer.restore(req.body?.blob, req.body?.token);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  if (r.restored) console.log(`Restored room ${r.roomId} from a member's snapshot`);
  bots.kick(r.roomId);
  broadcast(r.roomId);
  res.json({ roomId: r.roomId, restored: r.restored });
});
app.use(express.json({ limit: '1mb' }));

app.post('/api/rooms', (req, res) => {
  const { name, roomName } = req.body ?? {};
  res.json(rooms.create(String(roomName ?? ''), String(name ?? '')));
});
app.post('/api/rooms/:id/join', (req, res) => {
  const rec = rooms.find(req.params.id);
  const r = rec && rooms.join(rec.state.id, String(req.body?.name ?? ''));
  if (!rec || !r) return res.status(404).json({ error: 'Room not found' });
  broadcast(rec.state.id);
  res.json({ ...r, roomId: rec.state.id });
});
app.get('/api/rooms/:id', (req, res) => {
  const rec = rooms.find(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Room not found' });
  const host = rec.state.players.find((p) => p.id === rec.state.hostId);
  res.json({ id: rec.state.id, name: rec.state.name, phase: rec.state.phase, host: host?.name ?? null, players: rec.state.players.map((p) => p.name) });
});
app.get('/healthz', (_req, res) => res.send('ok'));
registerCardDbRoutes(app);

if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST, { maxAge: '1h', index: false }));
  app.get('*', (_req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));
}

const server = http.createServer(app);
// Computer opponents: play the bot seats of matches (server/src/botdriver.ts).
const bots = new BotDriver(rooms, { onChange: (rid) => broadcast(rid) });
const io = new Server(server, { cors: { origin: true }, pingInterval: 10000, pingTimeout: 20000 });

// socket id -> {roomId, pid}
// `sent`: card ids whose data this socket already has (see roomcards.ts cardPayload).
const sockets = new Map<string, { roomId: string; pid: string; socket: Socket; sent: Set<string> }>();

function broadcast(roomId: string) {
  const rec = rooms.rooms.get(roomId);
  if (!rec) return;
  snapPending.add(roomId);
  for (const { roomId: r, pid, socket, sent } of sockets.values()) {
    if (r !== roomId) continue;
    const view = rooms.view(rec, pid);
    try {
      const cards = rooms.cardsFor(rec, view, sent);
      if (cards) socket.emit('cards', cards);
    } catch (e) {
      console.error('card payload failed', e);
    }
    socket.emit('room', view);
  }
}

function setConnected(roomId: string, pid: string) {
  const rec = rooms.rooms.get(roomId);
  if (!rec) return;
  const online = new Set([...sockets.values()].filter((s) => s.roomId === roomId).map((s) => s.pid));
  for (const p of rec.state.players) if (!p.isBot) p.connected = online.has(p.id);
  void pid;
}

io.on('connection', (socket) => {
  const { roomId, token } = socket.handshake.auth as { roomId?: string; token?: string };
  const auth = roomId && token ? rooms.auth(roomId, token) : null;
  if (!auth) {
    // 'missing': the server doesn't know the room (it restarted): the client restores it from its snapshot or waits for a member who can.
    if (roomId && !rooms.find(roomId)) socket.emit('missing', roomId);
    else socket.emit('fatal', 'Room not found or your seat expired — rejoin from the home page.');
    socket.disconnect(true);
    return;
  }
  const rid = auth.rec.state.id;
  sockets.set(socket.id, { roomId: rid, pid: auth.pid, socket, sent: new Set() });
  setConnected(rid, auth.pid);
  broadcast(rid);

  socket.on('msg', (msg: ClientMsg, ack?: (r: { error: string | null }) => void) => {
    let error: string | null;
    try {
      // A spectator who takes over an away seat changes who this token speaks for.
      const entry = sockets.get(socket.id);
      const pid = auth.rec.tokens[token!] ?? auth.pid;
      if (entry) entry.pid = pid;
      error = rooms.handle(auth.rec, pid, msg);
      if (entry) entry.pid = auth.rec.tokens[token!] ?? pid;
    } catch (e) {
      console.error(e);
      error = 'Server error: ' + (e as Error).message;
    }
    if (typeof ack === 'function') ack({ error });
    if (!error) { broadcast(rid); bots.kick(rid); }
  });

  socket.on('disconnect', () => {
    sockets.delete(socket.id);
    setConnected(rid, auth.pid);
    broadcast(rid);
  });
});

setInterval(() => {
  for (const rid of snapPending) {
    const rec = rooms.rooms.get(rid);
    if (!rec) continue;
    const members = [...sockets.values()].filter((x) => x.roomId === rid);
    if (members.length) {
      const snap = { roomId: rid, v: rec.state.updatedAt, takenAt: Date.now(), blob: codec.seal(rec) };
      for (const m of members) m.socket.emit('snapshot', snap);
    }
  }
  snapPending.clear();
}, SNAPSHOT_MS);

setInterval(() => {
  for (const rid of rooms.tick(Date.now())) broadcast(rid);
  bots.kickAll();
}, 250);

server.listen(PORT, () => console.log(`OJB Cube server on http://localhost:${PORT}`));
