#!/usr/bin/env python3
"""
test_login_workflow.py – Autologin AVEC proxy
Priorité Turnstile (ananana.py), fallback IconCaptcha (ravitoto.py - optionnel)
"""

import os
import sys
import json
import time
import random
import subprocess
import base64
from pathlib import Path
from datetime import datetime
from typing import Optional, Dict, Any

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
from cryptography.hazmat.backends import default_backend
from github import Github, GithubException, Auth
from camoufox import Camoufox
from playwright.sync_api import TimeoutError as PlaywrightTimeout

import ananana

# ravitoto est optionnel
try:
    import ravitoto
    HAS_RAVITOTO = True
except ImportError:
    HAS_RAVITOTO = False
    print("ℹ️  Module ravitoto non trouvé → IconCaptcha désactivé")


# ── Variables d'environnement ───────────────────────────────────────────────
EMAIL            = os.getenv("TEST_EMAIL")
PASSWORD         = os.getenv("TEST_PASSWORD")
PLATFORM         = os.getenv("TEST_PLATFORM")
PROXY_INDEX      = int(os.getenv("TEST_PROXY_INDEX", "0") or "0")
INITIAL_TIMER_STR = os.getenv("TEST_INITIAL_TIMER", "60:00")
GH_TOKEN         = os.getenv("GH_TOKEN")
GH_USERNAME      = os.getenv("GH_USERNAME")
GH_REPO          = os.getenv("GH_REPO")
GH_BRANCH        = os.getenv("GH_BRANCH", "main")
USER_ID          = os.getenv("USER_ID")
CRYPTO_SECRET    = os.getenv("CRYPTO_SECRET")
JP_PROXY_LIST    = [p.strip() for p in os.getenv("JP_PROXY_LIST", "").split(",") if p.strip()]

if not CRYPTO_SECRET:
    print("❌ CRYPTO_SECRET est obligatoire")
    sys.exit(1)

USER_FILE   = (
    f"account_{USER_ID}_{PLATFORM}_{EMAIL}.json"
    if USER_ID
    else f"account_{EMAIL}_{PLATFORM}.json"
)
GLOBAL_FILE = "global_accounts.json"

VIDEOS_DIR = Path(__file__).parent / "videos"
VIDEOS_DIR.mkdir(exist_ok=True)


def random_sleep(min_ms: int, max_ms: int) -> None:
    time.sleep(random.randint(min_ms, max_ms) / 1000)


def derive_key(secret: str, salt: bytes = b"salt") -> bytes:
    kdf = Scrypt(salt=salt, length=32, n=2**14, r=8, p=1, backend=default_backend())
    return kdf.derive(secret.encode())


def encrypt(text: str) -> str:
    key = derive_key(CRYPTO_SECRET)
    iv  = os.urandom(16)
    cipher    = Cipher(algorithms.AES(key), modes.CBC(iv), backend=default_backend())
    encryptor = cipher.encryptor()
    pad_len   = 16 - (len(text) % 16)
    padded    = text + chr(pad_len) * pad_len
    encrypted = encryptor.update(padded.encode()) + encryptor.finalize()
    return iv.hex() + ":" + encrypted.hex()


def decrypt(encrypted_text: str) -> str:
    parts = encrypted_text.split(":", 1)
    if len(parts) != 2:
        raise ValueError("Format chiffré invalide (attendu iv:data)")
    key       = derive_key(CRYPTO_SECRET)
    iv        = bytes.fromhex(parts[0])
    encrypted = bytes.fromhex(parts[1])
    cipher    = Cipher(algorithms.AES(key), modes.CBC(iv), backend=default_backend())
    decryptor = cipher.decryptor()
    padded    = decryptor.update(encrypted) + decryptor.finalize()
    pad_len   = padded[-1]
    return padded[:-pad_len].decode()


def time_str_to_minutes(s: str) -> float:
    if not s or ":" not in s:
        return 60.0
    parts = s.split(":")
    mins  = int(parts[0]) if parts[0] else 0
    secs  = int(parts[1]) if len(parts) > 1 and parts[1] else 0
    return mins + secs / 60.0


def parse_proxy_url(proxy_url: str) -> Optional[Dict[str, str]]:
    if not proxy_url:
        return None
    proxy_url = proxy_url.strip()
    if proxy_url.startswith("socks5://") or proxy_url.startswith("socks://"):
        protocol = "socks5"
    else:
        protocol = "http"
    if "://" in proxy_url:
        proxy_url = proxy_url.split("://", 1)[1]
    parts = proxy_url.split("@")
    if len(parts) == 2:
        auth, server = parts
        user, pwd = auth.split(":", 1)
        host, port = server.split(":")
        return {
            "server": f"{protocol}://{host}:{port}",
            "username": user,
            "password": pwd,
        }
    else:
        host, port = proxy_url.split(":")
        return {"server": f"{protocol}://{host}:{port}", "username": None, "password": None}


