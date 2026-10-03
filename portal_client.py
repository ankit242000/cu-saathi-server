"""
CU Portal Client — curl_cffi se TLS impersonation ke saath.
Approach #2: Chrome jaisa TLS fingerprint, bot detection bypass.

Flow:
1. GET login page → ViewState + form fields nikalo
2. POST Stage 1 (UID + NEXT) → Stage 2 page (password + CAPTCHA)
3. GET CAPTCHA image (same session!) → user ko dikhao
4. POST Stage 2 (password + CAPTCHA + LOGIN) → dashboard
5. Data pages scrape karo
"""
from curl_cffi import requests as crequests
from bs4 import BeautifulSoup
import re
from urllib.parse import urljoin

BASE = 'https://students.cuchd.in'

class PortalClient:
    def __init__(self):
        # Chrome 124 impersonation — TLS fingerprint Chrome jaisa
        self.s = crequests.Session(impersonate="chrome124")
        self.s.headers.update({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        })
        self.form_action = None
        self.stage2_fields = None

    def get_login_page(self):
        """Step 1: Login page lao"""
        r = self.s.get(BASE + '/', timeout=30)
        if r.status_code != 200:
            return {'ok': False, 'reason': f'HTTP {r.status_code}'}
        self.form_action = self._get_form_action(r.text, r.url)
        return {'ok': True, 'html': r.text}

    def _get_form_action(self, html, url):
        soup = BeautifulSoup(html, 'html.parser')
        form = soup.find('form')
        action = form.get('action', '/') if form else '/'
        return urljoin(url, action)

    def _collect_fields(self, html):
        """Saare form fields nikalo"""
        soup = BeautifulSoup(html, 'html.parser')
        fields = {}
        for tag in soup.find_all(['input', 'select', 'textarea']):
            name = tag.get('name')
            if not name:
                continue
            t = tag.name.lower()
            itype = (tag.get('type') or 'text').lower()
            if itype in ('submit', 'button', 'image', 'reset', 'file'):
                continue
            if itype in ('checkbox', 'radio') and not tag.get('checked'):
                continue
            if t == 'select':
                opt = tag.find('option', selected=True) or tag.find('option')
                fields[name] = opt.get('value', '') if opt else ''
            else:
                fields[name] = tag.get('value', '')
        return fields

    def _detect_async(self, html):
        """UpdatePanel detect karo"""
        m = re.search(r"PageRequestManager\._initialize\('([^']+)'", html)
        return m.group(1) if m else None

    def _detect_panels(self, html):
        """UpdatePanel IDs seedha _initialize se"""
        m = re.search(r"PageRequestManager\._initialize\('([^']+)',\s*'[^']*',\s*\[([^\]]*)\]", html)
        if not m:
            return None
        panels = re.findall(r"'[tf]([^']+)'", m.group(2))
        return {'sm': m.group(1), 'panels': panels}

    def submit_uid(self, uid):
        """Step 2: UID + NEXT (FULL postback, async nahi!)"""
        r = self.s.get(BASE + '/', timeout=30)
        html = r.text
        self.form_action = self._get_form_action(html, r.url)

        soup = BeautifulSoup(html, 'html.parser')
        fields = self._collect_fields(html)

        # Pehla text input = UID field
        text_input = soup.find('input', {'type': 'text'})
        if not text_input or not text_input.get('name'):
            return {'ok': False, 'reason': 'UID field nahi mila'}
        fields[text_input['name']] = uid

        # NEXT button dhoondho
        next_btn = None
        for btn in soup.find_all(['input', 'button']):
            val = (btn.get('value') or '') + (btn.get_text() or '') + (btn.get('id') or '')
            if 'next' in val.lower():
                next_btn = btn
                break
        if not next_btn or not next_btn.get('name'):
            return {'ok': False, 'reason': 'NEXT button nahi mila'}

        next_name = next_btn['name']

        # NOTE: NEXT button UpdatePanel me NAHI hai — FULL postback karo, async nahi!
        # ASP.NET WebForms: __EVENTTARGET use karo button name ki jagah
        # Sirf normal headers bhejo, X-MicrosoftAjax nahi!
        headers = {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Origin': BASE,
            'Referer': self.form_action,
        }

        # WebForms postback: __EVENTTARGET=btnNext
        fields['__EVENTTARGET'] = 'btnNext'
        fields['__EVENTARGUMENT'] = ''
        # Button ka name/value mat bhejo (WebForms me zaroorat nahi)

        r = self.s.post(self.form_action, data=fields, headers=headers, timeout=30)
        if r.status_code >= 400:
            return {'ok': False, 'reason': f'Stage 1 HTTP {r.status_code}'}

        # Stage 2 = full HTML page (async nahi)
        self.stage2_fields = self._collect_fields(r.text)
        self.stage2_html = r.text
        self.form_action = self._get_form_action(r.text, r.url)

        return {'ok': True, 'async': False}

    def _parse_delta(self, text):
        """Delta response se HTML nikalo"""
        html_parts = []
        i = 0
        while i < len(text):
            p1 = text.find('|', i)
            if p1 < 0:
                break
            try:
                length = int(text[i:p1])
            except:
                break
            p2 = text.find('|', p1 + 1)
            p3 = text.find('|', p2 + 1)
            if p2 < 0 or p3 < 0:
                break
            dtype = text[p1+1:p2]
            content = text[p3+1:p3+1+length]
            if dtype == 'updatePanel':
                html_parts.append(content)
            i = p3 + 1 + length + 1
        return ''.join(html_parts)

    def _parse_delta_hidden(self, text):
        """Delta se hidden fields (naya viewstate)"""
        hidden = {}
        i = 0
        while i < len(text):
            p1 = text.find('|', i)
            if p1 < 0:
                break
            try:
                length = int(text[i:p1])
            except:
                break
            p2 = text.find('|', p1 + 1)
            p3 = text.find('|', p2 + 1)
            if p2 < 0 or p3 < 0:
                break
            dtype = text[p1+1:p2]
            did = text[p2+1:p3]
            content = text[p3+1:p3+1+length]
            if dtype == 'hiddenField':
                hidden[did] = content
            i = p3 + 1 + length + 1
        return hidden

    def get_captcha(self):
        """Step 3: CAPTCHA image nikalo (same session!)"""
        soup = BeautifulSoup(self.stage2_html, 'html.parser')
        cap_img = None
        for img in soup.find_all('img'):
            src = img.get('src', '')
            if 'captcha' in src.lower():
                cap_img = src
                break
        if not cap_img:
            return {'ok': False, 'reason': 'CAPTCHA image nahi mili'}

        url = urljoin(self.form_action, cap_img)
        r = self.s.get(url, headers={'Referer': self.form_action}, timeout=30)
        if r.status_code != 200:
            return {'ok': False, 'reason': f'CAPTCHA HTTP {r.status_code}'}
        return {'ok': True, 'image': r.content}

    def submit_login(self, password, captcha_text):
        """Step 4: Password + CAPTCHA + LOGIN"""
        soup = BeautifulSoup(self.stage2_html, 'html.parser')
        fields = dict(self.stage2_fields)

        # Password field
        pass_input = soup.find('input', {'type': 'password'})
        if not pass_input or not pass_input.get('name'):
            return {'ok': False, 'reason': 'Password field nahi mila'}
        fields[pass_input['name']] = password

        # CAPTCHA field
        cap_input = None
        for inp in soup.find_all('input', {'type': 'text'}):
            name = inp.get('name', '')
            if 'captcha' in name.lower() or 'cap' in name.lower():
                cap_input = inp
                break
        if cap_input and cap_input.get('name'):
            fields[cap_input['name']] = captcha_text

        # LOGIN button
        login_btn = None
        for btn in soup.find_all(['input', 'button']):
            val = (btn.get('value') or '') + (btn.get_text() or '')
            if 'login' in val.lower() or 'sign' in val.lower():
                login_btn = btn
                break
        if login_btn and login_btn.get('name'):
            fields[login_btn['name']] = login_btn.get('value', 'Login')

        fields['__EVENTTARGET'] = ''
        fields['__EVENTARGUMENT'] = ''

        sm_name = self._detect_async(self.stage2_html)
        headers = {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Origin': BASE,
            'Referer': self.form_action,
        }
        if sm_name:
            panel_info = self._detect_panels(self.stage2_html)
            panel_id = panel_info['panels'][0] if panel_info and panel_info['panels'] else ''
            login_name = login_btn['name'] if login_btn and login_btn.get('name') else ''
            fields[sm_name] = f'{panel_id}|{login_name}'
            fields['__ASYNCPOST'] = 'true'
            headers['X-MicrosoftAjax'] = 'Delta=true'
            headers['X-Requested-With'] = 'XMLHttpRequest'

        r = self.s.post(self.form_action, data=fields, headers=headers, timeout=30)
        if r.status_code >= 400:
            return {'ok': False, 'reason': f'Stage 2 HTTP {r.status_code}'}

        body = r.text
        # Success check: dashboard ya redirect
        if 'StudentHome.aspx' in body or 'studenthome' in body.lower():
            return {'ok': True, 'html': body}
        # Delta redirect check
        if sm_name:
            try:
                redirect = self._parse_delta_redirect(body)
                if redirect:
                    return {'ok': True, 'redirect': redirect}
            except:
                pass
        return {'ok': False, 'reason': 'Login success confirm nahi hua', 'html': body[:2000]}

    def _parse_delta_redirect(self, text):
        i = 0
        while i < len(text):
            p1 = text.find('|', i)
            if p1 < 0:
                break
            try:
                length = int(text[i:p1])
            except:
                break
            p2 = text.find('|', p1 + 1)
            p3 = text.find('|', p2 + 1)
            if p2 < 0 or p3 < 0:
                break
            dtype = text[p1+1:p2]
            content = text[p3+1:p3+1+length]
            if dtype == 'pageRedirect':
                return content
            i = p3 + 1 + length + 1
        return None

    def get_page(self, url):
        """Authenticated page fetch"""
        full = urljoin(BASE, url)
        r = self.s.get(full, timeout=30)
        return {'ok': r.status_code == 200, 'html': r.text, 'status': r.status_code}
