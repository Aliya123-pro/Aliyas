#!/usr/bin/env python3
"""
Bot de login avec Camoufox (Firefox furtif).
Résolution Turnstile automatique – détection du succès par absence d'erreur
et absence de 'login.php' dans l'URL après connexion.
"""

import os, sys, json, time, random, subprocess, base64
from pathlib import Path
from datetime import datetime
from typing import Optional, Dict, Any

# Optionnel : charger .env en local uniquement
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

# ---------- Variables d'environnement ----------
EMAIL = os.getenv("TEST_EMAIL")
PASSWORD = os.getenv("TEST_PASSWORD")
PLATFORM = os.getenv("TEST_PLATFORM")
PROXY_INDEX = int(os.getenv("TEST_PROXY_INDEX", "0") or "0")
INITIAL_TIMER_STR = os.getenv("TEST_INITIAL_TIMER", "60:00")
GH_TOKEN = os.getenv("GH_TOKEN")
GH_USERNAME = os.getenv("GH_USERNAME")
GH_REPO = os.getenv("GH_REPO")
GH_BRANCH = os.getenv("GH_BRANCH", "main")
USER_ID = os.getenv("USER_ID")
CRYPTO_SECRET = os.getenv("CRYPTO_SECRET")

if not CRYPTO_SECRET:
    print("❌ CRYPTO_SECRET est obligatoire")
    sys.exit(1)

USER_FILE = f"account_{USER_ID}_{PLATFORM}_{EMAIL}.json" if USER_ID else f"account_{EMAIL}_{PLATFORM}.json"
GLOBAL_FILE = "global_accounts.json"

JP_PROXY_LIST = [p.strip() for p in os.getenv("JP_PROXY_LIST", "").split(",") if p.strip()]
if not JP_PROXY_LIST:
    print("❌ JP_PROXY_LIST doit contenir au moins 1 proxy")
    sys.exit(1)

VIDEOS_DIR = Path(__file__).parent / "videos"
VIDEOS_DIR.mkdir(exist_ok=True)

# ---------- Config par plateforme ----------
# Plateformes React/Next.js (SPA) : nécessitent une attente d'hydratation
REACT_PLATFORMS = {"tronlux"}

# Sélecteurs spécifiques par plateforme
PLATFORM_SELECTORS = {
    # freetron (tronlux) : app React, pas de name sur les inputs, id dynamique
    "tronlux": {
        "email":    'input[type="email"]',
        "password": 'input[type="password"]',
        "login_btn": 'button[type="submit"]:has-text("Log in")',
        "error_check": "react",   # mode de vérification d'erreur
    },
    # Plateformes classiques (PHP) : login.php, sélecteurs stables
    "_default": {
        "email":    'input[type="email"], input[name="email"]',
        "password": 'input[type="password"]',
        "login_btn": 'button:has-text("Log in")',
        "error_check": "php",
    },
}

def get_selectors(platform: str) -> dict:
    return PLATFORM_SELECTORS.get(platform, PLATFORM_SELECTORS["_default"])

# ---------- Utilitaires ----------
def random_sleep(min_ms: int, max_ms: int) -> None:
    time.sleep(random.randint(min_ms, max_ms) / 1000)

# ---------- Chiffrement / Déchiffrement ----------
def derive_key(secret: str, salt: bytes = b"salt") -> bytes:
    kdf = Scrypt(salt=salt, length=32, n=2**14, r=8, p=1, backend=default_backend())
    return kdf.derive(secret.encode())

def encrypt(text: str) -> str:
    key = derive_key(CRYPTO_SECRET)
    iv = os.urandom(16)
    cipher = Cipher(algorithms.AES(key), modes.CBC(iv), backend=default_backend())
    encryptor = cipher.encryptor()
    pad_len = 16 - (len(text) % 16)
    padded = text + chr(pad_len) * pad_len
    encrypted = encryptor.update(padded.encode()) + encryptor.finalize()
    return iv.hex() + ":" + encrypted.hex()

