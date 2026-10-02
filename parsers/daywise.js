// Day-wise / lecture-wise attendance modal parser.
// Source structure: CU portal "Attendance Summary Print Data" modal.
// Columns: SrNo | Date | Type | Time | Attendance | Section | Group | Marked By
// NOTE: data-label here has NO trailing colon (differs from summary table).
const cheerio = require('cheerio');

function cell($, tr, label) {
  let el = $(tr).find(`td[data-label="${label}"]`);
  if (!el.length) el = $(tr).find(`td[data-label="${label}:"]`);
  if (!el.length) el = $(tr).find('td').eq(labelIndex(label));
  return el.first().text().trim();
}

const ORDER = ['SrNo', 'Date', 'Type', 'Time', 'Attendance', 'Section', 'Group', 'Marked By'];
function labelIndex(label) { return ORDER.indexOf(label); }

// "Sushmita Dhar::R243 on dated:Sep 29 2026 12:51PM"
//  -> { teacher, teacherId, markedOn }
function parseMarkedBy(text) {
  const m = String(text || '').match(/^(.*?)::(.*?) on dated:(.*)$/);
  if (!m) return { teacher: String(text || '').trim(), teacherId: '', markedOn: '' };
  return { teacher: m[1].trim(), teacherId: m[2].trim(), markedOn: m[3].trim() };
}

// Raw status -> kind: present | absent | leave
function statusKind(raw) {
  const s = String(raw || '');
  if (/^present/i.test(s)) return 'present';
  if (/medical leave/i.test(s)) return 'leave';
  if (/\b(VDL|IDL|ADL)\b/i.test(s) || /duty leave/i.test(s)) return 'leave';
  return 'absent';
}

function parseDayWise(html) {
  const $ = cheerio.load(html);
  const rows = [];
  $('table tbody tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 8) return;
    const srNo = cell($, tr, 'SrNo');
    if (!srNo || !/^\d+$/.test(srNo)) return;
    const attendance = cell($, tr, 'Attendance');
    const markedBy = parseMarkedBy(cell($, tr, 'Marked By'));
    rows.push({
      srNo: parseInt(srNo, 10),
      date: cell($, tr, 'Date'),
      type: cell($, tr, 'Type'),
      time: cell($, tr, 'Time'),
      attendance,
      kind: statusKind(attendance),
      section: cell($, tr, 'Section'),
      group: cell($, tr, 'Group'),
      teacher: markedBy.teacher,
      teacherId: markedBy.teacherId,
      markedOn: markedBy.markedOn,
    });
  });
  return rows;
}

module.exports = { parseDayWise, parseMarkedBy, statusKind };
