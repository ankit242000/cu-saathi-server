// scraper.js — CU portal scraper (axios + cookie jar, NO browser, NO CAPTCHA solving).
//
// Portal facts (verified 29-30 Sep 2026, sanitized spec only):
// - Base: https://students.cuchd.in
// - Login is 2-STAGE:
//     Stage 1: Login.aspx shows USERNAME field only -> submit -> server
//     Stage 2: page shows PASSWORD + CAPTCHA image -> submit both ->
//              LandingPage.aspx -> "Go to Home Page" -> StudentHome.aspx
// - CAPTCHA expires in ~1 min. Server NEVER solves it: hum image nikaal kar
//   app ko dete hain, student padh kar text wapas bhejta hai.
// - Attendance summary URL me per-session token hota hai:
//     frmStudentCourseWiseAttendanceSummary.aspx?type=<token>
//   Isko dashboard HTML se nikaalo, hardcode MAT karo.
// - Day-wise attendance summary page par MODAL hai (koi alag URL nahi).
//   Har subject row me "View" button:
//     <input type="button" chk="<SESSION_TOKEN>" obj="<COURSE_CODE>"
//            value="View" onclick="getdata(this)">
//   getdata() ka JS implementation fixture me NAHI hai (sirf structure hai),
//   isliye fetchDayWise() multiple strategies try karta hai aur jo kaam kare
//   usko yaad rakhta hai. Pehli real-portal run par log me dikhega kaunsi
//   strategy kaam ki — usko phir primary bana dena.
//
// Cookie jars disk par persist hote hain (data/jars/<studentId>.json, 0600)
// taaki scheduler har 10 min me dobara login na maange.

const axios = require('axios');
const cheerio = require('cheerio');
const { wrapper } = require('axios-cookiejar-support');
const tough = require('tough-cookie');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const BASE = config.portalBase;
const UA = 'Mozilla/5.0 (Linux; Android 10) CU-Saathi-Server/2.0';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
function dataDir() {
  const d = config.dataDir;
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}
function safeId(studentId) { return String(studentId || '').replace(/[^A-Za-z0-9_-]/g, '_'); }
function jarPath(studentId) {
  const d = path.join(dataDir(), 'jars');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return path.join(d, safeId(studentId) + '.json');
}
function captchaPath(studentId) {
  const d = path.join(dataDir(), 'captcha');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return path.join(d, safeId(studentId) + '.png');
}

// ---------------------------------------------------------------------------
// HTTP client (per-student cookie jar)
// ---------------------------------------------------------------------------
function newClient(jar) {
  const c = wrapper(axios.create({
    jar: jar || new tough.CookieJar(),
    withCredentials: true,
    timeout: 30000,
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    maxRedirects: 5,
    validateStatus: () => true, // status hum khud check karenge
  }));
  return c;
}

function saveJar(studentId, client) {
  try {
    const jar = client.defaults.jar;
    if (!jar) return;
    fs.writeFileSync(jarPath(studentId), JSON.stringify(jar.toJSON()), { mode: 0o600 });
  } catch (e) { console.log('[scraper] jar save fail:', e.message); }
}

function loadJar(studentId) {
  try {
    const p = jarPath(studentId);
    if (!fs.existsSync(p)) return null;
    return tough.CookieJar.fromJSON(JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch (e) { console.log('[scraper] jar load fail:', e.message); return null; }
}

function hasJar(studentId) {
  try { return fs.existsSync(jarPath(studentId)); } catch { return false; }
}

// ---------------------------------------------------------------------------
// ASP.NET helpers
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
// stage1 = sirf username (koi password field nahi)
// stage2 = password + captcha
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

// ---------------------------------------------------------------------------
// Login flow
// ---------------------------------------------------------------------------
async function getLoginPage(client) {
  const r = await client.get(BASE + '/Login.aspx');
  const url = r.request?.res?.responseUrl || (BASE + '/Login.aspx');
  const html = typeof r.data === 'string' ? r.data : '';
  const $ = cheerio.load(html);
  return { $, html, url, status: r.status, fields: aspFields($), stage: detectLoginStage($) };
}

// Form ka action URL nikalo (default: Login.aspx).
function formAction($, inputEl) {
  const form = $(inputEl).closest('form');
  let action = form.attr('action') || '/Login.aspx';
  if (action.startsWith('/')) return BASE + action;
  if (/^https?:/i.test(action)) return action;
  return BASE + '/' + action;
}

// Stage 1: username submit karo -> stage 2 page milega.
async function submitStage1(client, loginPage, studentId) {
  const { $ } = loginPage;
  // username field: pehla text input (captcha stage1 me nahi hota)
  const userInput = $('input[type="text"]').first();
  if (!userInput.length) return { ok: false, reason: 'no-username-field' };
  const action = formAction($, userInput);
  const form = new URLSearchParams({ ...aspFields($) });
  form.set(userInput.attr('name'), studentId);
  // submit button (naam wala) — "Next" / "Continue" / "Login" kuch bhi ho
  const btn = $(userInput).closest('form').find('input[type="submit"], input[type="button"], button[type="submit"]').first();
  if (btn.length && btn.attr('name')) form.set(btn.attr('name'), btn.attr('value') || 'Submit');

  const r = await client.post(action, form.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': loginPage.url },
  });
  const url = r.request?.res?.responseUrl || action;
  const html = typeof r.data === 'string' ? r.data : '';
  const $$ = cheerio.load(html);
  return { ok: true, $, html, url, status: r.status, fields: aspFields($$), stage: detectLoginStage($$) };
}

// Captcha <img> dhoondho.
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
      if (/captchaimage|getcaptcha|showcaptcha/i.test(s)) { src = $(el).attr('src'); return false; }
    });
  }
  if (!src) return '';
  if (src.startsWith('http')) return src;
  if (src.startsWith('/')) return BASE + src;
  return BASE + '/' + src;
}

