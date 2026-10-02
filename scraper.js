// scraper.js — CU portal scraper (Puppeteer + REAL Chromium, bot-block proof).
//
// Kyun Puppeteer? Portal Node.js HTTP (axios) ko bot samajh kar CAPTCHA wala
// page hi nahi deta tha ("captcha-not-found"). Real Chromium me portal ko
// asli user dikhta hai — CAPTCHA milta hai, login hota hai.
//
// Design:
// - Har student ka ek persistent Chromium profile: data/profiles/<id>/
//   (cookies disk par auto-save — har baar dobara login nahi mangta).
// - Ek browser per student reuse hota hai (scheduler har 10 min chalata hai).
// - 25 min idle rahe to browser band (Redmi ki RAM bachao); agli baar
//   profile se cookies wapas load ho jati hain.
// - CAPTCHA flow: beginCaptchaLogin() stage1 submit -> CAPTCHA ka screenshot ->
//   pending Map (5 min) -> app image dikhata hai -> completePendingLogin().
// - pipeline.js / server.js me KOI change nahi chahiye: same exports;
//   client = { browser, page } (getPage/fetchDayWise andar page use karte hain).
//
// SERVER KABHI CAPTCHA SOLVE NAHI KARTA — sirf image app ko deta hai,
// student padh kar text wapas bhejta hai.

const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const BASE = config.portalBase;
const UA = 'Mozilla/5.0 (Linux; Android 13; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const PENDING_TTL_MS = 5 * 60 * 1000;   // pending captcha 5 min tak valid
const IDLE_CLOSE_MS  = 25 * 60 * 1000;  // 25 min idle -> browser band (RAM)
const NAV_TIMEOUT    = 60000;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
function dataDir() {
  const d = config.dataDir;
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}
function safeId(studentId) { return String(studentId || '').replace(/[^A-Za-z0-9_-]/g, '_'); }
// Persistent Chromium profile — cookies yahin auto-save hote hain.
function profileDir(studentId) {
  const d = path.join(dataDir(), 'profiles', safeId(studentId));
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}
function jarPath(studentId) {
  // Compat: purana jar path (ab profile use hota hai, ye sirf hasJar ke liye)
  return path.join(dataDir(), 'jars', safeId(studentId) + '.json');
}
function captchaPath(studentId) {
  const d = path.join(dataDir(), 'captcha');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return path.join(d, safeId(studentId) + '.png');
}
function isPng(buf) {
  return buf && buf.length > 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
}

// ---------------------------------------------------------------------------
// Chromium dhoondho (Termux + normal Linux dono)
// ---------------------------------------------------------------------------
const CHROMIUM_CANDIDATES = [
  process.env.CHROMIUM_PATH,
  '/data/data/com.termux/files/usr/bin/chromium',
  '/data/data/com.termux/files/usr/bin/chromium-browser',
  '/data/data/com.termux/files/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].filter(Boolean);

let _chromiumPath = null;
function findChromium() {
  if (_chromiumPath) return _chromiumPath;
  for (const p of CHROMIUM_CANDIDATES) {
    try { if (p && fs.existsSync(p)) { _chromiumPath = p; return p; } } catch {}
  }
  try {
    const out = require('child_process')
      .execSync('command -v chromium 2>/dev/null || command -v chromium-browser 2>/dev/null || true', { encoding: 'utf8' })
      .trim().split('\n')[0];
    if (out) { _chromiumPath = out; return out; }
  } catch {}
  throw new Error('Chromium nahi mila! install-chrome.sh chalao (pkg install chromium)');
}

// ---------------------------------------------------------------------------
// Browser pool — ek browser per student, reuse hota hai
// ---------------------------------------------------------------------------
const browsers = new Map(); // studentId -> { browser, page, lastUsed }

async function launchBrowser(studentId) {
  let executablePath;
  try { executablePath = findChromium(); } catch { executablePath = undefined; }
  console.log(`[scraper] ${studentId}: Chromium launch ho raha hai...`);
  const browser = await puppeteer.launch({
    ...(executablePath ? { executablePath } : {}),
    headless: true,
    userDataDir: profileDir(studentId),
    timeout: 60000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-client-side-phishing-detection',
      '--disable-hang-monitor',
      '--disable-popup-blocking',
      '--disable-prompt-on-repost',
      '--disable-sync',
      '--metrics-recording-only',
      '--safebrowsing-disable-auto-update',
      '--no-zygote',
      '--mute-audio',
    ],
  });
  return browser;
}

