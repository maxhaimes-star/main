// Playing against the computer: one human creates a cube sealed room with "Play vs bot", builds a deck, challenges
// the bot and plays a few turns by playing lands and passing. The bot (server/src/botdriver.ts) must keep its hand,
// play lands and act on its own; it is shown as a normal opponent with a "Bot" badge.
// Usage: node e2e/bot.mjs [baseUrl] [outDir]
import { assert, BASE, handLands, logText, logTail, needsDecision, newPage, pressOk, runScenarios, settle, shot, step, currentStep } from './lib.mjs';

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

scenario('1. human vs bot: lobby option, challenge, the bot plays lands', async () => {
  const A = await newPage();
  try {
    step('create a room: cube sealed, one seat, Play vs bot');
    await A.goto(BASE);
    await A.getByLabel('Your name').fill('Max');
    await A.getByRole('button', { name: 'Create room' }).click();
    await A.waitForURL(/\/r\//);
    await A.getByRole('button', { name: /^Cube sealed/ }).click();
    await A.getByLabel('Cube:').selectOption({ label: 'Import new…' });
    await A.locator('.custom-list textarea').fill('30 Lightning Bolt\n30 Embereth Shieldbreaker');
    await A.getByRole('button', { name: 'Use this list' }).click();
    const set = async (label, v) => { await A.locator('.setting', { hasText: label }).locator('input').fill(String(v)); await A.waitForTimeout(250); };
    await set('Seats at the table', 1);
    await set('Packs per player', 1);
    await set('Cards per pack', 20);
    const fill = A.locator('.setting.check', { hasText: 'Fill empty seats with bots' }).locator('input');
    if (await fill.isChecked()) await fill.click();
    await A.getByLabel('Play vs bot').click();
    await A.getByLabel('Bot difficulty').waitFor();
    await A.waitForTimeout(300);
    await shot(A, 'bot-1-lobby');
    await A.getByRole('button', { name: /Start cube sealed/i }).click();

    step('build a deck and challenge the bot');
    await A.getByText('Deckbuilding').waitFor();
    for (let i = 0; i < 20; i++) await A.locator('.db-main > .pool-summary .pool-stack').first().locator('.cube-card').last().click({ force: true });
    await A.getByRole('button', { name: /Suggest lands/ }).click();
    await A.getByLabel('Deck ready').check();
    await A.waitForTimeout(600);
    const botRow = A.locator('.bot-row');
    await botRow.first().waitFor();
    assert(/Bot/.test(await botRow.first().innerText()), 'the bot is listed with a Bot badge');
    await shot(A, 'bot-2-deckbuilding');
    await botRow.first().getByRole('button', { name: /Play vs/ }).click();

    step('mulligan: keep; the bot keeps on its own');
    await A.getByRole('button', { name: /^Keep/ }).click();
    await A.locator('.center-bar').waitFor();
    await A.locator('.player-area.top .bot-badge').waitFor();
    assert((await A.locator('.player-area.top .pp-name').innerText()).includes('Bot'), 'opponent shown with its name and a Bot badge');

    step('play a few turns: play a land each turn, pass otherwise');
    const turnOf = async () => Number(((await logText(A)).match(/— Turn (\d+):/g) ?? []).pop()?.match(/\d+/)?.[0] ?? 0);
    let myLands = 0;
    let landTurn = -1;
    for (let i = 0; i < 400 && (await turnOf()) < 7; i++) {
      if (await needsDecision(A)) {
        // e.g. discard to hand size: take the first option
        const opt = A.locator('.modal.pending .row button').first();
        if (await opt.count()) { await opt.click().catch(() => {}); await settle(A, 300); continue; }
      }
      const mine = (await A.locator('.player-area.bottom.active').count()) > 0;
      const t = await turnOf();
      if (mine && /Main/.test(await currentStep(A)) && landTurn !== t) {
        const land = handLands(A, 'Mountain').first();
        if (await land.count()) {
          await land.click();
          await settle(A, 400);
          landTurn = t;
          myLands++;
          continue;
        }
      }
      if (!(await pressOk(A, 300))) await settle(A, 300);
    }
    const log = await logText(A);
    await shot(A, 'bot-3-game');
    assert((await turnOf()) >= 5, `the game should advance several turns:\n${await logTail(A, 15)}`);
    assert(myLands >= 2, 'the human played lands');
    const botLands = (log.match(/Bot \w+ plays (Mountain|Plains|Island|Swamp|Forest)/g) ?? []).length;
    assert(botLands >= 2, `the bot should play lands (saw ${botLands}):\n${await logTail(A, 20)}`);
    assert(/Bot \w+ keeps/.test(log), 'the bot decided its mulligan');
    console.log(`  bot played ${botLands} lands; casts: ${(log.match(/Bot \w+ casts/g) ?? []).length}`);
  } finally {
    await A.context().close();
  }
});


await runScenarios('bot', scenarios);
