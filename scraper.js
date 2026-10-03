// CU Saathi - Complete Axios-based scraper (Puppeteer REPLACED!)
// ASP.NET ViewState handling with axios + cheerio + tough-cookie
// 512MB RAM me 50+ parallel logins! No browser needed!

const axios = require('axios');
const cheerio = require('cheerio');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const fs = require('fs');
const path = require('path');

const BASE = 'https://students.cuchd.in';
const DATA_DIR = path.join(__dirname, 'data');
const JAR_DIR = path.join(DATA_DIR, 'jars');

// Per-student session: { jar, client, stage2html, tokens, password, createdAt }
const sessions = new Map();
const PENDING_TTL_MS = 5 * 60 * 1000;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(JAR_DIR)) fs.mkdirSync(JAR_DIR, { recursive: true });
}

function captchaPath(studentId) {
  ensureDataDir();
  const safe = String(studentId).replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(DATA_DIR, `captcha_${safe}.png`);
}

function jarPath(studentId) {
  ensureDataDir();
  const safe = String(studentId).replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(JAR_DIR, `${safe}.json`);
}

function pruneSessions() {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now - v.createdAt > PENDING_TTL_MS) sessions.delete(k);
  }
}

function extractTokens($) {
  return {
    viewState: $('#__VIEWSTATE').val() || '',
    viewStateGenerator: $('#__VIEWSTATEGENERATOR').val() || '',
    eventValidation: $('#__EVENTVALIDATION').val() || '',
  };
}

function createClient() {
  const jar = new CookieJar();
  const client = wrapper(axios.create({
    jar,
    withCredentials: true,
    timeout: 30000,
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 12; Narzo 70 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  }));
  return { jar, client };
}

// ============ SESSION MANAGEMENT ============

function saveJar(studentId, clientObj) {
  try {
    const jar = clientObj.jar || clientObj;
    const data = jar.toJSON();
    fs.writeFileSync(jarPath(studentId), JSON.stringify(data));
    try { fs.chmodSync(jarPath(studentId), 0o600); } catch {}
  } catch (e) {
    console.log(`[axios] saveJar error: ${e.message}`);
  }
}

function loadJar(studentId) {
  try {
    const p = jarPath(studentId);
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    const jar = CookieJar.fromJSON(data);
    const client = wrapper(axios.create({
      jar,
      withCredentials: true,
      timeout: 30000,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 12; Narzo 70 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    }));
    return { jar, client };
  } catch (e) {
    return null;
  }
}

function hasJar(studentId) {
  try {
    return fs.existsSync(jarPath(studentId));
  } catch {
    return false;
  }
}

function newClient() {
  return createClient();
}

// ============ PAGE FETCHING ============

async function getPage(clientObj, p) {
  const client = clientObj.client || clientObj;
  const url = p.startsWith('http') ? p : BASE + p;
  
  try {
    const res = await client.get(url);
    const html = typeof res.data === 'string' ? res.data : '';
    const $ = cheerio.load(html);
    
    // Check if logged out (redirected to login page)
    const hasLoginForm = $('#txtUserId').length > 0 || $('input[type="password"]').length > 0;
    const loggedOut = hasLoginForm && url.includes('StudentHome');
    
    return {
      html,
      status: res.status,
      url: res.request?.res?.responseUrl || url,
      loggedOut,
    };
  } catch (e) {
    if (e.response) {
      const html = typeof e.response.data === 'string' ? e.response.data : '';
      return {
        html,
        status: e.response.status,
        url,
        loggedOut: false,
      };
    }
    throw e;
  }
}

async function gotoDashboard(clientObj) {
  return getPage(clientObj, '/StudentHome.aspx');
}

function extractSummaryUrl(dashboardHtml) {
  const $ = cheerio.load(dashboardHtml || '');
  let href = '';
  $('a').each((_, el) => {
    const h = $(el).attr('href') || '';
    if (/frmStudentCourseWiseAttendanceSummary\.aspx/i.test(h)) { href = h; return false; }
  });
  if (!href) {
    // Try alternative patterns
    $('a').each((_, el) => {
      const h = $(el).attr('href') || '';
      if (/attendance/i.test(h) && h.includes('.aspx')) { href = h; return false; }
    });
  }
  return href;
}

