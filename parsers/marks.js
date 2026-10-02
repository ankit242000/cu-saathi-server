// Marks accordion parser.
// URL: frmStudentMarksView.aspx
// Structure: jQuery UI accordion — one .ui-accordion-content panel per subject.
// Each panel: hidden input (value = subject code) + table with
//   thead: Exam Description | Max. Marks | Marks Obtd.
// Title comes from the preceding h3 header, e.g. "Environmental Law (22LLT-592)".
const cheerio = require('cheerio');

function num(s) {
  const n = parseFloat(String(s || '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function parseMarks(html) {
  const $ = cheerio.load(html);
  const subjects = [];
  $('.ui-accordion-content').each((_, panel) => {
    const $p = $(panel);
    const code = ($p.find('input[type="hidden"]').attr('value') || '').trim();
    // Title from the header element right before this panel.
    let title = '';
    const header = $p.prevAll('h3').first().text().trim()
      || $p.prevAll('[id^="ui-accordion-accordion-header"]').first().text().trim();
    const tm = header.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    if (tm) { title = tm[1].trim(); }
    else { title = header; }
    const exams = [];
    $p.find('table tbody tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length < 3) return;
      const desc = $(tds[0]).text().trim();
      if (!desc) return;
      exams.push({
        desc,
        max: num($(tds[1]).text()),
        obtained: num($(tds[2]).text()),
      });
    });
    if (!code && !exams.length) return;
    subjects.push({ code, title, exams });
  });
  return subjects;
}

module.exports = { parseMarks };
