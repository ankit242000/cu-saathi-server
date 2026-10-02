// pipeline.js — FULL scrape pipeline ek student ke liye.
//
// scrapeStudent(studentId):
//   session ensure (login w/ captcha orchestration) ->
//   dashboard -> attendance summary -> day-wise (har subject) ->
//   timetable -> datesheet -> leaves (duty/general/medical) ->
//   profile -> marks -> cache/<studentId>.json
//
// Rules:
// - Network error (throw) = retryable. Logical fail (captcha/login) = return {ok:false}.
// - Ek page fail ho to baaki continue (section error log me).
// - Cache me sirf non-empty sections overwrite hote hain — purana achha data
//   kabhi khaali parse se MITTA NAHI (keep last-known).
// - Fail hone par cache file ko haath NAHI lagate.

const fs = require('fs');
const path = require('path');
const config = require('./config');
const sessions = require('./sessions');
const scraper = require('./scraper');

const { parseSummary } = require('./parsers/summary');
const { parseDayWise } = require('./parsers/daywise');
const { parseTimetable } = require('./parsers/timetable');
const { parseDatesheet } = require('./parsers/datesheet');
const { parseLeaveHistory } = require('./parsers/leave');
const { parseProfile } = require('./parsers/profile');
const { parseMarks } = require('./parsers/marks');
const { parseImportantMessage, parseAnnouncements } = require('./parsers/dashboard');

function cachePath(studentId) {
  const d = path.join(config.dataDir, 'cache');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return path.join(d, String(studentId).replace(/[^A-Za-z0-9_-]/g, '_') + '.json');
}

function readCache(studentId) {
  try { return JSON.parse(fs.readFileSync(cachePath(studentId), 'utf8')); }
  catch { return null; }
}

function isEmptySection(v) {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  if (typeof v === 'string') return v.trim() === '';
  return false;
}

// Purana cache + naya data merge karo: naya section khaali ho aur purana bhara
// ho to purana rakho (stale mark karke). Pehli baar purana null hota hai.
function mergeCache(oldC, newData) {
  const merged = { ...(oldC || {}) };
  const stale = [];
  for (const [k, v] of Object.entries(newData)) {
    if (['studentId', 'scrapedAt'].includes(k)) { merged[k] = v; continue; }
    if (isEmptySection(v) && oldC && !isEmptySection(oldC[k])) {
      stale.push(k); // purana rakha, naya khaali tha
      continue;
    }
    merged[k] = v;
  }
  if (stale.length) merged.staleSections = stale;
  else delete merged.staleSections;
  return merged;
}

// Ek page fetch + parse, fail ho to { error } (throw NAHI — pipeline rukegi nahi).
async function trySection(client, label, pagePath, parseFn) {
  try {
    const r = await scraper.getPage(client, pagePath);
    if (r.loggedOut) return { error: 'logged-out' };
    if (r.status !== 200) return { error: 'http-' + r.status };
    const data = parseFn(r.html, r);
    return { data, html: r.html };
  } catch (e) {
    return { error: 'network: ' + e.message };
  }
}

