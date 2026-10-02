// Timetable grid parser.
// URL: frmMyTimeTable.aspx
// Grid: Timing | Mon | Tue | Wed | Thu | Fri | Sat | Sun
// Cell format: "<Code>:<L/T/P>::GP-<Group>: By <Teacher>(<ID>) at <Room>"
// Empty <td></td> = no class.
const cheerio = require('cheerio');

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// "22LBT-593:L::GP-All: By Sushmita Dhar(R243) at Block-B5-402"
function parseCell(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const out = { raw: t, code: '', kind: '', group: '', teacher: '', teacherId: '', room: '' };
  const byParts = t.split(' By ');
  const left = (byParts[0] || '').trim();
  const right = (byParts[1] || '').trim();
  const lp = left.split(':');
  out.code = (lp[0] || '').trim();
  out.kind = (lp[1] || '').trim(); // L / T / P
  const gp = (lp[3] || '').trim(); // "GP-All"
  out.group = gp.replace(/^GP-/, '');
  const rm = right.match(/^(.*?)\((.*?)\)\s+at\s+(.*)$/);
  if (rm) {
    out.teacher = rm[1].trim();
    out.teacherId = rm[2].trim();
    out.room = rm[3].trim();
  } else {
    out.teacher = right;
  }
  return out;
}

function parseTimetable(html) {
  const $ = cheerio.load(html);
  const slots = [];
  // Find the grid table: the one whose first header is "Timing".
  $('table').each((_, table) => {
    const headers = $(table).find('thead th').map((_, th) => $(th).text().trim()).get();
    if (!headers.length || headers[0].toLowerCase() !== 'timing') return;
    $(table).find('tbody tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length < 8) return;
      const timing = $(tds[0]).text().trim();
      if (!timing) return;
      const days = {};
      DAYS.forEach((d, i) => {
        days[d] = parseCell($(tds[i + 1]).text());
      });
      slots.push({ timing, days });
    });
  });
  return slots;
}

module.exports = { parseTimetable, parseCell };
