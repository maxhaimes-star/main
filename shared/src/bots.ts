/**
 * Draft bots: pick by power, settle into two colours after the first few picks, keep the curve and
 * creature count in shape, and build a sensible 40-card deck from the pool. Everything here is
 * deterministic; the only randomness is the injected rng (a small tie-break noise on picks).
 */
import { type CardData, type Color, parseManaSymbols, COLORS } from './cards.ts';
import type { Deck } from './room.ts';
import type { CardLookup, Rng } from './draft.ts';
import { emptyDeck, multisetDiff } from './deckutil.ts';
import { cardPower, isMustPick, mustPickPriority } from './power.ts';

const isLand = (c: CardData) => c.types.includes('Land');
const isCreature = (c: CardData) => c.types.includes('Creature');

/** Ideal number of spells per mana-value bucket (1-, 2, 3, 4, 5, 6+) in a 23-spell deck. */
const CURVE_IDEAL = [0, 3, 5, 5, 4, 3, 2];
const CREATURE_TARGET = 14;
const curveBucket = (c: CardData) => Math.max(1, Math.min(6, Math.floor(c.cmc)));

/** Colors a bot leans toward given its picks so far (power-weighted; gold cards split their weight). */
export function colorWeights(picks: string[], lookup: CardLookup): Record<Color, number> {
  const w: Record<Color, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const id of picks) {
    const c = lookup(id);
    if (!c || isLand(c)) continue;
    const weight = 0.2 + cardPower(c);
    for (const col of c.colors) w[col] += weight / c.colors.length;
  }
  return w;
}

/** The two strongest colours (ties broken in WUBRG order, so the result is deterministic). */
export function topColors(w: Record<Color, number>, n = 2): Color[] {
  return COLORS.map((c, i) => ({ c, v: w[c], i })).sort((a, b) => b.v - a.v || a.i - b.i).slice(0, n).map((x) => x.c);
}

/** How settled a drafter with `picks` picks is in its colours: 0 for the first few picks, rising to 1 by about pick 11. */
export function commitment(picks: number): number {
  return Math.max(0, Math.min(1, (picks - 3) / 8));
}

export interface PickProfile {
  picks: number;
  weights: Record<Color, number>;
  /** The colours the bot is drafting (empty before it has any coloured picks). */
  top: Color[];
  commit: number;
  /** Creatures and spells per curve bucket among the picks that fit the colours. */
  creatures: number;
  buckets: number[];
}

