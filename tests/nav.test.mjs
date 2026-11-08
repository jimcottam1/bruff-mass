// Drives the Mass page in Chrome through every way someone can move around it.
// Time is faked with ?now= plus a controllable Date.now; the 30-second timer is run on demand with __tick().
// Run: cd tests && npm install && npm test        (optionally: node nav.test.mjs path/to/index.html)
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE = process.argv[2] ? pathToFileURL(process.argv[2]).href : new URL('../index.html', import.meta.url).href;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
await browser.newPage();  // keep one tab open so Chrome doesn't shut down between tests
const results = [];

/** Open the page as a phone would, pretending it's `when` (Irish time). realFeeds = let the live video feeds load. */
async function open(when, { size = { width: 412, height: 860 }, realFeeds = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ ...size, isMobile: true, hasTouch: true });
  await page.emulateTimezone('Europe/Dublin');
  await page.setRequestInterception(true);
  const blocked = realFeeds ? /churchcamlive|churchservices\.tv|fonts\.g/ : /churchcamlive|churchservices|wowza|fonts\.g/;
  page.on('request', r => blocked.test(r.url()) ? r.abort() : r.continue());
  page.on('pageerror', e => results.push({ name: `JS error at ${when}`, ok: false, detail: e.message }));
  await page.evaluateOnNewDocument(() => {
    const realNow = Date.now.bind(Date);
    window.__skip = 0;
    Date.now = () => realNow() + window.__skip;
    const realSetInterval = window.setInterval;
    window.setInterval = (fn, ms, ...a) => { window.__tick = fn; return realSetInterval(fn, 1e9, ...a); };
    // Record what the page asks of the screen's orientation (a desktop test browser can't really rotate)
    window.__orient = [];
    if (window.screen && screen.orientation) {
      screen.orientation.lock = (o) => { window.__orient.push(`lock:${o}`); return Promise.resolve(); };
      screen.orientation.unlock = () => { window.__orient.push('unlock'); };
    }
    window.__hidden = false;
    Object.defineProperty(Document.prototype, 'hidden', { get: () => window.__hidden, configurable: true });
    Object.defineProperty(Document.prototype, 'visibilityState', { get: () => window.__hidden ? 'hidden' : 'visible', configurable: true });
  });
  await page.goto(`${PAGE}?now=${when}`, { waitUntil: 'domcontentloaded' });
  return page;
}

async function advance(page, minutes) { await page.evaluate(m => { window.__skip += m * 60000; window.__tick(); }, minutes); }
async function background(page) { await page.evaluate(() => { window.__hidden = true; document.dispatchEvent(new Event('visibilitychange')); }); }
async function foreground(page) { await page.evaluate(() => { window.__hidden = false; document.dispatchEvent(new Event('visibilitychange')); }); }
async function tapWatch(page, id) { await page.click(`#church-${id} .watch`); await sleep(150); }
async function tapBack(page) { await page.click('#back'); await sleep(300); }
async function phoneBack(page) { await page.goBack({ timeout: 3000 }).catch(() => null); await sleep(300); }

/** What's on screen right now */
async function state(page) {
  return page.evaluate(() => {
    const vis = el => el && !el.hidden && getComputedStyle(el).display !== 'none';
    const card = id => {
      const el = document.getElementById(`church-${id}`);
      return { live: el.classList.contains('live'), next: el.querySelector('.next').textContent, until: el.querySelector('.until').textContent };
    };
    return {
      screen: vis(document.getElementById('player')) ? 'player' : vis(document.getElementById('home')) ? 'list' : 'nothing',
      backButton: vis(document.getElementById('back')),
      showing: document.querySelector('#player iframe') ? 'page' : document.querySelector('#player video') ? 'video' : document.querySelector('#player .message') ? 'message' : 'none',
      message: document.querySelector('#player .message')?.textContent || '',
      order: [...document.querySelectorAll('.church h2')].map(h => h.textContent).join(' | '),
      bruff: card('bruff'), stjohns: card('stjohns'), stmarys: card('stmarys')
    };
  }).catch(() => ({ screen: 'left the app' }));
}

function check(name, ok, detail = '') { results.push({ name, ok: !!ok, detail }); }
const MON = '2026-11-09';  // Monday: Mass at 10:00 in all three; St John's also 17:45

