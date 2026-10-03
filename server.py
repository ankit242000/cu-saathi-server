"""
CU Saathi Server v2 — Flask + curl_cffi (Approach #2)
App ke existing endpoints se compatible:
  POST /register {studentId, password} → {ok, captchaNeeded}
  GET  /captcha/{studentId} → PNG bytes
  POST /captcha/{studentId} {text} → {ok} ya {ok:false, retry:true}
  GET  /data/{studentId} → {ok, data}
  GET  /health
"""
from flask import Flask, request, jsonify, send_file
import time
import io
import base64
from portal_client import PortalClient

app = Flask(__name__)

# sessions: {studentId: {client, password, logged_in, captcha_pending, created}}
sessions = {}
SESSION_TTL = 10 * 60  # 10 min

def clean():
    now = time.time()
    for k in list(sessions.keys()):
        if now - sessions[k]['created'] > SESSION_TTL:
            del sessions[k]

def safe_id(s):
    return ''.join(c if c.isalnum() or c in '-_' else '_' for c in str(s or ''))

@app.route('/health')
def health():
    clean()
    return jsonify({'ok': True, 'time': time.time(), 'students': len(sessions)})

@app.route('/register', methods=['POST'])
def register():
    clean()
    data = request.json or {}
    student_id = safe_id(data.get('studentId', ''))
    password = data.get('password', '')
    if not student_id or not password:
        return jsonify({'ok': False, 'reason': 'studentId+password chahiye'}), 400

    client = PortalClient()
    r1 = client.submit_uid(data.get('studentId', '').strip())
    if not r1['ok']:
        return jsonify({'ok': False, 'reason': r1['reason']})

    # CAPTCHA nikalo
    cap = client.get_captcha()
    if not cap['ok']:
        return jsonify({'ok': False, 'reason': 'captcha nahi mila: ' + cap['reason']})

    sessions[student_id] = {
        'client': client,
        'password': password,
        'logged_in': False,
        'captcha_pending': True,
        'captcha_image': cap['image'],
        'created': time.time(),
    }
    return jsonify({'ok': True, 'captchaNeeded': True})

@app.route('/captcha/<student_id>')
def get_captcha(student_id):
    clean()
    sid = safe_id(student_id)
    s = sessions.get(sid)
    if not s or not s.get('captcha_pending'):
        return jsonify({'ok': False, 'reason': 'no-pending-captcha'}), 404
    img = s.get('captcha_image')
    if not img:
        # Naya captcha nikalo
        cap = s['client'].get_captcha()
        if not cap['ok']:
            return jsonify({'ok': False, 'reason': 'captcha-expired'}), 404
        img = cap['image']
        s['captcha_image'] = img
    return send_file(io.BytesIO(img), mimetype='image/png')

@app.route('/captcha/<student_id>', methods=['POST'])
def submit_captcha(student_id):
    clean()
    sid = safe_id(student_id)
    s = sessions.get(sid)
    if not s:
        return jsonify({'ok': False, 'reason': 'session expired'}), 404

    data = request.json or {}
    text = (data.get('text') or '').strip()
    if not text:
        return jsonify({'ok': False, 'reason': 'text chahiye'}), 400

    r = s['client'].submit_login(s['password'], text)
    if not r['ok']:
        # Naya CAPTCHA taiyaar karo retry ke liye
        cap = s['client'].get_captcha()
        if cap['ok']:
            s['captcha_image'] = cap['image']
        s['created'] = time.time()
        return jsonify({'ok': False, 'retry': True,
                        'reason': r['reason']})

    s['logged_in'] = True
    s['captcha_pending'] = False
    s['created'] = time.time()
    # Password memory se hatao (suraksha)
    s['password'] = ''
    return jsonify({'ok': True})