export function pickProfile(picks: string[], lookup: CardLookup): PickProfile {
  const weights = colorWeights(picks, lookup);
  const top = Object.values(weights).some((v) => v > 0) ? topColors(weights) : [];
  const prof: PickProfile = { picks: picks.length, weights, top, commit: commitment(picks.length), creatures: 0, buckets: Array(7).fill(0) };
  for (const id of picks) {
    const c = lookup(id);
    if (!c || isLand(c) || !c.colors.every((x) => top.includes(x))) continue;
    if (isCreature(c)) prof.creatures++;
    prof.buckets[curveBucket(c)]++;
  }
  return prof;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** How much the bot wants `card` given its profile; roughly 0.05 (junk) .. 2.2 (on-colour bomb). */
export function scoreCard(card: CardData, prof: PickProfile): number {
  let score = 0.3 + 1.5 * cardPower(card);
  const { commit, top, weights } = prof;
  if (isLand(card)) {
    // Only fixing for our colours is worth a pick; basics never are.
    if (card.supertypes.includes('Basic')) return 0.05;
    const makes = card.producedMana.filter((m): m is Color => (COLORS as string[]).includes(m));
    const fits = makes.length >= 2 && makes.every((m) => top.includes(m));
    return Math.max(0.05, score - 0.5 + (fits ? 0.5 * commit : -0.3 * commit));
  }
  // Colour commitment: a soft lean at first, firm after about eleven picks.
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  if (card.colors.length === 0) {
    score += 0.2;
  } else {
    const onColor = card.colors.filter((c) => top.includes(c)).length;
    const share = total > 0 ? card.colors.reduce((a, c) => a + weights[c], 0) / total / card.colors.length : 0;
    score += 0.35 * share * (1 - commit);
    if (onColor === card.colors.length) score += 0.55 * commit;
    else if (onColor > 0) score -= 0.5 * commit;
    else score -= 0.9 * commit;
  }
  // Curve and creature count, once there is something to balance.
  if (prof.picks >= 5) {
    const progress = Math.min(1, prof.picks / 36);
    const fits = card.colors.every((c) => top.includes(c));
    if (fits) {
      if (isCreature(card)) score += clamp(CREATURE_TARGET * progress - prof.creatures, -3, 3) * 0.06;
      const b = curveBucket(card);
      score += clamp(CURVE_IDEAL[b] * progress - prof.buckets[b], -2, 2) * 0.05;
      if (b >= 5 && prof.buckets[5] + prof.buckets[6] >= CURVE_IDEAL[5] + CURVE_IDEAL[6]) score -= 0.25;
    }
  }
  return Math.max(0.05, score);
}

export function cardScore(card: CardData, picks: string[], lookup: CardLookup): number {
  return scoreCard(card, pickProfile(picks, lookup));
}

// ===================================================================== signals and synergy

/**
 * Colour signals: strong cards still in a pack that reaches us late mean their colour is flowing from upstream.
 * `left` = cards in the pack now, `size` = the pack's full size. A first pick (a fresh pack) says nothing.
 */
export function noteSignals(signals: Record<Color, number>, pack: string[], left: number, size: number, lookup: CardLookup) {
  const lateness = size > 0 ? Math.max(0, 1 - left / size) : 0;
  if (lateness <= 0) return;
  for (const id of pack) {
    const c = lookup(id);
    if (!c || isLand(c) || !c.colors.length) continue;
    const strength = Math.max(0, cardPower(c) - 0.4);
    for (const col of c.colors) signals[col] += (strength * (0.5 + lateness)) / c.colors.length;
  }
}

/** How much `card` gains from the picks so far (tribes, spells-matter, artifacts); 0 .. ~0.35. */
export function synergy(card: CardData, picks: string[], lookup: CardLookup): number {
  const pool = picks.map(lookup).filter(Boolean) as CardData[];
  if (!pool.length) return 0;
  let s = 0;
  // Tribes: creature types shared with the pool (only types that matter: more than a couple).
  if (isCreature(card)) {
    const types = new Set(card.subtypes);
    const mates = pool.filter((c) => isCreature(c) && c.subtypes.some((t) => types.has(t))).length;
    const tribal = pool.some((c) => card.subtypes.some((t) => new RegExp(`\\b${t}s?\\b`).test(c.oracle)));
    s += Math.min(0.2, mates * (tribal ? 0.05 : 0.02));
    if (card.subtypes.some((t) => pool.some((c) => new RegExp(`\\b${t}s?\\b`).test(c.oracle)))) s += 0.1;
  }
  const spell = (c: CardData) => c.types.includes('Instant') || c.types.includes('Sorcery');
  const spellsMatter = (c: CardData) => /instant (and|or) sorcery|noncreature spell/i.test(c.oracle);
  const artifactsMatter = (c: CardData) => /\bartifacts?\b/i.test(c.oracle) && !c.types.includes('Artifact');
  // Payoffs and enablers find each other.
  if (spell(card)) s += Math.min(0.2, pool.filter(spellsMatter).length * 0.07);
  if (spellsMatter(card)) s += Math.min(0.2, pool.filter(spell).length * 0.02);
  if (card.types.includes('Artifact')) s += Math.min(0.15, pool.filter(artifactsMatter).length * 0.05);
  if (artifactsMatter(card)) s += Math.min(0.15, pool.filter((c) => c.types.includes('Artifact')).length * 0.02);
  return Math.min(0.35, s);
}

export function botPick(pack: string[], picks: string[], lookup: CardLookup, rng: Rng, signals?: Record<Color, number>): string {
  // Never pass a super busted card, whatever its colours: take the best of them.
  const busted = pack.map((id) => ({ id, c: lookup(id) })).filter((x) => x.c && isMustPick(x.c));
  if (busted.length) return busted.sort((a, b) => mustPickPriority(a.c!) - mustPickPriority(b.c!))[0].id;
  const prof = pickProfile(picks, lookup);
  let best = pack[0];
  let bestScore = -Infinity;
  const sigTotal = signals ? COLORS.reduce((a, c) => a + signals[c], 0) : 0;
  for (const id of pack) {
    const c = lookup(id);
    let s = (c ? scoreCard(c, prof) : 0) + rng() * 0.12;
    if (c && !isLand(c)) {
      // Read the signals while still choosing colours: lean toward what's flowing.
      if (sigTotal > 0 && c.colors.length) s += 0.3 * (1 - 0.6 * prof.commit) * (c.colors.reduce((a, col) => a + signals![col], 0) / c.colors.length / sigTotal);
      s += synergy(c, picks, lookup);
    }
    if (s > bestScore) { bestScore = s; best = id; }
  }
  return best;
}

// ===================================================================== deckbuilding

const PAIRS: Color[][] = COLORS.flatMap((a, i) => COLORS.slice(i + 1).map((b) => [a, b]));

/** Greedily choose `n` spells by power, steering toward ~14 creatures and a healthy curve. */
function chooseSpells(eligible: CardData[], n: number): CardData[] {
  const left = eligible.slice().sort((a, b) => cardPower(b) - cardPower(a) || a.cmc - b.cmc || a.id.localeCompare(b.id));
  const chosen: CardData[] = [];
  const buckets = Array(7).fill(0);
  let creatures = 0;
  while (chosen.length < n && left.length) {
    const slots = n - chosen.length;
    const urgency = Math.max(0, CREATURE_TARGET - creatures) / slots;
    let bestIdx = 0;
    let bestScore = -Infinity;
    left.forEach((c, i) => {
      const b = curveBucket(c);
      let s = cardPower(c);
      if (isCreature(c)) s += 0.3 * Math.min(1, urgency * 1.2);
      else if (urgency >= 1) s -= 0.3;
      s += 0.06 * clamp(CURVE_IDEAL[b] - buckets[b], -3, 3);
      if (b >= 6 && buckets[6] >= CURVE_IDEAL[6]) s -= 0.5;
      if (s > bestScore) { bestScore = s; bestIdx = i; }
    });
    const [pick] = left.splice(bestIdx, 1);
    chosen.push(pick);
    buckets[curveBucket(pick)]++;
    if (isCreature(pick)) creatures++;
  }
  return chosen;
}

/** How good the best 23-card build in this colour pair would be (sum of power, minus holes). */
function pairValue(spells: CardData[], pair: Color[]): number {
  const eligible = spells.filter((c) => c.colors.every((x) => pair.includes(x)));
  const top = eligible.map(cardPower).sort((a, b) => b - a).slice(0, 23);
  const creatures = Math.min(CREATURE_TARGET, eligible.filter(isCreature).length);
  return top.reduce((a, b) => a + b, 0) - 0.5 * Math.max(0, 23 - top.length) - 0.12 * (CREATURE_TARGET - creatures);
}

/** Split `total` basics across colours in proportion to coloured mana symbols (every used colour gets at least a few). */
export function splitBasics(spells: CardData[], total: number, fallback: Color[]): Record<Color, number> {
  const pips: Record<Color, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const c of spells) for (const sym of parseManaSymbols(c.manaCost)) for (const col of COLORS) if (sym.includes(col)) pips[col]++;
  const out: Record<Color, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  if (total <= 0) return out;
  const used = COLORS.filter((c) => pips[c] > 0);
  const colors = used.length ? used : fallback.slice(0, 1);
  const sum = colors.reduce((a, c) => a + (pips[c] || 1), 0);
  const raw = colors.map((c) => ({ c, v: ((pips[c] || 1) / sum) * total }));
  let given = 0;
  for (const r of raw) { out[r.c] = Math.floor(r.v); given += out[r.c]; }
  raw.sort((a, b) => (b.v % 1) - (a.v % 1) || COLORS.indexOf(a.c) - COLORS.indexOf(b.c));
  for (let i = 0; given < total; i++, given++) out[raw[i % raw.length].c]++;
  // A colour that is actually played should have a few sources.
  for (const c of colors) {
    while (out[c] < Math.min(3, total) && colors.some((o) => o !== c && out[o] > 3)) {
      const donor = colors.filter((o) => o !== c).sort((a, b) => out[b] - out[a])[0];
      out[donor]--; out[c]++;
    }
  }
  return out;
}

