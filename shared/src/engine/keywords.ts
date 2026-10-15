/**
 * Keyword-granted activated abilities (Forge K: lines) expressed as synthesized Forge "AB$" lines, so the
 * normal engine (targets, costs, resolution) runs them. Pure: depends only on the script data passed in.
 *
 * Index scheme (see SYNTH_BASE in types.ts): SYNTH_BASE + 10 * keywordIndex + variant.
 *
 *   Equip:<cost>[:<valid>:<desc>]  -> AB$ Attach (sorcery speed) targeting a creature (or <valid>) you control
 *   Reconfigure:<cost>             -> variant 0: attach like Equip; variant 1: AB$ Unattach
 *   Cycling:<cost>                 -> AB$ Draw from hand, cost + Discard<1/CARDNAME>
 *   TypeCycling:<Type>:<cost>      -> AB$ ChangeZone library -> hand (search), from hand, cost + discard
 *   Level up:<cost>                -> AB$ PutCounter LEVEL on itself (sorcery speed)
 *   Crew:<N>                       -> AB$ Crew (tap creatures with total power N; runtime asks which)
 *   Ninjutsu:<cost>[:Commander]    -> AB$ Ninjutsu from hand; the "target" is the unblocked attacker returned as a cost
 *
 * Runtime behaviour (activation checks, Crew / Ninjutsu, Ward reminders, custom APIs) is in keyword-play.ts.
 */
import { type ForgeFace, SYNTH_BASE } from './types.ts';

/** Effect APIs that only synthesized keyword abilities use (executed by keyword-play.ts). */
export const KEYWORD_APIS = new Set(['Unattach', 'Crew', 'Ninjutsu']);

export interface SynthAbility {
  index: number;
  /** Forge K: keyword name, e.g. "Equip", "Cycling". */
  keyword: string;
  line: string;
}

/** "1 R" -> "{1}{R}"; non-mana costs are kept as-is. */
export function costText(cost: string): string {
  const parts = cost.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '{0}';
  if (parts.every((p) => /^(\d+|[WUBRGCX]|[WUBRG2]\/[WUBRGP])$/.test(p))) return parts.map((p) => `{${p}}`).join('');
  return cost;
}

function article(word: string): string {
  return /^[AEIOU]/i.test(word) ? `an ${word}` : `a ${word}`;
}

/** Synthesized abilities for one face, in keyword order. */
export function synthAbilities(f: ForgeFace): SynthAbility[] {
  const out: SynthAbility[] = [];
  f.keywords.forEach((k, ki) => {
    const parts = k.split(':');
    const name = parts[0].trim();
    const base = SYNTH_BASE + 10 * ki;
    const add = (variant: number, line: string) => out.push({ index: base + variant, keyword: name, line });
    switch (name) {
      case 'Equip': {
        const cost = (parts[1] ?? '0').trim() || '0';
        const valid = parts[2]?.trim() || 'Creature.YouCtrl';
        const desc = parts[3]?.trim() || 'creature';
        add(0, `AB$ Attach | Cost$ ${cost} | ValidTgts$ ${valid}+Other | TgtPrompt$ Select target ${desc} you control | SorcerySpeed$ True | Keyword$ Equip | SpellDescription$ Equip ${desc === 'creature' ? '' : `${desc} `}${costText(cost)} (Attach to target ${desc} you control. Equip only as a sorcery.)`);
        break;
      }
      case 'Reconfigure': {
        const cost = (parts[1] ?? '0').trim() || '0';
        add(0, `AB$ Attach | Cost$ ${cost} | ValidTgts$ Creature.YouCtrl+Other | TgtPrompt$ Select target creature you control | SorcerySpeed$ True | Keyword$ Reconfigure | SpellDescription$ Reconfigure ${costText(cost)}: attach to target creature you control (it stops being a creature while attached).`);
        add(1, `AB$ Unattach | Cost$ ${cost} | Defined$ Self | SorcerySpeed$ True | Keyword$ Reconfigure | SpellDescription$ Reconfigure ${costText(cost)}: unattach CARDNAME (it becomes a creature again).`);
        break;
      }
      case 'Cycling': {
        const cost = (parts[1] ?? '0').trim() || '0';
        add(0, `AB$ Draw | Cost$ ${cost} Discard<1/CARDNAME> | ActivationZone$ Hand | Defined$ You | NumCards$ 1 | Keyword$ Cycling | SpellDescription$ Cycling ${costText(cost)} (Discard this card: Draw a card.)`);
        break;
      }
      case 'TypeCycling': {
        const type = (parts[1] ?? 'Card').trim();
        const cost = (parts[2] ?? '0').trim() || '0';
        add(0, `AB$ ChangeZone | Cost$ ${cost} Discard<1/CARDNAME> | ActivationZone$ Hand | Origin$ Library | Destination$ Hand | ChangeType$ ${type} | ChangeNum$ 1 | Keyword$ TypeCycling | SpellDescription$ ${type}cycling ${costText(cost)} (Search your library for ${article(type)} card, reveal it, put it into your hand, then shuffle.)`);
        break;
      }
      case 'Level up': {
        const cost = (parts[1] ?? '0').trim() || '0';
        add(0, `AB$ PutCounter | Cost$ ${cost} | Defined$ Self | CounterType$ LEVEL | CounterNum$ 1 | SorcerySpeed$ True | Keyword$ Level up | SpellDescription$ Level up ${costText(cost)} (Put a level counter on this. Level up only as a sorcery.)`);
        break;
      }
      case 'Crew': {
        const n = parseInt(parts[1] ?? '1', 10) || 1;
        add(0, `AB$ Crew | CrewPower$ ${n} | Defined$ Self | Keyword$ Crew | SpellDescription$ Crew ${n} (Tap any number of untapped creatures you control with total power ${n} or more: CARDNAME becomes an artifact creature until end of turn.)`);
        break;
      }
      case 'Chapter': {
        // Saga chapters that give the Saga activated abilities (Urza's Saga): available from that chapter on
        // (ChapterLore$, checked in turns.ts). Mana abilities come from turns.ts chapterManaLines.
        let v = 0;
        (parts[2] ?? '').split(',').map((s) => s.trim()).forEach((svar, ch) => {
          const m = /^\s*DB\$\s*Animate\b.*\|\s*Abilities\$\s*([^|]+)/.exec(f.svars[svar] ?? '');
          if (!m) return;
          for (const name of m[1].split(',').map((s) => s.trim())) {
            const line = f.svars[name];
            if (!line || !/^\s*AB\$/.test(line) || /^\s*AB\$\s*Mana\b/.test(line) || v > 9) continue;
            add(v++, `${line} | ChapterLore$ ${ch + 1}`);
          }
        });
        break;
      }
      case 'Ninjutsu': {
        const cost = (parts[1] ?? '0').trim() || '0';
        add(0, `AB$ Ninjutsu | Cost$ ${cost} | ActivationZone$ Hand | ValidTgts$ Creature.attacking+YouCtrl | TgtPrompt$ Select an unblocked attacking creature you control to return to its owner's hand | TargetsAreCost$ True | Keyword$ Ninjutsu | SpellDescription$ Ninjutsu ${costText(cost)} (Return an unblocked attacker you control to hand: put CARDNAME onto the battlefield from your hand tapped and attacking.)`);
        break;
      }
    }
  });
  return out;
}