@app.route('/data/<student_id>')
def get_data(student_id):
    clean()
    sid = safe_id(student_id)
    s = sessions.get(sid)
    if not s:
        return jsonify({'ok': False, 'reason': 'not-registered'}), 404
    if s.get('captcha_pending'):
        return jsonify({'ok': False, 'captchaNeeded': True})
    if not s.get('logged_in'):
        return jsonify({'ok': False, 'reason': 'login nahi hua'}), 401

    client = s['client']
    data = {'studentId': sid}

    # Attendance summary — app-compatible format
    # Portal URL: frmStudentCourseWiseAttendanceSummary.aspx?type=<token>
    # Token dashboard se nikalna padta hai!
    att_url = '/frmStudentCourseWiseAttendanceSummary.aspx'  # fallback
    d = client.get_page('/StudentHome.aspx')
    if d['ok']:
        from bs4 import BeautifulSoup
        import re
        soup = BeautifulSoup(d['html'], 'html.parser')
        for a in soup.find_all('a', href=True):
            if 'frmStudentCourseWiseAttendanceSummary.aspx' in a['href']:
                att_url = a['href']
                break

    att = client.get_page(att_url)
    if att['ok']:
        summary = parse_attendance_summary(att['html'])
        if summary:
            data['attendanceSummary'] = summary

    # Profile — Digital ID Card ke liye
    # Portal URL: frmStudentProfile.aspx
    prof = client.get_page('/frmStudentProfile.aspx')
    if prof['ok']:
        profile = parse_profile(prof['html'])
        if profile and (profile.get('name') or profile.get('uid')):
            data['profile'] = profile

    # Timetable — frmMyTimeTable.aspx
    tt = client.get_page('/frmMyTimeTable.aspx')
    if tt['ok']:
        slots = parse_timetable(tt['html'])
        if slots:
            data['timetable'] = slots

    # Datesheet — frmStudentDatesheet.aspx
    ds = client.get_page('/frmStudentDatesheet.aspx')
    if ds['ok']:
        datesheet = parse_datesheet(ds['html'])
        if datesheet:
            data['datesheet'] = datesheet

    # Leaves — duty, general, medical
    leaves = {}
    for kind, url in [('duty', '/frmStudentApplyDutyLeave.aspx'),
                      ('general', '/frmStudentGeneralLeaveApply.aspx'),
                      ('medical', '/frmStudentMedicalLeaveApply.aspx')]:
        lr = client.get_page(url)
        if lr['ok']:
            rows = parse_leave_history(lr['html'])
            leaves[kind] = rows
    if leaves:
        data['leaves'] = leaves

    # Marks — frmStudentMarksView.aspx
    mk = client.get_page('/frmStudentMarksView.aspx')
    if mk['ok']:
        marks = parse_marks(mk['html'])
        if marks:
            data['marks'] = marks

    # Notices — dashboard se announcements
    if d['ok']:
        notices = parse_notices(d['html'])
        if notices and (notices.get('announcements') or notices.get('importantMessage')):
            data['notices'] = notices

    # scrapedAt — ISO-8601 (app isko last_sync me convert karta hai)
    from datetime import datetime, timezone
    data['scrapedAt'] = datetime.now(timezone.utc).isoformat()

    s['created'] = time.time()  # TTL refresh
    return jsonify({'ok': True, 'data': data})


def parse_attendance_summary(html):
    """Portal ke attendance table ko app ke format me parse karo.
    Columns: Course Code | Title | Total Delv. | Total Attd. | IDL | ADL |
             VDL | Medical Leave | Eligible Delivered | Eligible Attended |
             Eligible Percentage | View Attendance
    NOTE: td me data-label attribute hai (e.g. data-label="Course Code:")
    """
    from bs4 import BeautifulSoup
    import re
    soup = BeautifulSoup(html, 'html.parser')
    rows = []

    def cell(tr, label):
        # data-label="Course Code:" ya data-label="Course Code"
        el = tr.find('td', attrs={'data-label': label + ':'})
        if not el:
            el = tr.find('td', attrs={'data-label': label})
        return el.get_text(strip=True) if el else ''

    def num(s):
        try:
            n = float(str(s or '').replace(',', ''))
            return n if n == n else 0  # NaN check
        except (ValueError, TypeError):
            return 0

    for table in soup.find_all('table'):
        for tr in table.find_all('tr'):
            code = cell(tr, 'Course Code')
            if not code:
                continue
            btn = tr.find('input', attrs={'value': 'View'})
            rows.append({
                'code': code,
                'title': cell(tr, 'Title'),
                'delivered': num(cell(tr, 'Total Delv.')),
                'attended': num(cell(tr, 'Total Attd.')),
                'idl': num(cell(tr, 'IDL')),
                'adl': num(cell(tr, 'ADL')),
                'vdl': num(cell(tr, 'VDL')),
                'medical': num(cell(tr, 'Medical Leave')),
                'eligibleDelivered': num(cell(tr, 'Eligible Delivered')),
                'eligibleAttended': num(cell(tr, 'Eligible Attended')),
                'pct': num(cell(tr, 'Eligible Percentage')),
                'viewObj': btn.get('obj', '') if btn else '',
                'viewChk': btn.get('chk', '') if btn else '',
            })
        if rows:
            break  # Pehli table jisme data mila

    return rows