async function newPortalPage(browser) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
  await page.setUserAgent(UA);
  await page.setViewport({ width: 360, height: 640, isMobile: true, hasTouch: true });
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  page.setDefaultTimeout(30000);
  return page;
}

function touchBrowser(studentId) {
  const e = browsers.get(studentId);
  if (e) e.lastUsed = Date.now();
}

async function closeBrowser(studentId) {
  const e = browsers.get(studentId);
  browsers.delete(studentId);
  if (e) {
    try { await e.browser.close(); } catch {}
    console.log(`[scraper] ${studentId}: browser band`);
  }
}

// 25 min se idle browsers band karo (pending wale ko haath nahi).
async function pruneIdleBrowsers() {
  const now = Date.now();
  for (const [id, e] of browsers) {
    if (pending.has(id)) continue;
    if (now - e.lastUsed > IDLE_CLOSE_MS) {
      console.log(`[scraper] ${id}: idle browser band kar rahe (RAM bachao)`);
      await closeBrowser(id);
    }
  }
}

async function getBrowser(studentId) {
  prunePending();
  await pruneIdleBrowsers();
  let e = browsers.get(studentId);
  if (e && typeof pending !== 'undefined' && pending.has(studentId)) { e.lastUsed = Date.now(); return e; }
  if (e && e.browser && !e.page.isClosed()) {
    e.lastUsed = Date.now();
    return e;
  }
  if (e) { try { await e.browser.close(); } catch {} browsers.delete(studentId); }
  const browser = await launchBrowser(studentId);
  const page = await newPortalPage(browser);
  e = { browser, page, lastUsed: Date.now() };
  browsers.set(studentId, e);
  return e;
}

function wrapClient(browser, page) {
  return { browser, page };
}

async function closeAllBrowsers() {
  for (const id of [...browsers.keys()]) await closeBrowser(id);
}
process.on('SIGTERM', () => { closeAllBrowsers().finally(() => process.exit(0)); });
process.on('SIGINT', () => { closeAllBrowsers().finally(() => process.exit(0)); });

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------
async function waitNav(page, timeout = 15000) {
  try {
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout });
  } catch {
    // timeout ya bina navigation ke postback — page state aage check hogi
  }
}

// Network shaant hone do (thoda), warna aage badho.
async function settle(page) {
  try {
    if (typeof page.waitForNetworkIdle === 'function') {
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 });
      return;
    }
  } catch {}
  await new Promise(r => setTimeout(r, 1500));
}

// Submit-type button dhoondh kar click + navigation wait.
async function clickSubmit(page) {
  const handle = await page.evaluateHandle(() => {
    const sels = ['input[type="submit"]', 'input[type="button"]', 'button[type="submit"]', 'button'];
    for (const s of sels) {
      const els = Array.from(document.querySelectorAll(s));
      for (const el of els) {
        const t = ((el.value || el.textContent || '') + ' ' + (el.id || '') + ' ' + (el.name || '')).toLowerCase();
        if (/login|submit|next|continue|sign|verify/.test(t)) return el;
      }
    }
    for (const s of sels) { const el = document.querySelector(s); if (el) return el; }
    return null;
  });
  const el = handle.asElement();
  if (!el) { try { await handle.dispose(); } catch {} return false; }
  await Promise.all([page.waitForResponse(r => r.status() === 200, {timeout: 10000}).catch(() => null), el.click().catch(() => {})]); await new Promise(r => setTimeout(r, 800));
  try { await handle.dispose(); } catch {}
  return true;
}

