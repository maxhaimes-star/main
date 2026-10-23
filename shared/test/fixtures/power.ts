/**
 * The power cards that aren't in the cube ("Power up", shared/src/powerup.ts), from the full card database
 * (data/carddb, built from Forge), copied here because the database isn't in git: card data and Forge scripts,
 * verbatim (AI-only SVars left out). Sol Ring, Mana Vault and Mana Crypt are in fixtures/mana-rocks.ts; Timetwister
 * is a cube card. Used by power.test.ts. Regenerate an entry from data/carddb/cards/*.json + data/carddb/scripts/*.json.
 */
export const POWER: Record<string, { card: Record<string, unknown>; script: Record<string, unknown>[] }> = {
  "black_lotus": { card: {"id":"black_lotus","name":"Black Lotus","manaCost":"{0}","cmc":0,"colors":[],"colorIdentity":[],"typeLine":"Artifact","supertypes":[],"types":["Artifact"],"subtypes":[],"oracle":"{T}, Sacrifice Black Lotus: Add three mana of any one color.","keywords":[],"producedMana":["W","U","B","R","G"],"layout":"normal","tokens":[]},
    script: [{"name":"Black Lotus","abilities":["AB$ Mana | Cost$ T Sac<1/CARDNAME> | Produced$ Any | Amount$ 3 | AILogic$ BlackLotus | SpellDescription$ Add three mana of any one color."],"triggers":[],"statics":[],"replacements":[],"keywords":[],"svars":{}}] },
  "mox_pearl": { card: {"id":"mox_pearl","name":"Mox Pearl","manaCost":"{0}","cmc":0,"colors":[],"colorIdentity":["W"],"typeLine":"Artifact","supertypes":[],"types":["Artifact"],"subtypes":[],"oracle":"{T}: Add {W}.","keywords":[],"producedMana":["W"],"layout":"normal","tokens":[]},
    script: [{"name":"Mox Pearl","abilities":["AB$ Mana | Cost$ T | Produced$ W | SpellDescription$ Add {W}."],"triggers":[],"statics":[],"replacements":[],"keywords":[],"svars":{}}] },
  "mox_sapphire": { card: {"id":"mox_sapphire","name":"Mox Sapphire","manaCost":"{0}","cmc":0,"colors":[],"colorIdentity":["U"],"typeLine":"Artifact","supertypes":[],"types":["Artifact"],"subtypes":[],"oracle":"{T}: Add {U}.","keywords":[],"producedMana":["U"],"layout":"normal","tokens":[]},
    script: [{"name":"Mox Sapphire","abilities":["AB$ Mana | Cost$ T | Produced$ U | SpellDescription$ Add {U}."],"triggers":[],"statics":[],"replacements":[],"keywords":[],"svars":{}}] },
  "mox_jet": { card: {"id":"mox_jet","name":"Mox Jet","manaCost":"{0}","cmc":0,"colors":[],"colorIdentity":["B"],"typeLine":"Artifact","supertypes":[],"types":["Artifact"],"subtypes":[],"oracle":"{T}: Add {B}.","keywords":[],"producedMana":["B"],"layout":"normal","tokens":[]},
    script: [{"name":"Mox Jet","abilities":["AB$ Mana | Cost$ T | Produced$ B | SpellDescription$ Add {B}."],"triggers":[],"statics":[],"replacements":[],"keywords":[],"svars":{}}] },
  "mox_ruby": { card: {"id":"mox_ruby","name":"Mox Ruby","manaCost":"{0}","cmc":0,"colors":[],"colorIdentity":["R"],"typeLine":"Artifact","supertypes":[],"types":["Artifact"],"subtypes":[],"oracle":"{T}: Add {R}.","keywords":[],"producedMana":["R"],"layout":"normal","tokens":[]},
    script: [{"name":"Mox Ruby","abilities":["AB$ Mana | Cost$ T | Produced$ R | SpellDescription$ Add {R}."],"triggers":[],"statics":[],"replacements":[],"keywords":[],"svars":{}}] },
  "mox_emerald": { card: {"id":"mox_emerald","name":"Mox Emerald","manaCost":"{0}","cmc":0,"colors":[],"colorIdentity":["G"],"typeLine":"Artifact","supertypes":[],"types":["Artifact"],"subtypes":[],"oracle":"{T}: Add {G}.","keywords":[],"producedMana":["G"],"layout":"normal","tokens":[]},
    script: [{"name":"Mox Emerald","abilities":["AB$ Mana | Cost$ T | Produced$ G | SpellDescription$ Add {G}."],"triggers":[],"statics":[],"replacements":[],"keywords":[],"svars":{}}] },
  "ancestral_recall": { card: {"id":"ancestral_recall","name":"Ancestral Recall","manaCost":"{U}","cmc":1,"colors":["U"],"colorIdentity":["U"],"typeLine":"Instant","supertypes":[],"types":["Instant"],"subtypes":[],"oracle":"Target player draws three cards.","keywords":[],"producedMana":[],"layout":"normal","tokens":[]},
    script: [{"name":"Ancestral Recall","abilities":["SP$ Draw | NumCards$ 3 | ValidTgts$ Player | SpellDescription$ Target player draws three cards."],"triggers":[],"statics":[],"replacements":[],"keywords":[],"svars":{}}] },
  "time_walk": { card: {"id":"time_walk","name":"Time Walk","manaCost":"{1}{U}","cmc":2,"colors":["U"],"colorIdentity":["U"],"typeLine":"Sorcery","supertypes":[],"types":["Sorcery"],"subtypes":[],"oracle":"Take an extra turn after this one.","keywords":[],"producedMana":[],"layout":"normal","tokens":[]},
    script: [{"name":"Time Walk","abilities":["SP$ AddTurn | NumTurns$ 1 | SpellDescription$ Take an extra turn after this one."],"triggers":[],"statics":[],"replacements":[],"keywords":[],"svars":{}}] },
};
