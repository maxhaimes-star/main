# 🍊 OJB Cube Online

A private, MTGO/Arena-style website for drafting and playing the **Orangejuicebox cube** (606 cards) with friends in different places. Everyone sees the same table live.

- **Booster draft**: packs pass left, right, left, with a pick timer that shrinks as packs get smaller. Bots fill empty seats.
- **Auction draft (pack-based)**: one pack is opened at a time. Players take turns choosing a card from it to put up for auction. The chooser opens the bidding at 0, and everyone bids from a shared budget. Each bid resets the timer.
- **Sealed**: everyone gets a pile of packs (default 6 × 15) and builds straight away.
- **Deckbuilder**: CMC columns, mana curve, "suggest lands", and export to **XMage (.dck)**, MTGA/MTGO text, or Cockatrice (.cod).
- **Play**: best-of-1/3/5 matches with sideboarding between games, on a synced tabletop.

## What's automated and what's manual

| Automated (the site does it) | Manual (you do it, like paper Magic) |
|---|---|
| Shuffling, drawing, opening hands, London mulligan | Applying each card's text (move/tap/count things yourself) |
| Turn structure: untap step, draw step, phases, priority passing with MTGO-style stops, F6 | Static effects (Thalia tax, Opposition, Winter Orb…). Use notes and P/T modifiers |
| The stack: cast → opponent can respond → resolves to battlefield or graveyard; adventures go to exile | Judgement calls about legality (targets, timing) |
| Mana: click a land to tap it for mana; casting pays from your pool (Phyrexian mana with life) | |
| Combat: declare attackers/blockers by clicking, damage math (first/double strike, trample, deathtouch, lifelink, infect, indestructible) that both players confirm | |
| Tokens (each card knows the tokens it makes), counters, loyalty (planeswalkers enter with loyalty, abilities adjust it), transform/MDFC/adventure/split | |
| Hidden information: hands, libraries and face-down cards are hidden by the server, so nobody can peek | |
| Scry, surveil, look at top N, search library, reveal, mill; library is re-keyed on every shuffle | |
| Undo (opponent approves), full game log, chat | |

For full rules enforcement, export your deck to **[XMage](https://xmage.today/)** (free, MTGO-like). It plays the cards it has implemented with every rule applied automatically.

## Controls in a game

- **Click** a land to tap it for mana, a creature to tap/untap it, or a hand card to play or cast it.
- **Right-click** (or the ⋯ button on a card) opens every option: abilities, triggers, counters, P/T, transform, attach, control, copy, move…
- **Drag** cards between hand, battlefield, graveyard, exile and library.
- Click your **library** for draw / scry / surveil / search / mill / shuffle.
- **F2 or Space**: OK / pass priority. **F6**: pass until end of turn. **Ctrl+Z**: ask to undo.
- **Phase bar**: click a later step to skip ahead (on your turn). Right-click a step to toggle a stop.
- **Attackers step**: click your creatures, then OK. **Blockers step**: click your creature, then the attacker, then OK.

## Run it locally

Requires [Node.js](https://nodejs.org/) 20 or newer.

```bash
npm install
npm run build      # build the website
npm start          # http://localhost:3001
```

For development with hot reload: `npm run dev`, then open http://localhost:5173.

Tests: `npm test` (unit tests), `npm run e2e` (browser tests, needs the server running).

To put it online for friends, see **[DEPLOY.md](DEPLOY.md)**.

## Card data

- `cube/orangejuicebox.txt`: the cube list. Edit it to change the cube.
- `shared/data/cube.json`: the card data (Oracle text, types, costs, tokens, faces) generated from the list:
  - `npm run build-cube` pulls everything from **Scryfall** (best: hi-res images, needs internet).
  - `npm run build-cube -- --forge <path-to-forge>/forge-gui/res` uses a checkout of the open-source [Forge](https://github.com/Card-Forge/forge) card database instead. The committed file was built this way.
- `client/public/cards/NNN.jpg`: card images cropped from the print-and-play PDF (card N of the list). To regenerate: `python3 scripts/crop_pdf.py <pdf> client/public/cards`, then `npm run build-cube` again.
- Images: the lobby has a toggle between the PDF scans (fast, default) and Scryfall hi-res. Hovering a card always tries the hi-res image first. Tokens and basic lands without a scan are drawn as text cards.

Hosts can also paste a custom card list in the lobby to use only part of the cube for an event.

## Layout

```
cube/            cube list
scripts/         card data builder + PDF cropper
shared/src/      card model, draft/auction/sealed logic, game engine (reducer, combat, hidden-info views)
server/src/      Express + Socket.IO server: rooms, timers, bots, matches, persistence
client/src/      React UI: lobby, draft, auction, deckbuilder, game table
e2e/             Playwright browser tests
```