// CAPTCHA <img> element dhoondho (page ke andar).
async function findCaptchaElement(page) {
  const handle = await page.evaluateHandle(() => {
    const imgs = Array.from(document.querySelectorAll('img'));
    for (const img of imgs) {
      const s = ((img.currentSrc || img.src || '')).toLowerCase();
      const meta = ((img.id || '') + ' ' + (img.className || '') + ' ' + (img.alt || '')).toLowerCase();
      if (s.includes('captcha') || meta.includes('captcha')) return img;
    }
    for (const img of imgs) {
      const s = (img.currentSrc || img.src || '').toLowerCase();
      if (/captchaimage|getcaptcha|showcaptcha|generatecaptcha/i.test(s)) return img;
    }
    return null;
  });
  const el = handle.asElement();
  if (!el) { try { await handle.dispose(); } catch {} return null; }
  const box = await el.boundingBox().catch(() => null);
  if (!box || box.width < 5 || box.height < 5) { try { await handle.dispose(); } catch {} return null; }
  return el;
}

// ---------------------------------------------------------------------------
// ASP.NET helpers (pure — tests in par depend karte hain, mat badlo)
// ---------------------------------------------------------------------------
const ASP_FIELDS = ['__VIEWSTATE', '__VIEWSTATEGENERATOR', '__EVENTVALIDATION',
  '__EVENTTARGET', '__EVENTARGUMENT', '__LASTFOCUS'];

// Har POST se PEHLE page ke TAAZA hidden fields lo (purana viewstate = error).
function aspFields($) {
  const f = {};
  ASP_FIELDS.forEach(n => {
    const v = $(`input[name="${n}"]`).attr('value');
    if (v !== undefined && v !== null) f[n] = v;
  });
  return f;
}

// Login page ka stage pehchano.
function detectLoginStage($) {
  const pwCount = $('input[type="password"]').length;
  if (pwCount > 0) return 'stage2';
  const txtCount = $('input[type="text"]').length;
  if (txtCount > 0) return 'stage1';
  return 'unknown';
}

function isLoginHtml($, url) {
  if (/login\.aspx/i.test(url || '')) return true;
  // login form ke nishaan: password field ya captcha image
  return detectLoginStage($) !== 'unknown';
}

function pageError($) {
  const t = $.text();
  if (/invalid captcha/i.test(t)) return 'bad-captcha';
  if (/invalid (user|username|password)|login failed|authentication failed/i.test(t)) return 'bad-credentials';
  return '';
}

function findCaptchaSrc($) {
  let src = '';
  $('img').each((_, el) => {
    const $el = $(el);
    const s = ($el.attr('src') || '').toLowerCase();
    const meta = (($el.attr('id') || '') + ' ' + ($el.attr('class') || '') + ' ' + ($el.attr('alt') || '')).toLowerCase();
    if (s.includes('captcha') || meta.includes('captcha')) { src = $el.attr('src'); return false; }
  });
  // fallback: CaptchaImage.aspx jaise common naam
  if (!src) {
    $('img').each((_, el) => {
      const s = ($(el).attr('src') || '').toLowerCase();
      if (/captchaimage|getcaptcha|showcaptcha|generatecaptcha/i.test(s)) { src = $(el).attr('src'); return false; }
    });
  }
  if (!src) return '';
  if (src.startsWith('http')) return src;
  if (src.startsWith('/')) return BASE + src;
  return BASE + '/' + src;
}

// ---------------------------------------------------------------------------
// Client compat (purana interface)
// ---------------------------------------------------------------------------
// Naya browser+page lao (testing/compat ke liye). Pipeline isko directly
// use nahi karta — ensureLoggedIn andar se browser pool chalata hai.
async function newClient() {
  const sid = 'tmp-' + Date.now();
  const browser = await launchBrowser(sid);
  const page = await newPortalPage(browser);
  // tmp profile turant saaf — ye client session save nahi karta
  return wrapClient(browser, page);
}