/** The synthesized line for an ability index (>= SYNTH_BASE), or undefined. */
export function synthLine(f: ForgeFace, index: number): string | undefined {
  return synthAbilities(f).find((s) => s.index === index)?.line;
}

/** Ward cost from a face's keywords ("Ward:2" -> "{2}"), or undefined. */
export function wardCost(f: ForgeFace): string | undefined {
  const k = f.keywords.find((x) => /^Ward:/.test(x));
  return k ? costText(k.slice(5)) : undefined;
}

// ------------------------------------------------------------------ level up

export interface LevelStats { power?: number; toughness?: number; keywords: string[]; description?: string }

/**
 * What a leveler is at a given level, from its S: lines ("IsPresent$ Card.Self+counters_GE2_LEVEL+counters_LE6_LEVEL").
 * Returns undefined below the first level band.
 * The static-effects layer (statics.ts) applies these S: lines in effectivePT / hasKeyword (with `state`)
 * via the generic counters_GE<n>_LEVEL property; this helper is for display / tests.
 */
export function levelStats(f: ForgeFace, level: number): LevelStats | undefined {
  let found: LevelStats | undefined;
  for (const line of f.statics) {
    const pres = /IsPresent\$\s*Card\.Self\+([^|]*)/.exec(line);
    if (!pres || !/AffectedDefined\$\s*Self/.test(line) || !/_LEVEL/.test(pres[1])) continue;
    let ok = true;
    for (const m of pres[1].matchAll(/counters_(GE|LE|LT|GT|EQ)(\d+)_LEVEL/g)) {
      const n = parseInt(m[2], 10);
      if (m[1] === 'GE' && !(level >= n)) ok = false;
      if (m[1] === 'GT' && !(level > n)) ok = false;
      if (m[1] === 'LE' && !(level <= n)) ok = false;
      if (m[1] === 'LT' && !(level < n)) ok = false;
      if (m[1] === 'EQ' && level !== n) ok = false;
    }
    if (!ok) continue;
    const p = /SetPower\$\s*(-?\d+)/.exec(line);
    const t = /SetToughness\$\s*(-?\d+)/.exec(line);
    const kw = /AddKeyword\$\s*([^|]+)/.exec(line);
    const desc = /Description\$\s*([^|]+)/.exec(line);
    found = {
      power: p ? parseInt(p[1], 10) : found?.power,
      toughness: t ? parseInt(t[1], 10) : found?.toughness,
      keywords: [...(found?.keywords ?? []), ...(kw ? kw[1].split('&').map((x) => x.trim()) : [])],
      description: desc?.[1].trim() ?? found?.description,
    };
  }
  return found;
}
