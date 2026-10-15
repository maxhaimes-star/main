/**
 * Support checks for the effect APIs in engine/more.ts. Pure (no game-state imports) so script.ts can use it.
 */
import type { ParsedAbility } from './types.ts';

/** Effect APIs executed by more.ts. */
export const MORE_APIS = new Set([
  'Branch', 'RepeatEach', 'Repeat', 'GenericChoice', 'ChooseCard', 'ChooseNumber', 'TapOrUntap', 'Amass', 'Proliferate', 'Connive',
  'Explore', 'MultiplyCounter', 'ExchangeControl', 'SetState', 'Protection', 'PeekAndReveal', 'Reveal', 'RollDice', 'DamageResolve',
  'DigUntil', 'CopySpellAbility', 'AlterAttribute', 'Earthbend', 'Airbend', 'Play', '_Remember', '_RepeatCheck', '_SetChosenType',
]);

/** Defined$ values more.ts resolves (beyond script.ts SUPPORTED_DEFINED). */
export const MORE_DEFINED = new Set([
  'ChosenCard', 'ChosenCardLKI', 'ChosenCardController', 'ChosenCardOwner', 'Imprinted', 'ReplacedCard', 'TriggeredSpellAbility', 'TriggeredCardOpponent',
  'TriggeredDefender', 'TargetedOrController', 'ExiledWith', 'Remembered', 'RememberedController', 'RememberedOwner', 'ThisTargetedCard', 'ThisTargetedPlayer',
  'TriggeredDefender.Opponent & Valid Planeswalker.TriggeredDefender', 'Enchanted', 'TriggeredAttackingPlayer', 'TriggeredActivator', 'Player.Opponent',
  'TriggeredStackItem',
]);

/** Counting variables more.ts evaluates. */
export function moreVarSupported(v: string | undefined): boolean {
  if (!v) return false;
  return /^Count\$(ChosenNumber|RememberedSize|YourCountersEnergy|ResolvedThisTurn|Monarch|Initiative|DungeonsCompleted|YourLifeGainedThisTurn|LifeYouGainedThisTurn|CardsDrawnThisTurn|YouDrewThisTurn|Devotion\.[A-Za-z]+|DevotionDual\.[A-Za-z]+\.[A-Za-z]+|ThisTurnCast_.+|TriggerRememberAmount)$/.test(v)
    || /^Remembered\$(Valid .+|CardManaCost|CardPower|Amount)$/.test(v)
    || /^TriggeredCard\$Card(Power|Toughness|ManaCost)$/.test(v)
    || /^TriggerCount\$\w+$/.test(v)
    || /^Count\$YourCountersEnergy\/.+$/.test(v)
    || /^Count\$Valid .+\/(HalfDown|HalfUp|Twice)$/.test(v)
    || /^PlayerCountRegisteredOpponents\$HasPropertyLostLifeThisTurn$/.test(v)
    || /^Count\$(Compare|IfCastInOwnMainPhase).*$/.test(v);
}

/** Reason the step can't be automated: undefined = not a more.ts API, null = supported. */
export function moreReason(step: ParsedAbility): string | null | undefined {
  const p = step.params;
  if (!MORE_APIS.has(step.api)) return undefined;
  switch (step.api) {
    case 'Branch': return p.BranchConditionSVar || p.BranchCondition ? null : 'Branch';
    case 'RepeatEach': return p.RepeatSubAbility && (p.RepeatPlayers || p.RepeatCards || p.DefinedCards || p.RepeatTypesFrom) ? null : 'RepeatEach';
    case 'Repeat': return p.RepeatSubAbility ? null : 'Repeat';
    case 'GenericChoice': return p.Choices ? null : 'GenericChoice';
    case 'ChooseCard': return null;
    case 'Play': return null;
    case 'CopySpellAbility': return null;
  }
  return null;
}