def decrypt(encrypted_text: str) -> str:
    key = derive_key(CRYPTO_SECRET)
    parts = encrypted_text.split(":", 1)   # FIX: split limité à 1 pour éviter la casse si ":" dans le ciphertext hex
    iv = bytes.fromhex(parts[0])
    encrypted = bytes.fromhex(parts[1])
    cipher = Cipher(algorithms.AES(key), modes.CBC(iv), backend=default_backend())
    decryptor = cipher.decryptor()
    padded = decryptor.update(encrypted) + decryptor.finalize()
    pad_len = padded[-1]
    return padded[:-pad_len].decode()

def time_str_to_minutes(s: str) -> float:
    if not s or ":" not in s:
        return 60.0
    parts = s.split(":")
    mins = int(parts[0]) if parts[0] else 0
    secs = int(parts[1]) if len(parts) > 1 and parts[1] else 0
    return mins + secs / 60.0

# ---------- Capture vidéo ----------
def start_ffmpeg(video_path: str):
    display = os.environ.get("DISPLAY", ":99")
    args = [
        "ffmpeg", "-f", "x11grab", "-video_size", "1280x720", "-i", display,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "0", "-pix_fmt", "yuv420p", "-y", video_path,
    ]
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(f"🎥 FFmpeg démarré sur {display}, vidéo → {video_path}")
    return proc

def stop_ffmpeg(proc):
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
    print("🎥 FFmpeg arrêté")

# ---------- Parsing proxy ----------
def parse_proxy_url(proxy_url: str) -> Optional[Dict[str, str]]:
    if not proxy_url:
        return None
    proxy_url = proxy_url.strip()
    is_socks = proxy_url.startswith("socks5://") or proxy_url.startswith("socks://")
    protocol = "socks5" if is_socks else "http"
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

# ---------- Fonctions d'interaction ----------
def human_fill(page, selector, value, field_name):
    print(f"⌨️ Remplissage de {field_name}...")
    page.fill(selector, value)
    time.sleep(random.uniform(0.5, 1.5))

def move_mouse_to(page, x: float, y: float):
    start = page.evaluate("() => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 })")
    steps = random.randint(10, 20)
    for i in range(1, steps + 1):
        t = i / steps
        cp = {
            "x": start["x"] + random.uniform(-100, 100),
            "y": start["y"] + random.uniform(-100, 100),
        }
        nx = (1 - t) ** 2 * start["x"] + 2 * (1 - t) * t * cp["x"] + t**2 * x
        ny = (1 - t) ** 2 * start["y"] + 2 * (1 - t) * t * cp["y"] + t**2 * y
        page.mouse.move(nx, ny)
        time.sleep(0.015)

def check_turnstile_token(page) -> bool:
    try:
        val = page.evaluate("""() => {
            const input = document.querySelector('input[name="cf-turnstile-response"]');
            if (input && input.value.length > 0) return true;
            if (typeof window.__cf_turnstile_callback === 'function') return true;
            return false;
        }""")
        return bool(val)
    except:
        return False

def solve_turnstile(page, timeout=30):
    start = time.time()
    while time.time() - start < 3:
        if check_turnstile_token(page):
            print("✅ Turnstile résolu automatiquement (invisible)")
            return True
        time.sleep(0.5)

    try:
        verify_btn = page.wait_for_selector('text="Verify you are human"', timeout=5000)
        if verify_btn:
            box = verify_btn.bounding_box()
            if box:
                x = box['x'] + box['width'] / 2
                y = box['y'] + box['height'] / 2
                print(f"🖱️ Clic sur 'Verify you are human' à ({x:.0f}, {y:.0f})")
                move_mouse_to(page, x, y)
                page.mouse.click(x, y)
    except:
        pass

    while time.time() - start < timeout:
        if check_turnstile_token(page):
            print("✅ Turnstile résolu après clic")
            return True
        time.sleep(1)
    return False

