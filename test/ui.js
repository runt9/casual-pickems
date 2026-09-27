// Renders the pick page in headless Chromium with google.script.run wired to the Node harness,
// and checks the main flows. Run: GAMES_CSV=/path/games.csv node ui.js   (needs Playwright)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));
const { load } = require('./harness');

const SRC = path.join(__dirname, '..', 'src');
const CSV_PATH = process.env.GAMES_CSV || path.join(__dirname, '..', '..', 'nflverse', 'nfldata', 'data', 'games.csv');

/** Assembles the page the way HtmlService would: token scriptlet and include_() calls. */
function buildPage(token) {
  const read = (name) => fs.readFileSync(path.join(SRC, name + '.html'), 'utf8');
  return read('Index')
    .replace(/<\?!= include_\('(\w+)'\) \?>/g, (_, name) => read(name))
    .replace('<?!= JSON.stringify(token) ?>', JSON.stringify(token));
}

/** Fake google.script.run that forwards to the harness through Playwright's exposeFunction. */
const SCRIPT_RUN_SHIM = `<script>
window.google = { script: { get run() {
  let onSuccess, onFailure;
  const runner = new Proxy({}, { get(_, name) {
    if (name === 'withSuccessHandler') return (fn) => { onSuccess = fn; return runner; };
    if (name === 'withFailureHandler') return (fn) => { onFailure = fn; return runner; };
    return (...args) => window.__callServer(name, args).then((r) => r.error ? onFailure(new Error(r.error)) : onSuccess(r.value));
  } });
  return runner;
} } };
</script>`;

(async () => {
  const env = load({ now: Date.UTC(2026, 8, 26, 21, 0), csv: fs.readFileSync(CSV_PATH, 'utf8') });
  env.ctx.setup();
  const [runt, bunte] = JSON.parse(env.store.get('players'));
  env.ctx.apiSetName(runt.token, 'Runt');
  env.ctx.apiSetName(bunte.token, 'Bunte');
  env.ctx.apiSetPick(bunte.token, '2026_03_LAC_BUF', 'away');

  const browser = await chromium.launch();
  const openPage = async (colorScheme) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 1400 }, colorScheme });
    page.errors = [];
    page.on('pageerror', (error) => page.errors.push(error.message));
    await page.exposeFunction('__callServer', (name, args) => {
      try {
        return { value: JSON.parse(JSON.stringify(env.ctx[name](...args))) };
      } catch (error) {
        return { error: error.message };
      }
    });
    await page.setContent(buildPage(runt.token).replace('<head>', '<head>' + SCRIPT_RUN_SHIM));
    await page.waitForSelector('.game-card');
    return page;
  };

  // Open week: pick, lock, banner, other player's status.
  const page = await openPage('light');
  assert.strictEqual(await page.locator('#rename-form').isVisible(), false, 'rename form starts hidden');
  assert.strictEqual(await page.locator('.game-card').count(), 16);
  assert.strictEqual(await page.locator('.team-button').count(), 30, '15 open games x 2 teams');
  assert.strictEqual(await page.locator('.no-lock-banner').count(), 1, 'no-lock banner before a lock');
  const billsCard = page.locator('.game-card', { hasText: 'Bills (BUF)' });
  assert(!(await page.textContent('#week-content')).includes('has picked'), 'pick page does not show other players\' pick status');

  await page.click('text=@ Bills (BUF)');
  await page.waitForSelector('.team-button[aria-pressed="true"]');
  await billsCard.locator('.lock-button').click();
  await page.waitForSelector('.lock-button[aria-pressed="true"]');
  assert.strictEqual(await page.locator('.no-lock-banner').count(), 0, 'banner gone after locking');
  assert.strictEqual(env.ctx.apiGetState(runt.token, 3).myLock, '2026_03_LAC_BUF');

  // Clicking the chosen team again clears the pick and its lock.
  await page.click('text=@ Bills (BUF)');
  await page.waitForSelector('.no-lock-banner');
  assert.strictEqual(env.ctx.apiGetState(runt.token, 3).myLock, null);
  await page.click('text=@ Bills (BUF)');
  await billsCard.locator('.lock-button').click();
  await page.waitForSelector('.lock-button[aria-pressed="true"]');
  await page.screenshot({ path: path.join(__dirname, 'ui_open.png') });
  assert.deepStrictEqual(page.errors, []);

  // Changing the week through the dropdown loads that week.
  await page.selectOption('#week-select', '4');
  await page.waitForFunction(() => document.querySelector('#week-select').value === '4' && !document.body.textContent.includes('Falcons @ Packers'));
  await page.selectOption('#week-select', '3');
  await page.waitForSelector('text=Falcons @ Packers');

  // Frozen week: lines, point values, and both picks visible; no team buttons.
  env.clock.now = Date.UTC(2026, 8, 27, 20, 30);
  env.ctx.sync_(true);
  const frozen = await openPage('dark');
  assert.strictEqual(await frozen.locator('.team-button').count(), 4, 'only Sunday night and Monday night still open (2 games x 2 teams)');
  const billsFrozen = await frozen.locator('.game-card', { hasText: 'Chargers @ Bills' }).textContent();
  assert(billsFrozen.includes('Line: BUF -7'), billsFrozen);
  assert(billsFrozen.includes('You: BUF (lock)'), billsFrozen);
  assert(billsFrozen.includes('Bunte: LAC'), billsFrozen);
  await frozen.screenshot({ path: path.join(__dirname, 'ui_frozen.png') });
  assert.deepStrictEqual(frozen.errors, []);

  await browser.close();
  console.log('ui checks passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