async function fetchCaptchaPng(client, src, referer) {
  const r = await client.get(src, {
    responseType: 'arraybuffer',
    headers: { 'Referer': referer || (BASE + '/Login.aspx') },
  });
  if (r.status !== 200 || !r.data) throw new Error('captcha-download-fail:' + r.status);
  return Buffer.from(r.data);
}

// Stage 2: password + user-diya-captcha submit karo.
async function submitStage2(client, stage2, password, captchaText) {
  const { $ } = stage2;
  const pwInput = $('input[type="password"]').first();
  if (!pwInput.length) return { ok: false, reason: 'no-password-field' };
  // captcha field: naam/id me 'captcha' ho; na mile to akela bacha text input
  let capInput = $('input[type="text"]').filter((_, el) => {
    const m = (($(el).attr('name') || '') + ' ' + ($(el).attr('id') || '')).toLowerCase();
    return m.includes('captcha');
  }).first();
  if (!capInput.length) {
    const texts = $('input[type="text"]');
    if (texts.length === 1) capInput = texts.first();
  }
  const action = formAction($, pwInput);
  const form = new URLSearchParams({ ...aspFields($) }); // TAAZA viewstate!
  form.set(pwInput.attr('name'), password);
  if (capInput && capInput.length && capInput.attr('name')) form.set(capInput.attr('name'), captchaText);
  const btn = $(pwInput).closest('form').find('input[type="submit"], button[type="submit"]').first();
  if (btn.length && btn.attr('name')) form.set(btn.attr('name'), btn.attr('value') || 'Login');

  const r = await client.post(action, form.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': stage2.url },
  });
  const url = r.request?.res?.responseUrl || action;
  const html = typeof r.data === 'string' ? r.data : '';
  const $$ = cheerio.load(html);
  const err = pageError($$);
  if (err) return { ok: false, reason: err, url };
  if (/landingpage\.aspx|studenthome\.aspx/i.test(url)) return { ok: true, url, $, html };
  if (isLoginHtml($$, url)) return { ok: false, reason: 'login-failed', url };
  // kahin aur redirect hua — maan lo login hua, aage verify karenge
  return { ok: true, url, $, html };
}

// ---------------------------------------------------------------------------
// Session ensure + pending captcha orchestration
// ---------------------------------------------------------------------------
// Pending logins (captcha ka intezaar): studentId -> { client, stage2, password, createdAt }
// Server restart par ye map khaali ho jata hai — captcha waise bhi 1 min me
// expire hota hai, to dobara begin hoga. Koi dikkat nahi.
const pending = new Map();

function prunePending() {
  const now = Date.now();
  for (const [k, v] of pending) {
    if (now - v.createdAt > 90000) pending.delete(k); // 90s se purana = bekaar
  }
}

// Arbitrary page lao; login redirect pakdo.
async function getPage(client, p) {
  const url = p.startsWith('http') ? p : BASE + p;
  const r = await client.get(url);
  const finalUrl = r.request?.res?.responseUrl || url;
  const html = typeof r.data === 'string' ? r.data : '';
  const $ = cheerio.load(html);
  return { status: r.status, html, $, url: finalUrl, loggedOut: isLoginHtml($, finalUrl) };
}