// Profile me cookies auto-save hote hain — ye sirf compat ke liye hai.
function saveJar(studentId, client) {
  try { fs.mkdirSync(profileDir(studentId), { recursive: true }); } catch {}
}
function loadJar(studentId) { return null; } // cookies profile me hain
function hasJar(studentId) {
  try {
    const d = path.join(profileDir(studentId), 'Default');
    return fs.existsSync(d) && fs.readdirSync(d).length > 0;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Page fetch (pipeline inhi ko bulata hai)
// ---------------------------------------------------------------------------
// Arbitrary page lao; login redirect pakdo.
async function getPage(client, p) {
  const { page } = client;
  const url = p.startsWith('http') ? p : BASE + p;
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await settle(page);
  const html = await page.content();
  const finalUrl = page.url();
  const $ = cheerio.load(html);
  return { status: resp ? resp.status() : 200, html, $, url: finalUrl, loggedOut: isLoginHtml($, finalUrl) };
}

// LandingPage -> "Go to Home Page" -> StudentHome (zaroorat pade to).
async function gotoDashboard(client) {
  const { page } = client;
  let resp = await page.goto(BASE + '/StudentHome.aspx', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await settle(page);
  let html = await page.content();
  let url = page.url();
  let $ = cheerio.load(html);
  let loggedOut = isLoginHtml($, url);
  if (!loggedOut && /landingpage\.aspx/i.test(url)) {
    const clicked = await page.evaluate(() => {
      const as = Array.from(document.querySelectorAll('a'));
      for (const a of as) {
        if ((a.textContent || '').toLowerCase().includes('go to home')) { a.click(); return true; }
      }
      return false;
    });
    if (clicked) {
      await new Promise(r => setTimeout(r, 2000));
      html = await page.content();
      url = page.url();
      $ = cheerio.load(html);
      loggedOut = isLoginHtml($, url);
    }
  }
  return { status: resp ? resp.status() : 200, html, $, url, loggedOut };
}

// Dashboard HTML se attendance summary ka link (token wala) nikalo.
function extractSummaryUrl(dashboardHtml) {
  const $ = cheerio.load(dashboardHtml || '');
  let href = '';
  $('a').each((_, el) => {
    const h = $(el).attr('href') || '';
    if (/frmStudentCourseWiseAttendanceSummary\.aspx/i.test(h)) { href = h; return false; }
  });
  if (!href) return '/frmStudentCourseWiseAttendanceSummary.aspx'; // fallback (token bina)
  if (href.startsWith('http')) return href;
  if (href.startsWith('/')) return href;
  return '/' + href;
}

// ---------------------------------------------------------------------------
// Login flow (page-based; purane naam, nayi engine)
// ---------------------------------------------------------------------------
async function getLoginPage(client) {
  const { page } = client;
  const resp = await page.goto(BASE + '/Login.aspx', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await settle(page);
  const html = await page.content();
  const url = page.url();
  const $ = cheerio.load(html);
  return { page, $, html, url, status: resp ? resp.status() : 200, fields: aspFields($), stage: detectLoginStage($) };
}

// Stage 1: username submit karo -> stage 2 page milega.
async function submitStage1(client, loginPage, studentId) {
  const { page } = client;
  const userInput = await page.$('input[type="text"]');
  if (!userInput) return { ok: false, reason: 'no-username-field' };
  await userInput.click({ clickCount: 3 }).catch(() => {});
  await userInput.type(String(studentId), { delay: 20 });
  if (!(await clickSubmit(page))) return { ok: false, reason: 'no-submit-button' };
  await settle(page);
  const html = await page.content();
  const url = page.url();
  const $ = cheerio.load(html);
  return { ok: true, $, html, url, stage: detectLoginStage($) };
}

// Stage 2: password + user-diya-captcha submit karo.
async function doStage2Submit(page, password, captchaText) {
  const pwEl = await page.$('input[type="password"]');
  if (pwEl) { await pwEl.click({ clickCount: 3 }).catch(() => {}); await pwEl.type(String(password), { delay: 15 }); }
  // captcha field: naam/id me 'captcha' ho; na mile to aakhri text input
  const capHandle = await page.evaluateHandle(() => {
    const texts = Array.from(document.querySelectorAll('input[type="text"]'));
    for (const t of texts) {
      const m = ((t.name || '') + ' ' + (t.id || '')).toLowerCase();
      if (m.includes('captcha')) return t;
    }
    return texts.length ? texts[texts.length - 1] : null;
  });
  const capInput = capHandle.asElement();
  if (!capInput) { try { await capHandle.dispose(); } catch {} return { ok: false, reason: 'no-captcha-field' }; }
  await capInput.click({ clickCount: 3 }).catch(() => {});
  await capInput.type(String(captchaText).trim(), { delay: 15 });
  try { await capHandle.dispose(); } catch {}
  if (!(await clickSubmit(page))) return { ok: false, reason: 'no-submit-button' };
  await new Promise(r => setTimeout(r, 3000));
  const html = await page.content();
  const $ = cheerio.load(html);
  const perr = pageError($);
  if (perr) return { ok: false, reason: perr };
  return { ok: true, $, html, url: page.url() };
}

async function submitStage2(client, stage2, password, captchaText) {
  return doStage2Submit(client.page, password, captchaText);
}

// ---------------------------------------------------------------------------
// CAPTCHA orchestration (pending Map me browser+page rehta hai, 5 min)
// ---------------------------------------------------------------------------
const pending = new Map(); // studentId -> { browser, page, password, createdAt }

function prunePending() {
  const now = Date.now();
  for (const [k, v] of pending) {
    if (now - v.createdAt > PENDING_TTL_MS) {
      pending.delete(k);
      // browser pool me rehne do — session reuse ho sakta hai
    }
  }
}

// Login shuru karo: stage1 -> stage2 -> captcha screenshot lo, pending me rakho.
// App GET /captcha/:id se image lega, student padhega, POST /captcha/:id se text aayega.
async function beginCaptchaLogin(studentId, password) {
  prunePending();
  if (pending.has(studentId)) return { ok: false, reason: 'captcha-needed' }; // pehle se wait ho raha
  let entry;
  try {
    entry = await getBrowser(studentId);
  } catch (e) {
    console.log(`[scraper] ${studentId}: browser launch fail: ${e.message}`);
    return { ok: false, reason: 'browser-launch-fail', detail: e.message };
  }
  const { browser, page } = entry;
  try {
    await page.goto(BASE + '/Login.aspx', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await settle(page);
    let $ = cheerio.load(await page.content());
    let url = page.url();
    let stage = detectLoginStage($);

    // Pehle se logged in? (profile ke cookies kaam kar gaye)
    if (stage === 'unknown' && /studenthome|landingpage/i.test(url)) {
      touchBrowser(studentId);
      console.log(`[scraper] ${studentId}: purana session zinda — captcha nahi chahiye`);
      return { ok: true, client: wrapClient(browser, page) };
    }

    // Stage 1 (agar seedha stage2 dikhe to username step skip)
    if (stage === 'stage1') {
      const userInput = await page.$('input[type="text"]');
      if (!userInput) { await closeBrowser(studentId); return { ok: false, reason: 'no-username-field' }; }
      await userInput.click({ clickCount: 3 }).catch(() => {});
      await userInput.type(String(studentId), { delay: 20 });
      if (!(await clickSubmit(page))) { await closeBrowser(studentId); return { ok: false, reason: 'no-submit-button' }; }
      await settle(page);
      $ = cheerio.load(await page.content());
      url = page.url();
      stage = detectLoginStage($);
    }

    // Stage1 ke baad seedha dashboard? (kabhi-kabhi captcha nahi mangta)
    if (/landingpage\.aspx|studenthome\.aspx/i.test(url) && !isLoginHtml($, url)) {
      touchBrowser(studentId);
      console.log(`[scraper] ${studentId}: seedha dashboard — captcha nahi chahiye`);
      return { ok: true, client: wrapClient(browser, page) };
    }
    if (stage !== 'stage2') {
      const perr = pageError($);
      await closeBrowser(studentId);
      return { ok: false, reason: perr || 'stage2-not-reached', detail: stage + ' @ ' + url };
    }

    // Stage 2: CAPTCHA ka screenshot lo (real browser — bot-block nahi!)
    const capEl = await findCaptchaElement(page);
    if (!capEl) { await closeBrowser(studentId); return { ok: false, reason: 'captcha-not-found' }; }
    const pngPath = captchaPath(studentId);
    await capEl.screenshot({ path: pngPath });
    try { fs.chmodSync(pngPath, 0o600); } catch {}
    const png = fs.readFileSync(pngPath);
    if (!isPng(png)) { await closeBrowser(studentId); return { ok: false, reason: 'captcha-not-png' }; }

    pending.set(studentId, { browser, page, password: String(password), createdAt: Date.now() });
    touchBrowser(studentId);
    console.log(`[scraper] ${studentId}: captcha ready (${png.length} bytes), student input ka intezaar`);
    return { ok: false, reason: 'captcha-needed' };
  } catch (e) {
    if (typeof pending === "undefined" || !pending.has(studentId)) { await closeBrowser(studentId); }
    console.log(`[scraper] ${studentId}: beginCaptchaLogin error: ${e.message}`);
    return { ok: false, reason: 'network-error', detail: e.message };
  }
}

// App ne captcha text bheja -> login poora karo.
async function completePendingLogin(studentId, captchaText) {
  prunePending();
  const p = pending.get(studentId);
  if (!p) return { ok: false, reason: 'no-pending-login' };
  pending.delete(studentId);
  const { browser, page, password } = p;
  try {
    const res = await doStage2Submit(page, password, captchaText);
    if (!res.ok) {
      console.log(`[scraper] ${studentId}: stage2 fail (${res.reason})`);
      if (res.reason === 'bad-captcha') {
        // server.js naya captcha mangwayega — purana browser band, naya banega
//        await closeBrowser(studentId);
      }
      return { ok: false, reason: res.reason };
    }
    // verify: dashboard khul raha hai?
    const dash = await gotoDashboard(wrapClient(browser, page));
    if (dash.loggedOut) { await closeBrowser(studentId); return { ok: false, reason: 'verify-failed' }; }
    touchBrowser(studentId);
    console.log(`[scraper] ${studentId}: login OK`);
    return { ok: true, client: wrapClient(browser, page) };
  } catch (e) {
    return { ok: false, reason: 'network-error', detail: e.message };
  }
}

function hasPendingLogin(studentId) {
  prunePending();
  return pending.has(studentId);
}

// Session ensure karo: purana profile try karo -> dashboard check -> zaroorat ho to captcha flow.
async function ensureLoggedIn(studentId, password) {
  if (!password) return { ok: false, reason: 'no-credentials' };
  if (hasPendingLogin(studentId)) return { ok: false, reason: 'captcha-needed' };
  // 1) purana session (persistent profile cookies)
  try {
    const entry = await getBrowser(studentId);
    const client = wrapClient(entry.browser, entry.page);
    const dash = await gotoDashboard(client);
    if (!dash.loggedOut && dash.status === 200) {
      touchBrowser(studentId);
      return { ok: true, client, reused: true };
    }
    console.log(`[scraper] ${studentId}: purana session expire, dobara login`);
  } catch (e) {
    console.log(`[scraper] ${studentId}: session check me error: ${e.message}`);
  }
  // 2) full login (captcha flow)
  try {
    const res = await beginCaptchaLogin(studentId, password);
    if (res.ok) return { ok: true, client: res.client, reused: false };
    return res; // { ok:false, reason:'captcha-needed' | ... }
  } catch (e) {
    return { ok: false, reason: 'network-error', detail: e.message };
  }
}

// ---------------------------------------------------------------------------
// Day-wise attendance modal
// ---------------------------------------------------------------------------
// Portal ka getdata(this) sabse sambhav ASP.NET WebMethod ko AJAX POST karta
// hai (frmStudentCourseWiseAttendanceSummary.aspx/<Method> with JSON
// {obj, chk} -> {d: "<table>...</table>"}). Real browser ke andar fetch()
// chalane se cookies/session automatic — koi jar jugad nahi.
// Kaam karne wali strategy yaad rehti hai (daywiseStrategy).
let daywiseStrategy = null; // 'webmethod:<name>' | 'postback' | 'get-query'

const WEBMETHOD_NAMES = ['GetAttendanceDetails', 'GetAttendance', 'getdata', 'GetData', 'BindAttendance'];

async function tryParseDaywise(html) {
  try {
    const { parseDayWise } = require('./parsers/daywise');
    const rows = parseDayWise(html || '');
    return rows;
  } catch { return []; }
}

async function fetchDayWiseBrowser(client, summaryUrl, summaryHtml, code) {
  const { page } = client;
  const log = [];
  const $ = cheerio.load(summaryHtml || '');
  let chk = '', obj = code;
  $('input[value="View"]').each((_, el) => {
    const o = $(el).attr('obj') || '';
    if (o === code || (!chk && o)) { obj = o || code; chk = $(el).attr('chk') || ''; }
  });
  const note = (s) => { log.push(s); console.log(`[daywise:${code}] ${s}`); };
  const absSummary = summaryUrl.startsWith('http') ? summaryUrl : BASE + summaryUrl;
  const webMethodBase = absSummary.split('?')[0]; // WebMethod URL me query nahi

  const attempts = [];
  // 1) yaad ki hui strategy pehle
  if (daywiseStrategy && daywiseStrategy.startsWith('webmethod:')) {
    attempts.push({ kind: 'webmethod', name: daywiseStrategy.slice(10) });
  }
  if (daywiseStrategy === 'postback') attempts.push({ kind: 'postback' });
  if (daywiseStrategy === 'get-query') attempts.push({ kind: 'get-query' });
  // 2) phir saari webmethods
  WEBMETHOD_NAMES.forEach(n => {
    if (!attempts.some(a => a.kind === 'webmethod' && a.name === n)) attempts.push({ kind: 'webmethod', name: n });
  });
  // 3) phir postback + get-query
  if (!attempts.some(a => a.kind === 'postback')) attempts.push({ kind: 'postback' });
  if (!attempts.some(a => a.kind === 'get-query')) attempts.push({ kind: 'get-query' });

  for (const a of attempts) {
    try {
      let html = '';
      if (a.kind === 'webmethod') {
        const r = await page.evaluate(async (url, payload) => {
          const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify(payload),
            credentials: 'include',
          });
          return { status: resp.status, text: await resp.text() };
        }, webMethodBase + '/' + a.name, { obj, chk });
        let d = r.text;
        try { d = JSON.parse(r.text); } catch { /* raw html */ }
        html = (d && d.d) ? d.d : (typeof d === 'string' ? d : '');
        note(`webmethod ${a.name}: status=${r.status} htmlLen=${html.length}`);
      } else if (a.kind === 'postback') {
        // __doPostBack replication: TAAZE viewstate + obj/chk fields
        const fields = aspFields(cheerio.load(await page.content()));
        if (!Object.keys(fields).length) Object.assign(fields, aspFields($));
        fields.__EVENTTARGET = '';
        fields.__EVENTARGUMENT = '';
        fields.obj = obj;
        if (chk) fields.chk = chk;
        const body = new URLSearchParams(fields).toString();
        const r = await page.evaluate(async (url, bodyStr) => {
          const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: bodyStr,
            credentials: 'include',
          });
          return { status: resp.status, text: await resp.text() };
        }, absSummary, body);
        html = r.text;
        note(`postback: status=${r.status} htmlLen=${html.length}`);
      } else {
        const sep = absSummary.includes('?') ? '&' : '?';
        await page.goto(`${absSummary}${sep}obj=${encodeURIComponent(obj)}&chk=${encodeURIComponent(chk)}`,
          { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        await settle(page);
        html = await page.content();
        note(`get-query: htmlLen=${html.length}`);
      }
      const rows = await tryParseDaywise(html);
      if (rows.length > 0) {
        daywiseStrategy = a.kind === 'webmethod' ? 'webmethod:' + a.name : a.kind;
        note(`SUCCESS via ${daywiseStrategy} (${rows.length} rows)`);
        return { rows, strategy: daywiseStrategy, log };
      }
    } catch (e) {
      note(`${a.kind} error: ${e.message}`);
    }
  }
  note('KOI strategy kaam nahi ki — portal ka getdata() JS check karna padega');
  return { rows: [], strategy: 'none', log };
}

// Legacy HTTP client (axios-style {post,get}) ke liye purana implementation —
// tests aur koi bhi purana caller isi par chalta hai. Asli pipeline hamesha
// browser client bhejta hai (fetchDayWiseBrowser).
async function fetchDayWiseLegacy(client, summaryUrl, summaryHtml, code) {
  const log = [];
  const $ = cheerio.load(summaryHtml || '');
  let chk = '', obj = code;
  $('input[value="View"]').each((_, el) => {
    const o = $(el).attr('obj') || '';
    if (o === code || (!chk && o)) { obj = o || code; chk = $(el).attr('chk') || ''; }
  });
  const note = (s) => { log.push(s); console.log(`[daywise:${code}] ${s}`); };

  const attempts = [];
  // 1) yaad ki hui strategy pehle
  if (daywiseStrategy && daywiseStrategy.startsWith('webmethod:')) {
    attempts.push({ kind: 'webmethod', name: daywiseStrategy.slice(10) });
  }
  if (daywiseStrategy === 'postback') attempts.push({ kind: 'postback' });
  if (daywiseStrategy === 'get-query') attempts.push({ kind: 'get-query' });
  // 2) phir saari webmethods
  WEBMETHOD_NAMES.forEach(n => {
    if (!attempts.some(a => a.kind === 'webmethod' && a.name === n)) attempts.push({ kind: 'webmethod', name: n });
  });
  // 3) phir postback + get-query
  if (!attempts.some(a => a.kind === 'postback')) attempts.push({ kind: 'postback' });
  if (!attempts.some(a => a.kind === 'get-query')) attempts.push({ kind: 'get-query' });

  for (const a of attempts) {
    try {
      let html = '';
      if (a.kind === 'webmethod') {
        const r = await client.post(summaryUrl + '/' + a.name,
          JSON.stringify({ obj, chk }),
          { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
        let d = r.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch { /* raw html */ } }
        html = (d && d.d) ? d.d : (typeof d === 'string' ? d : '');
        note(`webmethod ${a.name}: status=${r.status} htmlLen=${html.length}`);
      } else if (a.kind === 'postback') {
        // __doPostBack replication: viewstate + obj/chk fields
        const form = new URLSearchParams({ ...aspFields($), __EVENTTARGET: '', __EVENTARGUMENT: '' });
        form.set('obj', obj);
        if (chk) form.set('chk', chk);
        const r = await client.post(summaryUrl, form.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        html = typeof r.data === 'string' ? r.data : '';
        note(`postback: status=${r.status} htmlLen=${html.length}`);
      } else {
        const sep = summaryUrl.includes('?') ? '&' : '?';
        const r = await client.get(`${summaryUrl}${sep}obj=${encodeURIComponent(obj)}&chk=${encodeURIComponent(chk)}`);
        html = typeof r.data === 'string' ? r.data : '';
        note(`get-query: status=${r.status} htmlLen=${html.length}`);
      }
      const rows = await tryParseDaywise(html);
      if (rows.length > 0) {
        daywiseStrategy = a.kind === 'webmethod' ? 'webmethod:' + a.name : a.kind;
        note(`SUCCESS via ${daywiseStrategy} (${rows.length} rows)`);
        return { rows, strategy: daywiseStrategy, log };
      }
    } catch (e) {
      note(`${a.kind} error: ${e.message}`);
    }
  }
  note('KOI strategy kaam nahi ki — portal ka getdata() JS check karna padega');
  return { rows: [], strategy: 'none', log };
}

// Dispatcher: browser client -> real-Chromium path, warna legacy HTTP path.
async function fetchDayWise(client, summaryUrl, summaryHtml, code) {
  if (client && client.page) return fetchDayWiseBrowser(client, summaryUrl, summaryHtml, code);
  return fetchDayWiseLegacy(client, summaryUrl, summaryHtml, code);
}

module.exports = {
  BASE,
  newClient, saveJar, loadJar, hasJar,
  aspFields, detectLoginStage, findCaptchaSrc, isLoginHtml, pageError,
  getLoginPage, submitStage1, submitStage2,
  getPage, gotoDashboard, extractSummaryUrl,
  ensureLoggedIn, beginCaptchaLogin, completePendingLogin, hasPendingLogin,
  fetchDayWise,
  captchaPath,
};
