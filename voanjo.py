#!/usr/bin/env python3
"""
voanjo.py – Claim des faucet avec cookies (Camoufox + Turnstile)
Version avec capture vidéo + meilleure détection du bouton Claim
"""

import os, sys, json, time, random, base64, subprocess
from pathlib import Path
from datetime import datetime
from typing import Optional, Dict, Any

from dotenv import load_dotenv
load_dotenv()

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
from cryptography.hazmat.backends import default_backend
from github import Github, GithubException, Auth
from camoufox import Camoufox
from playwright.sync_api import TimeoutError as PlaywrightTimeout

import ananana

# ---------- Variables d'environnement ----------
GH_TOKEN = os.getenv("GH_TOKEN")
GH_USERNAME = os.getenv("GH_USERNAME")
GH_REPO = os.getenv("GH_REPO")
GH_BRANCH = os.getenv("GH_BRANCH", "main")
USER_ID = os.getenv("USER_ID")
CLAIM_EMAIL = os.getenv("CLAIM_EMAIL")
CLAIM_PLATFORM = os.getenv("CLAIM_PLATFORM")
CRYPTO_SECRET = os.getenv("CRYPTO_SECRET")
JP_PROXY_LIST = [p.strip() for p in os.getenv("JP_PROXY_LIST", "").split(",") if p.strip()]

if not all([CRYPTO_SECRET, USER_ID, CLAIM_EMAIL, CLAIM_PLATFORM, JP_PROXY_LIST]):
    print("❌ Variables d'environnement manquantes")
    sys.exit(1)

USER_FILE = f"account_{USER_ID}_{CLAIM_PLATFORM}_{CLAIM_EMAIL}.json"

# Dossier vidéos
VIDEOS_DIR = Path(__file__).parent / "videos"
VIDEOS_DIR.mkdir(exist_ok=True)

# --- Chiffrement ---
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
    except:
        return encrypted_text

def decrypt_cookies(encrypted_cookies: str) -> list:
    dec = decrypt(encrypted_cookies)
    try:
        return json.loads(dec)
    except:
        return []

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

# --- Capture vidéo ---
def start_ffmpeg(video_path: str):
    display = os.environ.get("DISPLAY", ":99")
    args = [
        "ffmpeg",
        "-f", "x11grab",
        "-video_size", "1280x720",
        "-i", display,
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "28",
        "-pix_fmt", "yuv420p",
        "-y", video_path,
    ]
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(f"🎥 FFmpeg démarré → {video_path}")
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

def get_github_client():
    return Github(auth=Auth.Token(GH_TOKEN))

def save_account(account_data: dict) -> None:
    g = get_github_client()
    repo = g.get_repo(f"{GH_USERNAME}/{GH_REPO}")
    content = json.dumps(account_data, indent=2)
    max_retries = 30
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
                    message=f"Mise à jour compte {CLAIM_EMAIL}",
                    content=content,
                    branch=GH_BRANCH,
                    sha=sha,
                )
            else:
                repo.create_file(
                    path=USER_FILE,
                    message=f"Mise à jour compte {CLAIM_EMAIL}",
                    content=content,
                    branch=GH_BRANCH,
                )
            print("💾 Sauvegarde réussie")
            return
        except GithubException as e:
            if e.status == 409:
                print(f"⚠️ Conflit 409, tentative {attempt}/{max_retries}")
                time.sleep(attempt + random.uniform(0, 3))
            else:
                raise