def start_ffmpeg(video_path: str):
    display = os.environ.get("DISPLAY", ":99")
    args = [
        "ffmpeg", "-f", "x11grab", "-video_size", "1280x720",
        "-i", display, "-c:v", "libx264", "-preset", "ultrafast",
        "-crf", "28", "-pix_fmt", "yuv420p", "-y", video_path,
    ]
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(f"🎥 FFmpeg démarré → {video_path}")
    return proc


def stop_ffmpeg(proc):
    if proc is None:
        return
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
    print("🎥 FFmpeg arrêté")


def human_fill(page, selector: str, value: str, field_name: str) -> None:
    print(f"⌨️  Remplissage de {field_name}...")
    page.fill(selector, value)
    time.sleep(random.uniform(0.5, 1.5))


def scroll_to_element(page, selector: str) -> None:
    try:
        element = page.wait_for_selector(selector, timeout=5000)
        page.evaluate("(el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' })", element)
        time.sleep(random.uniform(1.0, 2.0))
    except Exception:
        pass


def verify_login_success(page) -> bool:
    """Détection stricte de connexion réussie"""
    try:
        url = page.url.lower()

        if any(x in url for x in ["login", "signin", "auth"]):
            pwd = page.query_selector('input[type="password"]')
            if pwd:
                box = pwd.bounding_box()
                if box and box["width"] > 10:
                    return False

        error_text = page.evaluate("""() => {
            const selectors = ['#signupAlert', '.alert-danger', '.error', '[class*="error"]'];
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el && el.offsetParent !== null && el.textContent.trim().length > 0)
                    return el.textContent.trim();
            }
            return '';
        }""")
        if error_text:
            print(f"⚠️ Message d'erreur détecté : {error_text}")
            return False

        cookies = page.context.cookies()
        if len(cookies) == 0:
            print("⚠️ Aucun cookie trouvé → considéré comme non connecté")
            return False

        return True
    except Exception:
        return False


def get_github_client():
    return Github(auth=Auth.Token(GH_TOKEN))


def save_account(account_data: dict) -> None:
    g    = get_github_client()
    repo = g.get_repo(f"{GH_USERNAME}/{GH_REPO}")

    secure             = account_data.copy()
    secure["password"] = encrypt(account_data["password"])
    secure["cookies"]  = encrypt(json.dumps(account_data["cookies"]))
    content            = json.dumps(secure, indent=2)

    max_retries = 3
    for attempt in range(1, max_retries + 1):
        try:
            sha = None
            try:
                contents = repo.get_contents(USER_FILE, ref=GH_BRANCH)
                sha = contents.sha
            except GithubException as e:
                if e.status != 404:
                    raise

            if sha:
                repo.update_file(
                    path=USER_FILE,
                    message=f"Mise à jour du compte {EMAIL}",
                    content=content,
                    branch=GH_BRANCH,
                    sha=sha,
                )
            else:
                repo.create_file(
                    path=USER_FILE,
                    message=f"Création du compte {EMAIL}",
                    content=content,
                    branch=GH_BRANCH,
                )
            print(f"💾 Compte individuel sauvegardé (chiffré) dans {USER_FILE}")
            return

        except GithubException as e:
            if e.status == 409 and attempt < max_retries:
                print(f"⚠️ Conflit de version sur {USER_FILE}, tentative {attempt}/{max_retries}...")
                time.sleep(attempt)
            else:
                raise


def update_global_accounts(new_entry: dict) -> None:
    g    = get_github_client()
    repo = g.get_repo(f"{GH_USERNAME}/{GH_REPO}")

    max_retries = 3
    for attempt in range(1, max_retries + 1):
        try:
            sha     = None
            current = []
            try:
                contents = repo.get_contents(GLOBAL_FILE, ref=GH_BRANCH)
                sha      = contents.sha
                current  = json.loads(base64.b64decode(contents.content).decode())
            except GithubException as e:
                if e.status != 404:
                    raise

            index = next(
                (i for i, acc in enumerate(current)
                 if acc["email"] == new_entry["email"]
                 and acc["platform"] == new_entry["platform"]),
                None
            )
            if index is not None:
                current[index]["lastLogin"] = new_entry["addedAt"]
                print(f"🔄 Compte déjà présent dans {GLOBAL_FILE}, timestamp mis à jour.")
            else:
                current.append(new_entry)
                print(f"🌍 Compte ajouté à {GLOBAL_FILE} : {new_entry['email']} ({new_entry['platform']})")

            content = json.dumps(current, indent=2)
            if sha:
                repo.update_file(GLOBAL_FILE, f"Mise à jour de {new_entry['email']}", content, sha, branch=GH_BRANCH)
            else:
                repo.create_file(GLOBAL_FILE, f"Création de {new_entry['email']}", content, branch=GH_BRANCH)
            return

        except GithubException as e:
            if e.status == 409 and attempt < max_retries:
                print(f"⚠️ Conflit sur {GLOBAL_FILE}, tentative {attempt}/{max_retries}...")
                time.sleep(attempt)
            else:
                raise