/** Bot deckbuilding: the best two colours, ~23 spells with a sane curve and creature count, fixing lands, and basics for the rest. */
export function botDeck(pool: string[], lookup: CardLookup): Deck {
  const cards = pool.map((id) => lookup(id)).filter(Boolean) as CardData[];
  const spells = cards.filter((c) => !isLand(c));
  let pair = PAIRS[0];
  let bestValue = -Infinity;
  for (const p of PAIRS) {
    const v = pairValue(spells, p);
    if (v > bestValue) { bestValue = v; pair = p; }
  }
  const inPair = (c: CardData) => c.colors.every((x) => pair.includes(x));
  // Non-basic lands that make our colours (and colourless) and nothing else.
  const fixing = cards
    .filter((c) => isLand(c) && !c.supertypes.includes('Basic') && c.producedMana.some((m) => pair.includes(m as Color)) && c.producedMana.every((m) => pair.includes(m as Color) || m === 'C'))
    .sort((a, b) => cardPower(b) - cardPower(a) || a.id.localeCompare(b.id))
    .slice(0, 3);
  const eligible = spells.filter(inPair);
  // Spell slots depend on how low the curve of the best spells runs: aggro decks get 16 lands.
  const preview = chooseSpells(eligible, 23);
  const avg = preview.length ? preview.reduce((a, c) => a + c.cmc, 0) / preview.length : 3;
  const landCount = avg < 2.4 ? 16 : avg > 3.6 ? 18 : 17;
  const slots = 40 - landCount;
  let chosen = chooseSpells(eligible, slots);
  if (chosen.length < slots) {
    // Thin colours: top up with the best off-colour cards rather than playing too few spells.
    const used = new Set(chosen);
    const extra = spells.filter((c) => !used.has(c)).sort((a, b) => cardPower(b) - cardPower(a) || a.id.localeCompare(b.id)).slice(0, slots - chosen.length);
    chosen = [...chosen, ...extra];
  }
  const nonbasic = fixing.slice(0, Math.max(0, landCount - 8));
  const main = [...chosen, ...nonbasic].map((c) => c.id);
  const deck = emptyDeck();
  deck.main = main;
  deck.side = multisetDiff(pool, main);
  deck.basics = splitBasics(chosen, Math.max(0, 40 - main.length), pair);
  deck.ready = true;
  return deck;
}
