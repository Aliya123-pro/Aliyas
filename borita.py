#!/usr/bin/env python3
"""
borita.py – Déconnexion propre du compte avec suppression des fichiers associés.
"""

import os, sys, json, time, random, base64, re
from pathlib import Path
from typing import Optional, Dict, Any

# Lecture optionnelle d'un .env en local
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

# ---------- Variables d'environnement ----------
LOGOUT_EMAIL = os.getenv("LOGOUT_EMAIL")
LOGOUT_PLATFORM = os.getenv("LOGOUT_PLATFORM")
PROXY_INDEX = int(os.getenv("LOGOUT_PROXY_INDEX", "0") or "0")
GH_TOKEN = os.getenv("GH_TOKEN")
GH_USERNAME = os.getenv("GH_USERNAME")
GH_REPO = os.getenv("GH_REPO")
GH_BRANCH = os.getenv("GH_BRANCH", "main")
USER_ID = os.getenv("USER_ID")
CRYPTO_SECRET = os.getenv("CRYPTO_SECRET")
JP_PROXY_LIST = [p.strip() for p in os.getenv("JP_PROXY_LIST", "").split(",") if p.strip()]

if not CRYPTO_SECRET or not USER_ID:
    print("❌ CRYPTO_SECRET ou USER_ID manquant")
    sys.exit(1)

if not LOGOUT_EMAIL or not LOGOUT_PLATFORM:
    print("❌ LOGOUT_EMAIL et LOGOUT_PLATFORM sont requis")
    sys.exit(1)

if not GH_TOKEN or not GH_USERNAME or not GH_REPO:
    print("❌ Variables GitHub manquantes")
    sys.exit(1)

USER_FILE = f"account_{USER_ID}_{LOGOUT_PLATFORM}_{LOGOUT_EMAIL}.json"
GLOBAL_FILE = "global_accounts.json"
HISTORY_FILE = f"history_{USER_ID}.json"

SCREENSHOTS_DIR = Path("screenshots")
SCREENSHOTS_DIR.mkdir(exist_ok=True)

# --- Chiffrement (identique) ---
def derive_key(secret: str, salt: bytes = b"salt") -> bytes:
    kdf = Scrypt(salt=salt, length=32, n=2**14, r=8, p=1, backend=default_backend())
    return kdf.derive(secret.encode())

KEY = derive_key(CRYPTO_SECRET)

def decrypt(encrypted_text: str) -> str:
    if not isinstance(encrypted_text, str):
        return encrypted_text
    try:
        json.loads(encrypted_text)
        return encrypted_text
    except:
        pass
    parts = encrypted_text.split(":")
    if len(parts) != 2:
        return encrypted_text
    try:
        iv = bytes.fromhex(parts[0])
        encrypted = parts[1]
        cipher = Cipher(algorithms.AES(KEY), modes.CBC(iv), backend=default_backend())
        decryptor = cipher.decryptor()
        padded = decryptor.update(bytes.fromhex(encrypted)) + decryptor.finalize()
        pad_len = padded[-1]
        return padded[:-pad_len].decode('utf-8')
    except Exception:
        return encrypted_text

def decrypt_cookies(encrypted_cookies) -> list:
    if isinstance(encrypted_cookies, list):
        return encrypted_cookies
    dec = decrypt(encrypted_cookies)
    try:
        return json.loads(dec)
    except:
        return []

# --- Parsing proxy ---
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

# --- Client GitHub ---
def get_github_client():
    return Github(auth=Auth.Token(GH_TOKEN))

# --- Chargement / suppression des fichiers ---
def load_account():
    g = get_github_client()
    repo = g.get_repo(f"{GH_USERNAME}/{GH_REPO}")
    try:
        contents = repo.get_contents(USER_FILE, ref=GH_BRANCH)
        return json.loads(base64.b64decode(contents.content).decode())
    except GithubException as e:
        if e.status == 404:
            return None
        raise

def delete_file(path: str, message: str) -> bool:
    g = get_github_client()
    repo = g.get_repo(f"{GH_USERNAME}/{GH_REPO}")
    try:
        contents = repo.get_contents(path, ref=GH_BRANCH)
        repo.delete_file(
            path=path,
            message=message,
            sha=contents.sha,
            branch=GH_BRANCH,
        )
        print(f"🗑️ Fichier {path} supprimé.")
        return True
    except GithubException as e:
        if e.status == 404:
            print(f"ℹ️ Le fichier {path} n'existe pas.")
            return True
        print(f"❌ Erreur suppression {path} : {e}")
        return False