// ---------- The list ----------
{
  const p = await open(`${MON}T09:49`);
  let s = await state(p);
  check('1a list shows Bruff first, then the two Limerick churches', s.order === "Bruff | St John's Cathedral | St Mary's Church", s.order);
  check('1b 9:49: Bruff says next Mass today at 10, in 11 minutes', s.bruff.next === 'Next Mass: Today at 10 in the morning' && s.bruff.until === "That's in 11 minutes.", JSON.stringify(s.bruff));
  check('1c 9:49: nothing is red yet', !s.bruff.live && !s.stjohns.live && !s.stmarys.live);
  await advance(p, 2);
  s = await state(p);
  check('1d 9:51: all three cards turn red, "starts in 9 minutes"', s.bruff.live && s.stjohns.live && s.stmarys.live && s.bruff.next === 'Mass starts in 9 minutes', JSON.stringify(s.bruff));
  check('1e 9:51: nothing opens by itself', s.screen === 'list', s.screen);
  await advance(p, 20);
  s = await state(p);
  check('1f 10:11: "Mass is on now, it started at 10"', s.bruff.next === 'Mass is on now' && s.bruff.until === 'It started at 10 in the morning.', JSON.stringify(s.bruff));
  await advance(p, 50);
  s = await state(p);
  check('1g 11:01: Mass over, cards back to next Mass', !s.bruff.live && s.bruff.next === 'Next Mass: Wednesday at 10 in the morning' && !s.stjohns.live && s.stjohns.next === 'Next Mass: Today at 5:45 in the evening', `${s.bruff.next} / ${s.stjohns.next}`);
  await p.close();
}
{
  const p = await open(`${MON}T17:40`);
  const s = await state(p);
  check("2  17:40: only St John's is red (5:45 Mass)", s.stjohns.live && s.stjohns.next === 'Mass starts in 5 minutes' && !s.bruff.live && !s.stmarys.live, JSON.stringify(s.stjohns));
  await p.close();
}

// ---------- Watching Bruff ----------
{
  const p = await open(`${MON}T10:05`);
  await tapWatch(p, 'bruff');
  let s = await state(p);
  check('3a tap Watch Mass on Bruff: Bruff player fills the screen with Back button', s.screen === 'player' && s.showing === 'page' && s.backButton, JSON.stringify(s));
  const src = await p.$eval('#player iframe', f => f.src);
  check('3b ...it is the Bruff stream', /slug=bruffparishwebcam/.test(src), src);
  await advance(p, 90);
  s = await state(p);
  check('3c Mass ends while watching: video is not taken away', s.screen === 'player' && s.showing === 'page');
  await background(p); await foreground(p);
  s = await state(p);
  check('3d switch apps and back: still watching', s.screen === 'player' && s.showing === 'page');
  await tapBack(p);
  s = await state(p);
  check('3e on-screen Back: list again, video stopped, cards up to date', s.screen === 'list' && s.showing === 'none' && s.bruff.next === 'Next Mass: Wednesday at 10 in the morning', JSON.stringify(s));
  await phoneBack(p);
  s = await state(p);
  check('3f then phone Back: never re-opens the video', s.screen !== 'player', s.screen);
  await p.close();
}
{
  const p = await open(`${MON}T10:05`);
  await tapWatch(p, 'bruff');
  await phoneBack(p);
  const s = await state(p);
  check("4  phone's Back button while watching: back to the list", s.screen === 'list' && s.showing === 'none', s.screen);
  await p.close();
}
{
  const p = await open(`${MON}T14:00`);
  await tapWatch(p, 'bruff');
  const s = await state(p);
  check('5  Watch Mass works when no Mass is on too (funerals etc.)', s.screen === 'player' && s.showing === 'page');
  await p.close();
}

// ---------- Watching the Limerick churches, with the real feeds ----------
{
  const p = await open(`${MON}T10:05`, { realFeeds: true });
  await tapWatch(p, 'stjohns');
  let s = await state(p);
  check("6a tap Watch Mass on St John's: video player fills the screen with Back button", s.screen === 'player' && (s.showing === 'video' || s.showing === 'message') && s.backButton, JSON.stringify(s));
  // Give the real feed time to start
  let v = null;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    v = await p.evaluate(() => { const v = document.querySelector('#player video'); return v ? { t: v.currentTime, ready: v.readyState, paused: v.paused, muted: v.muted, w: v.videoWidth } : null; });
    if (v && v.t > 1) break;
  }
  s = await state(p);
  if (s.showing === 'message') check("6b St John's feed: off air message shown", true, s.message);
  else check("6b St John's feed plays by itself, with sound", v && v.t > 1 && !v.paused && !v.muted, JSON.stringify(v));
  await tapBack(p);
  s = await state(p);
  check('6c Back: list again, feed stopped', s.screen === 'list' && s.showing === 'none');
  // Straight into another church
  await tapWatch(p, 'stmarys');
  for (let i = 0; i < 15 && (s = await state(p)).showing === 'video'; i++) {
    const t = await p.evaluate(() => document.querySelector('#player video')?.currentTime || 0);
    if (t > 1) break;
    await sleep(1000);
  }
  s = await state(p);
  if (s.showing === 'message') check("6d St Mary's (not on air now): plain message (its Mass is due, so: may start shortly)", /St Mary's Church isn't showing anything at the moment\.It may start in a minute or two/.test(s.message), s.message);
  else check("6d St Mary's feed is on and plays", s.showing === 'video', s.showing);
  await phoneBack(p);
  s = await state(p);
  check('6e phone Back from the message: list again', s.screen === 'list', s.screen);
  await p.close();
}

