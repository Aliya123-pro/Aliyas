const { connect } = require('puppeteer-real-browser');
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
try { require('dotenv').config(); } catch (e) {}

const email = process.env.LOGOUT_EMAIL;
const platform = process.env.LOGOUT_PLATFORM;
const proxyIndex = process.env.LOGOUT_PROXY_INDEX !== undefined ? parseInt(process.env.LOGOUT_PROXY_INDEX) : 0;

const GH_TOKEN = process.env.GH_TOKEN;
const GH_USERNAME = process.env.GH_USERNAME;
const GH_REPO = process.env.GH_REPO;
const GH_BRANCH = process.env.GH_BRANCH || 'main';
const USER_ID = process.env.USER_ID;
const CRYPTO_SECRET = process.env.CRYPTO_SECRET;

if (!CRYPTO_SECRET || !USER_ID) {
    console.error('❌ CRYPTO_SECRET ou USER_ID manquant');
    process.exit(1);
}

const ALGORITHM = 'aes-256-cbc';

function decrypt(encryptedText) {
    if (!encryptedText || typeof encryptedText !== 'string') return encryptedText;
    const key = crypto.scryptSync(CRYPTO_SECRET, 'salt', 32);
    const parts = encryptedText.split(':');
    if (parts.length < 2) return encryptedText;
    const iv = Buffer.from(parts.shift(), 'hex');
    const encrypted = parts.join(':');
    try {
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) {
        return encryptedText;
    }
}

if (!email || !platform) {
    console.error('❌ LOGOUT_EMAIL et LOGOUT_PLATFORM sont requis.');
    process.exit(1);
}
if (!GH_TOKEN || !GH_USERNAME || !GH_REPO) {
    console.error('❌ Variables GitHub manquantes');
    process.exit(1);
}

const USER_FILE = `account_${USER_ID}_${platform}_${email}.json`;
const GLOBAL_FILE = 'global_accounts.json';
const HISTORY_FILE = `history_${USER_ID}.json`;

const JP_PROXY_LIST = (process.env.JP_PROXY_LIST || '').split(',').filter(p => p.trim() !== '');
if (JP_PROXY_LIST.length === 0) {
    console.error('❌ JP_PROXY_LIST doit contenir au moins 1 proxy');
    process.exit(1);
}

const screenshotsDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });

const octokit = new Octokit({ auth: GH_TOKEN });
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function parseProxyUrl(proxyUrl) {
    if (!proxyUrl) return null;
    proxyUrl = proxyUrl.trim();
    try {
        const url = new URL(proxyUrl);
        const protocol = url.protocol.replace(':', '');
        return {
            server: `${protocol}://${url.hostname}:${url.port}`,
            username: url.username || null,
            password: url.password || null
        };
    } catch (e) {
        console.error('❌ Format proxy invalide :', proxyUrl);
        return null;
    }
}

async function loadAccount() {
    try {
        const res = await octokit.repos.getContent({
            owner: GH_USERNAME, repo: GH_REPO, path: USER_FILE, ref: GH_BRANCH
        });
        return JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8'));
    } catch (e) {
        if (e.status === 404) return null;
        throw e;
    }
}

async function deleteAccountFile() {
    try {
        const res = await octokit.repos.getContent({
            owner: GH_USERNAME, repo: GH_REPO, path: USER_FILE, ref: GH_BRANCH
        });
        const sha = res.data.sha;
        await octokit.repos.deleteFile({
            owner: GH_USERNAME, repo: GH_REPO, path: USER_FILE,
            message: `Suppression du compte ${email}`,
            sha, branch: GH_BRANCH
        });
        console.log(`🗑️ Fichier ${USER_FILE} supprimé.`);
        return true;
    } catch (e) {
        if (e.status === 404) {
            console.log('ℹ️ Le fichier individuel n\'existe pas.');
            return true;
        }
        console.error('❌ Erreur suppression fichier :', e.message);
        return false;
    }
}

async function removeFromGlobalList(email, platform) {
    try {
        let entries = [];
        let sha = null;
        try {
            const res = await octokit.repos.getContent({
                owner: GH_USERNAME, repo: GH_REPO, path: GLOBAL_FILE, ref: GH_BRANCH
            });
            entries = JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8'));
            sha = res.data.sha;
        } catch (e) {
            return true;
        }
        const newEntries = entries.filter(e => !(e.email === email && e.platform === platform));
        if (newEntries.length === entries.length) return true;
        const content = Buffer.from(JSON.stringify(newEntries, null, 2)).toString('base64');
        await octokit.repos.createOrUpdateFileContents({
            owner: GH_USERNAME, repo: GH_REPO, path: GLOBAL_FILE,
            message: `Suppression de ${email}`, content, branch: GH_BRANCH, sha
        });
        console.log('✅ Retiré de la liste globale.');
        return true;
    } catch (e) {
        console.error('❌ Erreur globale :', e.message);
        return false;
    }
}