def verify_login_success(page, platform: str = "") -> bool:
    """
    Vérifie si le login a réussi.
    - Plateformes React (tronlux) : pas de login.php, vérification via URL et alertes React
    - Plateformes PHP classiques : détecte login.php dans l'URL + alertes DOM standards
    """
    selectors = get_selectors(platform)
    error_mode = selectors.get("error_check", "php")

    try:
        if error_mode == "react":
            # Freetron / React : cherche les messages d'erreur dans les composants React
            error_text = page.evaluate("""() => {
                // Alertes génériques
                const alert = document.querySelector('[role="alert"]');
                if (alert && alert.textContent.trim().length > 0) return alert.textContent.trim();
                // Toast d'erreur
                const toast = document.querySelector('[data-sonner-toast][data-type="error"]');
                if (toast && toast.textContent.trim().length > 0) return toast.textContent.trim();
                // Classe d'erreur générique
                const err = document.querySelector('.text-destructive, .text-red-500, .error-message');
                if (err && err.textContent.trim().length > 0) return err.textContent.trim();
                return '';
            }""")
        else:
            # Plateformes PHP classiques
            error_text = page.evaluate("""() => {
                const alert = document.querySelector('#signupAlert');
                if (alert && alert.style.display !== 'none' && alert.textContent.trim().length > 0)
                    return alert.textContent.trim();
                const danger = document.querySelector('.alert-danger:not([style*="display: none"])');
                if (danger && danger.textContent.trim().length > 0) return danger.textContent.trim();
                const error = document.querySelector('.error:not([style*="display: none"])');
                if (error && error.textContent.trim().length > 0) return error.textContent.trim();
                return '';
            }""")

        if error_text:
            print(f"⚠️ Message d'erreur détecté : {error_text}")
            return False
    except:
        pass

    # Vérification URL : plateformes PHP restent sur login.php en cas d'échec
    if error_mode == "php" and 'login.php' in page.url:
        return False

    # Plateformes React : restent sur /login en cas d'échec
    if error_mode == "react" and page.url.rstrip("/").endswith("/login"):
        return False

    return True

def scroll_to_element(page, selector):
    try:
        element = page.wait_for_selector(selector, timeout=5000)
        page.evaluate("""(el) => {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }""", element)
        time.sleep(random.uniform(1.0, 2.0))
    except:
        pass

def wait_for_field(page, selector: str, platform: str, field_name: str, timeout: int = 30000):
    """
    Attend qu'un champ soit visible et interactif.
    Pour les plateformes React, ajoute une pause d'hydratation après détection.
    """
    print(f"⏳ Attente du champ {field_name} ({platform})...")
    try:
        page.wait_for_selector(selector, state="visible", timeout=timeout)
        # Pause hydratation React : laisse le framework finir de monter les composants
        if platform in REACT_PLATFORMS:
            time.sleep(2.0)
        else:
            time.sleep(0.5)
    except Exception as e:
        raise RuntimeError(f"Champ {field_name} introuvable sur {platform} après {timeout}ms : {e}")

def login_page_action(page, email: str, password: str, platform: str):
    selectors = get_selectors(platform)
    email_sel    = selectors["email"]
    password_sel = selectors["password"]
    btn_sel      = selectors["login_btn"]

    # Vérification cookie persistant
    if verify_login_success(page, platform):
        print("✅ Déjà connecté via cookie persistant")
        return True

    # --- Attente et remplissage email ---
    wait_for_field(page, email_sel, platform, "email")
    human_fill(page, email_sel, email, 'email')

    # --- Attente et remplissage password ---
    wait_for_field(page, password_sel, platform, "password")
    human_fill(page, password_sel, password, 'password')

    # --- Sélection du captcha Turnstile ---
    try:
        page.wait_for_selector("select", state="visible", timeout=10000)
        if platform in REACT_PLATFORMS:
            time.sleep(1.0)  # stabilisation React
        options = page.eval_on_selector_all(
            "select option",
            "opts => opts.map(o => ({ text: o.textContent.trim(), value: o.value }))"
        )
        turnstile_value = next(
            (o["value"] for o in options if o["text"] == "Cloudflare Turnstile"), None
        )
        if not turnstile_value:
            raise RuntimeError("Option Cloudflare Turnstile introuvable dans le <select>")
        print("🔍 Sélection de Cloudflare Turnstile...")
        page.select_option("select", turnstile_value)
        time.sleep(2)
    except RuntimeError:
        raise
    except Exception as e:
        print(f"⚠️ Impossible de sélectionner le captcha : {e}")

    # --- Scroll vers le bouton login ---
    scroll_to_element(page, btn_sel)

    # --- 3 tentatives de résolution Turnstile ---
    solved = False
    for attempt in range(1, 4):
        print(f"--- Tentative {attempt}/3 de résolution du Turnstile ---")
        if solve_turnstile(page, timeout=30):
            solved = True
            break
        if attempt < 3:
            print("⏳ Pause de 10s avant la prochaine tentative...")
            time.sleep(10)

    if not solved:
        print("❌ Échec du Turnstile après 3 tentatives")
        return False

    # --- Clic sur le bouton de connexion ---
    scroll_to_element(page, btn_sel)
    try:
        login_btn = page.wait_for_selector(btn_sel, state="visible", timeout=5000)
        login_btn.click()
    except Exception as e:
        raise RuntimeError(f"Bouton de connexion introuvable ({btn_sel}) : {e}")

    try:
        page.wait_for_load_state("networkidle", timeout=60000)
    except:
        print("⚠️ Navigation lente, attente supplémentaire...")
    time.sleep(5)

    # --- Vérification finale ---
    if verify_login_success(page, platform):
        print("✅ Connexion réussie")
        return True
    else:
        try:
            if platform in REACT_PLATFORMS:
                error = page.evaluate("""() => {
                    const alert = document.querySelector('[role="alert"]');
                    if (alert && alert.textContent.trim()) return alert.textContent.trim();
                    const toast = document.querySelector('[data-sonner-toast][data-type="error"]');
                    return toast ? toast.textContent.trim() : 'Aucun message React';
                }""")
            else:
                error = page.evaluate("""() => {
                    const alert = document.querySelector('#signupAlert');
                    if (alert && alert.textContent.trim()) return alert.textContent.trim();
                    const danger = document.querySelector('.alert-danger');
                    return danger ? danger.textContent.trim() : 'Aucun message';
                }""")
        except:
            error = "Erreur inconnue"
        raise RuntimeError(f"Échec de connexion sur {platform} : {error}")