// ---------- Around the week (Bruff card) ----------
{
  const cases = [
    ['2026-11-10T09:55', false, 'Next Mass: Tomorrow at 10 in the morning', '7a Tuesday 9:55 (no Bruff Mass)'],
    ['2026-11-11T11:20', false, 'Next Mass: Friday at 10 in the morning', '7b Wednesday 11:20 (skips Thursday)'],
    ['2026-11-14T17:49', false, 'Next Mass: Today at 6 in the evening', '7c Saturday 17:49'],
    ['2026-11-14T17:51', true, 'Mass starts in 9 minutes', '7d Saturday 17:51'],
    ['2026-11-14T19:30', false, 'Next Mass: Tomorrow at 11 in the morning', '7e Saturday 19:30'],
    ['2026-11-15T11:30', true, 'Mass is on now', '7f Sunday 11:30'],
    ['2026-11-15T12:30', false, 'Next Mass: Tomorrow at 10 in the morning', '7g Sunday 12:30 (wraps to Monday)'],
    ['2027-03-28T10:52', true, 'Mass starts in 8 minutes', '7h Sunday after clocks go forward'],
    ['2027-10-31T10:52', true, 'Mass starts in 8 minutes', '7i Sunday after clocks go back']
  ];
  for (const [t, live, next, name] of cases) {
    const p = await open(t);
    const s = await state(p);
    check(name, s.bruff.live === live && s.bruff.next === next, JSON.stringify(s.bruff));
    await p.close();
  }
}
{
  const p = await open('2026-11-08T21:00');  // Sunday night, left open
  await advance(p, 4 * 60);
  let s = await state(p);
  check('8a left open overnight: 01:00 Monday says Today', s.bruff.next === 'Next Mass: Today at 10 in the morning', s.bruff.next);
  await advance(p, 8 * 60 + 51);
  s = await state(p);
  check('8b ...09:51 the card has turned red, nothing opened by itself', s.bruff.live && s.screen === 'list');
  await p.close();
}

// ---------- More churches ----------
{
  const p = await open(`${MON}T14:00`);
  const closed = await p.$eval('#others', d => d.open);
  check('9a more churches folded away at first', closed === false);
  await p.click('#others summary');
  const info = await p.evaluate(() => ({ open: document.getElementById('others').open, n: document.querySelectorAll('#others a').length, newTab: [...document.querySelectorAll('#others a')].every(a => a.target === '_blank') }));
  check('9b tapping opens it; all 18 links open in a new tab', info.open && info.n === 18 && info.newTab, JSON.stringify(info));
  const popup = new Promise(r => browser.once('targetcreated', t => r(t.url())));
  await p.click('#church-list a');
  const url = await Promise.race([popup, sleep(3000).then(() => null)]);
  const s = await state(p);
  check('9c tapping a church opens a new tab, app stays on the list', !!url && s.screen === 'list', `${url} / ${s.screen}`);
  await p.close();
}

// ---------- Fills the screen either way up ----------
for (const [name, size] of [['upright', { width: 412, height: 860 }], ['on its side', { width: 860, height: 412 }]]) {
  for (const id of ['bruff', 'stjohns']) {
    const p = await open(`${MON}T10:05`, { size });
    await tapWatch(p, id);
    const box = await p.$eval('#player iframe, #player video, #player .message', f => { const r = f.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
    check(`10 ${id} fills the screen, phone ${name}`, box[0] === 0 && box[1] === 0 && box[2] === size.width && box[3] === size.height, box.join(','));
    await p.close();
  }
}

// ---------- Full screen (Android / computer) ----------
for (const id of ['bruff', 'stjohns']) {
  const p = await open(`${MON}T10:05`, { realFeeds: id === 'stjohns' });
  await tapWatch(p, id);
  await sleep(500);
  const fs = await p.evaluate(() => document.fullscreenElement?.id || null);
  check(`11a ${id}: tapping Watch Mass goes full screen`, fs === 'player', `full screen element: ${fs}`);
  const turned = await p.evaluate(() => window.__orient.join(','));
  check(`11d ${id}: ...and turns the picture sideways`, turned === 'lock:landscape', turned);
  await tapBack(p);
  await sleep(300);
  const released = await p.evaluate(() => window.__orient.join(','));
  check(`11e ${id}: Back lets the phone turn upright again`, released === 'lock:landscape,unlock', released);
  const after = await p.evaluate(() => ({ fs: document.fullscreenElement?.id || null }));
  const s = await state(p);
  check(`11b ${id}: Back leaves full screen and shows the list`, after.fs === null && s.screen === 'list', `${after.fs} / ${s.screen}`);
  await p.close();
}
{ // She swipes out of full screen herself: still watching, Back still there
  const p = await open(`${MON}T10:05`);
  await tapWatch(p, 'bruff');
  await sleep(500);
  await p.evaluate(() => document.exitFullscreen());
  await sleep(300);
  const s = await state(p);
  check('11c leaving full screen with the phone: still watching, Back button there', s.screen === 'player' && s.backButton, JSON.stringify(s));
  await p.close();
}

await browser.close();
const width = Math.max(...results.map(r => r.name.length));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.ok && !/off air|plain message/.test(r.name) ? '' : r.detail}`);
console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`);