def add_history_entry(user_id, email, platform, success, bonus=0):
    g = get_github_client()
    repo = g.get_repo(f"{GH_USERNAME}/{GH_REPO}")
    history_file = f"history_{user_id}.json"
    entry = {
        "email": email,
        "platform": platform,
        "timestamp": int(time.time() * 1000),
        "success": success,
        "bonus": bonus
    }
    try:
        sha = None
        history = []
        try:
            contents = repo.get_contents(history_file, ref=GH_BRANCH)
            sha = contents.sha
            history = json.loads(base64.b64decode(contents.content).decode())
        except GithubException as e:
            if e.status != 404:
                raise
        history.append(entry)
        content = json.dumps(history, indent=2)
        if sha:
            repo.update_file(history_file, f"Historique claim {email}", content, sha, branch=GH_BRANCH)
        else:
            repo.create_file(history_file, f"Historique claim {email}", content, branch=GH_BRANCH)
        print("📜 Historique sauvegardé.")
    except Exception as e:
        print(f"⚠️ Impossible d'enregistrer l'historique : {e}")

def extract_timer(page):
    try:
        return page.evaluate("""() => {
            const timerEl = document.querySelector('#next_claim_timer, .countdown, [id*="timer"], [class*="timer"]');
            if (timerEl) {
                const txt = timerEl.textContent.trim();
                const mmss = txt.match(/(\\d+):(\\d+)/);
                if (mmss) return parseInt(mmss[1]) + parseInt(mmss[2]) / 60;
            }
            const cells = document.querySelectorAll('td, th');
            for (const cell of cells) {
                const txt = cell.textContent.trim();
                const mmss = txt.match(/(\\d+):(\\d+)/);
                if (mmss && txt.length <= 8) return parseInt(mmss[1]) + parseInt(mmss[2]) / 60;
            }
            const errorMsg = document.querySelector('.alert-danger, .error, [class*="error"]');
            if (errorMsg) {
                const msg = errorMsg.textContent.trim();
                const match = msg.match(/(\\d+)\\s*(minutes?|mins?)/i);
                if (match) return parseInt(match[1]);
            }
            return null;
        }""")
    except:
        return None

