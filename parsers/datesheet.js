// Datesheet table parser.
// URL: frmStudentDatesheet.aspx
// Columns (12): Exam Type | datesheettype | Course code | Course Name |
//   SlotNo | UID | New SlotNo | Exam Date | Exam Timing | Exam Venue |
//   Mode OF Exam | Error Reporting
// Cells are plain <td> — positional parsing.
const cheerio = require('cheerio');

function parseDatesheet(html) {
  const $ = cheerio.load(html);
  const rows = [];
  $('table').each((_, table) => {
    const headers = $(table).find('thead th').map((_, th) => $(th).text().trim().toLowerCase()).get();
    if (!headers.includes('exam date')) return;
    $(table).find('tbody tr').each((_, tr) => {
      const t = $(tr).find('td').map((_, td) => $(td).text().trim()).get();
      if (t.length < 12) return;
      if (!t[2]) return; // no course code
      rows.push({
        examType: t[0],
        datesheetType: t[1],
        code: t[2],
        name: t[3],
        slotNo: t[4],
        uid: t[5],
        newSlotNo: t[6],
        date: t[7],
        timing: t[8],
        venue: t[9],
        mode: t[10],
        errorReporting: t[11],
      });
    });
  });
  return rows;
}

module.exports = { parseDatesheet };
