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
  app.post('/api/decks/validate', guard((req) => {
    const { format, text } = (req.body ?? {}) as { format?: string; text?: string };
    if (!text) throw new Error('Missing deck text');
    const deck = resolveDeck(String(text));
    const errors = format ? formatLegality(deck.entries, String(format)) : [];
    return { ok: !deck.errors.length && !errors.length, format: format ?? null, deck, errors: [...deck.errors, ...errors] };
  }));
}