async function deleteHistoryFile() {
    try {
        const res = await octokit.repos.getContent({
            owner: GH_USERNAME, repo: GH_REPO, path: HISTORY_FILE, ref: GH_BRANCH
        });
        const sha = res.data.sha;
        await octokit.repos.deleteFile({
            owner: GH_USERNAME, repo: GH_REPO, path: HISTORY_FILE,
            message: `Suppression de l'historique du compte ${email}`,
            sha, branch: GH_BRANCH
        });
        console.log(`🗑️ Historique ${HISTORY_FILE} supprimé.`);
        return true;
    } catch (e) {
        if (e.status === 404) {
            console.log('ℹ️ Aucun historique trouvé.');
            return true;
        }
        console.error('❌ Erreur suppression historique :', e.message);
        return false;
    }
}

async function humanClickAt(page, coords) {
    const start = await page.evaluate(() => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 }));
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const cp = { x: start.x + (Math.random() - 0.5) * 100, y: start.y + (Math.random() - 0.5) * 100 };
        const x = Math.pow(1 - t, 2) * start.x + 2 * (1 - t) * t * cp.x + Math.pow(t, 2) * coords.x;
        const y = Math.pow(1 - t, 2) * start.y + 2 * (1 - t) * t * cp.y + Math.pow(t, 2) * coords.y;
        await page.mouse.move(x, y); await delay(15);
    }
    await page.mouse.click(coords.x, coords.y);
}