# ---------- Sauvegarde GitHub ----------
def get_github_client():
    return Github(auth=Auth.Token(GH_TOKEN))

def save_account(account_data: dict) -> None:
    g = get_github_client()
    repo = g.get_repo(f"{GH_USERNAME}/{GH_REPO}")
    secure = account_data.copy()
    secure["password"] = encrypt(account_data["password"])
    secure["cookies"] = encrypt(json.dumps(account_data["cookies"]))

    content = json.dumps(secure, indent=2)
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
                    message=f"Mise à jour du compte {EMAIL}",
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
    g = get_github_client()
    repo = g.get_repo(f"{GH_USERNAME}/{GH_REPO}")
    max_retries = 3
    for attempt in range(1, max_retries + 1):
        try:
            sha = None
            current = []
            try:
                contents = repo.get_contents(GLOBAL_FILE, ref=GH_BRANCH)
                sha = contents.sha
                current = json.loads(base64.b64decode(contents.content).decode())
            except GithubException as e:
                if e.status != 404:
                    raise

            index = next((i for i, acc in enumerate(current)
                          if acc["email"] == new_entry["email"] and acc["platform"] == new_entry["platform"]), None)
            if index is not None:
                current[index]["lastLogin"] = new_entry["addedAt"]
                print(f"🔄 Compte déjà présent dans {GLOBAL_FILE}, mise à jour du timestamp.")
            else:
                current.append(new_entry)
                print(f"🌍 Compte ajouté à {GLOBAL_FILE} : {new_entry['email']} ({new_entry['platform']})")

            content = json.dumps(current, indent=2)
            if sha:
                repo.update_file(GLOBAL_FILE, f"Mise à jour de {new_entry['email']}", content, sha, branch=GH_BRANCH)
            else:
                repo.create_file(GLOBAL_FILE, f"Mise à jour de {new_entry['email']}", content, branch=GH_BRANCH)
            return
        except GithubException as e:
            if e.status == 409 and attempt < max_retries:
                print(f"⚠️ Conflit sur {GLOBAL_FILE}, tentative {attempt}/{max_retries}...")
                time.sleep(attempt)
            else:
                raise

