"""Encrypted cookie persistence for CU Saathi server.

Cookies ko Fernet (AES-128-CBC + HMAC-SHA256) se encrypt karke disk par save karta hai.
- Password KABHI save nahi hota - sirf session cookies!
- Key PBKDF2HMAC (100,000 iterations) se derive hoti hai
- Har deployment ka alag salt
- 7-day auto-expiry
- File permission 0600 (sirf server padh sake)
"""
import os
import time
import base64

COOKIE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.cookies')

def _ensure_dir():
    os.makedirs(COOKIE_DIR, exist_ok=True)
    # Directory ko bhi restrictive rakho
    try:
        os.chmod(COOKIE_DIR, 0o700)
    except Exception:
        pass

def _get_fernet():
    """PBKDF2 se strong key derive karo (top-notch security)."""
    from cryptography.fernet import Fernet
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    from cryptography.hazmat.primitives import hashes

    secret = os.environ.get('COOKIE_SECRET', '')
    if not secret:
        # Dev fallback - production me COOKIE_SECRET env var SET KARO!
        secret = 'cu-saathi-dev-fallback-key-change-in-production'

    # Salt: env var se ya deterministic fallback (har deployment consistent rahe)
    salt_b64 = os.environ.get('COOKIE_SALT', '')
    if salt_b64:
        try:
            salt = base64.urlsafe_b64decode(salt_b64.encode())
        except Exception:
            salt = b'cu-saathi-salt-16b'
    else:
        salt = b'cu-saathi-salt-16b'

    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=100_000,  # 1 lakh rounds - brute force impractical
    )
    key = base64.urlsafe_b64encode(kdf.derive(secret.encode()))
    return Fernet(key)

def _safe_id(student_id):
    """Filename-safe student ID (path traversal se bachao)."""
    import re
    return re.sub(r'[^a-zA-Z0-9_-]', '_', str(student_id))[:64]

def save_cookies(student_id, cookie_jar):
    """Session cookies ko encrypt karke save karo. Returns True/False."""
    try:
        import pickle
        _ensure_dir()
        f = _get_fernet()
        payload = {
            'sid': _safe_id(student_id),
            'cookies': dict(cookie_jar),
            'saved_at': time.time(),
        }
        encrypted = f.encrypt(pickle.dumps(payload))
        path = os.path.join(COOKIE_DIR, f'{_safe_id(student_id)}.enc')
        with open(path, 'wb') as fp:
            fp.write(encrypted)
        os.chmod(path, 0o600)  # sirf owner padh sake
        return True
    except Exception:
        return False

def load_cookies(student_id):
    """Saved cookies decrypt karke lao. None agar nahi mile/expire/invalid."""
    try:
        import pickle
        sid = _safe_id(student_id)
        path = os.path.join(COOKIE_DIR, f'{sid}.enc')
        if not os.path.exists(path):
            return None
        f = _get_fernet()
        with open(path, 'rb') as fp:
            encrypted = fp.read()
        payload = pickle.loads(f.decrypt(encrypted))
        # Student ID bind check - cookie dusre ID par kaam nahi karega
        if payload.get('sid') != sid:
            return None
        # 7 din se purana cookie discard
        if time.time() - payload.get('saved_at', 0) > 7 * 24 * 3600:
            try:
                os.remove(path)
            except Exception:
                pass
            return None
        cookies = payload.get('cookies')
        if not isinstance(cookies, dict) or not cookies:
            return None
        return cookies
    except Exception:
        return None


def clear_cookies(student_id):
    """Logout par saved cookies delete karo."""
    try:
        path = os.path.join(COOKIE_DIR, f'{_safe_id(student_id)}.enc')
        if os.path.exists(path):
            os.remove(path)
        return True
    except Exception:
        return False
