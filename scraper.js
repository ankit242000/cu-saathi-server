// CU Saathi - Axios-based scraper (Puppeteer REPLACED!)
// ASP.NET ViewState handling with axios + cheerio + tough-cookie
// 512MB RAM me 50+ parallel logins!

const axios = require('axios');
const cheerio = require('cheerio');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const fs = require('fs');
const path = require('path');

const BASE = 'https://students.cuchd.in';
const DATA_DIR = path.join(__dirname, 'data');

// Per-student session: { jar, client, stage2html, captchaPath, createdAt }
const sessions = new Map();
const PENDING_TTL_MS = 5 * 60 * 1000;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function captchaPath(studentId) {
  ensureDataDir();
  const safe = String(studentId).replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(DATA_DIR, `captcha_${safe}.png`);
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
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 12; Narzo 70 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  }));
  return { jar, client };
}

/**
 * Stage 1: Login page lao, ID submit karo
 * Returns: { ok, captchaNeeded, reason }
 */
async function beginLogin(studentId, password) {
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
      maxRedirects: 5,
    });

    const $2 = cheerio.load(postRes.data);
    const tokens2 = extractTokens($2);

    // Check if we're at password stage
    const hasPassword = $2('input[type="password"]').length > 0;
    if (!hasPassword) {
      // Check for error
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

    // Make absolute URL
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

/**
 * Stage 2: CAPTCHA submit karo, login complete karo
 */
async function submitCaptcha(studentId, captchaText) {
  pruneSessions();
  const sess = sessions.get(studentId);
  if (!sess) return { ok: false, reason: 'no-pending-login' };
  sessions.delete(studentId);

  const { client, stage2html, tokens, password } = sess;

  try {
    const $ = cheerio.load(stage2html);

    // Find field names
    let pwField = 'txtPassword';
    let capField = 'txtCaptcha';
    $('input').each((_, el) => {
      const name = ($(el).attr('name') || '').toLowerCase();
      const type = $(el).attr('type') || '';
      if (type === 'password') pwField = $(el).attr('name');
      if (name.includes('captcha') && type === 'text') capField = $(el).attr('name');
    });

    // Find submit button name
    let submitName = 'btnLogin';
    $('input[type="submit"], button[type="submit"]').each((_, el) => {
      const name = $(el).attr('name') || '';
      const val = ($(el).attr('value') || $(el).text() || '').toLowerCase();
      if (val.includes('login') || val.includes('submit')) submitName = name;
    });

    console.log(`[axios] ${studentId}: CAPTCHA submit...`);
    const formData = new URLSearchParams();
    formData.append('__VIEWSTATE', tokens.viewState);
    formData.append('__VIEWSTATEGENERATOR', tokens.viewStateGenerator);
    if (tokens.eventValidation) formData.append('__EVENTVALIDATION', tokens.eventValidation);
    formData.append(pwField, password);
    formData.append(capField, String(captchaText).trim());
    formData.append(submitName, 'Login');

    const res = await client.post(BASE + '/', formData.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      maxRedirects: 5,
    });

    const $2 = cheerio.load(res.data);
    const text = $2.text();

    // Check for CAPTCHA error
    if (/invalid captcha/i.test(text)) {
      return { ok: false, reason: 'bad-captcha' };
    }
    if (/invalid.*password|login failed|authentication failed/i.test(text)) {
      return { ok: false, reason: 'bad-credentials' };
    }

    // Check if we're logged in (dashboard)
    const url = res.request?.res?.responseUrl || '';
    const isDashboard = url.includes('StudentHome') || $2('a[href*="Logout"], a[href*="logout"]').length > 0;

    if (!isDashboard) {
      // Might still be on login page = failed
      if ($2('input[type="password"]').length > 0) {
        return { ok: false, reason: 'verify-failed' };
      }
    }

    console.log(`[axios] ${studentId}: login OK!`);
    return { ok: true, client, jar };

  } catch (e) {
    console.log(`[axios] ${studentId}: submitCaptcha error: ${e.message}`);
    return { ok: false, reason: 'network-error', detail: e.message };
  }
}

function hasPendingLogin(studentId) {
  pruneSessions();
  return sessions.has(studentId);
}

function getCaptchaPath(studentId) {
  return captchaPath(studentId);
}

module.exports = {
  beginLogin,
  submitCaptcha,
  hasPendingLogin,
  getCaptchaPath,
  // Legacy compatibility
  beginCaptchaLogin: beginLogin,
  completePendingLogin: async (id, text) => {
    const r = await submitCaptcha(id, text);
    if (r.ok) return { ok: true, client: r.client };
    return r;
  },
  captchaPath: getCaptchaPath,
};