def claim_with_cookies(account: dict):
    faucet_urls = {
        "tronpick": "https://tronpick.io/faucet.php",
        "litepick": "https://litepick.io/faucet.php",
        "dogepick": "https://dogepick.io/faucet.php",
        "solpick": "https://solpick.io/faucet.php",
        "bnbpick": "https://bnbpick.io/faucet.php",
        "tonpick": "https://tonpick.game/faucet.php",
        "suipick": "https://suipick.io/faucet.php",
        "polpick": "https://polpick.io/faucet.php",
        "freetron": "https://freetron.in/faucet",
    }
    faucet_url = faucet_urls.get(CLAIM_PLATFORM, "https://tronpick.io/faucet.php")

    proxy_index = account.get("proxyIndex", 0)
    proxy_url = JP_PROXY_LIST[proxy_index] if proxy_index < len(JP_PROXY_LIST) else JP_PROXY_LIST[0]
    proxy_dict = parse_proxy_url(proxy_url)
    if not proxy_dict:
        raise ValueError("Proxy invalide")

    # Nom de la vidéo
    safe_email = CLAIM_EMAIL.replace("@", "_").replace(".", "_")
    video_path = str(VIDEOS_DIR / f"claim_{CLAIM_PLATFORM}_{safe_email}_{int(time.time())}.mp4")
    ffmpeg_proc = None

    for attempt in range(1, 4):
        try:
            print(f"--- Tentative claim {attempt}/3 ---")
            
            # Démarrer la capture vidéo à chaque tentative
            ffmpeg_proc = start_ffmpeg(video_path)
            time.sleep(1)

            with Camoufox(
                headless=False,
                humanize=True,
                geoip=True,
                proxy=proxy_dict,
            ) as browser:
                page = browser.new_page()

                # Injection des cookies
                cookies_data = account.get("cookies")
                if cookies_data:
                    decrypted = decrypt_cookies(cookies_data)
                    if isinstance(decrypted, list) and len(decrypted) > 0:
                        valid_cookies = [c for c in decrypted if c.get("name") and c.get("value")]
                        if valid_cookies:
                            page.context.add_cookies(valid_cookies)
                            print(f"🍪 {len(valid_cookies)} cookies injectés")

                page.goto(faucet_url, wait_until="networkidle", timeout=90000)
                time.sleep(15)

                if "login.php" in page.url:
                    print("❌ Cookies expirés")
                    account["cookiesStatus"] = "expired"
                    account["lastClaim"] = int(time.time() * 1000)
                    account["timer"] = 120
                    save_account(account)
                    add_history_entry(USER_ID, CLAIM_EMAIL, CLAIM_PLATFORM, False, 0)
                    stop_ffmpeg(ffmpeg_proc)
                    return {"success": False, "message": "Cookies expirés"}

                print("✅ Session valide")
                account["cookiesStatus"] = "valid"

                # ─────────────── Meilleure détection du bouton Claim ───────────────
                claim_btn_selectors = [
                    "#process_claim_hourly_faucet",
                    "button#process_claim_hourly_faucet",
                    "input#process_claim_hourly_faucet",
                    "button:has-text('Claim')",
                    "button:has-text('CLAIM')",
                    ".btn-claim",
                    "[onclick*='claim']",
                ]

                claim_btn = None
                for sel in claim_btn_selectors:
                    try:
                        claim_btn = page.wait_for_selector(sel, timeout=8000, state="visible")
                        if claim_btn:
                            print(f"✅ Bouton Claim trouvé avec le sélecteur : {sel}")
                            break
                    except:
                        continue

                if not claim_btn:
                    print("⏳ Bouton Claim absent, lecture du timer...")
                    minutes_left = extract_timer(page)
                    if minutes_left is not None and minutes_left < 60:
                        minutes_left = 60
                    wait_time = minutes_left if minutes_left is not None else 62
                    print(f"⏱️ Timer restant : {wait_time:.1f} minutes")
                    account["timer"] = wait_time
                    account["lastClaim"] = int(time.time() * 1000)
                    save_account(account)
                    add_history_entry(USER_ID, CLAIM_EMAIL, CLAIM_PLATFORM, False, 0)
                    stop_ffmpeg(ffmpeg_proc)
                    return {"success": False, "message": f"Claim déjà fait, dispo dans {wait_time:.1f} min"}

                # Scroll vers le bouton
                page.evaluate("""(el) => {
                    el.style.display = 'inline-block';
                    el.style.visibility = 'visible';
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }""", claim_btn)
                time.sleep(2)

                box = claim_btn.bounding_box()
                if not box or box["width"] == 0:
                    raise RuntimeError("Impossible de localiser le bouton Claim (bounding box vide)")
                
                claim_x = box["x"] + box["width"] / 2
                claim_y = box["y"] + box["height"] / 2
                print(f"📍 Bouton Claim visible à ({claim_x:.0f}, {claim_y:.0f})")

                # ─────────────── Résolution Turnstile ───────────────
                print("🔍 Résolution Turnstile intelligente...")

                select = page.query_selector("select")
                if select:
                    options = page.eval_on_selector_all(
                        "select option",
                        "opts => opts.map(o => ({text: o.textContent.trim(), value: o.value}))"
                    )
                    turnstile_opt = next((o for o in options if "Turnstile" in o.get("text", "")), None)
                    if turnstile_opt:
                        page.select_option("select", turnstile_opt["value"])
                        print("🔁 Turnstile sélectionné")
                        time.sleep(2)

                token_found = ananana.solve_turnstile(page, timeout=35)

                if not token_found:
                    print("❌ Token Turnstile non résolu")
                    account["lastClaim"] = int(time.time() * 1000)
                    account["timer"] = 2
                    save_account(account)
                    add_history_entry(USER_ID, CLAIM_EMAIL, CLAIM_PLATFORM, False, 0)
                    stop_ffmpeg(ffmpeg_proc)
                    return {"success": False, "message": "Échec Turnstile"}

                print("✅ Turnstile résolu")
                time.sleep(2)

                # Clic sur Claim
                print("🖱️ Clic sur le bouton Claim")
                ananana.move_mouse_to(page, claim_x, claim_y)
                page.mouse.click(claim_x, claim_y)

                # Attente résultat
                try:
                    page.wait_for_function("""
                        () => {
                            const btn = document.querySelector('#process_claim_hourly_faucet');
                            if (btn && btn.disabled) return true;
                            const msgs = document.querySelectorAll('.alert-success, .alert-danger, .error, [class*="error"], .success, [class*="success"]');
                            for (const msg of msgs) if (msg.textContent.trim().length > 0) return true;
                            return false;
                        }
                    """, timeout=20000)
                    claim_result = 'success'
                except PlaywrightTimeout:
                    claim_result = 'timeout'

                try:
                    page.wait_for_load_state("networkidle", timeout=10000)
                except:
                    pass
                time.sleep(3)

                messages = page.evaluate("""() => {
                    return Array.from(document.querySelectorAll('.alert-success, .alert-danger, .success, [class*="success"], .error, [class*="error"]'))
                        .map(el => el.textContent.trim()).filter(t => t);
                }""")
                result_message = messages[0] if messages else ""
                if result_message:
                    print(f"📢 Message du site : {result_message}")

                is_error = any(word in result_message.lower() for word in ["error", "something went wrong", "try again"])
                btn_disabled_now = page.evaluate("""() => {
                    const btn = document.querySelector('#process_claim_hourly_faucet');
                    return btn ? btn.disabled : false;
                }""")

                success = (not is_error) and (claim_result != 'timeout' or btn_disabled_now)
                if success:
                    print("✅ Claim réussi")
                else:
                    print("❌ Claim échoué")

                balance = 0.0
                try:
                    bal_el = page.query_selector('[class*="balance"]')
                    if bal_el:
                        balance_text = bal_el.inner_text()
                        balance = float("".join(c for c in balance_text if c.isdigit() or c == "."))
                        print(f"💰 Solde après claim : {balance}")
                except:
                    print("⚠️ Impossible de lire le solde")

                if success:
                    account["totalClaims"] = account.get("totalClaims", 0) + 1
                account["finalBalance"] = balance
                new_timer = extract_timer(page)
                if new_timer is not None:
                    if new_timer < 60:
                        new_timer = 60
                    account["timer"] = new_timer
                else:
                    account["timer"] = 62 if not is_error else 120
                account["lastClaim"] = int(time.time() * 1000)
                save_account(account)
                add_history_entry(USER_ID, CLAIM_EMAIL, CLAIM_PLATFORM, success, balance)

                stop_ffmpeg(ffmpeg_proc)
                print(f"🎥 Vidéo sauvegardée : {video_path}")
                return {"success": success, "message": result_message or ("Claim OK" if success else "Échec")}

        except Exception as e:
            print(f"❌ Erreur tentative {attempt}: {e}")
            stop_ffmpeg(ffmpeg_proc)
            if "NS_ERROR_PROXY_FORBIDDEN" in str(e) or "PROXY" in str(e).upper():
                print("⚠️ Problème de proxy détecté")
            if attempt == 3:
                raise
            time.sleep(3)

    raise RuntimeError("Échec du claim après plusieurs tentatives")

def main():
    try:
        g = get_github_client()
        repo = g.get_repo(f"{GH_USERNAME}/{GH_REPO}")
        try:
            contents = repo.get_contents(USER_FILE, ref=GH_BRANCH)
            account = json.loads(base64.b64decode(contents.content).decode())
        except GithubException as e:
            if e.status == 404:
                print("❌ Compte introuvable")
                sys.exit(1)
            raise

        account.setdefault("totalClaims", 0)
        account.setdefault("initialBalance", 0)
        account.setdefault("finalBalance", 0)

        print(f"📋 Compte chargé : {account['email']} ({account['platform']})")
        result = claim_with_cookies(account)
        print(f"🏁 Terminé. Succès: {result['success']} - {result['message']}")
    except Exception as e:
        print(f"❌ Erreur fatale : {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
