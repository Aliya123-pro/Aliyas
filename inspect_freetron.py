#!/usr/bin/env python3
"""
Script de diagnostic pour freetron.in/login : liste tous les champs et boutons.
"""
import os, sys, time, json
from camoufox import Camoufox

# Configuration via variables d'environnement (mêmes que le script principal)
EMAIL = os.getenv("TEST_EMAIL", "test@example.com")
PASSWORD = os.getenv("TEST_PASSWORD", "dummy")
PLATFORM = os.getenv("TEST_PLATFORM", "freetron")
PROXY_INDEX = int(os.getenv("TEST_PROXY_INDEX", "0") or "0")
JP_PROXY_LIST = [p.strip() for p in os.getenv("JP_PROXY_LIST", "").split(",") if p.strip()]

def parse_proxy_url(proxy_url: str):
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

def main():
    if not JP_PROXY_LIST:
        print("❌ JP_PROXY_LIST vide")
        sys.exit(1)

    proxy_url = JP_PROXY_LIST[PROXY_INDEX] if PROXY_INDEX < len(JP_PROXY_LIST) else JP_PROXY_LIST[0]
    print(f"Proxy: {proxy_url}")
    proxy_dict = parse_proxy_url(proxy_url)

    login_url = "https://freetron.in/login"

    with Camoufox(headless=False, humanize=True, geoip=True, proxy=proxy_dict) as browser:
        page = browser.new_page()
        print(f"Chargement de {login_url}...")
        page.goto(login_url, wait_until="networkidle", timeout=60000)
        time.sleep(5)  # laisser le temps aux scripts de se charger

        print("\n=== INFORMATIONS DE LA PAGE ===")
        print(f"URL actuelle: {page.url}")
        print(f"Titre: {page.title()}")

        # Extraire tous les champs et boutons
        elements_info = page.evaluate("""() => {
            const result = { inputs: [], buttons: [], selects: [], forms: [] };

            // Tous les éléments input
            document.querySelectorAll('input').forEach(el => {
                result.inputs.push({
                    type: el.type || null,
                    name: el.name || null,
                    id: el.id || null,
                    placeholder: el.placeholder || null,
                    value: el.value || null,
                    className: el.className || null,
                    outerHTML: el.outerHTML.slice(0, 200) // pour voir le HTML complet
                });
            });

            // Tous les boutons (balise button et input submit/button)
            document.querySelectorAll('button, input[type="submit"], input[type="button"]').forEach(el => {
                result.buttons.push({
                    tag: el.tagName,
                    type: el.type || null,
                    name: el.name || null,
                    id: el.id || null,
                    text: el.textContent ? el.textContent.trim() : null,
                    value: el.value || null,
                    className: el.className || null,
                    outerHTML: el.outerHTML.slice(0, 200)
                });
            });

            // Tous les selects
            document.querySelectorAll('select').forEach(el => {
                const options = Array.from(el.options).map(opt => ({
                    value: opt.value,
                    text: opt.textContent.trim()
                }));
                result.selects.push({
                    name: el.name || null,
                    id: el.id || null,
                    className: el.className || null,
                    options: options,
                    outerHTML: el.outerHTML.slice(0, 300)
                });
            });

            // Tous les formulaires
            document.querySelectorAll('form').forEach(el => {
                result.forms.push({
                    id: el.id || null,
                    action: el.action || null,
                    method: el.method || null,
                    className: el.className || null,
                    outerHTML: el.outerHTML.slice(0, 300)
                });
            });

            return result;
        }""")

        # Afficher les résultats
        print("\n--- CHAMPS INPUT ---")
        for inp in elements_info['inputs']:
            print(json.dumps(inp, indent=2))
        print("\n--- BOUTONS ---")
        for btn in elements_info['buttons']:
            print(json.dumps(btn, indent=2))
        print("\n--- SELECTS ---")
        for sel in elements_info['selects']:
            print(json.dumps(sel, indent=2))
        print("\n--- FORMULAIRES ---")
        for form in elements_info['forms']:
            print(json.dumps(form, indent=2))

        # Vérifier s'il y a des iframes
        iframes = page.evaluate("""() => {
            return Array.from(document.querySelectorAll('iframe')).map(iframe => ({
                src: iframe.src,
                id: iframe.id,
                name: iframe.name,
                className: iframe.className
            }));
        }""")
        if iframes:
            print("\n--- IFRAMES ---")
            for iframe in iframes:
                print(json.dumps(iframe, indent=2))
        else:
            print("\nAucun iframe détecté.")

if __name__ == "__main__":
    main()
