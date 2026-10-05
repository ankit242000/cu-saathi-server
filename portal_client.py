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

        # Password field (name ya id — jo mile)
        pass_input = soup.find('input', {'type': 'password'})
        pw_name = pass_input.get('name') if pass_input else None
        if not pw_name and pass_input:
            pw_name = pass_input.get('id')
        if not pass_input or not pw_name:
            return {'ok': False, 'reason': 'Password field nahi mila'}
        fields[pw_name] = password

        # CAPTCHA field (name ya id me captcha/cap dhoondho)
        cap_input = None
        for inp in soup.find_all('input', {'type': 'text'}):
            name = inp.get('name', '') or inp.get('id', '')
            if 'captcha' in name.lower() or 'cap' in name.lower():
                cap_input = inp
                break
        if cap_input:
            cap_name = cap_input.get('name') or cap_input.get('id')
            if cap_name:
                fields[cap_name] = captcha_text

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
        # Privacy-safe diagnostics (no personal data, no HTML content)
        debug = {
            'http_status': r.status_code,
            'body_len': len(body),
            'cookie_count': len(self.s.cookies),
            'has_studenthome': 'StudentHome.aspx' in body or 'studenthome' in body.lower(),
            'has_landing': 'LandingPage' in body,
            'has_login_form': 'txtUserId' in body or 'txtPassword' in body,
            'has_captcha_img': 'captcha' in body.lower() and 'img' in body.lower(),
            'has_error_text': 'invalid' in body.lower() or 'incorrect' in body.lower() or 'failed' in body.lower(),
            'has_delta': '|#|' in body[:500] if len(body) > 0 else False,
        }
        # Success check: dashboard ya redirect
        if debug['has_studenthome']:
            return {'ok': True, 'html': body, 'debug': debug}
        # Delta redirect check
        if sm_name:
            try:
                redirect = self._parse_delta_redirect(body)
                if redirect:
                    debug['delta_redirect'] = redirect[:100]  # URL path only, no personal data
                    return {'ok': True, 'redirect': redirect, 'debug': debug}
            except:
                pass
        return {'ok': False, 'reason': 'Login success confirm nahi hua', 'debug': debug}

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

    def submit_attendance_search(self, att_html, att_url):
        """Attendance page par Search button dabao taaki data table aaye.
        att_html: attendance filter page ka HTML (119KB)
        att_url: attendance page ka URL
        Returns: {'ok': bool, 'html': str, 'status': int}
        """
        from bs4 import BeautifulSoup
        import re
        from urllib.parse import urljoin
        soup = BeautifulSoup(att_html, 'html.parser')
        
        # ViewState nikalo
        vs = soup.find('input', {'name': '__VIEWSTATE'})
        ev = soup.find('input', {'name': '__EVENTVALIDATION'})
        viewstate = vs.get('value', '') if vs else ''
        eventvalidation = ev.get('value', '') if ev else ''
        
        # Search button dhoondho
        event_target = None
        for inp in soup.find_all('input', {'type': 'submit'}):
            val = inp.get('value', '').lower()
            if 'search' in val:
                # onclick me __doPostBack ho sakta hai
                onclick = inp.get('onclick', '')
                m = re.search(r"__doPostBack\('([^']+)'", onclick)
                if m:
                    event_target = m.group(1)
                else:
                    # Name attribute use karo
                    event_target = inp.get('name', '')
                break
        
        # Agar button nahi mila to form ka default submit
        data = {
            '__VIEWSTATE': viewstate,
            '__EVENTVALIDATION': eventvalidation,
        }
        if event_target:
            data['__EVENTTARGET'] = event_target
            data['__EVENTARGUMENT'] = ''
        
        # Form ke saare hidden inputs bhi add karo
        for inp in soup.find_all('input', {'type': 'hidden'}):
            name = inp.get('name')
            if name and name not in data:
                data[name] = inp.get('value', '')
        
        from urllib.parse import urljoin
        full_url = urljoin('https://students.cuchd.in/', att_url)
        r = self.s.post(full_url, data=data, timeout=30)
        return {'ok': r.status_code == 200, 'html': r.text, 'status': r.status_code}

    def get_page(self, url, referer=None):
        """Authenticated page fetch - plain GET (portal uses simple GETs for navigation)"""
        full = urljoin(BASE, url)
        headers = {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'max-age=0',
            'Upgrade-Insecure-Requests': '1',
            # Sec-Fetch metadata (real browser sends these automatically)
            'Sec-Fetch-Site': 'same-origin',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-User': '?1',
            # Client Hints (Chrome 124)
            'Sec-CH-UA': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
            'Sec-CH-UA-Mobile': '?0',
            'Sec-CH-UA-Platform': '"Windows"',
        }
        if referer:
            headers['Referer'] = urljoin(BASE, referer)
        else:
            # Default referer: dashboard (portal expects navigation from dashboard)
            headers['Referer'] = urljoin(BASE, '/StudentHome.aspx')
        r = self.s.get(full, headers=headers, timeout=30)
        return {'ok': r.status_code == 200, 'html': r.text, 'status': r.status_code}

    def navigate_via_postback(self, dashboard_html, link_text, debug_info=None):
        """Dashboard se menu link par click karke navigate karo (WebForms postback).
        link_text: menu item ka text (e.g. 'My Attendance', 'Time Table')
        Returns: {'ok': bool, 'html': str, 'status': int}
        """
        from bs4 import BeautifulSoup
        import re
        soup = BeautifulSoup(dashboard_html, 'html.parser')
        
        # Debug: collect all menu link texts (privacy-safe, just link texts)
        if debug_info is not None:
            all_links = []
            for a in soup.find_all('a', href=True):
                txt = a.get_text(strip=True)[:30]
                if txt:
                    all_links.append(txt)
            debug_info['menu_link_count'] = len(all_links)
            debug_info['menu_links_sample'] = all_links[:20]
            debug_info['total_a_tags'] = len(soup.find_all('a'))
            debug_info['search_pattern'] = link_text[:50]
        
        # Menu link dhoondho: pehle text se, phir URL pattern se
        # link_text URL fragment bhi ho sakta hai (e.g. 'frmMyTimeTable.aspx')
        event_target = None
        direct_href = None
        is_url_pattern = '.' in link_text and ('aspx' in link_text.lower() or '/' in link_text)
        for a in soup.find_all('a', href=True):
            href = a['href']
            text = a.get_text()
            matched = False
            if is_url_pattern:
                # URL pattern se match karo (e.g. 'frmMyTimeTable.aspx' in href)
                if link_text.lower() in href.lower():
                    matched = True
            else:
                # Text se match karo (purana tarika)
                if link_text.lower() in text.lower():
                    matched = True
            if matched:
                # javascript:__doPostBack('ctl00$...','') format
                m = re.search(r"__doPostBack\('([^']+)'", href)
                if m:
                    event_target = m.group(1)
                    break
                elif not href.startswith('javascript:'):
                    # Regular link — use directly
                    direct_href = href
                    break
        
        if direct_href:
            # Regular link hai, direct GET karo
            if debug_info is not None:
                debug_info['nav_method'] = 'direct_href'
                debug_info['direct_href'] = direct_href[:100]
            return self.get_page(direct_href)
        
        # Fallback: onclick handlers me __doPostBack dhoondho
        if not event_target and not direct_href:
            for tag in soup.find_all(attrs={'onclick': True}):
                onclick = tag.get('onclick', '')
                if link_text.lower() in onclick.lower() or 'dopostback' in onclick.lower():
                    m = re.search(r"__doPostBack\('([^']+)'", onclick, re.IGNORECASE)
                    if m:
                        event_target = m.group(1)
                        if debug_info is not None:
                            debug_info['found_via'] = 'onclick'
                        break
        
        if not event_target:
            if debug_info is not None:
                debug_info['nav_method'] = 'not-found'
            return {'ok': False, 'html': '', 'status': 0, 'error': 'menu-link-not-found'}
        
        if debug_info is not None:
            debug_info['nav_method'] = 'postback'
        
        # Dashboard ka ViewState nikalo (saare hidden fields)
        vs = soup.find('input', {'name': '__VIEWSTATE'})
        ev = soup.find('input', {'name': '__EVENTVALIDATION'})
        vsg = soup.find('input', {'name': '__VIEWSTATEGENERATOR'})
        viewstate = vs.get('value', '') if vs else ''
        eventvalidation = ev.get('value', '') if ev else ''
        viewstategenerator = vsg.get('value', '') if vsg else ''
        
        if debug_info is not None:
            debug_info['has_viewstate'] = bool(viewstate)
            debug_info['has_eventvalidation'] = bool(eventvalidation)
            debug_info['has_viewstategenerator'] = bool(viewstategenerator)
            debug_info['event_target'] = event_target[:50] if event_target else ''
        
        # Postback karo (saare required fields ke saath)
        data = {
            '__EVENTTARGET': event_target,
            '__EVENTARGUMENT': '',
            '__VIEWSTATE': viewstate,
            '__VIEWSTATEGENERATOR': viewstategenerator,
            '__EVENTVALIDATION': eventvalidation,
            '__LASTFOCUS': '',
        }
        # Form action URL nikalo (hardcoded nahi!)
        form = soup.find('form')
        post_url = form.get('action', '/StudentHome.aspx') if form else '/StudentHome.aspx'
        if debug_info is not None:
            debug_info['post_url'] = post_url[:100]
        r = self.s.post(urljoin(BASE, post_url), data=data, timeout=30)
        return {'ok': r.status_code == 200, 'html': r.text, 'status': r.status_code}

    def get_attendance_json(self, att_html, att_url):
        """TRIAL: JSON PageMethod se attendance lao.
        att_html: attendance page ka HTML
        att_url: attendance page ka URL
        Returns: {'ok': bool, 'data': list, 'debug': dict}
        """
        import re
        import json
        debug = {}
        
        # report_id nikalo: getReport('...')
        m = re.search(r"getReport\('([^']+)'\)", att_html)
        if not m:
            debug['error'] = 'report_id not found'
            return {'ok': False, 'debug': debug}
        report_id = m.group(1)
        debug['report_id_found'] = True
        
        # session nikalo: CurrentSession(...)
        m2 = re.search(r"CurrentSession\(['\"]([^'\"]+)['\"]\)", att_html)
        if not m2:
            # Alternative pattern
            m2 = re.search(r"CurrentSession\(([^)]+)\)", att_html)
        session_val = m2.group(1).strip("'\"") if m2 else ""
        debug['session_found'] = bool(session_val)
        
        # JSON POST karo
        post_url = att_url.rsplit('/', 1)[0] + '/frmStudentCourseWiseAttendanceSummary.aspx/GetReport'
        # Actually att_url already has the page, just append /GetReport
        if '/GetReport' not in att_url:
            # att_url is like https://.../frmStudentCourseWiseAttendanceSummary.aspx?type=...
            # We need base page URL without query
            base_page = att_url.split('?')[0]
            post_url = base_page + '/GetReport'
        else:
            post_url = att_url
            
        debug['post_url'] = post_url[:100]
        
        try:
            r = self.s.post(
                post_url,
                json={'report_id': report_id, 'session': session_val},
                headers={'Content-Type': 'application/json'},
                timeout=30
            )
            debug['http_status'] = r.status_code
            if r.status_code != 200:
                debug['error'] = f'HTTP {r.status_code}'
                return {'ok': False, 'debug': debug}
            
            # Response me "d" key me JSON string hai
            resp = r.json()
            if 'd' not in resp:
                debug['error'] = 'no d key in response'
                debug['resp_keys'] = list(resp.keys())[:5]
                return {'ok': False, 'debug': debug}
            
            data_str = resp['d']
            data = json.loads(data_str) if isinstance(data_str, str) else data_str
            debug['rows'] = len(data) if isinstance(data, list) else 0
            return {'ok': True, 'data': data, 'debug': debug}
            
        except Exception as e:
            debug['error'] = str(e)[:100]
            return {'ok': False, 'debug': debug}

    def get_marks_all_sessions(self, marks_url='/frmStudentMarksView.aspx'):
        """Marks: saare sessions ke liye marks nikalo (Aug-2026 scraper pattern).
        1. GET marks page
        2. Dropdown se sessions nikalo
        3. Har session ke liye: fresh GET (VIEWSTATE) -> POST with dropdown value
        Returns: {'ok': bool, 'sessions': list, 'data': dict, 'debug': dict}
        """
        from bs4 import BeautifulSoup
        from urllib.parse import urljoin
        debug = {}
        full_url = urljoin(BASE, marks_url)
        
        # Step 1: GET marks page
        r = self.s.get(full_url, headers={'Referer': urljoin(BASE, '/StudentHome.aspx')}, timeout=30)
        debug['get_status'] = r.status_code
        debug['get_len'] = len(r.text)
        if r.status_code != 200 or len(r.text) < 500:
            debug['error'] = 'marks page fetch failed'
            return {'ok': False, 'debug': debug}
        if 'UIMS Error' in r.text:
            debug['error'] = 'UIMS Error on marks page'
            return {'ok': False, 'debug': debug}
        
        soup = BeautifulSoup(r.text, 'html.parser')
        select_tag = soup.find('select', {'name': 'ctl00$ContentPlaceHolder1$wucStudentMarksView$ddlCAndPSession'})
        if not select_tag:
            debug['error'] = 'session dropdown not found'
            return {'ok': False, 'debug': debug}
        
        sessions = []
        for opt in select_tag.find_all('option'):
            sessions.append({
                'value': opt.get('value', ''),
                'name': opt.get_text(strip=True),
                'isCurrent': opt.get('selected') is not None,
            })
        debug['session_count'] = len(sessions)
        if not sessions:
            debug['error'] = 'no sessions in dropdown'
            return {'ok': False, 'debug': debug}
        
        # Step 2: Har session ke liye marks nikalo
        marks_data = {}
        for sess in sessions:
            try:
                # Fresh GET for VIEWSTATE
                fr = self.s.get(full_url, headers={'Referer': full_url}, timeout=30)
                fsoup = BeautifulSoup(fr.text, 'html.parser')
                vs = fsoup.find('input', {'name': '__VIEWSTATE'})
                ev = fsoup.find('input', {'name': '__EVENTVALIDATION'})
                vsg = fsoup.find('input', {'name': '__VIEWSTATEGENERATOR'})
                
                form_data = {
                    'ctl00$ContentPlaceHolder1$wucStudentMarksView$ddlCAndPSession': sess['value'],
                }
                if vs: form_data['__VIEWSTATE'] = vs.get('value', '')
                if ev: form_data['__EVENTVALIDATION'] = ev.get('value', '')
                if vsg: form_data['__VIEWSTATEGENERATOR'] = vsg.get('value', '')
                form_data['__EVENTTARGET'] = ''
                form_data['__EVENTARGUMENT'] = ''
                
                pr = self.s.post(full_url, data=form_data,
                    headers={'Referer': full_url, 'Content-Type': 'application/x-www-form-urlencoded'},
                    timeout=30)
                if pr.status_code == 200 and 'UIMS Error' not in pr.text:
                    marks_data[sess['value']] = pr.text
            except Exception as e:
                debug[f'session_{sess["value"]}_error'] = str(e)[:50]
        
        debug['fetched_sessions'] = len(marks_data)
        return {'ok': True, 'sessions': sessions, 'data': marks_data, 'debug': debug}

    def get_timetable_data(self, tt_url='/frmMyTimeTable.aspx'):
        """Timetable: ReportViewer pattern (Aug-2026 scraper).
        1. GET timetable page
        2. Agar #grdMain nahi mila to POST with EVENTTARGET
        Returns: {'ok': bool, 'html': str, 'debug': dict}
        """
        from bs4 import BeautifulSoup
        from urllib.parse import urljoin
        debug = {}
        full_url = urljoin(BASE, tt_url)
        
        r = self.s.get(full_url, headers={'Referer': urljoin(BASE, '/StudentHome.aspx')}, timeout=30)
        debug['get_status'] = r.status_code
        debug['get_len'] = len(r.text)
        if r.status_code != 200:
            debug['error'] = f'HTTP {r.status_code}'
            return {'ok': False, 'debug': debug}
        if 'UIMS Error' in r.text:
            debug['error'] = 'UIMS Error'
            return {'ok': False, 'debug': debug}
        
        soup = BeautifulSoup(r.text, 'html.parser')
        if soup.find(id='grdMain'):
            debug['method'] = 'direct_get'
            return {'ok': True, 'html': r.text, 'debug': debug}
        
        # POST with EVENTTARGET for ReportViewer
        vs = soup.find('input', {'name': '__VIEWSTATE'})
        if vs and vs.get('value'):
            post_data = {
                '__VIEWSTATE': vs.get('value', ''),
                '__EVENTTARGET': 'ctl00$ContentPlaceHolder1$ReportViewer1$ctl09$Reserved_AsyncLoadTarget',
                '__EVENTARGUMENT': '',
            }
            vsg = soup.find('input', {'name': '__VIEWSTATEGENERATOR'})
            ev = soup.find('input', {'name': '__EVENTVALIDATION'})
            if vsg: post_data['__VIEWSTATEGENERATOR'] = vsg.get('value', '')
            if ev: post_data['__EVENTVALIDATION'] = ev.get('value', '')
            
            pr = self.s.post(full_url, data=post_data,
                headers={'Referer': full_url, 'Content-Type': 'application/x-www-form-urlencoded'},
                timeout=30)
            debug['post_status'] = pr.status_code
            debug['post_len'] = len(pr.text)
            if pr.status_code == 200 and 'UIMS Error' not in pr.text:
                psoup = BeautifulSoup(pr.text, 'html.parser')
                if psoup.find(id='grdMain'):
                    debug['method'] = 'postback'
                    return {'ok': True, 'html': pr.text, 'debug': debug}
        
        debug['error'] = 'grdMain not found'
        return {'ok': False, 'debug': debug}

    def get_attendance_report_json(self, att_html, att_url):
        """Attendance JSON API - CORRECT format from Aug-2026 scraper.
        POST /frmStudentCourseWiseAttendanceSummary.aspx/GetReport
        Body: {UID:'<reportId>',Session:'<sessionId>'}
        Returns: {'ok': bool, 'data': list, 'debug': dict}
        """
        import re
        import json
        from urllib.parse import urljoin
        debug = {}
        
        # report_id: getReport('...') ya similar pattern
        m = re.search(r"getReport\('([^']+)'\)", att_html)
        if not m:
            m = re.search(r"['\"]UID['\"]\s*:\s*['\"]([^'\"]+)['\"]", att_html)
        if not m:
            debug['error'] = 'report_id not found in HTML'
            return {'ok': False, 'debug': debug}
        report_id = m.group(1)
        debug['report_id_len'] = len(report_id)
        
        # session_id: CurrentSession('...') ya similar
        m2 = re.search(r"CurrentSession\(['\"]([^'\"]+)['\"]\)", att_html)
        if not m2:
            m2 = re.search(r"['\"]Session['\"]\s*:\s*['\"]([^'\"]+)['\"]", att_html)
        session_val = m2.group(1) if m2 else ""
        debug['session_found'] = bool(session_val)
        
        # POST URL
        base_page = att_url.split('?')[0] if '?' in att_url else att_url
        if not base_page.startswith('http'):
            base_page = urljoin(BASE, base_page)
        post_url = base_page + '/GetReport'
        debug['post_url'] = post_url[:80]
        
        # CORRECT JSON format: {UID:'...',Session:'...'}
        json_body = "{UID:'%s',Session:'%s'}" % (report_id, session_val)
        
        try:
            r = self.s.post(post_url, data=json_body,
                headers={'Content-Type': 'application/json; charset=utf-8',
                         'Referer': base_page},
                timeout=30)
            debug['http_status'] = r.status_code
            if r.status_code != 200:
                debug['error'] = f'HTTP {r.status_code}'
                debug['resp_preview'] = r.text[:200]
                return {'ok': False, 'debug': debug}
            
            resp = r.json()
            if 'd' not in resp:
                debug['error'] = 'no d key'
                debug['resp_keys'] = list(resp.keys())[:5]
                return {'ok': False, 'debug': debug}
            
            data_str = resp['d']
            data = json.loads(data_str) if isinstance(data_str, str) else data_str
            debug['rows'] = len(data) if isinstance(data, list) else 0
            return {'ok': True, 'data': data, 'debug': debug}
        except Exception as e:
            debug['error'] = str(e)[:100]
            return {'ok': False, 'debug': debug}

    def get_datesheet_data(self, ds_url='/frmStudentDatesheet.aspx'):
        """Datesheet: simple GET + parse (WebForms pattern).
        Returns: {'ok': bool, 'html': str, 'debug': dict}
        """
        from bs4 import BeautifulSoup
        from urllib.parse import urljoin
        debug = {}
        full_url = urljoin(BASE, ds_url)
        
        r = self.s.get(full_url, headers={'Referer': urljoin(BASE, '/StudentHome.aspx')}, timeout=30)
        debug['get_status'] = r.status_code
        debug['get_len'] = len(r.text)
        if r.status_code != 200:
            debug['error'] = f'HTTP {r.status_code}'
            return {'ok': False, 'debug': debug}
        if 'UIMS Error' in r.text:
            debug['error'] = 'UIMS Error'
            return {'ok': False, 'debug': debug}
        
        # Check if datesheet table exists
        soup = BeautifulSoup(r.text, 'html.parser')
        has_table = bool(soup.find('table'))
        debug['has_table'] = has_table
        debug['method'] = 'direct_get'
        return {'ok': True, 'html': r.text, 'debug': debug}

    def get_leave_data(self, leave_url, leave_type='duty'):
        """Leave history: simple GET + parse (WebForms pattern).
        leave_url: e.g. '/frmStudentApplyDutyLeave.aspx'
        Returns: {'ok': bool, 'html': str, 'debug': dict}
        """
        from bs4 import BeautifulSoup
        from urllib.parse import urljoin
        debug = {'leave_type': leave_type}
        full_url = urljoin(BASE, leave_url)
        
        r = self.s.get(full_url, headers={'Referer': urljoin(BASE, '/StudentHome.aspx')}, timeout=30)
        debug['get_status'] = r.status_code
        debug['get_len'] = len(r.text)
        if r.status_code != 200:
            debug['error'] = f'HTTP {r.status_code}'
            return {'ok': False, 'debug': debug}
        if 'UIMS Error' in r.text:
            debug['error'] = 'UIMS Error'
            return {'ok': False, 'debug': debug}
        
        soup = BeautifulSoup(r.text, 'html.parser')
        has_table = bool(soup.find('table'))
        debug['has_table'] = has_table
        debug['method'] = 'direct_get'
        return {'ok': True, 'html': r.text, 'debug': debug}

    def replay_dashboard_webmethods(self):
        """Dashboard ke WebMethod AJAX calls replay karo taaki session state initialize ho.
        Ye calls browser dashboard load par karta hai. Inke bina inner pages UIMS Error dete hain.
        Returns: {'ok': bool, 'methods_ok': int, 'debug': dict}
        """
        from urllib.parse import urljoin
        import json
        debug = {}
        methods_ok = 0
        
        # Student WebMethods jo dashboard load par call hote hain
        webmethods = [
            'LoadPendingNotifications',
            'DisplayAnnouncements', 
            'DisplayStudentMyMessages',
            'LoadRecentMenuLinks',
            'DisplayPopup',
            'DisplaySubjectDetails',
        ]
        
        base = urljoin(BASE, '/StudentHome.aspx')
        
        for method in webmethods:
            try:
                url = f"{base}/{method}"
                # WebMethod POST: JSON body, special content-type
                r = self.s.post(url,
                    data='{}',
                    headers={
                        'Content-Type': 'application/json; charset=utf-8',
                        'Accept': 'application/json',
                        'Referer': base,
                        'X-Requested-With': 'XMLHttpRequest',
                    },
                    timeout=15)
                debug[method] = {
                    'status': r.status_code,
                    'len': len(r.text),
                    'has_d': '"d"' in r.text[:100],
                }
                if r.status_code == 200 and '"d"' in r.text:
                    methods_ok += 1
            except Exception as e:
                debug[method] = {'error': str(e)[:50]}
        
        debug['methods_ok'] = methods_ok
        debug['total'] = len(webmethods)
        return {'ok': methods_ok > 0, 'methods_ok': methods_ok, 'debug': debug}
