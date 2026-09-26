// Renders Index.html in Chromium with google.script.run wired to the Node harness.
const fs = require('fs'), path = require('path');
const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
const { load } = require('./harness');
(async () => {
  const csv = fs.readFileSync(process.env.GAMES_CSV || path.join(__dirname, '..', '..', 'nflverse', 'nfldata', 'data', 'games.csv'), 'utf8');
  const env = load({ now: Date.UTC(2026, 8, 26, 21, 0), csv });
  env.ctx.setup();
  const [p1, p2] = JSON.parse(env.store.get('players'));
  env.ctx.apiSetName(p1.token, 'Runt'); env.ctx.apiSetName(p2.token, 'Bunte');
  env.ctx.apiSetPick(p2.token, '2026_03_LAC_BUF', 'away');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'Index.html'), 'utf8')
    .replace('<?!= JSON.stringify(token) ?>', JSON.stringify(p1.token));
  const shim = `<script>window.google={script:{get run(){let ok,fail;const r=new Proxy({}, {get(_,k){
    if(k==='withSuccessHandler')return f=>{ok=f;return r;}; if(k==='withFailureHandler')return f=>{fail=f;return r;};
    return (...a)=>window.__api(k,a).then(x=>x.error?fail(new Error(x.error)):ok(x.value));}});return r;}}};</script>`;
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  const shot = async (scheme, name, actions) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 1400 }, colorScheme: scheme });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.exposeFunction('__api', (fn, args) => {
      try { return { value: JSON.parse(JSON.stringify(env.ctx[fn](...args))) }; } catch (e) { return { error: e.message }; }
    });
    await page.setContent(html.replace('<head>', '<head>' + shim));
    await page.waitForSelector('.card');
    if (actions) await actions(page);
    await page.screenshot({ path: path.join(__dirname, name), fullPage: false });
    if (errors.length) console.log('page errors', errors);
    await page.close();
  };
  await shot('light', 'ui_open.png', async page => {
    await page.click('text=@ Bills (BUF)');
    await page.waitForTimeout(200);
    await page.click('button.lock >> nth=0');
    await page.waitForTimeout(200);
    await page.click('text=Dolphins');
    await page.waitForTimeout(300);
  });
  // advance to after results for a frozen view
  env.clock.now = Date.UTC(2026, 8, 27, 20, 30);
  env.ctx.sync_(true);
  await shot('dark', 'ui_frozen.png');
  console.log('p1 week3 state lock =', env.ctx.apiGetState(p1.token, 3).myLock);
  await browser.close();
})();
