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
    # Portal URL: frmStudentCourseWiseAttendanceSummary.aspx
    att = client.get_page('/frmStudentCourseWiseAttendanceSummary.aspx')
    if att['ok']:
        summary = parse_attendance_summary(att['html'])
        if summary:
            data['attendanceSummary'] = summary

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

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=10000)
