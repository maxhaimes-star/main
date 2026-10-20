/** HTTP endpoints for the full card database (see carddb.ts). All respond 503 when it isn't built. */
import type { Express, Request, Response } from 'express';
import {
  boosterFor, carddbAvailable, carddbMeta, cardsByIds, formatLegality, formatList, getSet, resolveDeck,
  searchCards, setList,
} from './carddb.ts';

function guard(fn: (req: Request, res: Response) => unknown) {
  return (req: Request, res: Response) => {
    if (!carddbAvailable()) return res.status(503).json({ error: 'Card database not available on this server (only the built-in cube).' });
    try {
      const out = fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  };
}

export function registerCardDbRoutes(app: Express) {
  app.get('/api/carddb', guard(() => carddbMeta()));
  app.get('/api/sets', guard(() => setList()));
  app.get('/api/sets/:code', guard((req, res) => {
    const set = getSet(String(req.params.code));
    if (!set) return res.status(404).json({ error: 'Unknown set' });
    return { ...set, sheets: undefined };
  }));
  app.get('/api/sets/:code/booster', guard((req) => boosterFor(String(req.params.code))));
  app.get('/api/formats', guard(() => formatList().map(({ banned, restricted, additional, ...f }) => ({
    ...f, banned, restricted, ...(additional.length ? { additional } : {}),
  }))));
  app.get('/api/cards/search', guard((req) => {
    const q = String(req.query.q ?? '');
    const num = (k: string) => (req.query[k] !== undefined ? Number(req.query[k]) : undefined);
    return searchCards(q, {
      limit: num('limit'), offset: num('offset'),
      ...(req.query.format ? { format: String(req.query.format) } : {}),
      ...(req.query.set ? { set: String(req.query.set) } : {}),
    });
  }));
  app.get('/api/cards', guard((req) => {
    const ids = String(req.query.ids ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 1000);
    return cardsByIds(ids);
  }));
  // CubeCobra list proxy (browsers can't fetch it cross-origin). Plain text, one card per line.
  app.get('/api/cubecobra/:id', async (req, res) => {
    const id = String(req.params.id ?? '');
    if (!/^[\w-]{1,64}$/.test(id)) return res.status(400).json({ error: 'Bad cube id' });
    try {
      const r = await fetch(`https://cubecobra.com/cube/api/cubelist/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10000) });
      const text = r.ok ? (await r.text()).slice(0, 200_000) : '';
      if (!text.trim() || /<html/i.test(text)) return res.status(404).json({ error: 'CubeCobra cube not found' });
      res.json({ text });
    } catch {
      res.status(502).json({ error: 'Could not reach CubeCobra' });
    }
  });
  app.post('/api/decks/validate', guard((req) => {
    const { format, text } = (req.body ?? {}) as { format?: string; text?: string };
    if (!text) throw new Error('Missing deck text');
    const deck = resolveDeck(String(text));
    const errors = format ? formatLegality(deck.entries, String(format)) : [];
    return { ok: !deck.errors.length && !errors.length, format: format ?? null, deck, errors: [...deck.errors, ...errors] };
  }));
}