async function scrapeStudent(studentId) {
  const t0 = Date.now();
  const log = (m) => console.log(`[pipeline:${studentId}] ${m}`);
  const sections = {};
  const errors = {};

  // ---- 1) session ----
  const pw = sessions.getPassword(studentId);
  if (!pw) return { ok: false, reason: 'no-credentials' };
  let sess;
  try {
    sess = await scraper.ensureLoggedIn(studentId, pw);
  } catch (e) {
    throw new Error('network: ' + e.message); // retryable
  }
  if (!sess.ok) {
    if (sess.reason === 'captcha-needed') {
      sessions.setCaptchaNeeded(studentId, true);
      return { ok: false, reason: 'captcha-needed' };
    }
    return { ok: false, reason: sess.reason || 'login-failed', detail: sess.detail };
  }
  sessions.setCaptchaNeeded(studentId, false);
  const client = sess.client;
  log(`session OK (reused=${!!sess.reused})`);

  // ---- 2) dashboard (notices + summary link) ----
  let dash;
  try {
    dash = await scraper.gotoDashboard(client);
  } catch (e) { throw new Error('network: ' + e.message); }
  if (dash.loggedOut || dash.status !== 200) {
    return { ok: false, reason: 'dashboard-unreachable', detail: 'http-' + dash.status };
  }
  sections.notices = {
    importantMessage: parseImportantMessage(dash.html),
    announcements: parseAnnouncements(dash.html),
  };
  const summaryUrl = scraper.extractSummaryUrl(dash.html);
  log('summaryUrl=' + summaryUrl);

  // ---- 3) attendance summary ----
  const sumRes = await trySection(client, 'summary', summaryUrl, (h) => parseSummary(h));
  if (sumRes.error) { errors.attendanceSummary = sumRes.error; log('summary FAIL: ' + sumRes.error); }
  else {
    sections.attendanceSummary = sumRes.data;
    log(`summary OK: ${sumRes.data.length} subjects`);
  }

  // ---- 4) day-wise (har subject ke liye modal replicate) ----
  sections.daywise = {};
  if (sections.attendanceSummary && sections.attendanceSummary.length) {
    for (const subj of sections.attendanceSummary) {
      const code = subj.code;
      try {
        const dw = await scraper.fetchDayWise(client, summaryUrl, sumRes.html, code);
        if (dw.rows.length) sections.daywise[code] = dw.rows;
        else { errors['daywise:' + code] = 'no-rows strategy=' + dw.strategy; }
        log(`daywise ${code}: ${dw.rows.length} rows via ${dw.strategy}`);
      } catch (e) {
        errors['daywise:' + code] = 'network: ' + e.message;
        log(`daywise ${code} FAIL: ${e.message}`);
      }
    }
  }

  // ---- 5) timetable ----
  const tt = await trySection(client, 'timetable', '/frmMyTimeTable.aspx', (h) => parseTimetable(h));
  if (tt.error) { errors.timetable = tt.error; log('timetable FAIL: ' + tt.error); }
  else { sections.timetable = tt.data; log(`timetable OK: ${tt.data.length} slots`); }

  // ---- 6) datesheet ----
  const ds = await trySection(client, 'datesheet', '/frmStudentDatesheet.aspx', (h) => parseDatesheet(h));
  if (ds.error) { errors.datesheet = ds.error; log('datesheet FAIL: ' + ds.error); }
  else { sections.datesheet = ds.data; log(`datesheet OK: ${ds.data.length} rows`); }

  // ---- 7) leaves (duty / general / medical) ----
  sections.leaves = { duty: [], general: [], medical: [] };
  const leavePages = [
    ['duty', '/frmStudentApplyDutyLeave.aspx'],
    ['general', '/frmStudentGeneralLeaveApply.aspx'],
    ['medical', '/frmStudentMedicalLeaveApply.aspx'],
  ];
  for (const [kind, p] of leavePages) {
    const lr = await trySection(client, 'leave-' + kind, p, (h) => parseLeaveHistory(h));
    if (lr.error) { errors['leaves:' + kind] = lr.error; log(`leaves ${kind} FAIL: ${lr.error}`); }
    else { sections.leaves[kind] = lr.data; log(`leaves ${kind} OK: ${lr.data.length} rows`); }
  }

  // ---- 8) profile (digital ID card isi se banega) ----
  const pr = await trySection(client, 'profile', '/frmStudentProfile.aspx', (h) => parseProfile(h));
  if (pr.error) { errors.profile = pr.error; log('profile FAIL: ' + pr.error); }
  else { sections.profile = pr.data; log('profile OK'); }

  // ---- 9) marks ----
  const mk = await trySection(client, 'marks', '/frmStudentMarksView.aspx', (h) => parseMarks(h));
  if (mk.error) { errors.marks = mk.error; log('marks FAIL: ' + mk.error); }
  else { sections.marks = mk.data; log(`marks OK: ${mk.data.length} subjects`); }

  // ---- 10) merge + write cache ----
  const oldC = readCache(studentId);
  const newData = {
    studentId,
    scrapedAt: new Date().toISOString(),
    ...sections,
  };
  const merged = mergeCache(oldC, newData);
  if (Object.keys(errors).length) merged.sectionErrors = errors;
  else delete merged.sectionErrors;
  fs.writeFileSync(cachePath(studentId), JSON.stringify(merged, null, 1), { mode: 0o600 });
  scraper.saveJar(studentId, client); // session cookies taaza rakho
  sessions.markScraped(studentId, true);
  log(`DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s, errors=${Object.keys(errors).length}`);
  return { ok: true, sections: Object.keys(sections), stale: merged.staleSections || [], errors };
}

module.exports = { scrapeStudent, readCache, cachePath, mergeCache };
