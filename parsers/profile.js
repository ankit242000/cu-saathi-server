// Student profile parser (for digital ID card).
// URL: frmStudentProfile.aspx
// Section: <h4 class="card-heading"><b>Student Personal Information</b></h4>
// followed by a label | value table.
const cheerio = require('cheerio');

function parseProfile(html) {
  const $ = cheerio.load(html);
  const out = {};
  $('h4.card-heading').each((_, h4) => {
    if (!/student personal information/i.test($(h4).text())) return;
    let table = $(h4).nextAll('table').first();
    if (!table.length) table = $(h4).parent().find('table').first();
    table.find('tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length < 2) return;
      const label = $(tds[0]).text().trim().toLowerCase().replace(/[^a-z]+/g, '');
      const value = $(tds[1]).text().trim();
      if (label) out[label] = value;
    });
  });
  // Normalize common keys.
  return {
    uid: out.uid || '',
    name: out.name || '',
    fathersName: out.fathersname || '',
    motherName: out.mothername || '',
    dob: out.dob || '',
    admissionYear: out.admissionyear || '',
    currentSection: out.currentsection || '',
    programCode: out.programcode || '',
    raw: out,
  };
}

module.exports = { parseProfile };