def login_page_action(page, email: str, password: str, platform: str) -> bool:

    if verify_login_success(page):
        print("✅ Déjà connecté via cookie persistant")
        return True

    email_selector = (
        '#user_email, '
        'input[name="user_email"], '
        'input[type="email"], '
        'input[name="email"]'
    )
    password_selector = (
        'input[type="password"], '
        'input[name="password"], '
        '#password'
    )
    human_fill(page, email_selector, email, 'email')
    human_fill(page, password_selector, password, 'password')

    select_sel = "#captcha_provider, select"
    try:
        page.wait_for_selector(select_sel, timeout=10000)
        options = page.eval_on_selector_all(
            f"{select_sel} option",
            "opts => opts.map(o => ({ text: o.textContent.trim(), value: o.value }))"
        )
    except:
        options = []

    scroll_to_element(page, '#process_login, button:has-text("Log in"), button:has-text("LOGIN"), button:has-text("Login"), button[type="submit"]')

    captcha_solved = False

    # Priorité Turnstile
    turnstile_opt = next((o for o in options if "Turnstile" in o.get("text", "")), None)
    if turnstile_opt:
        print("🔍 Priorité Turnstile...")
        page.select_option(select_sel, turnstile_opt["value"])
        time.sleep(2)

        if ananana.solve_turnstile(page, timeout=30):
            print("✅ Turnstile résolu")
            captcha_solved = True
        else:
            print("⚠️ Turnstile non résolu...")

    # Fallback IconCaptcha (seulement si disponible)
    icon_opt = next((o for o in options if o.get("text") == "IconCaptcha"), None)
    if not captcha_solved and icon_opt and HAS_RAVITOTO:
        print("🔍 Tentative IconCaptcha...")
        page.select_option(select_sel, icon_opt["value"])
        time.sleep(1)

        login_btn = page.wait_for_selector('#process_login, button:has-text("Log in"), button:has-text("LOGIN")', timeout=5000)
        box = login_btn.bounding_box()
        if not box:
            raise RuntimeError("Bouton Log in introuvable pour IconCaptcha")
        login_coords = {
            'x': box['x'] + box['width'] / 2,
            'y': box['y'] + box['height'] / 2,
        }

        if ravitoto.solve_iconcaptcha(page, login_coords, max_attempts=3):
            print("✅ IconCaptcha résolu")
            captcha_solved = True
        else:
            print("❌ Échec IconCaptcha")
    elif not captcha_solved and icon_opt and not HAS_RAVITOTO:
        print("⚠️ IconCaptcha demandé mais module ravitoto absent")

    if not captcha_solved and options:
        # Si aucun captcha n'a été résolu mais qu'il y avait des options, on continue quand même
        # (certains sites n'ont plus de captcha obligatoire)
        print("⚠️ Aucun captcha résolu, tentative de login quand même...")

    # Clic sur Log in
    login_btn_sel = (
        '#process_login, '
        'button:has-text("Log in"), '
        'button:has-text("LOGIN"), '
        'button:has-text("Login"), '
        'button[type="submit"], '
        'input[type="submit"]'
    )
    scroll_to_element(page, login_btn_sel)
    login_btn = page.wait_for_selector(login_btn_sel, timeout=8000)
    login_btn.click()

    try:
        page.wait_for_load_state("networkidle", timeout=60000)
    except Exception:
        print("⚠️ Navigation lente, attente supplémentaire...")
    time.sleep(5)

    if not verify_login_success(page):
        error = page.evaluate("""() => {
            const alert = document.querySelector('#signupAlert, .alert-danger');
            return alert ? alert.textContent.trim() : 'Aucun message d\\'erreur trouvé';
        }""")
        raise RuntimeError(f"Échec de connexion : {error}")

    print("✅ Connexion réussie")
    return True


