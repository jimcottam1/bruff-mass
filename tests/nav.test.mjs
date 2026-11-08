// Drives the Bruff Mass page in Chrome through every way someone can move around it.
// Time is faked with ?now= plus a controllable Date.now; the 30-second timer is run on demand with __tick().
// Run: cd tests && npm install && npm test        (optionally: node nav.test.mjs path/to/index.html)
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE = process.argv[2] ? pathToFileURL(process.argv[2]).href : new URL('../index.html', import.meta.url).href;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const results = [];
await browser.newPage();  // keep one tab open so Chrome doesn't shut down between tests

/** Open the page as a phone would, pretending it's `when` (Irish time). */
async function open(when, size = { width: 412, height: 860 }) {
  const page = await browser.newPage();
  await page.setViewport({ ...size, isMobile: true, hasTouch: true });
  // Don't actually stream video during tests
  await page.setRequestInterception(true);
  page.on('request', r => /churchcamlive|churchservices|fonts\.g/.test(r.url()) ? r.abort() : r.continue());
  await page.emulateTimezone('Europe/Dublin');
  page.on('pageerror', e => results.push({ name: `JS error at ${when}`, ok: false, detail: e.message }));
  await page.evaluateOnNewDocument(() => {
    // Controllable clock
    const realNow = Date.now.bind(Date);
    window.__skip = 0;
    Date.now = () => realNow() + window.__skip;
    // Run the page's 30-second timer when we say
    const realSetInterval = window.setInterval;
    window.setInterval = (fn, ms, ...a) => { window.__tick = fn; return realSetInterval(fn, 1e9, ...a); };
    // Controllable "app is in the background"
    window.__hidden = false;
    Object.defineProperty(Document.prototype, 'hidden', { get: () => window.__hidden, configurable: true });
    Object.defineProperty(Document.prototype, 'visibilityState', { get: () => window.__hidden ? 'hidden' : 'visible', configurable: true });
  });
  await page.goto(`${PAGE}?now=${when}`, { waitUntil: 'domcontentloaded' });
  return page;
}

/** Move the pretend clock forward and let the page's timer run. */
async function advance(page, minutes) {
  await page.evaluate(m => { window.__skip += m * 60000; window.__tick(); }, minutes);
}
async function background(page) { await page.evaluate(() => { window.__hidden = true; document.dispatchEvent(new Event('visibilitychange')); }); }
async function foreground(page) { await page.evaluate(() => { window.__hidden = false; document.dispatchEvent(new Event('visibilitychange')); }); }

/** What's on screen right now */
async function state(page) {
  return page.evaluate(() => {
    const vis = el => el && !el.hidden && getComputedStyle(el).display !== 'none';
    const f = document.querySelector('#video iframe');
    return {
      screen: vis(document.getElementById('video')) ? 'video' : vis(document.getElementById('wait')) ? 'waiting' : 'nothing',
      backButton: vis(document.getElementById('back')),
      iframe: !!f,
      frameId: f ? (f.dataset.t ||= Math.random().toString(36).slice(2)) : null,
      when: document.getElementById('when').textContent,
      until: document.getElementById('until').textContent,
      url: location.href
    };
  });
}

function check(name, s, expect) {
  const bad = Object.entries(expect).filter(([k, v]) => v instanceof RegExp ? !v.test(s[k]) : s[k] !== v);
  results.push({ name, ok: bad.length === 0, detail: bad.map(([k, v]) => `${k}: wanted ${v}, got ${JSON.stringify(s[k])}`).join('; ') });
}

// ---------- Scenarios ----------
const MON = '2026-11-09';  // Monday, Mass at 10:00

