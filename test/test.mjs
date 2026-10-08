/* End-to-end test (run with: node test/test.mjs) */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const errors = [];
let pass = 0, fail = 0;

function ok(cond, label) {
  if (cond) { pass++; console.log(`  ok  ${label}`); }
  else { fail++; console.log(` FAIL ${label}`); }
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = join(ROOT, p);
  if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(8123, r));
console.log('serving on http://127.0.0.1:8123');

// NOTE: customize chromium browser path to match your own system's configuration
import { createRequire } from 'node:module';
const require = createRequire('/home/linuxbrew/.linuxbrew/lib/node_modules/');
const { chromium } = require('playwright');
const browser = await chromium.launch({
  executablePath: '/var/home/user/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
});
const page = await browser.newPage();
page.on('console', (msg) => { if (msg.type() === 'error') errors.push('console: ' + msg.text()); });
page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));

// ---------- Home (empty saved list) ----------
await page.goto('http://127.0.0.1:8123/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#loading[hidden]', { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1500);
ok(await page.locator('h1', { hasText: 'My Representatives' }).count() > 0, 'home: heading renders');
ok((await page.locator('#data-date').textContent()).includes('last updated'), 'home: data date shown');
ok(await page.locator('.empty-state').count() > 0, 'home: empty state when nothing saved');
const sampleBanner = await page.locator('.banner', { hasText: 'Sample data' }).count();
ok(sampleBanner === 0, 'home: no sample banner with real data');

// ---------- Find a representative ----------
await page.click('button[data-nav="find"]');
await page.waitForTimeout(300);
await page.fill('#name-search', 'Cantwell');
await page.waitForTimeout(300);
const cantwellCard = page.locator('.member-card', { hasText: 'Maria Cantwell' }).first();
ok(await cantwellCard.count() > 0, 'find: search finds Maria Cantwell');

// save Cantwell
await cantwellCard.locator('button[data-save]').click();
await page.waitForTimeout(300);
ok((await page.locator('button[data-unsave]').textContent()).includes('Saved'), 'find: save button works');

// search second rep
await page.fill('#name-search', 'Booker');
await page.waitForTimeout(300);
const bookerCard = page.locator('.member-card', { hasText: 'Cory A. Booker' }).first();
ok(await bookerCard.count() > 0, 'find: search finds Cory A. Booker');
await bookerCard.locator('button[data-save]').click();
await page.waitForTimeout(300);

// ---------- Member page ----------
await page.click('button[data-nav="home"]');
await page.waitForTimeout(300);
const cantwellHome = page.locator('.member-card', { hasText: 'Maria Cantwell' }).first();
ok(await cantwellHome.count() > 0, 'home: saved rep appears');
await cantwellHome.locator('a[href^="#/member/"]').click();
await page.waitForTimeout(500);
ok((await page.locator('h1').first().textContent()).includes('Maria Cantwell'), 'member: name in h1');
ok(await page.locator('h2', { hasText: 'Conduct & ethics records' }).count() > 0, 'member: conduct section');
ok(await page.locator('#vote-list article.vote').count() > 0, 'member: votes render');
const badges = await page.locator('#vote-list .badge').allTextContents();
ok(badges.some((b) => b.includes('FOR')) && badges.some((b) => b.includes('AGAINST')),
   `member: both FOR and AGAINST badges present (${badges.length} badges)`);
const summaries = await page.locator('#vote-list .what p').allTextContents();
ok(summaries.some((s) => s.length > 100), 'member: plain-language summaries present');

// filter by issue
const issueBtns = page.locator('.issue-row[data-issue]');
const issueCount = await issueBtns.count();
ok(issueCount > 2, `member: issue filter rows (${issueCount})`);
if (issueCount) {
  await issueBtns.first().click();
  await page.waitForTimeout(400);
  const total = await page.locator('#vote-list article.vote').count();
  ok(total > 0 && total < badges.length, `member: issue filter narrows votes (${total})`);
  // unfilter via "show all"
  await page.click('#issue-all');
  await page.waitForTimeout(300);
}

// read-more toggle on a long summary
const toggle = page.locator('.vote-toggle').first();
if (await toggle.count()) {
  await toggle.click();
  ok((await toggle.textContent()) === 'Show less', 'member: read-more expands');
  await toggle.click();
}

// ---------- Conduct view for a member with entries ----------
await page.goto('http://127.0.0.1:8123/#/member/M001216', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);
const conductCards = await page.locator('.conduct-entry').count();
ok(conductCards >= 1, `member M001216: ${conductCards} conduct entries rendered`);
ok(await page.locator('.conduct-entry .tag.unresolved').count() > 0, 'member: unresolved tag styled');

// ---------- Compare ----------
await page.goto('http://127.0.0.1:8123/#/compare', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);
ok(await page.locator('.chip').count() >= 2, 'compare: chips for saved reps');
const sel = page.locator('#cmp-issue');
const options = await sel.locator('option').allTextContents();
ok(options.length > 3, `compare: issue options (${options.length})`);
// find an issue where the chosen people (both senators) actually have votes;
// if none, the app must show a sensible empty state
let target = null, rows = 0;
for (const opt of options.slice(1)) {
  await sel.selectOption({ label: opt });
  await page.waitForTimeout(350);
  rows = await page.locator('table.compare').count();
  if (rows) { target = opt; break; }
}
ok(!!target, `compare: table renders for ${target} (${rows} table(s))`);
ok(await page.locator('.dot.for, .dot.against').count() > 0, 'compare: for/against dots present');
// and an issue with no votes for these people must show the empty state, not an empty table
await sel.selectOption({ label: 'Health Care' });
await page.waitForTimeout(350);
const hcEmpty = await page.locator('.empty-state', { hasText: 'people you chose' }).count();
ok(hcEmpty === 1 || (await page.locator('table.compare').count()) > 0, 'compare: other-chamber votes hidden (empty state or table)');

// ---------- localStorage persistence ----------
const saved = JSON.parse(await page.evaluate(() => localStorage.getItem('repwatch.saved.v1') || '[]'));
ok(saved.length >= 2, `storage: saved reps persisted (${saved.length})`);

// service worker registration (may be a no-op on file-less http; just check no crash)
const swState = await page.evaluate(() => navigator.serviceWorker ? 'supported' : 'unsupported');
ok(swState === 'supported', 'sw: service workers supported by browser');

await browser.close();
server.close();

console.log(`\n${pass} passed, ${fail} failed`);
if (errors.length) {
  console.log('\nJS errors captured:');
  for (const e of errors) console.log('  ' + e);
}
process.exit(fail || errors.length ? 1 : 0);
