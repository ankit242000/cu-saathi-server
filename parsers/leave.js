// Duty leave history parser.
// URL: frmStudentApplyDutyLeave.aspx -> "Duty Leave History" tab
// Columns: (empty) | DL_No | Timing | Category | File Name |
//          Leave_Type | Dated | Status | Remarks
// DL_No cell: <span id="lblID">3050030</span> + hidden input.
// Status: "Recommend and Approved" / "Not Recommend" / "Cancel By You on ..."
// NOTE: General Leave History tab was EMPTY ("No Record Found").
const cheerio = require('cheerio');

function parseDutyLeaveHistory(html) {
  const $ = cheerio.load(html);
  const rows = [];
  $('table').each((_, table) => {
    const headers = $(table).find('thead th').map((_, th) => $(th).text().trim()).get();
    if (!headers.includes('DL_No')) return;
    $(table).find('tbody tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length < 9) return;
      const dlNo = $(tds[1]).find('span#lblID').text().trim() || $(tds[1]).text().trim();
      if (!dlNo) return;
      const t = (i) => $(tds[i]).text().trim();
      rows.push({
        dlNo,
        timing: t(2),
        category: t(3),
        fileName: t(4),
        leaveType: t(5),
        dated: t(6),
        status: t(7),
        remarks: t(8),
      });
    });
  });
  return rows;
}

// Generic leave-history parser — duty / general / medical teeno tabs ke liye.
// "Status" header wali table dhoondhta hai aur columns ko header naam se map
// karta hai. "No Record Found" wali table -> [] (koi error nahi).
const HEADER_MAP = {
  id: ['dl_no', 'dlno', 'id', 'leave id', 'application no', 'app no', 'srno', 'sr no'],
  timing: ['timing', 'time'],
  category: ['category'],
  fileName: ['file name', 'filename', 'document', 'file'],
  leaveType: ['leave_type', 'leave type', 'type'],
  dated: ['dated', 'date', 'applied on', 'applied date'],
  status: ['status'],
  remarks: ['remarks', 'remark', 'reason'],
};

function normHeader(s) {
  return String(s || '').trim().toLowerCase().replace(/[:\s_]+/g, ' ').trim();
}

// aliases ko bhi wahi normalize karo (jaise 'DL_No' -> 'dl no')
const HEADER_LOOKUP = {};
for (const [key, aliases] of Object.entries(HEADER_MAP)) {
  for (const a of aliases) HEADER_LOOKUP[normHeader(a)] = key;
}

function parseLeaveHistory(html) {
  const $ = cheerio.load(html);
  const rows = [];
  $('table').each((_, table) => {
    const headers = $(table).find('thead th').map((_, th) => normHeader($(th).text())).get();
    if (!headers.length || !headers.includes('status')) return;
    // header -> hamara key
    const colIndex = {};
    headers.forEach((h, i) => {
      const key = HEADER_LOOKUP[h];
      if (key && colIndex[key] === undefined) colIndex[key] = i;
    });
    if (colIndex.status === undefined || colIndex.id === undefined) return;
    $(table).find('tbody tr').each((_, tr) => {
      const tds = $(tr).find('td');
      const t = (i) => (i !== undefined && tds[i] ? $(tds[i]).text().trim() : '');
      const txt = $(tr).text().trim();
      if (/no record found/i.test(txt)) return;
      const id = t(colIndex.id).replace(/\s+/g, ' ').trim();
      if (!id) return;
      rows.push({
        id,
        timing: t(colIndex.timing),
        category: t(colIndex.category),
        fileName: t(colIndex.fileName),
        leaveType: t(colIndex.leaveType),
        dated: t(colIndex.dated),
        status: t(colIndex.status),
        remarks: t(colIndex.remarks),
      });
    });
  });
  return rows;
}

module.exports = { parseDutyLeaveHistory, parseLeaveHistory };
