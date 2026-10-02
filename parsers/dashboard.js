// Dashboard sections parser.
// URL: StudentHome.aspx
// - Important Message: <h3 class="portlet-caption">Important Message</h3>
// - Announcements: <h3 class="portlet-caption"><span id="spanAnnouncementHeader">
//   Announcements ( ALL )</span></h3>
//   item = heading (title) + text (date + "Uploaded By <name>") + content div.
const cheerio = require('cheerio');

function sectionBody($, captionText) {
  let body = null;
  $('h3.portlet-caption').each((_, h3) => {
    if ($(h3).text().toLowerCase().includes(captionText.toLowerCase())) {
      body = $(h3).nextAll('div').first();
    }
  });
  return body;
}

function parseImportantMessage(html) {
  const $ = cheerio.load(html);
  const body = sectionBody($, 'Important Message');
  if (!body) return '';
  return body.text().trim().replace(/\s+/g, ' ');
}

function parseAnnouncements(html) {
  const $ = cheerio.load(html);
  const items = [];
  const body = sectionBody($, 'Announcements');
  if (!body) return items;
  body.find('h4').each((_, h4) => {
    const title = $(h4).text().trim();
    const meta = $(h4).next('p').text().trim();
    const content = $(h4).nextAll('div').first().text().trim();
    if (title) items.push({ title, meta, content });
  });
  return items;
}

module.exports = { parseImportantMessage, parseAnnouncements };