// ============ LOGIN FLOW ============

async function beginLogin(studentId, password) {
  return beginCaptchaLogin(studentId, password);
}

async function beginCaptchaLogin(studentId, password) {
  pruneSessions();
  ensureDataDir();

  const { jar, client } = createClient();

  try {
    // 1. GET login page
    console.log(`[axios] ${studentId}: login page GET...`);
    const getRes = await client.get(BASE + '/');
    const $ = cheerio.load(getRes.data);
    const tokens = extractTokens($);

    if (!tokens.viewState) {
      return { ok: false, reason: 'no-viewstate' };
    }

    // 2. POST student ID (Stage 1)
    console.log(`[axios] ${studentId}: ID submit...`);
    const formData = new URLSearchParams();
    formData.append('__VIEWSTATE', tokens.viewState);
    formData.append('__VIEWSTATEGENERATOR', tokens.viewStateGenerator);
    if (tokens.eventValidation) formData.append('__EVENTVALIDATION', tokens.eventValidation);
    formData.append('txtUserId', studentId);
    formData.append('btnNext', 'Next');

    const postRes = await client.post(BASE + '/', formData.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const $2 = cheerio.load(postRes.data);
    const tokens2 = extractTokens($2);

    // Check if we're at password stage
    const hasPassword = $2('input[type="password"]').length > 0;
    if (!hasPassword) {
      const text = $2.text();
      if (/invalid|not found|error/i.test(text)) {
        return { ok: false, reason: 'bad-credentials' };
      }
      return { ok: false, reason: 'unexpected-stage' };
    }

    // 3. Find CAPTCHA image
    let captchaSrc = '';
    $2('img').each((_, el) => {
      const src = ($2(el).attr('src') || '').toLowerCase();
      if (src.includes('captcha')) {
        captchaSrc = $2(el).attr('src');
      }
    });

    if (!captchaSrc) {
      return { ok: false, reason: 'no-captcha-image' };
    }

    if (!captchaSrc.startsWith('http')) {
      captchaSrc = BASE + (captchaSrc.startsWith('/') ? '' : '/') + captchaSrc;
    }

    // 4. Download CAPTCHA
    console.log(`[axios] ${studentId}: CAPTCHA download...`);
    const capRes = await client.get(captchaSrc, { responseType: 'arraybuffer' });
    const pngPath = captchaPath(studentId);
    fs.writeFileSync(pngPath, Buffer.from(capRes.data));
    try { fs.chmodSync(pngPath, 0o600); } catch {}

    // Save session for stage 2
    sessions.set(studentId, {
      jar, client,
      stage2html: postRes.data,
      tokens: tokens2,
      password: String(password),
      createdAt: Date.now(),
    });

    console.log(`[axios] ${studentId}: captcha ready, waiting for input`);
    return { ok: false, reason: 'captcha-needed', captchaNeeded: true };

  } catch (e) {
    console.log(`[axios] ${studentId}: beginLogin error: ${e.message}`);
    return { ok: false, reason: 'network-error', detail: e.message };
  }
}

async function submitCaptcha(studentId, captchaText) {
  return completePendingLogin(studentId, captchaText);
}

async function completePendingLogin(studentId, captchaText) {
  pruneSessions();
  const sess = sessions.get(studentId);
  if (!sess) return { ok: false, reason: 'no-pending-login' };
  sessions.delete(studentId);

  const { client, jar, stage2html, tokens, password } = sess;

  try {
    const $ = cheerio.load(stage2html);

    // Find field names dynamically
    let pwField = 'txtPassword';
    let capField = 'txtCaptcha';
    let idField = 'txtUserId';
    
    $('input').each((_, el) => {
      const name = $(el).attr('name') || '';
      const nameLower = name.toLowerCase();
      const type = $(el).attr('type') || '';
      if (type === 'password') pwField = name;
      if (nameLower.includes('captcha') && type === 'text') capField = name;
      if (nameLower.includes('userid') || nameLower.includes('user')) {
        if (type === 'text' || type === 'hidden') idField = name;
      }
    });

    // Find submit button
    let submitName = '';
    let submitValue = '';
    $('input[type="submit"], button[type="submit"]').each((_, el) => {
      const name = $(el).attr('name') || '';
      const val = $(el).attr('value') || $(el).text() || '';
      const valLower = val.toLowerCase();
      if (valLower.includes('login') || valLower.includes('submit')) {
        submitName = name;
        submitValue = val;
        return false;
      }
    });

    console.log(`[axios] ${studentId}: CAPTCHA submit...`);
    const formData = new URLSearchParams();
    formData.append('__VIEWSTATE', tokens.viewState);
    formData.append('__VIEWSTATEGENERATOR', tokens.viewStateGenerator);
    if (tokens.eventValidation) formData.append('__EVENTVALIDATION', tokens.eventValidation);
    formData.append(idField, studentId);
    formData.append(pwField, password);
    formData.append(capField, String(captchaText).trim());
    if (submitName) formData.append(submitName, submitValue || 'Login');

    const res = await client.post(BASE + '/', formData.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const $2 = cheerio.load(res.data);
    const text = $2.text();

    if (/invalid captcha/i.test(text)) {
      return { ok: false, reason: 'bad-captcha' };
    }
    if (/invalid.*password|login failed|authentication failed/i.test(text)) {
      return { ok: false, reason: 'bad-credentials' };
    }

    // Check if logged in
    const finalUrl = res.request?.res?.responseUrl || '';
    const isDashboard = finalUrl.includes('StudentHome') || 
                       $2('a[href*="Logout"], a[href*="logout"]').length > 0;
    const stillOnLogin = $2('input[type="password"]').length > 0;

    if (stillOnLogin && !isDashboard) {
      return { ok: false, reason: 'verify-failed' };
    }

    console.log(`[axios] ${studentId}: login OK!`);
    const clientObj = { jar, client };
    saveJar(studentId, clientObj);
    return { ok: true, client: clientObj };

  } catch (e) {
    console.log(`[axios] ${studentId}: submitCaptcha error: ${e.message}`);
    return { ok: false, reason: 'network-error', detail: e.message };
  }
}

async function ensureLoggedIn(studentId, password) {
  if (!password) return { ok: false, reason: 'no-credentials' };
  if (hasPendingLogin(studentId)) return { ok: false, reason: 'captcha-needed' };
  
  // 1) Try old session (saved cookies)
  try {
    const saved = loadJar(studentId);
    if (saved) {
      const dash = await gotoDashboard(saved);
      if (!dash.loggedOut && dash.status === 200) {
        console.log(`[axios] ${studentId}: purana session reuse`);
        return { ok: true, client: saved, reused: true };
      }
      console.log(`[axios] ${studentId}: purana session expire, dobara login`);
    }
  } catch (e) {
    console.log(`[axios] ${studentId}: session check error: ${e.message}`);
  }
  
  // 2) Full login (captcha flow)
  try {
    const res = await beginCaptchaLogin(studentId, password);
    if (res.ok) return { ok: true, client: res.client, reused: false };
    return res;
  } catch (e) {
    return { ok: false, reason: 'network-error', detail: e.message };
  }
}

function hasPendingLogin(studentId) {
  pruneSessions();
  return sessions.has(studentId);
}

// ============ DAY-WISE ATTENDANCE ============

async function fetchDayWise(clientObj, summaryUrl, summaryHtml, code) {
  // Simplified: try to fetch day-wise data via HTTP
  // The pipeline will handle parsing
  try {
    const $ = cheerio.load(summaryHtml || '');
    // Look for day-wise link or WebMethod
    // For now, return empty - pipeline handles fallback
    return { rows: [], strategy: 'axios-none', log: 'Day-wise via axios not yet implemented' };
  } catch (e) {
    return { rows: [], strategy: 'error', log: e.message };
  }
}

// ============ EXPORTS ============

module.exports = {
  BASE,
  newClient, saveJar, loadJar, hasJar,
  getPage, gotoDashboard, extractSummaryUrl,
  ensureLoggedIn, beginCaptchaLogin, completePendingLogin, hasPendingLogin,
  beginLogin, submitCaptcha,
  fetchDayWise,
  captchaPath,
  getCaptchaPath: captchaPath,
};