def parse_profile(html):
    """Student profile ko app ke format me parse karo.
    URL: frmStudentProfile.aspx
    Section: <h4 class="card-heading">Student Personal Information</h4>
    followed by label | value table.
    """
    from bs4 import BeautifulSoup
    import re
    soup = BeautifulSoup(html, 'html.parser')
    out = {}

    for h4 in soup.find_all('h4', class_='card-heading'):
        if 'student personal information' not in h4.get_text().lower():
            continue
        table = None
        # Pehle next sibling tables dhoondho
        for sib in h4.next_siblings:
            if getattr(sib, 'name', None) == 'table':
                table = sib
                break
        if not table:
            # Parent me dhoondho
            parent = h4.parent
            if parent:
                table = parent.find('table')
        if not table:
            continue
        for tr in table.find_all('tr'):
            tds = tr.find_all('td')
            if len(tds) < 2:
                continue
            label = re.sub(r'[^a-z]+', '', tds[0].get_text(strip=True).lower())
            value = tds[1].get_text(strip=True)
            if label:
                out[label] = value

    return {
        'uid': out.get('uid', ''),
        'name': out.get('name', ''),
        'fathersName': out.get('fathersname', ''),
        'motherName': out.get('mothername', ''),
        'dob': out.get('dob', ''),
        'admissionYear': out.get('admissionyear', ''),
        'currentSection': out.get('currentsection', ''),
        'programCode': out.get('programcode', ''),
    }


def parse_timetable(html):
    """Timetable grid ko app ke format me parse karo.
    URL: frmMyTimeTable.aspx
    Grid: Timing | Mon | Tue | Wed | Thu | Fri | Sat | Sun
    Cell: "<Code>:<L/T/P>::GP-<Group>: By <Teacher>(<ID>) at <Room>"
    """
    from bs4 import BeautifulSoup
    import re
    soup = BeautifulSoup(html, 'html.parser')
    slots = []
    days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

    def parse_cell(text):
        t = (text or '').strip()
        if not t:
            return None
        out = {'raw': t, 'code': '', 'kind': '', 'group': '',
               'teacher': '', 'teacherId': '', 'room': ''}
        parts = t.split(' By ')
        left = parts[0].strip() if parts else ''
        right = parts[1].strip() if len(parts) > 1 else ''
        lp = left.split(':')
        out['code'] = lp[0].strip() if len(lp) > 0 else ''
        out['kind'] = lp[1].strip() if len(lp) > 1 else ''
        gp = lp[3].strip() if len(lp) > 3 else ''
        out['group'] = re.sub(r'^GP-', '', gp)
        m = re.match(r'^(.*?)\((.*?)\)\s+at\s+(.*)$', right)
        if m:
            out['teacher'] = m.group(1).strip()
            out['teacherId'] = m.group(2).strip()
            out['room'] = m.group(3).strip()
        else:
            out['teacher'] = right
        return out

    for table in soup.find_all('table'):
        thead = table.find('thead')
        if not thead:
            continue
        headers = [th.get_text(strip=True) for th in thead.find_all('th')]
        if not headers or headers[0].lower() != 'timing':
            continue
        tbody = table.find('tbody')
        rows = tbody.find_all('tr') if tbody else table.find_all('tr')[1:]
        for tr in rows:
            tds = tr.find_all('td')
            if len(tds) < 8:
                continue
            timing = tds[0].get_text(strip=True)
            if not timing:
                continue
            day_map = {}
            for i, d in enumerate(days):
                day_map[d] = parse_cell(tds[i + 1].get_text() if len(tds) > i + 1 else '')
            slots.append({'timing': timing, 'days': day_map})

    return slots


def parse_datesheet(html):
    """Datesheet table ko app ke format me parse karo.
    URL: frmStudentDatesheet.aspx
    Columns: Exam Type | datesheettype | Course code | Course Name |
             SlotNo | UID | New SlotNo | Exam Date | Exam Timing |
             Exam Venue | Mode OF Exam | Error Reporting
    """
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, 'html.parser')
    rows = []

    for table in soup.find_all('table'):
        thead = table.find('thead')
        if not thead:
            continue
        headers = [th.get_text(strip=True).lower() for th in thead.find_all('th')]
        if 'exam date' not in headers:
            continue
        tbody = table.find('tbody')
        trs = tbody.find_all('tr') if tbody else table.find_all('tr')[1:]
        for tr in trs:
            tds = [td.get_text(strip=True) for td in tr.find_all('td')]
            if len(tds) < 12 or not tds[2]:
                continue
            rows.append({
                'examType': tds[0],
                'datesheetType': tds[1],
                'code': tds[2],
                'name': tds[3],
                'slotNo': tds[4],
                'uid': tds[5],
                'newSlotNo': tds[6],
                'date': tds[7],
                'timing': tds[8],
                'venue': tds[9],
                'mode': tds[10],
                'errorReporting': tds[11],
            })

    return rows