# ---------- Main ----------
def main():
    normalized_email = EMAIL.strip().lower()
    video_path = VIDEOS_DIR / f"login_{normalized_email.replace('@', '_').replace('.', '_')}.mp4"
    ffmpeg_proc = None

    try:
        proxy_url = JP_PROXY_LIST[PROXY_INDEX] if PROXY_INDEX < len(JP_PROXY_LIST) else JP_PROXY_LIST[0]
        print(f"🔄 Proxy utilisé : {proxy_url}")

        proxy_dict = parse_proxy_url(proxy_url)
        if not proxy_dict:
            raise ValueError("Proxy invalide")

        ffmpeg_proc = start_ffmpeg(str(video_path))

        login_urls = {
            "tronpick": "https://tronpick.io/login.php",
            "freetron":  "https://freetron.in/login",
            "litepick": "https://litepick.io/login.php",
            "dogepick": "https://dogepick.io/login.php",
            "solpick":  "https://solpick.io/login.php",
            "bnbpick":  "https://bnbpick.io/login.php",
            "tonpick":  "https://tonpick.game/login.php",
            "suipick":  "https://suipick.io/login.php",
            "polpick":  "https://polpick.io/login.php",
        }
        login_url = login_urls.get(PLATFORM, f"https://{PLATFORM}.io/login.php")

        with Camoufox(
            headless=False,
            humanize=True,
            geoip=True,
            proxy=proxy_dict,
        ) as browser:
            page = browser.new_page()
            print(f"🌐 Navigation vers {login_url}...")
            page.goto(login_url, wait_until="networkidle", timeout=60000)

            # Pause supplémentaire pour les SPA React avant toute interaction
            if PLATFORM in REACT_PLATFORMS:
                print(f"⏳ Attente hydratation React pour {PLATFORM}...")
                time.sleep(3.0)

            success = login_page_action(page, normalized_email, PASSWORD, PLATFORM)
            if not success:
                raise RuntimeError("La page de login a échoué")

            cookies = page.context.cookies()
            print(f"🍪 Cookies récupérés : {len(cookies)}")

            # --- Lecture du solde ---
            initial_balance = 0.0
            balance_selectors = [
                '[class*="balance"]',
                '[id*="balance"]',
                '[data-balance]',
            ]
            balance_found = False
            for bal_sel in balance_selectors:
                try:
                    balance_el = page.wait_for_selector(bal_sel, timeout=5000)
                    balance_text = balance_el.inner_text()
                    initial_balance = float("".join(c for c in balance_text if c.isdigit() or c == "."))
                    balance_found = True
                    break
                except:
                    continue

            if not balance_found:
                try:
                    faucet_url = f"https://freetron.in/faucet" if PLATFORM == "tronlux" else f"https://{PLATFORM}.io/faucet.php"
                    page.goto(faucet_url, wait_until="networkidle", timeout=30000)
                    time.sleep(5)
                    for bal_sel in balance_selectors:
                        balance_el = page.query_selector(bal_sel)
                        if balance_el:
                            balance_text = balance_el.inner_text()
                            initial_balance = float("".join(c for c in balance_text if c.isdigit() or c == "."))
                            break
                except Exception as e:
                    print(f"⚠️ Impossible de lire le solde : {e}")

        stop_ffmpeg(ffmpeg_proc)
        ffmpeg_proc = None

        # --- Récupération du compte existant ---
        g = get_github_client()
        repo = g.get_repo(f"{GH_USERNAME}/{GH_REPO}")
        existing_account = None
        try:
            if USER_ID:
                content = repo.get_contents(USER_FILE, ref=GH_BRANCH)
                existing_account = json.loads(base64.b64decode(content.content).decode())
        except:
            pass

        created_at = existing_account.get("createdAt") if existing_account else int(time.time() * 1000)
        saved_initial_balance = existing_account.get("initialBalance", initial_balance) if existing_account else initial_balance
        saved_total_claims = existing_account.get("totalClaims", 0) if existing_account else 0

        timer_value = time_str_to_minutes(INITIAL_TIMER_STR)
        account = {
            "email": normalized_email,
            "password": PASSWORD,
            "platform": PLATFORM,
            "proxyIndex": PROXY_INDEX,
            "enabled": True,
            "cookies": cookies,
            "cookiesStatus": "valid",
            "lastClaim": int(time.time() * 1000),
            "timer": timer_value,
            "createdAt": created_at,
            "initialBalance": saved_initial_balance,
            "totalClaims": saved_total_claims,
            "finalBalance": initial_balance,
        }
        save_account(account)
        update_global_accounts({
            "email": normalized_email,
            "platform": PLATFORM,
            "addedAt": datetime.utcnow().isoformat() + "Z",
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
