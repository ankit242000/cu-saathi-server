// Attendance summary table parser.
// URL: frmStudentCourseWiseAttendanceSummary.aspx
// Columns: Course Code | Title | Total Delv. | Total Attd. | IDL | ADL | VDL |
//          Medical Leave | Eligible Delivered | Eligible Attended |
//          Eligible Percentage | View Attendance
// NOTE: data-label here HAS a trailing colon (e.g. 'data-label="Course Code:"').
// View button: <input type="button" chk="<token>" obj="<COURSE_CODE>"
//              value="View" onclick="getdata(this)">
const cheerio = require('cheerio');

function cell($, tr, label) {
  let el = $(tr).find(`td[data-label="${label}:"]`);
  if (!el.length) el = $(tr).find(`td[data-label="${label}"]`);
  return el.first().text().trim();
}

function num(s) {
  const n = parseFloat(String(s || '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function parseSummary(html) {
  const $ = cheerio.load(html);
  const rows = [];
  $('table tbody tr').each((_, tr) => {
    const code = cell($, tr, 'Course Code');
    if (!code) return;
    const btn = $(tr).find('input[value="View"]');
    rows.push({
      code,
      title: cell($, tr, 'Title'),
      delivered: num(cell($, tr, 'Total Delv.')),
      attended: num(cell($, tr, 'Total Attd.')),
      idl: num(cell($, tr, 'IDL')),
      adl: num(cell($, tr, 'ADL')),
      vdl: num(cell($, tr, 'VDL')),
      medical: num(cell($, tr, 'Medical Leave')),
      eligibleDelivered: num(cell($, tr, 'Eligible Delivered')),
      eligibleAttended: num(cell($, tr, 'Eligible Attended')),
      pct: num(cell($, tr, 'Eligible Percentage')),
      viewObj: btn.attr('obj') || '',
      viewChk: btn.attr('chk') || '',
    });
  });
  return rows;
}

module.exports = { parseSummary };
