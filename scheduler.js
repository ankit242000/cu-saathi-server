// scheduler.js — har 10 min har registered student ka FULL scrape.
//
// Flow per student:
//   purana cache padho -> retry(3, backoff) se pipeline.scrapeStudent ->
//   fail => Telegram alert (owner ko), cache ko HAATH NAHI (last-known serve hota rahega)
//   success => diff (attendance % / nayi datesheet / leave status / marks) ->
//              changes ho to FCM push student ko.
//
// Network blips: 3 attempts, backoff 5s / 15s / 30s. Logical fails
// (captcha-needed, bad-credentials) retry NAHI hote.
const cron = require('node-cron');
const sessions = require('./sessions');
const pipeline = require('./pipeline');
const telegram = require('./telegram');
const fcm = require('./fcm');
const scraper = require('./scraper');

const BACKOFFS = [5000, 15000, 30000];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// fn ko 3 baar try karo; sirf THROW hone par retry (network).
// {ok:false} return logical fail hai — turant wapas.
async function withRetry(fn, label) {
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      console.log(`[sched] ${label}: attempt ${i + 1} fail: ${e.message}`);
      if (i < 2) await sleep(BACKOFFS[i]);
    }
  }
  throw lastErr;
}

// Purana vs naya cache — student ko bhejne layak changes.
function diffCaches(oldC, newC) {
  const changes = [];
  if (!oldC || !newC) return changes; // pehla scrape — spam nahi
  try {
    // 1) attendance % badla?
    const oldSum = oldC.attendanceSummary || [];
    for (const s of (newC.attendanceSummary || [])) {
      const o = oldSum.find(x => x.code === s.code);
      if (o && o.pct !== s.pct) {
        changes.push(`📊 ${s.code}: ${o.pct}% → ${s.pct}%`);
      }
    }
    // 2) nayi datesheet rows?
    const key = (r) => `${r.examType}|${r.code}|${r.date}`;
    const oldDs = new Set((oldC.datesheet || []).map(key));
    for (const r of (newC.datesheet || [])) {
      if (!oldDs.has(key(r))) changes.push(`📝 Datesheet: ${r.examType} ${r.code} — ${r.date}`);
    }
    // 3) leave status badla? (duty/general/medical teeno)
    for (const kind of ['duty', 'general', 'medical']) {
      const oldL = (oldC.leaves && oldC.leaves[kind]) || [];
      const newL = (newC.leaves && newC.leaves[kind]) || [];
      for (const n of newL) {
        const o = oldL.find(x => String(x.id) === String(n.id));
        if (o && o.status !== n.status) {
          changes.push(`🏖️ Leave ${n.id}: ${o.status} → ${n.status}`);
        } else if (!o && n.id) {
          changes.push(`🏖️ Nayi leave: ${n.id} (${n.status || 'status?'})`);
        }
      }
    }
    // 4) marks badle?
    for (const sub of (newC.marks || [])) {
      const o = (oldC.marks || []).find(x => x.code === sub.code);
      if (!o) continue;
      for (const ex of (sub.exams || [])) {
        const oe = (o.exams || []).find(x => x.desc === ex.desc);
        if (oe && oe.obtained !== ex.obtained) {
          changes.push(`🎯 ${sub.code} ${ex.desc}: ${oe.obtained} → ${ex.obtained}`);
        }
      }
    }
  } catch (e) {
    console.log('[sched] diff error:', e.message);
  }
  return changes;
}

async function runStudent(studentId) {
  if (scraper.hasPendingLogin(studentId)) {
    console.log(`[sched] ${studentId}: pending CAPTCHA — skip`);
    return { ok: false, reason: 'captcha-pending-skip' };
  }
  console.log(`[sched] scrape start: ${studentId}`);
  const oldC = pipeline.readCache(studentId);
  let res;
  try {
    res = await withRetry(() => pipeline.scrapeStudent(studentId), studentId);
  } catch (e) {
    // 3 attempts ke baad bhi network fail
    sessions.markScraped(studentId, false);
    telegram.send(`⚠️ CU Saathi: ${studentId} ka scrape 3 try me fail (network). Cached data serve ho raha hai. (${e.message})`);
    console.log(`[sched] ${studentId}: network fail after retries`);
    return { ok: false, reason: 'network' };
  }
  if (!res.ok) {
    sessions.markScraped(studentId, false);
    if (res.reason === 'captcha-needed') {
      telegram.captchaNeeded(studentId);
      console.log(`[sched] ${studentId}: CAPTCHA chahiye — app ko batana padega`);
    } else if (res.reason === 'no-credentials') {
      console.log(`[sched] ${studentId}: credentials nahi mile`);
    } else {
      telegram.send(`🔧 CU Saathi: ${studentId} scrape fail (${res.reason}). ${res.detail || ''}`);
    }
    return res;
  }
  // success — diff + notify
  const newC = pipeline.readCache(studentId);
  const changes = diffCaches(oldC, newC);
  if (changes.length) {
    console.log(`[sched] ${studentId}: ${changes.length} changes -> FCM`);
    try {
      const sent = await fcm.pushToStudent(studentId, 'CU Saathi update', changes.slice(0, 5).join('\n'));
      if (!sent) console.log('[sched] FCM not configured — push skipped');
    } catch (e) { console.log('[sched] FCM error:', e.message); }
  } else {
    console.log(`[sched] ${studentId}: koi change nahi`);
  }
  return { ok: true, changes: changes.length };
}

let running = false;
async function runAll() {
  if (running) { console.log('[sched] pichla run abhi chal raha — skip'); return; }
  running = true;
  try {
    const ids = sessions.listStudents();
    console.log(`[sched] runAll: ${ids.length} students`);
    for (const id of ids) {
      try { await runStudent(id); }
      catch (e) { console.log(`[sched] ${id} unexpected:`, e.message); }
    }
  } finally { running = false; }
}

function start() {
  // Har 10 min: FULL scrape har student ka
  cron.schedule('*/10 * * * *', () => { runAll(); });
  // Raat ko owner summary
  cron.schedule('0 22 * * *', () => {
    const ids = sessions.listStudents();
    telegram.nightly(`${ids.length} students tracked. Server healthy.`);
  });
  console.log('[sched] started: har 10 min full scrape');
}

module.exports = { start, runAll, runStudent, diffCaches, withRetry };
