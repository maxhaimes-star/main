/**
 * Support checks for the effect APIs in engine/more.ts. Pure (no game-state imports) so script.ts can use it.
 */
import type { ParsedAbility } from './types.ts';

/** Effect APIs executed by more.ts. */
export const MORE_APIS = new Set([
  'Branch', 'RepeatEach', 'Repeat', 'GenericChoice', 'ChooseCard', 'ChooseNumber', 'TapOrUntap', 'Amass', 'Proliferate', 'Connive',
  'Explore', 'MultiplyCounter', 'ExchangeControl', 'SetState', 'Protection', 'PeekAndReveal', 'Reveal', 'RollDice', 'DamageResolve',
  'DigUntil', 'CopySpellAbility', 'AlterAttribute', 'Earthbend', 'Airbend', 'Play', '_Remember', '_RepeatCheck', '_SetChosenType', '_Throne',
  'AddPhase', '_Madness', '_ToGraveyard', '_Replicate', '_FlashSac', '_Fading', '_CumUpkeep', '_Cascade', '_Storm', '_LivingWeapon', '_Ravenous', '_Backup', '_PutBottom',
]);

/** Defined$ values more.ts resolves (beyond script.ts SUPPORTED_DEFINED). */
export const MORE_DEFINED = new Set([
  'ChosenCard', 'ChosenCardLKI', 'ChosenCardController', 'ChosenCardOwner', 'Imprinted', 'ReplacedCard', 'TriggeredSpellAbility', 'TriggeredCardOpponent',
  'TriggeredDefender', 'TargetedOrController', 'ExiledWith', 'Remembered', 'RememberedController', 'RememberedOwner', 'ThisTargetedCard', 'ThisTargetedPlayer',
  'TriggeredDefender.Opponent & Valid Planeswalker.TriggeredDefender', 'Enchanted', 'TriggeredAttackingPlayer', 'TriggeredActivator', 'Player.Opponent',
  'TriggeredStackItem', 'TopOfLibrary', 'Player.IsRemembered', 'NonRememberedController', 'Remembered.ExiledWithSource',
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
    || /^Count\$(Compare|IfCastInOwnMainPhase).*$/.test(v)
    || /^Count\$(Monarch|Initiative|Blessing|AltCost|Surged|Kicked|AttackedThisTurn|YouAttacked)\.-?\d+\.-?\d+$/.test(v)
    || /^Count\$(AttackersDeclared|YouAttackedThisTurn)$/.test(v)
    || /^DungeonsCompleted\$Amount$/.test(v)
    || /^PlayerCountOpponents\$HighestValid .+$/.test(v)
    || /^PlayerCountOpponents\$(HighestCardsInHand|LowestLifeTotal|HighestLifeTotal)$/.test(v)
    || /^Count\$CardsInYourHand\/.+$/.test(v)
    || /^Count\$xPaid\/(HalfDown|HalfUp|Twice)$/.test(v)
    || /^Count\$ValidExile .+$/.test(v)
    || /^SVar\$\w+\/(Plus|Minus|Times)\.(-?\d+|\w+)$/.test(v) || /^SVar\$\w+\/(HalfDown|HalfUp|Twice|Negative)$/.test(v)
    || /^TriggeredCard\$CardCounters\.\w+$/.test(v) || /^Sacrificed\$Card(ManaCost|Power)(\/Plus\.\d+)?$/.test(v)
    || /^Count\$Valid .+ControlledBy \w+$/.test(v)
    || /^(Remembered|RememberedLKI|Targeted|TargetedLKI)\$Card(Power|Toughness|ManaCost)\/(HalfUp|HalfDown|Twice)$/.test(v)
    || /^RememberedLKI\$Valid .+$/.test(v) || /^Imprinted\$Valid \w+\.sharesControllerWith (Remembered|Imprinted)$/.test(v)
    || /^Count\$YourCounters\w+$/.test(v) || /^Count\$wasCastFrom(Exile|Graveyard|Hand)\.-?\d+\.-?\d+$/.test(v);
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
    case 'AddPhase': return p.ExtraPhase === 'Combat' ? null : `AddPhase (${p.ExtraPhase})`;
  }
  return null;
}