async function performNormalLogout(accountCookies) {
    const proxyUrl = JP_PROXY_LIST[proxyIndex] || JP_PROXY_LIST[0];
    const proxyConfig = parseProxyUrl(proxyUrl);
    if (!proxyConfig) throw new Error('Proxy invalide');

    console.log(`🔌 Déconnexion de ${email} sur ${platform}.io`);

    if (!accountCookies || accountCookies.length === 0) {
        console.log('❌ Aucun cookie reçu !');
        return false;
    }

    const options = {
        headless: false,
        turnstile: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    };
    if (proxyConfig.username && proxyConfig.password) {
        options.proxy = `${proxyConfig.server.replace('://', '://' + proxyConfig.username + ':' + proxyConfig.password + '@')}`;
    } else {
        options.proxy = proxyConfig.server;
    }

    const { browser, page } = await connect(options);

    try {
        await page.setViewport({ width: 1280, height: 720 });
        await page.setCookie(...accountCookies);
        console.log('💉 Cookies injectés.')

const faucetUrls = {
    tronpick: 'https://tronpick.io/faucet.php',
    litepick: 'https://litepick.io/faucet.php',
    dogepick: 'https://dogepick.io/faucet.php',
    solpick: 'https://solpick.io/faucet.php',
    bnbpick: 'https://bnbpick.io/faucet.php',
    tonpick: 'https://tonpick.game/faucet.php',   // ← cas particulier
    suipick: 'https://suipick.io/faucet.php',
    polpick: 'https://polpick.io/faucet.php'
};
const faucetUrl = faucetUrls[platform] || `https://${platform}.io/faucet.php`;

        await page.goto(faucetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        console.log('⏳ Attente 20 secondes...');
        await delay(20000);

        if (page.url().includes('login.php')) {
            console.log('ℹ️ Session déjà expirée');
            return true;
        }

        await page.screenshot({ path: path.join(screenshotsDir, `01_before_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

        // Méthode 1 : Chercher le bouton Logout visible
        console.log('🔍 Recherche du bouton Logout visible...');
        const logoutCoords = await page.evaluate(() => {
            const candidates = [...document.querySelectorAll('button, a, div[role="button"], input[type="submit"]')];
            const btn = candidates.find(el => {
                const txt = el.textContent?.toLowerCase() || '';
                return txt.includes('log out') || txt.includes('logout') || txt.includes('déconnexion') || txt.includes('sign out');
            });
            if (btn) {
                const rect = btn.getBoundingClientRect();
                if (rect.width > 10 && rect.height > 10) {
                    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, text: btn.textContent.trim() };
                }
            }
            return null;
        });

        if (logoutCoords) {
            console.log(`🖱️ Clic sur "${logoutCoords.text}"`);
            await humanClickAt(page, logoutCoords);
            await delay(1000);

            // Vérifier boîte de confirmation
            const dialogVisible = await page.evaluate(() => {
                const modals = document.querySelectorAll('.modal, .dialog, [role="dialog"], .popup');
                return Array.from(modals).some(m => m.offsetParent !== null);
            });
            if (dialogVisible) {
                console.log('🔔 Boîte de confirmation détectée');
                const confirmClicked = await page.evaluate(() => {
                    const btns = [...document.querySelectorAll('button')];
                    const confirmBtn = btns.find(b => /yes|ok|confirm|oui|valider/i.test(b.textContent));
                    if (confirmBtn) { confirmBtn.click(); return true; }
                    return false;
                });
                if (!confirmClicked) await page.keyboard.press('Escape');
                await delay(2000);
            }

            await delay(4000);

            if (page.url().includes('login.php')) {
                console.log('✅ Déconnexion réussie');
                return true;
            }

            await page.goto(faucetUrl, { waitUntil: 'networkidle2', timeout: 10000 });
            await delay(5000);
            if (page.url().includes('login.php')) {
                console.log('✅ Déconnexion confirmée');
                return true;
            }
        } else {
            console.log('⚠️ Aucun bouton Logout visible trouvé.');
        }

        // Méthode 2 : Fallback POST (comme l'original)
        console.log('🔄 Tentative fallback POST...');

        let csrfToken = await page.evaluate(() => {
            const el = document.querySelector('input[name="csrf_test_name"]');
            return el ? el.value : null;
        });

        if (!csrfToken) {
            console.log('⚠️ Token CSRF non trouvé dans la page, recherche dans les cookies...');
            const cookies = await page.cookies();
            const csrfCookie = cookies.find(c => 
                c.name.toLowerCase().includes('csrf') || 
                c.name === 'csrf_cookie_name'
            );
            csrfToken = csrfCookie ? csrfCookie.value : null;
        }

        if (!csrfToken) {
            console.error('❌ Token CSRF introuvable');
            return false;
        }

        console.log('🔑 Token CSRF trouvé, envoi POST logout...');
        await page.evaluate(async (token) => {
            const formData = new FormData();
            formData.append('action', 'logout');
            formData.append('csrf_test_name', token);
            await fetch('process.php', { method: 'POST', body: formData });
        }, csrfToken);

        await delay(5000);
        await page.goto(faucetUrl, { waitUntil: 'networkidle2', timeout: 10000 });
        await delay(5000);

        if (page.url().includes('login.php')) {
            console.log('✅ Déconnexion réussie via POST');
            return true;
        }

        console.error('❌ Échec de la déconnexion');
        return false;
    } catch (err) {
        console.error(`❌ Erreur : ${err.message}`);
        return false;
    } finally {
        await browser.close().catch(() => {});
    }
}

(async () => {
    try {
        const account = await loadAccount();
        if (!account) {
            console.log('ℹ️ Compte inexistant, suppression des fichiers uniquement.');
            await deleteAccountFile();
            await removeFromGlobalList(email, platform);
            await deleteHistoryFile();
            console.log('✅ Nettoyage terminé.');
            process.exit(0);
        }

        console.log(`👤 Email dans le compte : ${account.email ? account.email.substring(0, 30) : 'non trouvé'}`);

        if (account.password) {
            account.password = decrypt(account.password);
            console.log('🔑 Mot de passe déchiffré.');
        }

        if (account.cookies) {
            if (typeof account.cookies === 'string') {
                try {
                    const decrypted = decrypt(account.cookies);
                    const parsed = JSON.parse(decrypted);
                    if (Array.isArray(parsed)) {
                        account.cookies = parsed;
                        console.log(`✅ Cookies déchiffrés : ${parsed.length} éléments`);
                    } else {
                        account.cookies = null;
                    }
                } catch (e) {
                    console.error(`❌ Échec déchiffrement cookies : ${e.message}`);
                    account.cookies = null;
                }
            } else if (Array.isArray(account.cookies)) {
                console.log(`✅ Cookies déjà en clair : ${account.cookies.length} éléments`);
            } else {
                account.cookies = null;
            }
        }

        if (!account.cookies || account.cookies.length === 0) {
            console.log('ℹ️ Pas de cookies valides, suppression directe.');
            await deleteAccountFile();
            await removeFromGlobalList(email, platform);
            await deleteHistoryFile();
            console.log('✅ Nettoyage terminé.');
            process.exit(0);
        }

        const logoutSuccess = await performNormalLogout(account.cookies);

        if (logoutSuccess) {
            console.log('🗑️ Suppression des fichiers...');
            await deleteAccountFile();
            await removeFromGlobalList(email, platform);
            await deleteHistoryFile();
            console.log('✅ Compte entièrement supprimé.');
            process.exit(0);
        } else {
            console.error('❌ ÉCHEC DE LA DÉCONNEXION. FICHIERS CONSERVÉS.');
            process.exit(1);
        }
    } catch (err) {
        console.error('❌ Erreur fatale :', err.message);
        process.exit(1);
    }
})();