// LandingPage -> "Go to Home Page" -> StudentHome (zaroorat pade to).
async function gotoDashboard(client) {
  let r = await getPage(client, '/StudentHome.aspx');
  if (!r.loggedOut && r.status === 200) return r;
  if (/landingpage\.aspx/i.test(r.url)) {
    const $ = cheerio.load(r.html);
    let href = '';
    $('a').each((_, el) => {
      const t = ($(el).text() || '').toLowerCase();
      if (t.includes('go to home')) { href = $(el).attr('href'); return false; }
    });
    if (href) {
      if (!href.startsWith('http')) href = BASE + (href.startsWith('/') ? '' : '/') + href;
      r = await getPage(client, href);
    }
  }
  return r;
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

// Login shuru karo: stage1 -> stage2 -> captcha image lao, pending me rakho.
// App GET /captcha/:id se image lega, student padhega, POST /captcha/:id se text aayega.
async function beginCaptchaLogin(studentId, password) {
  prunePending();
  const client = newClient(loadJar(studentId));
  const lp = await getLoginPage(client);
  if (lp.stage === 'unknown' && /studenthome|landingpage/i.test(lp.url)) {
    saveJar(studentId, client);
    return { ok: true, client }; // pehle se logged in (jar kaam kar gaya)
  }
  if (lp.stage !== 'stage1') {
    return { ok: false, reason: 'unexpected-login-stage', detail: lp.stage };
  }
  const s1 = await submitStage1(client, lp, studentId);
  if (!s1.ok) return { ok: false, reason: s1.reason };
  if (s1.stage !== 'stage2') {
    // stage1 ke baad seedha dashboard? (kabhi-kabhi aisa hota hai)
    if (/landingpage\.aspx|studenthome\.aspx/i.test(s1.url)) {
      saveJar(studentId, client);
      return { ok: true, client };
    }
    return { ok: false, reason: 'stage2-not-reached', detail: s1.stage };
  }
  const src = findCaptchaSrc(s1.$);
  if (!src) return { ok: false, reason: 'captcha-not-found' };
  const png = await fetchCaptchaPng(client, src, s1.url);
  fs.writeFileSync(captchaPath(studentId), png, { mode: 0o600 });
  pending.set(studentId, { client, stage2: s1, password, createdAt: Date.now() });
  console.log(`[scraper] ${studentId}: captcha ready (${png.length} bytes), student input ka intezaar`);
  return { ok: false, reason: 'captcha-needed' };
}

// App ne captcha text bheja -> login poora karo.
async function completePendingLogin(studentId, captchaText) {
  prunePending();
  const p = pending.get(studentId);
  if (!p) return { ok: false, reason: 'no-pending-login' };
  pending.delete(studentId);
  try {
    const res = await submitStage2(p.client, p.stage2, p.password, captchaText);
    if (!res.ok) {
      console.log(`[scraper] ${studentId}: stage2 fail (${res.reason})`);
      return { ok: false, reason: res.reason };
    }
    // verify: dashboard khul raha hai?
    const dash = await gotoDashboard(p.client);
    if (dash.loggedOut) return { ok: false, reason: 'verify-failed' };
    saveJar(studentId, p.client);
    console.log(`[scraper] ${studentId}: login OK, jar saved`);
    return { ok: true, client: p.client };
  } catch (e) {
    return { ok: false, reason: 'network-error', detail: e.message };
  }
}

function hasPendingLogin(studentId) {
  prunePending();
  return pending.has(studentId);
}

// Session ensure karo: jar try karo -> dashboard check -> zaroorat ho to captcha flow.
async function ensureLoggedIn(studentId, password) {
  if (!password) return { ok: false, reason: 'no-credentials' };
  // 1) purana jar try karo
  if (hasJar(studentId)) {
    try {
      const client = newClient(loadJar(studentId));
      const dash = await gotoDashboard(client);
      if (!dash.loggedOut && dash.status === 200) {
        saveJar(studentId, client); // cookies refresh
        return { ok: true, client, reused: true };
      }
      console.log(`[scraper] ${studentId}: purana session expire, dobara login`);
    } catch (e) {
      console.log(`[scraper] ${studentId}: jar check me network error: ${e.message}`);
    }
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
// ASSUMPTION (fixture me getdata() ka JS nahi hai — pehli real-portal run par
// log se verify karna):
//   Button: <input type="button" chk="<token>" obj="<CODE>" onclick="getdata(this)">
//   type="button" hai (submit NAHI), isliye seedha __doPostBack nahi hota.
//   getdata() sabse sambhav: ASP.NET WebMethod ko AJAX POST karta hai
//   (jaise frmStudentCourseWiseAttendanceSummary.aspx/GetAttendanceDetails
//   with JSON {obj, chk} -> {d: "<table>...</table>"}).
// Strategy: kaam karne wali strategy yaad rakho (daywiseStrategy), pehle wahi
// try karo; fail ho to baaki try karo. Har attempt log hota hai.
let daywiseStrategy = null; // 'webmethod:<name>' | 'postback' | 'get-query'

const WEBMETHOD_NAMES = ['GetAttendanceDetails', 'GetAttendance', 'getdata', 'GetData', 'BindAttendance'];

async function tryParseDaywise(html) {
  try {
    const { parseDayWise } = require('./parsers/daywise');
    const rows = parseDayWise(html || '');
    return rows;
  } catch { return []; }
}

async function fetchDayWise(client, summaryUrl, summaryHtml, code) {
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