def parse_leave_history(html):
    """Leave history table ko app ke format me parse karo.
    Duty/General/Medical teeno ke liye generic parser.
    "Status" header wali table dhoondhta hai.
    """
    from bs4 import BeautifulSoup
    import re
    soup = BeautifulSoup(html, 'html.parser')
    rows = []

    def norm(s):
        return re.sub(r'[:\s_]+', ' ', (s or '').strip().lower()).strip()

    header_map = {
        'dl no': 'id', 'dlno': 'id', 'id': 'id', 'leave id': 'id',
        'application no': 'id', 'app no': 'id', 'srno': 'id', 'sr no': 'id',
        'timing': 'timing', 'time': 'timing',
        'category': 'category',
        'file name': 'fileName', 'filename': 'fileName', 'document': 'fileName',
        'file': 'fileName',
        'leave type': 'leaveType', 'type': 'leaveType',
        'dated': 'dated', 'date': 'dated', 'applied on': 'dated',
        'applied date': 'dated',
        'status': 'status',
        'remarks': 'remarks', 'remark': 'remarks', 'reason': 'remarks',
    }

    for table in soup.find_all('table'):
        thead = table.find('thead')
        if not thead:
            continue
        headers = [norm(th.get_text()) for th in thead.find_all('th')]
        if not headers or 'status' not in headers:
            continue
        col_idx = {}
        for i, h in enumerate(headers):
            key = header_map.get(h)
            if key and key not in col_idx:
                col_idx[key] = i
        if 'status' not in col_idx or 'id' not in col_idx:
            continue
        tbody = table.find('tbody')
        trs = tbody.find_all('tr') if tbody else table.find_all('tr')[1:]
        for tr in trs:
            if re.search(r'no record found', tr.get_text(), re.I):
                continue
            tds = tr.find_all('td')
            def t(key):
                i = col_idx.get(key)
                return tds[i].get_text(strip=True) if i is not None and i < len(tds) else ''
            lid = re.sub(r'\s+', ' ', t('id')).strip()
            if not lid:
                continue
            rows.append({
                'id': lid,
                'timing': t('timing'),
                'category': t('category'),
                'fileName': t('fileName'),
                'leaveType': t('leaveType'),
                'dated': t('dated'),
                'status': t('status'),
                'remarks': t('remarks'),
            })

    return rows


def parse_marks(html):
    """Marks accordion ko app ke format me parse karo.
    URL: frmStudentMarksView.aspx
    Structure: jQuery UI accordion — .ui-accordion-content per subject.
    """
    from bs4 import BeautifulSoup
    import re
    soup = BeautifulSoup(html, 'html.parser')
    subjects = []

    def num(s):
        try:
            n = float(str(s or '').replace(',', ''))
            return n if n == n else 0
        except (ValueError, TypeError):
            return 0

    for panel in soup.find_all(class_='ui-accordion-content'):
        hidden = panel.find('input', attrs={'type': 'hidden'})
        code = hidden.get('value', '').strip() if hidden else ''
        # Title: preceding h3 header
        title = ''
        for sib in panel.previous_siblings:
            if getattr(sib, 'name', None) == 'h3':
                title = sib.get_text(strip=True)
                break
        m = re.match(r'^(.*?)\s*\(([^)]+)\)\s*$', title)
        if m:
            title = m.group(1).strip()
        exams = []
        for tr in panel.find_all('tr'):
            tds = tr.find_all('td')
            if len(tds) < 3:
                continue
            desc = tds[0].get_text(strip=True)
            if not desc:
                continue
            exams.append({
                'desc': desc,
                'max': num(tds[1].get_text()),
                'obtained': num(tds[2].get_text()),
            })
        if not code and not exams:
            continue
        subjects.append({'code': code, 'title': title, 'exams': exams})

    return subjects


def parse_notices(html):
    """Dashboard se announcements aur important message nikalo.
    URL: StudentHome.aspx
    """
    from bs4 import BeautifulSoup
    import re
    soup = BeautifulSoup(html, 'html.parser')
    out = {}

    def section_body(caption):
        for h3 in soup.find_all('h3', class_='portlet-caption'):
            if caption.lower() in h3.get_text().lower():
                # Next div sibling
                for sib in h3.next_siblings:
                    if getattr(sib, 'name', None) == 'div':
                        return sib
        return None

    # Important Message
    body = section_body('Important Message')
    if body:
        out['importantMessage'] = re.sub(r'\s+', ' ', body.get_text()).strip()

    # Announcements
    body = section_body('Announcements')
    items = []
    if body:
        for h4 in body.find_all('h4'):
            title = h4.get_text(strip=True)
            meta = ''
            content = ''
            nxt = h4.find_next_sibling('p')
            if nxt:
                meta = nxt.get_text(strip=True)
            nxt = h4.find_next_sibling('div')
            if nxt:
                content = nxt.get_text(strip=True)
            if title:
                items.append({'title': title, 'meta': meta, 'content': content})
    out['announcements'] = items

    return out

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=10000)
