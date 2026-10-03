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
    result = {'studentId': sid}

    # Dashboard
    d = client.get_page('/StudentHome.aspx')
    result['dashboard_ok'] = d['ok']

    # Attendance link dhoondho
    if d['ok']:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(d['html'], 'html.parser')
        att_url = None
        for a in soup.find_all('a', href=True):
            if 'attendance' in a['href'].lower():
                att_url = a['href']
                break
        if att_url:
            a = client.get_page(att_url)
            result['attendance_ok'] = a['ok']
            if a['ok']:
                # Tables nikalo
                tables = []
                asoup = BeautifulSoup(a['html'], 'html.parser')
                for tbl in asoup.find_all('table'):
                    rows = []
                    for tr in tbl.find_all('tr'):
                        cells = [c.get_text(strip=True) for c in tr.find_all(['td', 'th'])]
                        if cells:
                            rows.append(cells)
                    if rows:
                        tables.append({'rows': rows})
                result['attendance_tables'] = tables
        else:
            result['attendance_ok'] = False

    s['created'] = time.time()  # TTL refresh
    return jsonify({'ok': True, 'data': result})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=10000)
