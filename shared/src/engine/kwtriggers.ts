/**
 * Triggered keywords (Forge K: lines that stand for a triggered ability), synthesized as trigger lines the way
 * Prowess is (engine/triggers.ts): Annihilator, Exalted, Persist, Living Weapon, Fading, Vanishing, Cumulative upkeep,
 * Cascade, Storm, Ravenous (the draw), Backup. Their effects that aren't plain Forge APIs are internal steps of
 * engine/more.ts ('_Fading', '_CumUpkeep', '_Cascade', '_Storm', '_LivingWeapon', '_Ravenous', '_Backup').
 * Pure (no game-state imports).
 */

export interface KeywordTrigger {
  /** The keyword (for once-per-event keys and descriptions). */
  kw: string;
  /** Trigger params (Mode$ ...), matched like a T: line. */
  params: Record<string, string>;
  /** The effect, a single ability line. */
  line: string;
}

const upkeep = { Mode: 'Phase', Phase: 'Upkeep', ValidPlayer: 'You', TriggerZones: 'Battlefield' };
const etb = { Mode: 'ChangesZone', Origin: 'Any', Destination: 'Battlefield', ValidCard: 'Card.Self' };
const castSelf = { Mode: 'SpellCast', ValidCard: 'Card.Self' };

/** The synthesized triggers for a face's K: lines. */
export function keywordTriggers(keywords: readonly string[]): KeywordTrigger[] {
  const out: KeywordTrigger[] = [];
  for (const k of keywords) {
    const parts = k.split(':');
    const head = parts[0].trim();
    const arg = parts[1]?.trim() ?? '';
    switch (head) {
      case 'Annihilator': {
        const n = parseInt(arg, 10) || 1;
        out.push({ kw: head, params: { Mode: 'Attacks', ValidCard: 'Card.Self', TriggerZones: 'Battlefield', TriggerDescription: `Annihilator ${n} — defending player sacrifices ${n} permanent${n === 1 ? '' : 's'}.` },
          line: `DB$ Sacrifice | Defined$ TriggeredDefendingPlayer | SacValid$ Permanent | Amount$ ${n} | SpellDescription$ Annihilator ${n}.` });
        break;
      }
      case 'Exalted':
        out.push({ kw: head, params: { Mode: 'Attacks', ValidCard: 'Creature.YouCtrl', Alone: 'True', TriggerZones: 'Battlefield', TriggerDescription: 'Exalted — the creature attacking alone gets +1/+1 until end of turn.' },
          line: 'DB$ Pump | Defined$ TriggeredCard | NumAtt$ +1 | NumDef$ +1 | SpellDescription$ Exalted.' });
        break;
      case 'Persist':
        out.push({ kw: head, params: { Mode: 'ChangesZone', Origin: 'Battlefield', Destination: 'Graveyard', ValidCard: 'Card.Self+counters_EQ0_M1M1', TriggerZones: 'Battlefield', TriggerDescription: 'Persist — return it with a -1/-1 counter.' },
          line: 'DB$ ChangeZone | Defined$ TriggeredNewCardLKICopy | Origin$ Graveyard | Destination$ Battlefield | WithCountersType$ M1M1 | SpellDescription$ Persist.' });
        break;
      case 'Undying':
        out.push({ kw: head, params: { Mode: 'ChangesZone', Origin: 'Battlefield', Destination: 'Graveyard', ValidCard: 'Card.Self+counters_EQ0_P1P1', TriggerZones: 'Battlefield', TriggerDescription: 'Undying — return it with a +1/+1 counter.' },
          line: 'DB$ ChangeZone | Defined$ TriggeredNewCardLKICopy | Origin$ Graveyard | Destination$ Battlefield | WithCountersType$ P1P1 | SpellDescription$ Undying.' });
        break;
      case 'Living Weapon':
        out.push({ kw: head, params: { ...etb, TriggerDescription: 'Living weapon — create a 0/0 black Phyrexian Germ creature token, then attach this to it.' },
          line: 'DB$ _LivingWeapon | SpellDescription$ Living weapon.' });
        break;
      case 'Fading':
        out.push({ kw: head, params: { ...upkeep, TriggerDescription: "Fading — remove a fade counter from it. If you can't, sacrifice it." }, line: 'DB$ _Fading | CounterType$ FADE | SpellDescription$ Fading.' });
        break;
      case 'Vanishing':
        out.push({ kw: head, params: { ...upkeep, TriggerDescription: 'Vanishing — remove a time counter from it. When the last is removed, sacrifice it.' }, line: 'DB$ _Fading | CounterType$ TIME | Vanishing$ True | SpellDescription$ Vanishing.' });
        break;
      case 'Cumulative upkeep':
        out.push({ kw: head, params: { ...upkeep, TriggerDescription: `Cumulative upkeep — put an age counter on it, then sacrifice it unless you pay its upkeep cost for each age counter.` },
          line: `DB$ _CumUpkeep | UpkeepCost$ ${arg} | SpellDescription$ Cumulative upkeep.` });
        break;
      case 'Cascade':
        out.push({ kw: head, params: { ...castSelf, TriggerDescription: 'Cascade — exile cards from the top of your library until you exile a nonland card with lesser mana value. You may cast it without paying its mana cost.' },
          line: 'DB$ _Cascade | SpellDescription$ Cascade.' });
        break;
      case 'Storm':
        out.push({ kw: head, params: { ...castSelf, TriggerDescription: 'Storm — copy this spell for each spell cast before it this turn.' }, line: 'DB$ _Storm | SpellDescription$ Storm.' });
        break;
      case 'Ravenous':
        out.push({ kw: head, params: { ...etb, TriggerDescription: 'Ravenous — if X is 5 or more, draw a card.' }, line: 'DB$ _Ravenous | SpellDescription$ Ravenous.' });
        break;
      case 'Replicate':
        out.push({ kw: head, params: { ...castSelf, TriggerDescription: 'Replicate — copy this spell for each time its replicate cost was paid.' }, line: 'DB$ _Replicate | SpellDescription$ Replicate.' });
        break;
      case 'MayFlashSac':
        out.push({ kw: head, params: { ...etb, TriggerDescription: 'If it was cast with flash, sacrifice it at the beginning of the next cleanup step.' }, line: 'DB$ _FlashSac | SpellDescription$ Flash sacrifice.' });
        break;
      case 'Backup': {
        const n = parseInt(arg, 10) || 1;
        out.push({ kw: head, params: { ...etb, TriggerDescription: `Backup ${n} — put ${n} +1/+1 counter${n === 1 ? '' : 's'} on target creature. If that's another creature, it gains this creature's abilities until end of turn.` },
          line: `DB$ _Backup | ValidTgts$ Creature | TgtPrompt$ Select target creature | Num$ ${n} | Abilities$ ${parts[2]?.trim() ?? ''} | SpellDescription$ Backup ${n}.` });
        break;
      }
    }
  }
  return out;
}

/** K: keywords keywordTriggers synthesizes. */
export const TRIGGER_KEYWORDS = ['Foretell', 'Replicate', 'MayFlashSac', 'Madness', 'Spectacle', 'Surge', 'AlternateAdditionalCost', 'Multikicker', 'Mayhem', 'Escalate', 'Annihilator', 'Exalted', 'Persist', 'Undying', 'Living Weapon', 'Fading', 'Vanishing', 'Cumulative upkeep', 'Cascade', 'Storm', 'Ravenous', 'Backup', 'Miracle', 'Rebound'];