{ // 1. Waiting, then the video comes up by itself at 10 minutes before
  const p = await open(`${MON}T09:49`);
  check('1a 9:49 shows next Mass', await state(p), { screen: 'waiting', when: 'Today at 10 in the morning', until: "That's in 11 minutes." });
  await advance(p, 1.5);
  check('1b 9:50:30 video comes up by itself, no Back button', await state(p), { screen: 'video', backButton: false, iframe: true });
  await p.close();
}
{ // 2. Opening the app in the middle of Mass
  const p = await open(`${MON}T10:30`);
  check('2  opened at 10:30 goes straight to video', await state(p), { screen: 'video', backButton: false, iframe: true });
  await p.close();
}
{ // 3. Mass ends while she's still watching: don't take the video away
  const p = await open(`${MON}T10:30`);
  const before = await state(p);
  await advance(p, 50);  // 11:20
  const after = await state(p);
  check('3a Mass over but still watching: video stays', after, { screen: 'video' });
  check('3b ...and the video was not reloaded', after, { frameId: before.frameId });
  // 4. She switches away and comes back later
  await background(p); await foreground(p);
  check('4  back in the app after Mass: shows next Mass', await state(p), { screen: 'waiting', iframe: false, when: 'Wednesday at 10 in the morning', until: '' });
  await p.close();
}
{ // 5. Switches app mid-Mass and back again: video stays, not reloaded
  const p = await open(`${MON}T10:20`);
  const before = await state(p);
  await background(p); await advance(p, 20); await foreground(p);
  const after = await state(p);
  check('5  away and back during Mass: same video, not reloaded', after, { screen: 'video', frameId: before.frameId });
  await p.close();
}
{ // 6. "Open the video now" outside Mass time, then Back
  const p = await open(`${MON}T14:00`);
  await p.click('#anyway');
  check('6a Open the video now: video with Back button', await state(p), { screen: 'video', backButton: true, iframe: true });
  await advance(p, 5);
  check('6b ...timer does not take it away', await state(p), { screen: 'video', backButton: true });
  await background(p); await foreground(p);
  check('6c ...switching apps does not take it away', await state(p), { screen: 'video', backButton: true });
  await p.click('#back'); await new Promise(r => setTimeout(r, 300));
  check('6d Back: next Mass screen, video stopped', await state(p), { screen: 'waiting', iframe: false, when: 'Wednesday at 10 in the morning' });
  await p.close();
}
{ // 7. Opened by hand just before Mass, then Mass time arrives
  const p = await open(`${MON}T09:40`);
  await p.click('#anyway');
  await advance(p, 15);  // 9:55
  check('7a opened by hand at 9:40, still on at 9:55', await state(p), { screen: 'video' });
  await p.click('#back'); await new Promise(r => setTimeout(r, 300));
  check('7b Back during Mass time: video comes straight back, without Back button', await state(p), { screen: 'video', backButton: false });
  await p.close();
}
{ // 8. The phone's own Back button (Android) after "Open the video now"
  const p = await open(`${MON}T14:00`);
  await p.click('#anyway');
  await p.goBack({ timeout: 3000 }).catch(() => null); await new Promise(r => setTimeout(r, 300));
  const s = await state(p).catch(() => ({ screen: 'left the app' }));
  check("8  phone Back after Open the video now: returns to next Mass", s, { screen: 'waiting' });
  await p.close();
}
{ // 9. Phone Back again from the waiting screen leaves the app (normal), and Back twice doesn't loop
  const p = await open(`${MON}T14:00`);
  await p.click('#anyway');
  await p.goBack({ timeout: 3000 }).catch(() => null);
  await p.click('#anyway').catch(() => {});
  await p.click('#back').catch(() => {}); await new Promise(r => setTimeout(r, 300));
  const s = await state(p).catch(() => ({ screen: 'left the app' }));
  check('9  open, phone Back, open again, on-screen Back: next Mass screen', s, { screen: 'waiting' });
  await p.close();
}
{ // 9b. On-screen Back, then phone Back: must not bring the video back
  const p = await open(`${MON}T14:00`);
  await p.click('#anyway');
  await p.click('#back'); await new Promise(r => setTimeout(r, 300));
  await p.goBack({ timeout: 3000 }).catch(() => null); await new Promise(r => setTimeout(r, 300));
  const s = await state(p).catch(() => ({ screen: 'left the app' }));
  results.push({ name: '9b on-screen Back then phone Back: never back to the video', ok: s.screen !== 'video', detail: s.screen });
  // Forward again (Android has none, but a browser does) shouldn't break anything
  await p.click('#anyway').catch(() => {});
  results.push({ name: '9c after all that, Open the video now still works', ok: (await state(p).catch(() => ({}))).screen === 'video' || s.screen === 'left the app', detail: '' });
  await p.close();
}
{ // 9d. Phone Back during automatic Mass video (no Back button shown): nothing to go back to
  const p = await open(`${MON}T10:30`);
  const histLen = await p.evaluate(() => JSON.stringify(history.state));
  results.push({ name: '9d automatic video adds nothing to Back history', ok: histLen === 'null', detail: `history state ${histLen}` });
  await p.close();
}
{ // 10. Around the week: days with no Mass, weekend, wrap to next week
  const cases = [
    ['2026-11-10T09:55', 'waiting', 'Tomorrow at 10 in the morning', '10a Tuesday 9:55 (no Mass)'],
    ['2026-11-11T11:20', 'waiting', 'Friday at 10 in the morning', '10a2 Wednesday 11:20 (skips Thursday)'],
    ['2026-11-14T17:49', 'waiting', 'Today at 6 in the evening', '10b Saturday 17:49'],
    ['2026-11-14T17:51', 'video', null, '10c Saturday 17:51'],
    ['2026-11-14T19:30', 'waiting', 'Tomorrow at 11 in the morning', '10d Saturday 19:30'],
    ['2026-11-15T10:51', 'video', null, '10e Sunday 10:51'],
    ['2026-11-15T12:30', 'waiting', 'Tomorrow at 10 in the morning', '10f Sunday 12:30 (wraps to Monday)'],
    ['2026-11-13T11:16', 'waiting', 'Tomorrow at 6 in the evening', '10g Friday 11:16 (76 min after start)'],
    ['2026-11-13T11:14', 'video', null, '10h Friday 11:14 (74 min after start)'],
    ['2027-03-28T10:52', 'video', null, '10i Sunday after clocks go forward'],
    ['2027-10-31T10:52', 'video', null, '10j Sunday after clocks go back']
  ];
  for (const [t, screen, when, name] of cases) {
    const p = await open(t);
    check(name, await state(p), when ? { screen, when } : { screen });
    await p.close();
  }
}
{ // 11. Left open overnight on the waiting screen: words update, video comes up in the morning
  const p = await open('2026-11-08T21:00');  // Sunday night
  check('11a Sunday 21:00', await state(p), { when: 'Tomorrow at 10 in the morning' });
  await advance(p, 4 * 60);  // 01:00 Monday
  check('11b ...01:00 Monday says Today', await state(p), { when: 'Today at 10 in the morning' });
  await advance(p, 8 * 60 + 51);  // 09:51
  check('11c ...09:51 video has come up', await state(p), { screen: 'video', backButton: false });
  await p.close();
}
{ // 12. Other churches section
  const p = await open(`${MON}T17:40`);  // St John's has 17:45 Mass
  const closed = await p.$eval('#others', d => d.open);
  results.push({ name: '12a other churches folded away at first', ok: closed === false, detail: `open=${closed}` });
  await p.click('#others summary');
  const info = await p.evaluate(() => ({
    open: document.getElementById('others').open,
    links: [...document.querySelectorAll('#others a')].length,
    newTab: [...document.querySelectorAll('#others a')].every(a => a.target === '_blank'),
    cards: [...document.querySelectorAll('.venue')].map(v => ({ live: v.classList.contains('live'), next: v.querySelector('.next').textContent }))
  }));
  results.push({ name: '12b tapping opens it', ok: info.open, detail: '' });
  results.push({ name: '12c every church link opens in a new tab', ok: info.newTab && info.links === 20, detail: `${info.links} links` });
  results.push({ name: "12d St John's shows 'starts in 5 minutes' in red at 17:40", ok: info.cards[0].live && /starts in 5 minutes/.test(info.cards[0].next), detail: JSON.stringify(info.cards[0]) });
  results.push({ name: "12e St Mary's shows next Mass at 17:40", ok: !info.cards[1].live && /Tomorrow at 10/.test(info.cards[1].next), detail: JSON.stringify(info.cards[1]) });
  const popup = new Promise(r => browser.once('targetcreated', t => r(t.url())));
  await p.click('#church-list a');
  const url = await Promise.race([popup, new Promise(r => setTimeout(() => r(null), 3000))]);
  const s = await state(p);
  results.push({ name: '12f tapping a church opens a new tab, app stays on next Mass', ok: !!url && s.screen === 'waiting', detail: `new tab: ${url}; app: ${s.screen}` });
  await p.close();
}
{ // 13. Video fills the screen whichever way the phone is held
  for (const [name, size] of [['upright', { width: 412, height: 860 }], ['on its side', { width: 860, height: 412 }]]) {
    const p = await open(`${MON}T10:30`, size);
    const box = await p.$eval('#video iframe', f => { const r = f.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
    results.push({ name: `13 video fills screen, phone ${name}`, ok: box[0] === 0 && box[1] === 0 && box[2] === size.width && box[3] === size.height, detail: box.join(',') });
    await p.close();
  }
}

await browser.close();
const width = Math.max(...results.map(r => r.name.length));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.ok ? '' : r.detail}`);
console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`);