def main():
    normalized_email = EMAIL.strip().lower()
    video_path  = VIDEOS_DIR / f"login_{normalized_email.replace('@', '_').replace('.', '_')}.mp4"
    ffmpeg_proc = None

    try:
        # Gestion du proxy
        proxy_dict = None
        if JP_PROXY_LIST:
            proxy_url = JP_PROXY_LIST[PROXY_INDEX] if PROXY_INDEX < len(JP_PROXY_LIST) else JP_PROXY_LIST[0]
            proxy_dict = parse_proxy_url(proxy_url)
            print(f"🌐 Utilisation du proxy index {PROXY_INDEX}")
        else:
            print("ℹ️  Aucun proxy configuré")

        ffmpeg_proc = start_ffmpeg(str(video_path))
        time.sleep(1)

        login_urls = {
            "tronpick": "https://tronpick.io/login.php",
            "litepick": "https://litepick.io/login.php",
            "dogepick": "https://dogepick.io/login.php",
            "solpick":  "https://solpick.io/login.php",
            "bnbpick":  "https://bnbpick.io/login.php",
            "tonpick":  "https://tonpick.game/login.php",
            "suipick":  "https://suipick.io/login.php",
            "polpick":  "https://polpick.io/login.php",
            "tronlux":  "https://tronlux.io/login.php",
            "freetron": "https://freetron.in/login",
        }
        login_url = login_urls.get(PLATFORM, f"https://{PLATFORM}.io/login.php")

        print(f"🌐 Navigation vers {login_url}...")

        with Camoufox(
            headless=False,
            humanize=True,
            geoip=True,
            proxy=proxy_dict
        ) as browser:
            page = browser.new_page()
            page.goto(login_url, wait_until="networkidle", timeout=60000)

            success = login_page_action(page, normalized_email, PASSWORD, PLATFORM)
            if not success:
                raise RuntimeError("La page de login a échoué")

            cookies = page.context.cookies()
            print(f"🍪 Cookies récupérés : {len(cookies)}")

            if len(cookies) == 0:
                print("❌ Aucun cookie récupéré → échec")
                raise RuntimeError("Aucun cookie récupéré après login")

            # Lecture du solde
            initial_balance = 0.0
            try:
                balance_el = page.wait_for_selector('[class*="balance"]', timeout=5000)
                balance_text = balance_el.inner_text()
                initial_balance = float("".join(c for c in balance_text if c.isdigit() or c == "."))
            except Exception:
                try:
                    faucet_url = "https://freetron.in/faucet" if PLATFORM == "freetron" else f"https://{PLATFORM}.io/faucet.php"
                    page.goto(faucet_url, wait_until="networkidle", timeout=30000)
                    time.sleep(5)
                    balance_el = page.query_selector('[class*="balance"]')
                    if balance_el:
                        balance_text = balance_el.inner_text()
                        initial_balance = float("".join(c for c in balance_text if c.isdigit() or c == "."))
                except Exception as e:
                    print(f"⚠️ Impossible de lire le solde : {e}")

        stop_ffmpeg(ffmpeg_proc)
        ffmpeg_proc = None

        # Sauvegarde
        g = get_github_client()
        repo = g.get_repo(f"{GH_USERNAME}/{GH_REPO}")

        existing_account = None
        try:
            if USER_ID:
                content = repo.get_contents(USER_FILE, ref=GH_BRANCH)
                existing_account = json.loads(base64.b64decode(content.content).decode())
        except Exception:
            pass

        created_at = existing_account.get("createdAt") if existing_account else int(time.time() * 1000)
        saved_initial_balance = existing_account.get("initialBalance", initial_balance) if existing_account else initial_balance
        saved_total_claims = existing_account.get("totalClaims", 0) if existing_account else 0

        timer_value = time_str_to_minutes(INITIAL_TIMER_STR)
        account = {
            "email":          normalized_email,
            "password":       PASSWORD,
            "platform":       PLATFORM,
            "proxyIndex":     PROXY_INDEX,
            "enabled":        True,
            "cookies":        cookies,
            "cookiesStatus":  "valid",
            "lastClaim":      int(time.time() * 1000),
            "timer":          timer_value,
            "createdAt":      created_at,
            "initialBalance": saved_initial_balance,
            "totalClaims":    saved_total_claims,
            "finalBalance":   initial_balance,
        }

        save_account(account)
        update_global_accounts({
            "email":    normalized_email,
            "platform": PLATFORM,
            "addedAt":  datetime.utcnow().isoformat() + "Z",
        })

        print("🎉 Script terminé avec succès.")
        sys.exit(0)

    except Exception as e:
        print(f"❌ Erreur fatale : {e}")
        if ffmpeg_proc:
            stop_ffmpeg(ffmpeg_proc)
        sys.exit(1)


if __name__ == "__main__":
    main()
