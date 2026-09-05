#!/usr/bin/env python3
"""
test_login_workflow.py – Autologin avec proxy optionnel.
Priorité Turnstile (ananana.py), fallback IconCaptcha (ravitoto.py).
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

# Modules de résolution de captcha
import ananana      # Turnstile  (solve_turnstile, check_turnstile_token)
import ravitoto     # IconCaptcha (solve_iconcaptcha, move_mouse, click_dot, etc.)


# ── Variables d'environnement ───────────────────────────────────────────────
EMAIL             = os.getenv("TEST_EMAIL")
PASSWORD          = os.getenv("TEST_PASSWORD")
PLATFORM          = os.getenv("TEST_PLATFORM")
PROXY_INDEX       = int(os.getenv("TEST_PROXY_INDEX", "0") or "0")
INITIAL_TIMER_STR = os.getenv("TEST_INITIAL_TIMER", "60:00")
GH_TOKEN          = os.getenv("GH_TOKEN")
GH_USERNAME       = os.getenv("GH_USERNAME")
GH_REPO           = os.getenv("GH_REPO")
GH_BRANCH         = os.getenv("GH_BRANCH", "main")
USER_ID           = os.getenv("USER_ID")
CRYPTO_SECRET     = os.getenv("CRYPTO_SECRET")

JP_PROXY_LIST = [p.strip() for p in os.getenv("JP_PROXY_LIST", "").split(",") if p.strip()]

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


# ── Utilitaires de délai ────────────────────────────────────────────────────
def random_sleep(min_ms: int, max_ms: int) -> None:
    time.sleep(random.randint(min_ms, max_ms) / 1000)


# ── Proxy ──────────────────────────────────────────────────────────────────
def parse_proxy_url(proxy_url: str):
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
        return {"server": f"{protocol}://{host}:{port}", "username": user, "password": pwd}
    else:
        host, port = proxy_url.split(":")
        return {"server": f"{protocol}://{host}:{port}", "username": None, "password": None}


# ── Chiffrement / Déchiffrement (AES-256-CBC + scrypt) ─────────────────────
def derive_key(secret: str, salt: bytes = b"salt") -> bytes:
    kdf = Scrypt(
        salt=salt, length=32, n=2**14, r=8, p=1,
        backend=default_backend()
    )
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


# ── Capture vidéo ───────────────────────────────────────────────────────────
def start_ffmpeg(video_path: str):
    display = os.environ.get("DISPLAY", ":99")
    args = [
        "ffmpeg",
        "-f", "x11grab",
        "-video_size", "1280x720",
        "-i", display,
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "0",
        "-pix_fmt", "yuv420p",
        "-y", video_path,
    ]
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(f"🎥 FFmpeg démarré sur {display}, vidéo → {video_path}")
    return proc


def stop_ffmpeg(proc):
    if proc is None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
    print("🎥 FFmpeg arrêté")


# ── Remplissage via JavaScript (bypass visibilité Playwright) ──────────────
def human_fill(page, selector: str, value: str, field_name: str) -> None:
    print(f"⌨️  Remplissage de {field_name}...")
    # Passer la valeur via un argument JS pour éviter les injections
    # et ne jamais l'afficher dans les logs
    filled = page.evaluate(
        """([selectors, value]) => {
            const list = selectors.split(',').map(s => s.trim());
            for (const sel of list) {
                const el = document.querySelector(sel);
                if (el) {
                    el.focus();
                    el.value = value;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    return sel;
                }
            }
            return null;
        }""",
        [selector, value]
    )
    if not filled:
        raise RuntimeError(f"❌ Aucun champ trouvé pour : {field_name}")
    print(f"   → sélecteur utilisé : {filled}")
    time.sleep(random.uniform(0.5, 1.5))


def scroll_to_element(page, selector: str) -> None:
    try:
        element = page.wait_for_selector(selector, timeout=5000)
        page.evaluate(
            "(el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' })",
            element
        )
        time.sleep(random.uniform(1.0, 2.0))
    except Exception:
        pass


def verify_login_success(page) -> bool:
    try:
        error_text = page.evaluate("""() => {
            const alert = document.querySelector('#signupAlert');
            if (alert && alert.style.display !== 'none' && alert.textContent.trim().length > 0)
                return alert.textContent.trim();
            const danger = document.querySelector('.alert-danger:not([style*="display: none"])');
            if (danger && danger.textContent.trim().length > 0)
                return danger.textContent.trim();
            const error = document.querySelector('.error:not([style*="display: none"])');
            if (error && error.textContent.trim().length > 0)
                return error.textContent.trim();
            return '';
        }""")
        if error_text:
            print(f"⚠️ Message d'erreur détecté : {error_text}")
            return False
    except Exception:
        pass

    if 'login.php' in page.url:
        return False
    return True


# ── Sauvegarde GitHub ───────────────────────────────────────────────────────
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
                repo.update_file(
                    GLOBAL_FILE,
                    f"Mise à jour de {new_entry['email']}",
                    content,
                    sha,
                    branch=GH_BRANCH,
                )
            else:
                repo.create_file(
                    GLOBAL_FILE,
                    f"Création de {new_entry['email']}",
                    content,
                    branch=GH_BRANCH,
                )
            return

        except GithubException as e:
            if e.status == 409 and attempt < max_retries:
                print(f"⚠️ Conflit sur {GLOBAL_FILE}, tentative {attempt}/{max_retries}...")
                time.sleep(attempt)
            else:
                raise


# ── Page de login ───────────────────────────────────────────────────────────
def login_page_action(page, email: str, password: str, platform: str) -> bool:

    if verify_login_success(page):
        print("✅ Déjà connecté via cookie persistant")
        return True

    email_selector = (
        '#user_email, '
        'input[name="user_email"], '
        'input[type="email"], '
        'input[name="email"], '
        'input[autocomplete="email"]'
    )
    password_selector = (
        '#password, '
        'input[name="password"], '
        'input[type="password"]'
    )

    # ── Attendre que le DOM soit prêt (au moins un champ présent) ─────────
    print("⏳ Attente du champ email...")
    try:
        page.wait_for_function(
            """() => {
                const sels = ['#user_email','input[name="user_email"]',
                              'input[type="email"]','input[name="email"]',
                              'input[autocomplete="email"]'];
                return sels.some(s => document.querySelector(s) !== null);
            }""",
            timeout=30000
        )
    except PlaywrightTimeout:
        raise RuntimeError(f"❌ Champ email introuvable sur {platform} ({page.url})")

    human_fill(page, email_selector, email, 'email')

    # Pause après email pour laisser le site réagir
    time.sleep(1.5)

    print("⏳ Attente du champ password...")
    try:
        page.wait_for_function(
            """() => {
                const sels = ['#password','input[name="password"]','input[type="password"]'];
                return sels.some(s => document.querySelector(s) !== null);
            }""",
            timeout=10000
        )
    except PlaywrightTimeout:
        raise RuntimeError(f"❌ Champ password introuvable sur {platform} ({page.url})")

    # Scroll vers le champ password avant de remplir
    try:
        page.evaluate("""() => {
            const el = document.querySelector('#password, input[name="password"], input[type="password"]');
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }""")
        time.sleep(0.5)
    except Exception:
        pass

    human_fill(page, password_selector, password, 'password')

    # Vérifier que le password a bien été rempli
    filled_ok = page.evaluate("""() => {
        const el = document.querySelector('#password, input[name="password"], input[type="password"]');
        return el ? el.value.length > 0 : false;
    }""")
    if not filled_ok:
        print("⚠️ Password non rempli, 2ème tentative...")
        page.evaluate(
            """(pwd) => {
                const el = document.querySelector('#password, input[name="password"], input[type="password"]');
                if (el) {
                    el.focus();
                    el.value = pwd;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
                }
            }""",
            password
        )
        time.sleep(0.5)
    print("✅ Password rempli")

    select_sel = "#captcha_provider, select"
    page.wait_for_selector(select_sel, timeout=10000)
    options = page.eval_on_selector_all(
        f"{select_sel} option",
        "opts => opts.map(o => ({ text: o.textContent.trim(), value: o.value }))"
    )

    login_btn_sel = (
        '#process_login, '
        'button:has-text("Log in"), '
        'button:has-text("LOGIN"), '
        'button:has-text("Login"), '
        'button[type="submit"], '
        'input[type="submit"]'
    )
    scroll_to_element(page, login_btn_sel)

    turnstile_opt = next(
        (o for o in options if "Turnstile" in o["text"]), None
    )
    icon_opt = next(
        (o for o in options if o["text"] == "IconCaptcha"), None
    )

    captcha_solved = False

    if turnstile_opt:
        print("🔍 Priorité Turnstile...")
        page.select_option(select_sel, turnstile_opt["value"])
        time.sleep(2)
        if ananana.solve_turnstile(page, timeout=30):
            print("✅ Turnstile résolu")
            captcha_solved = True
        else:
            print("⚠️ Turnstile non résolu, bascule sur IconCaptcha...")

    if not captcha_solved and icon_opt:
        print("🔍 Tentative IconCaptcha...")
        page.select_option(select_sel, icon_opt["value"])
        time.sleep(1)
        login_btn = page.wait_for_selector(login_btn_sel, timeout=5000)
        box = login_btn.bounding_box()
        if not box:
            raise RuntimeError("Bouton Login introuvable pour IconCaptcha")
        login_coords = {
            'x': box['x'] + box['width'] / 2,
            'y': box['y'] + box['height'] / 2,
        }
        if ravitoto.solve_iconcaptcha(page, login_coords, max_attempts=3):
            print("✅ IconCaptcha résolu")
            captcha_solved = True
        else:
            print("❌ Échec IconCaptcha")

    if not captcha_solved:
        raise RuntimeError("❌ Aucun captcha résolu")

    print("🖱️ Clic sur LOGIN...")
    page.wait_for_function(
        """() => {
            const sels = ['#process_login','button[type="submit"]','input[type="submit"]'];
            return sels.some(s => document.querySelector(s) !== null);
        }""",
        timeout=10000
    )
    page.click(login_btn_sel)

    try:
        page.wait_for_load_state("networkidle", timeout=60000)
    except Exception:
        print("⚠️ Navigation lente, attente supplémentaire...")
    time.sleep(5)

    if not verify_login_success(page):
        error = page.evaluate("""() => {
            const alert = document.querySelector('#signupAlert');
            if (alert && alert.textContent.trim()) return alert.textContent.trim();
            const danger = document.querySelector('.alert-danger');
            return danger ? danger.textContent.trim() : 'Aucun message d\\'erreur trouvé';
        }""")
        raise RuntimeError(f"Échec de connexion : {error}")

    print("✅ Connexion réussie")
    return True


# ── Main ────────────────────────────────────────────────────────────────────
def main():
    normalized_email = EMAIL.strip().lower()
    # Masquer le mot de passe des logs dès le départ
    if PASSWORD:
        print(f"ℹ️  Compte : {normalized_email} | Plateforme : {PLATFORM}")
    video_path  = VIDEOS_DIR / f"login_{normalized_email.replace('@', '_').replace('.', '_')}.mp4"
    ffmpeg_proc = None

    try:
        # ── Résolution du proxy ───────────────────────────────────────────────
        proxy_dict = None
        if JP_PROXY_LIST:
            proxy_url = JP_PROXY_LIST[PROXY_INDEX] if PROXY_INDEX < len(JP_PROXY_LIST) else JP_PROXY_LIST[0]
            proxy_dict = parse_proxy_url(proxy_url)
            print(f"ℹ️  Connexion via proxy index {PROXY_INDEX}")
        else:
            print("ℹ️  Connexion directe (sans proxy)")

        ffmpeg_proc = start_ffmpeg(str(video_path))
        time.sleep(1)

        login_urls = {
            "tronpick": "https://tronpick.io/login.php",
            "1xbet":    "https://1x-bet.mobi/fr/virtualsports",
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
        print(f"🌐 URL cible : {login_url}")

        camoufox_kwargs = dict(headless=False, humanize=True, geoip=True)
        if proxy_dict:
            camoufox_kwargs["proxy"] = proxy_dict

        with Camoufox(**camoufox_kwargs) as browser:
            page = browser.new_page()
            page.goto(login_url, wait_until="networkidle", timeout=60000)

            success = login_page_action(page, normalized_email, PASSWORD, PLATFORM)
            if not success:
                raise RuntimeError("La page de login a échoué")

            cookies = page.context.cookies()
            print(f"🍪 Cookies récupérés : {len(cookies)}")

            # Lecture du solde
            initial_balance = 0.0
            try:
                balance_el   = page.wait_for_selector('[class*="balance"]', timeout=5000)
                balance_text = balance_el.inner_text()
                initial_balance = float("".join(c for c in balance_text if c.isdigit() or c == "."))
            except Exception:
                try:
                    page.goto(
                        f"https://{PLATFORM}.io/faucet.php",
                        wait_until="networkidle",
                        timeout=30000
                    )
                    time.sleep(5)
                    balance_el = page.query_selector('[class*="balance"]')
                    if balance_el:
                        balance_text = balance_el.inner_text()
                        initial_balance = float(
                            "".join(c for c in balance_text if c.isdigit() or c == ".")
                        )
                except Exception as e:
                    print(f"⚠️ Impossible de lire le solde : {e}")

        stop_ffmpeg(ffmpeg_proc)
        ffmpeg_proc = None

        # ── Sauvegarde GitHub ─────────────────────────────────────────────
        g    = get_github_client()
        repo = g.get_repo(f"{GH_USERNAME}/{GH_REPO}")

        existing_account = None
        try:
            if USER_ID:
                content          = repo.get_contents(USER_FILE, ref=GH_BRANCH)
                existing_account = json.loads(base64.b64decode(content.content).decode())
        except Exception:
            pass

        created_at            = existing_account.get("createdAt")                    if existing_account else int(time.time() * 1000)
        saved_initial_balance = existing_account.get("initialBalance", initial_balance) if existing_account else initial_balance
        saved_total_claims    = existing_account.get("totalClaims", 0)               if existing_account else 0

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
