/**
 * Incubate cards from the full card database (data/carddb), copied verbatim (AI-only SVars left out), since the
 * database is not checked in. Used by a2-card-bugs.test.ts.
 */
export const INCUBATE: Record<string, { card: Record<string, unknown>; script: Record<string, unknown>[] }> = {
 "eyes_of_gitaxias": {
  "card": {
   "id": "eyes_of_gitaxias",
   "name": "Eyes of Gitaxias",
   "manaCost": "{2}{U}",
   "cmc": 3,
   "colors": [
    "U"
   ],
   "colorIdentity": [
    "U"
   ],
   "typeLine": "Sorcery",
   "supertypes": [],
   "types": [
    "Sorcery"
   ],
   "subtypes": [],
   "oracle": "Incubate 3. (Create an Incubator token with three +1/+1 counters on it and \"{2}: Transform this token.\" It transforms into a 0/0 Phyrexian artifact creature.)\nDraw a card.",
   "keywords": [],
   "producedMana": [],
   "layout": "normal",
   "tokens": [],
   "image": "https://api.scryfall.com/cards/named?exact=Eyes%20of%20Gitaxias&format=image&version=normal",
   "rank": 9999
  },
  "script": [
   {
    "name": "Eyes of Gitaxias",
    "abilities": [
     "SP$ Incubate | Amount$ 3 | SubAbility$ DBDraw | SpellDescription$ Incubate 3. (Create an Incubator token with three +1/+1 counters on it and \"{2}: Transform this token.\" It transforms into a 0/0 Phyrexian artifact creature.)"
    ],
    "triggers": [],
    "statics": [],
    "replacements": [],
    "keywords": [],
    "svars": {
     "DBDraw": "DB$ Draw | SpellDescription$ Draw a card."
    }
   }
  ]
 }
};