def remove_from_global_list(email: str, platform: str) -> bool:
    g = get_github_client()
    repo = g.get_repo(f"{GH_USERNAME}/{GH_REPO}")
    try:
        try:
            contents = repo.get_contents(GLOBAL_FILE, ref=GH_BRANCH)
            entries = json.loads(base64.b64decode(contents.content).decode())
            sha = contents.sha
        except GithubException as e:
            if e.status == 404:
                return True
            raise
        new_entries = [e for e in entries if not (e["email"] == email and e["platform"] == platform)]
        if len(new_entries) == len(entries):
            return True
        content = json.dumps(new_entries, indent=2)
        repo.update_file(
            path=GLOBAL_FILE,
            message=f"Suppression de {email}",
            content=content,
            sha=sha,
            branch=GH_BRANCH,
        )
        print("✅ Retiré de la liste globale.")
        return True
    except Exception as e:
        print(f"❌ Erreur globale : {e}")
        return False

# --- Fonctions d'interaction ---
def human_click(page, x: float, y: float):
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
    page.mouse.click(x, y)

def perform_logout(account_cookies: list):
    proxy_url = JP_PROXY_LIST[PROXY_INDEX] if PROXY_INDEX < len(JP_PROXY_LIST) else JP_PROXY_LIST[0]
    proxy_dict = parse_proxy_url(proxy_url)
    if not proxy_dict:
        raise ValueError("Proxy invalide")

    print(f"🔌 Déconnexion de {LOGOUT_EMAIL} sur {LOGOUT_PLATFORM}.io")

    if not account_cookies or len(account_cookies) == 0:
        print("❌ Aucun cookie reçu !")
        return False

    with Camoufox(
        headless=False,
        humanize=True,
        geoip=True,
        proxy=proxy_dict,
    ) as browser:
        page = browser.new_page()

        # Injection des cookies
        page.context.add_cookies(account_cookies)
        print("💉 Cookies injectés.")

        faucet_urls = {
            "tronpick": "https://tronpick.io/faucet.php",
            "litepick": "https://litepick.io/faucet.php",
            "dogepick": "https://dogepick.io/faucet.php",
            "solpick": "https://solpick.io/faucet.php",
            "bnbpick": "https://bnbpick.io/faucet.php",
            "tonpick": "https://tonpick.game/faucet.php",
            "suipick": "https://suipick.io/faucet.php",
            "polpick": "https://polpick.io/faucet.php",
            "freetron": "https://https://freetron.in/faucet",
        }
        faucet_url = faucet_urls.get(LOGOUT_PLATFORM, f"https://{LOGOUT_PLATFORM}.io/faucet.php")

        page.goto(faucet_url, wait_until="networkidle", timeout=30000)
        print("⏳ Attente 20 secondes...")
        time.sleep(20)

        if "login.php" in page.url:
            print("ℹ️ Session déjà expirée")
            return True

        screenshot_path = SCREENSHOTS_DIR / f"01_before_{LOGOUT_EMAIL.replace('@', '_').replace('.', '_')}.png"
        page.screenshot(path=str(screenshot_path), full_page=True)

        # Méthode 1 : Chercher le bouton Logout visible
        print("🔍 Recherche du bouton Logout visible...")
        logout_coords = page.evaluate("""
            () => {
                const candidates = [...document.querySelectorAll('button, a, div[role="button"], input[type="submit"]')];
                const btn = candidates.find(el => {
                    const txt = (el.textContent || '').toLowerCase();
                    return txt.includes('log out') || txt.includes('logout') || txt.includes('déconnexion') || txt.includes('sign out');
                });
                if (btn) {
                    const rect = btn.getBoundingClientRect();
                    if (rect.width > 10 && rect.height > 10) {
                        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, text: btn.textContent.trim() };
                    }
                }
                return null;
            }
        """)

        if logout_coords:
            print(f"🖱️ Clic sur \"{logout_coords['text']}\"")
            human_click(page, logout_coords["x"], logout_coords["y"])
            time.sleep(1)

            # Boîte de confirmation
            dialog_visible = page.evaluate("""
                () => {
                    const modals = document.querySelectorAll('.modal, .dialog, [role="dialog"], .popup');
                    return Array.from(modals).some(m => m.offsetParent !== null);
                }
            """)
            if dialog_visible:
                print("🔔 Boîte de confirmation détectée")
                confirm_clicked = page.evaluate("""
                    () => {
                        const btns = [...document.querySelectorAll('button')];
                        const confirmBtn = btns.find(b => /yes|ok|confirm|oui|valider/i.test(b.textContent));
                        if (confirmBtn) { confirmBtn.click(); return true; }
                        return false;
                    }
                """)
                if not confirm_clicked:
                    page.keyboard.press("Escape")
                time.sleep(2)

            time.sleep(4)
            if "login.php" in page.url:
                print("✅ Déconnexion réussie")
                return True

            page.goto(faucet_url, wait_until="networkidle", timeout=10000)
            time.sleep(5)
            if "login.php" in page.url:
                print("✅ Déconnexion confirmée")
                return True
        else:
            print("⚠️ Aucun bouton Logout visible trouvé.")

        # Méthode 2 : Fallback POST
        print("🔄 Tentative fallback POST...")
        csrf_token = page.evaluate("""
            () => {
                const el = document.querySelector('input[name="csrf_test_name"]');
                return el ? el.value : null;
            }
        """)

        if not csrf_token:
            print("⚠️ Token CSRF non trouvé dans la page, recherche dans les cookies...")
            cookies = page.context.cookies()
            csrf_cookie = next((c for c in cookies if 'csrf' in c['name'].lower() or c['name'] == 'csrf_cookie_name'), None)
            csrf_token = csrf_cookie['value'] if csrf_cookie else None

        if not csrf_token:
            print("❌ Token CSRF introuvable")
            return False

        print("🔑 Token CSRF trouvé, envoi POST logout...")
        page.evaluate(f"""
            async () => {{
                const formData = new FormData();
                formData.append('action', 'logout');
                formData.append('csrf_test_name', '{csrf_token}');
                await fetch('process.php', {{ method: 'POST', body: formData }});
            }}
        """)

        time.sleep(5)
        page.goto(faucet_url, wait_until="networkidle", timeout=10000)
        time.sleep(5)

        if "login.php" in page.url:
            print("✅ Déconnexion réussie via POST")
            return True

        print("❌ Échec de la déconnexion")
        return False

