// CU Saathi Server — main entry.
// App is API se baat karta hai. Portal scraping background me scheduler karta hai.
//
// Endpoints:
//   GET  /health                  — server zinda?
//   POST /register {studentId, password}
//        — credentials encrypted save + turant pehla scrape (async)
//   GET  /data/:studentId         — cache/<id>.json (last-known, server down ho to bhi)
//   GET  /captcha/:studentId      — pending login ki captcha PNG (student padhega)
//   POST /captcha/:studentId {text}
//        — captcha text se login poora + scrape trigger
const express = require('express');
const fs = require('fs');
const config = require('./config');
const sessions = require('./sessions');
const scheduler = require('./scheduler');
const pipeline = require('./pipeline');
const scraper = require('./scraper');

const app = express();
app.use(express.json());

const safeId = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '_');

// Health
app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), students: sessions.listStudents().length });
});

// Student register: app pehli login ke baad credentials bhejta hai.
// Encrypted channel par aana chahiye (HTTPS / tunnel).
app.post('/register', async (req, res) => {
  const { studentId, password } = req.body || {};
  if (!studentId || !password) return res.status(400).json({ ok: false, reason: 'studentId+password chahiye' });
  const id = safeId(studentId);
  sessions.putStudent(id, String(password));
  // Pehla scrape — CAPTCHA aane tak WAIT karo (max 30 sec), phir batao
  // taaki app ko sahi captchaNeeded mile. Fire-and-forget NAHI!
  try {
    const r = await Promise.race([
      pipeline.scrapeStudent(id),
      new Promise(resolve => setTimeout(() => resolve({ ok: false, reason: 'timeout-waiting-captcha' }), 30000))
    ]);
    console.log(`[api] register scrape ${id}:`, r.ok ? 'OK' : r.reason);
  } catch (e) {
    console.log(`[api] register scrape ${id} throw:`, e.message);
  }
  // Ab check karo CAPTCHA pending hai ya nahi — sahi value bhejo
  const needCaptcha = scraper.hasPendingLogin(id);
  const c = pipeline.readCache(id);
  if (needCaptcha) {
    return res.json({ ok: true, captchaNeeded: true, hasData: !!c });
  }
  if (c) {
    return res.json({ ok: true, captchaNeeded: false, hasData: true });
  }
  // Na CAPTCHA pending, na cached data — scrape fail hua, app ko error do
  return res.status(503).json({ ok: false, reason: 'scrape-failed-no-data', captchaNeeded: false, hasData: false });
});

// Cached data: portal/server down ho to bhi last-known data milega.
app.get('/data/:studentId', (req, res) => {
  const id = safeId(req.params.studentId);
  const c = pipeline.readCache(id);
  if (!c) return res.status(404).json({ ok: false, reason: 'no-data' });
  res.json({ ok: true, captchaNeeded: scraper.hasPendingLogin(id), data: c });
});

// Captcha image: login pending ho to PNG do (app student ko dikhayega).
app.get('/captcha/:studentId', (req, res) => {
  const id = safeId(req.params.studentId);
  if (!scraper.hasPendingLogin(id)) {
    return res.status(404).json({ ok: false, reason: 'no-pending-captcha' });
  }
  const p = scraper.captchaPath(id);
  if (!fs.existsSync(p)) return res.status(404).json({ ok: false, reason: 'captcha-expired' });
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'no-store');
  fs.createReadStream(p).pipe(res);
});

// Captcha text aaya: login poora karo + scrape trigger karo.
app.post('/captcha/:studentId', async (req, res) => {
  const id = safeId(req.params.studentId);
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ ok: false, reason: 'text chahiye' });
  const r = await scraper.completePendingLogin(id, text);
  if (!r.ok) {
    // galat captcha? dobara captcha lao (naya pending banega)
    if (r.reason === 'bad-captcha') {
      const pw = sessions.getPassword(id);
      if (pw) {
        const b = await scraper.beginCaptchaLogin(id, pw).catch(() => ({ ok: false }));
        if (!b.ok && b.reason === 'captcha-needed') {
          return res.json({ ok: false, reason: 'bad-captcha', retry: true });
        }
      }
    }
    return res.json({ ok: false, reason: r.reason, detail: r.detail });
  }
  sessions.setCaptchaNeeded(id, false);
  pipeline.scrapeStudent(id)
    .then(x => console.log(`[api] captcha scrape ${id}:`, x.ok ? 'OK' : x.reason))
    .catch(e => console.log(`[api] captcha scrape ${id} throw:`, e.message));
  res.json({ ok: true, scraping: true });
});

const PORT = config.port;


app.listen(PORT, () => {
  console.log(`CU Saathi server :${PORT} par chal raha hai`);
  // scheduler.start(); // TEST KE LIYE BAND
  try { require('./telegram').send('🟢 CU Saathi Server started ' + new Date().toLocaleString('en-IN')); } catch (e) {}
});
