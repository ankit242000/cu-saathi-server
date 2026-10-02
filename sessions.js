// Encrypted student session storage.
// Har student ki portal credentials AES-256-GCM se encrypt hokar data/sessions.json me.
// Key: data/.server_key (pehli run par auto-generate, 0600).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const ALGO = 'aes-256-gcm';
let _key = null;

function dataDir() {
  const d = config.dataDir;
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}
function keyPath() { return path.join(dataDir(), '.server_key'); }
function sessPath() { return path.join(dataDir(), 'sessions.json'); }

function getKey() {
  if (_key) return _key;
  const kp = keyPath();
  if (fs.existsSync(kp)) {
    _key = Buffer.from(fs.readFileSync(kp, 'utf8').trim(), 'hex');
  } else {
    _key = crypto.randomBytes(32);
    fs.writeFileSync(kp, _key.toString('hex'), { mode: 0o600 });
  }
  return _key;
}

function enc(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv(ALGO, getKey(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}
function dec(b64) {
  const b = Buffer.from(b64, 'base64');
  const iv = b.slice(0, 12), tag = b.slice(12, 28), ct = b.slice(28);
  const d = crypto.createDecipheriv(ALGO, getKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

function load() {
  try { return JSON.parse(fs.readFileSync(sessPath(), 'utf8')); }
  catch { return {}; }
}
function save(s) {
  fs.writeFileSync(sessPath(), JSON.stringify(s, null, 1), { mode: 0o600 });
}

// studentId = CU ID (jaise 22ABC1234)
function putStudent(studentId, password) {
  const s = load();
  s[studentId] = {
    pw: enc(password),
    updatedAt: new Date().toISOString(),
    lastScrape: null,
    captchaNeeded: false,
  };
  save(s);
}
function getPassword(studentId) {
  const s = load()[studentId];
  if (!s) return null;
  try { return dec(s.pw); } catch { return null; }
}
function listStudents() { return Object.keys(load()); }
function markScraped(studentId, ok) {
  const s = load();
  if (s[studentId]) {
    s[studentId].lastScrape = new Date().toISOString();
    s[studentId].lastOk = !!ok;
    save(s);
  }
}
function setCaptchaNeeded(studentId, needed) {
  const s = load();
  if (s[studentId]) { s[studentId].captchaNeeded = !!needed; save(s); }
}
function removeStudent(studentId) {
  const s = load();
  delete s[studentId];
  save(s);
}

module.exports = { putStudent, getPassword, listStudents, markScraped, setCaptchaNeeded, removeStudent };