def main():
    try:
        account = load_account()
        if not account:
            print("ℹ️ Compte inexistant, suppression des fichiers uniquement.")
            delete_file(USER_FILE, f"Suppression du compte {LOGOUT_EMAIL}")
            remove_from_global_list(LOGOUT_EMAIL, LOGOUT_PLATFORM)
            delete_file(HISTORY_FILE, f"Suppression de l'historique du compte {LOGOUT_EMAIL}")
            print("✅ Nettoyage terminé.")
            sys.exit(0)

        print(f"👤 Email dans le compte : {account.get('email', 'non trouvé')[:30]}")

        # Déchiffrer le mot de passe (si présent)
        if account.get("password"):
            account["password"] = decrypt(account["password"])
            print("🔑 Mot de passe déchiffré.")

        # Déchiffrer les cookies
        cookies = account.get("cookies")
        if isinstance(cookies, str):
            try:
                decrypted = decrypt(cookies)
                parsed = json.loads(decrypted)
                if isinstance(parsed, list):
                    account["cookies"] = parsed
                    print(f"✅ Cookies déchiffrés : {len(parsed)} éléments")
                else:
                    account["cookies"] = None
            except Exception as e:
                print(f"❌ Échec déchiffrement cookies : {e}")
                account["cookies"] = None
        elif isinstance(cookies, list):
            print(f"✅ Cookies déjà en clair : {len(cookies)} éléments")
        else:
            account["cookies"] = None

        if not account.get("cookies") or len(account["cookies"]) == 0:
            print("ℹ️ Pas de cookies valides, suppression directe.")
            delete_file(USER_FILE, f"Suppression du compte {LOGOUT_EMAIL}")
            remove_from_global_list(LOGOUT_EMAIL, LOGOUT_PLATFORM)
            delete_file(HISTORY_FILE, f"Suppression de l'historique du compte {LOGOUT_EMAIL}")
            print("✅ Nettoyage terminé.")
            sys.exit(0)

        logout_success = perform_logout(account["cookies"])

        if logout_success:
            print("🗑️ Suppression des fichiers...")
            delete_file(USER_FILE, f"Suppression du compte {LOGOUT_EMAIL}")
            remove_from_global_list(LOGOUT_EMAIL, LOGOUT_PLATFORM)
            delete_file(HISTORY_FILE, f"Suppression de l'historique du compte {LOGOUT_EMAIL}")
            print("✅ Compte entièrement supprimé.")
            sys.exit(0)
        else:
            print("❌ ÉCHEC DE LA DÉCONNEXION. FICHIERS CONSERVÉS.")
            sys.exit(1)

    except Exception as e:
        print(f"❌ Erreur fatale : {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
