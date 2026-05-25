const { connect } = require('puppeteer-real-browser');
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Variables d'environnement ────────────────────────────────────────────────
const GH_TOKEN = process.env.GH_TOKEN;
const GH_USERNAME = process.env.GH_USERNAME;
const GH_REPO = process.env.GH_REPO;
const GH_BRANCH = process.env.GH_BRANCH || 'main';
const USER_ID = process.env.USER_ID;
const CLAIM_EMAIL = process.env.CLAIM_EMAIL;
const CLAIM_PLATFORM = process.env.CLAIM_PLATFORM;
const CRYPTO_SECRET = process.env.CRYPTO_SECRET;

if (!GH_TOKEN || !GH_USERNAME || !GH_REPO || !USER_ID || !CLAIM_EMAIL || !CLAIM_PLATFORM) {
    console.error('❌ Variables manquantes');
    process.exit(1);
}
if (!CRYPTO_SECRET) {
    console.error('❌ CRYPTO_SECRET manquant');
    process.exit(1);
}

// ─── Deux méthodes de chiffrement pour rétrocompatibilité ────────────────────
const ALGORITHM = 'aes-256-cbc';

// Nouvelle méthode (autologin)
function encryptNew(text) {
    const key = crypto.scryptSync(CRYPTO_SECRET, 'salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decryptNew(encryptedText) {
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

// Ancienne méthode (ancien claim.js)
function encryptOld(text) {
    const key = crypto.createHash('sha256').update(CRYPTO_SECRET).digest();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decryptOld(encryptedText) {
    if (!encryptedText || typeof encryptedText !== 'string') return encryptedText;
    const key = crypto.createHash('sha256').update(CRYPTO_SECRET).digest();
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

// Déchiffrement automatique (essaie les deux méthodes)
function decryptAuto(encryptedText) {
    if (!encryptedText || typeof encryptedText !== 'string') return encryptedText;
    if (!encryptedText.includes(':')) return encryptedText; // pas chiffré

    // Essayer d'abord la nouvelle méthode
    let result = decryptNew(encryptedText);
    // Si le résultat semble être l'original (contient '@' pour email, ou ':' pour chiffré), on garde
    if (result !== encryptedText) return result;

    // Essayer l'ancienne méthode
    result = decryptOld(encryptedText);
    return result;
}

// ─── Fichier de compte ──────────────────────────────────────────────────────
const USER_FILE = `account_${USER_ID}_${CLAIM_PLATFORM}_${CLAIM_EMAIL}.json`;
const octokit = new Octokit({ auth: GH_TOKEN });

// ─── Proxy(s) ──────────────────────────────────────────────────────────────
const JP_PROXY_LIST = (process.env.JP_PROXY_LIST || '').split(',').filter(p => p.trim() !== '');
console.log(`🌐 Proxys disponibles : ${JP_PROXY_LIST.length}`);

const screenshotsDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });

const TURNSTILE_LOGIN_COORDS = { x: 640, y: 615 };

// ─── Utilitaires ────────────────────────────────────────────────────────────
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

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

function filterValidCookies(cookies) {
    if (!Array.isArray(cookies)) return [];
    return cookies.filter(c => c.name && typeof c.name === 'string' && c.name.trim().length > 0);
}

async function fillField(page, selector, value) {
    await page.waitForSelector(selector, { timeout: 10000 });
    await page.click(selector, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await delay(100);
    await page.evaluate((sel, val) => {
        const el = document.querySelector(sel);
        if (el) el.value = val;
    }, selector, value);
    await delay(300);
    let actual = await page.$eval(selector, el => el.value);
    if (actual !== value) {
        await page.click(selector, { clickCount: 3 });
        await page.keyboard.press('Backspace');
        for (const char of value) await page.keyboard.type(char, { delay: 30 });
    }
}

async function humanScrollToClaim(page) {
    const coords = await page.evaluate(() => {
        const btn = document.querySelector('#process_claim_hourly_faucet');
        if (!btn) return null;
        const rect = btn.getBoundingClientRect();
        return { y: rect.y + window.scrollY };
    });
    if (!coords) throw new Error('Bouton CLAIM introuvable');
    const startY = await page.evaluate(() => window.scrollY);
    const targetY = Math.max(0, coords.y - 200);
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const currentY = startY + (targetY - startY) * t;
        await page.evaluate((y) => window.scrollTo(0, y), currentY);
        await delay(50 + Math.random() * 100);
    }
}

async function addRedDot(page, x, y) {
    await page.evaluate((x, y) => {
        const dot = document.createElement('div');
        dot.style.position = 'fixed'; dot.style.left = (x - 5) + 'px'; dot.style.top = (y - 5) + 'px';
        dot.style.width = '10px'; dot.style.height = '10px'; dot.style.borderRadius = '50%';
        dot.style.backgroundColor = 'red'; dot.style.zIndex = '99999'; dot.style.pointerEvents = 'none';
        dot.id = 'click-dot'; document.body.appendChild(dot);
        setTimeout(() => dot.remove(), 2000);
    }, x, y);
}

async function humanClickAt(page, coords) {
    await addRedDot(page, coords.x, coords.y);
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
    console.log(`🖱️ Clic à (${coords.x}, ${coords.y})`);
}

// ─── Extraction du timer ───────────────────────────────────────────────────
async function extractTimer(page) {
    return await page.evaluate(() => {
        const timerEl = document.querySelector('#next_claim_timer, .countdown, [id*="timer"], [class*="timer"]');
        if (timerEl) {
            const txt = timerEl.textContent.trim();
            const mmss = txt.match(/(\d+):(\d+)/);
            if (mmss) return parseInt(mmss[1]) + parseInt(mmss[2]) / 60;
            const hm = txt.match(/(\d+)\s*h\s*(\d+)?\s*m?/i);
            if (hm) {
                const hours = parseInt(hm[1]) || 0;
                const minutes = hm[2] ? parseInt(hm[2]) : 0;
                return hours * 60 + minutes;
            }
        }
        const cells = document.querySelectorAll('td, th');
        for (const cell of cells) {
            const txt = cell.textContent.trim();
            const mmss = txt.match(/(\d+):(\d+)/);
            if (mmss && txt.length <= 8) return parseInt(mmss[1]) + parseInt(mmss[2]) / 60;
        }
        return null;
    });
}

// ─── Gestion GitHub (rétrocompatible) ──────────────────────────────────────
async function loadAccounts() {
    try {
        const res = await octokit.repos.getContent({
            owner: GH_USERNAME, repo: GH_REPO, path: USER_FILE, ref: GH_BRANCH
        });
        const account = JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8'));

        // 🔓 Déchiffrer l'email (détection auto de la méthode)
        if (account.email) account.email = decryptAuto(account.email);

        // 🔓 Déchiffrer le mot de passe
        if (account.password) account.password = decryptAuto(account.password);

        // 🔓 Déchiffrer et valider les cookies
        if (account.cookies) {
            if (typeof account.cookies === 'string') {
                try {
                    const decrypted = decryptAuto(account.cookies);
                    const parsed = JSON.parse(decrypted);
                    if (Array.isArray(parsed)) {
                        account.cookies = parsed;
                    } else {
                        console.warn('⚠️ Cookies déchiffrés mais ne sont pas un tableau.');
                    }
                } catch (e) {
                    console.warn('⚠️ Impossible de déchiffrer/parser les cookies.');
                }
            } else if (Array.isArray(account.cookies)) {
                console.log('ℹ️ Cookies déjà en clair.');
            }
        }

        return [account];
    } catch (e) {
        if (e.status === 404) return [];
        throw e;
    }
}

async function saveAccounts(accounts, modifiedAccount = null) {
    let account = accounts[0];
    const maxRetries = 30;

    // Préparer les données pour la sauvegarde (email en clair, pwd/cookies avec nouvelle méthode)
    let toSave = { ...account };
    toSave.email = account.email; // déjà en clair après déchiffrement
    if (toSave.password) toSave.password = encryptNew(toSave.password);
    if (toSave.cookies) toSave.cookies = encryptNew(JSON.stringify(toSave.cookies));

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            let sha = null;
            try {
                const res = await octokit.repos.getContent({
                    owner: GH_USERNAME, repo: GH_REPO, path: USER_FILE, ref: GH_BRANCH
                });
                sha = res.data.sha;
            } catch (e) {}

            if (modifiedAccount) {
                toSave = { ...toSave, ...modifiedAccount };
                if (toSave.password && !toSave.password.includes(':')) toSave.password = encryptNew(toSave.password);
                if (toSave.cookies && typeof toSave.cookies !== 'string') toSave.cookies = encryptNew(JSON.stringify(toSave.cookies));
            }

            const content = Buffer.from(JSON.stringify(toSave, null, 2)).toString('base64');
            await octokit.repos.createOrUpdateFileContents({
                owner: GH_USERNAME, repo: GH_REPO, path: USER_FILE,
                message: 'Mise à jour automatique', content, branch: GH_BRANCH, sha
            });
            console.log(`💾 Sauvegarde réussie (tentative ${attempt})`);
            return;
        } catch (e) {
            if (e.status === 409) {
                console.warn(`⚠️ Conflit 409 – tentative ${attempt}/${maxRetries}`);
                if (attempt < maxRetries) {
                    const waitTime = 1000 + Math.random() * 4000;
                    await new Promise(r => setTimeout(r, waitTime));
                } else {
                    console.error('❌ Trop de conflits, abandon.');
                    throw e;
                }
            } else {
                throw e;
            }
        }
    }
    throw new Error('Échec sauvegarde après plusieurs tentatives');
}

// ─── Connexion proxy avec fallback ─────────────────────────────────────────
async function tryConnect(proxyUrl) {
    const proxyConfig = parseProxyUrl(proxyUrl);
    if (!proxyConfig) return null;

    const options = {
        headless: false,
        turnstile: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    };

    if (proxyConfig.username && proxyConfig.password) {
        options.proxy = `${proxyConfig.server.replace('://', '://' + proxyConfig.username + ':' + proxyConfig.password + '@')}`;
    } else {
        options.proxy = proxyConfig.server;
    }

    try {
        const { browser, page } = await connect(options);
        return { browser, page };
    } catch (err) {
        console.warn(`⚠️ Proxy ${proxyConfig.server} échoué : ${err.message}`);
        return null;
    }
}

async function connectWithFallback() {
    for (const proxyUrl of JP_PROXY_LIST) {
        const conn = await tryConnect(proxyUrl);
        if (conn) {
            console.log(`✅ Connecté via ${proxyUrl}`);
            return conn;
        }
        await delay(2000);
    }

    console.warn('⚠️ Aucun proxy disponible, tentative sans proxy...');
    try {
        const { browser, page } = await connect({
            headless: false,
            turnstile: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        console.log('✅ Connecté sans proxy');
        return { browser, page };
    } catch (err) {
        throw new Error('Impossible de se connecter même sans proxy : ' + err.message);
    }
}

// ─── Login ─────────────────────────────────────────────────────────────────
async function performLoginAndCaptureCookies(account) {
    const { email, password, platform } = account;
    console.log(`🔐 Login pour ${email} sur ${platform}...`);
    const siteUrls = {
        tronpick: 'https://tronpick.io/login.php',
        litepick: 'https://litepick.io/login.php',
        dogepick: 'https://dogepick.io/login.php',
        solpick: 'https://solpick.io/login.php',
        bnbpick: 'https://bnbpick.io/login.php'
    };
    const loginUrl = siteUrls[platform];
    if (!loginUrl) throw new Error('Plateforme inconnue');

    let browser;
    try {
        const { browser: br, page } = await connectWithFallback();
        browser = br;
        await page.setViewport({ width: 1280, height: 720 });
        await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });

        await fillField(page, 'input[type="email"], input[name="email"]', email);
        await fillField(page, 'input[type="password"]', password);
        await delay(2000);

        const frame = await page.waitForFrame(
            f => f.url().includes('challenges.cloudflare.com/turnstile'),
            { timeout: 15000 }
        ).catch(() => null);

        if (frame) {
            console.log('✅ Iframe Turnstile trouvée (login), clic checkbox');
            await frame.click('input[type="checkbox"]');
            await delay(8000);
        } else {
            console.log('⚠️ Iframe non trouvée, fallback coordonné');
            await humanClickAt(page, TURNSTILE_LOGIN_COORDS);
            await delay(10000);
        }

        const loginClicked = await page.evaluate(() => {
            const btns = [...document.querySelectorAll('button')];
            const loginBtn = btns.find(b => b.textContent.trim() === 'Log in');
            if (loginBtn) { loginBtn.click(); return true; }
            return false;
        });
        if (!loginClicked) throw new Error('Bouton Log in introuvable');

        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
        await delay(5000);
        if (page.url().includes('login.php')) {
            const errorMsg = await page.evaluate(() => {
                const el = document.querySelector('.alert-danger, .error');
                return el ? el.textContent.trim() : null;
            });
            throw new Error(errorMsg || 'Échec connexion');
        }
        const cookies = await page.cookies();
        return cookies;
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

// ─── Claim ────────────────────────────────────────────────────────────────
async function claimWithCookies(account) {
    const { email, cookies, platform } = account;
    console.log(`🍪 Claim pour ${email} sur ${platform} via cookies`);
    const siteUrls = {
        tronpick: 'https://tronpick.io/faucet.php',
        litepick: 'https://litepick.io/faucet.php',
        dogepick: 'https://dogepick.io/faucet.php',
        solpick: 'https://solpick.io/faucet.php',
        bnbpick: 'https://bnbpick.io/faucet.php'
    };
    const faucetUrl = siteUrls[platform] || 'https://tronpick.io/faucet.php';

    let browser;
    let attempt = 0;
    const maxAttempts = 3;

    while (attempt < maxAttempts) {
        attempt++;
        try {
            console.log(`🔄 Tentative ${attempt}/${maxAttempts}`);
            const { browser: br, page } = await connectWithFallback();
            browser = br;

            await page.setViewport({ width: 1280, height: 720 });

            const validCookies = filterValidCookies(cookies);
            await page.setCookie(...validCookies);
            await page.goto(faucetUrl, { waitUntil: 'networkidle2', timeout: 90000 });
            await delay(5000);
            if (page.url().includes('login.php')) {
                const errMsg = 'Cookies expirés – reconnexion automatique désactivée.';
                console.error(`❌ ${errMsg}`);
                return { success: false, message: errMsg, siteTimer: 62, cookies };
            }

            console.log('⏳ Attente de 5 secondes...');
            await delay(5000);
            console.log('🔄 Actualisation de la page faucet...');
            await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
            await page.screenshot({ path: path.join(screenshotsDir, `01_after_reload_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

            console.log('⏳ Attente de 20 secondes...');
            await delay(20000);
            await page.screenshot({ path: path.join(screenshotsDir, `02_after_wait_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

            const claimBtnNow = await page.evaluate(() => {
                const btn = document.querySelector('#process_claim_hourly_faucet');
                return btn !== null && btn.offsetParent !== null;
            });

            if (!claimBtnNow) {
                console.log('⏳ Bouton Claim absent, lecture du timer bot...');
                let minutesLeft = null;
                try { minutesLeft = await extractTimer(page); } catch (e) {}
                const waitTime = minutesLeft || 62;
                console.log(`⏱️ Timer restant : ${waitTime.toFixed(1)} minutes`);
                return { success: false, message: `Claim déjà fait, dispo dans ${waitTime.toFixed(1)} min`, siteTimer: waitTime, cookies };
            }

            await humanScrollToClaim(page);
            await delay(2000);
            await page.screenshot({ path: path.join(screenshotsDir, `03_turnstile_visible_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

            console.log('🔍 Sélection du type de captcha...');
            const selectSelector = 'select';
            await page.waitForSelector(selectSelector, { visible: true, timeout: 10000 });
            const availableOptions = await page.$$eval(`${selectSelector} option`, opts =>
                opts.map(o => ({ text: o.textContent.trim(), value: o.value }))
            );
            console.log('📋 Options disponibles :', availableOptions);

            const targetOptionText = 'Cloudflare Turnstile';
            const target = availableOptions.find(o => o.text === targetOptionText);
            if (!target) throw new Error(`Option "${targetOptionText}" introuvable`);
            await page.select(selectSelector, target.value);
            console.log(`✅ Option "${targetOptionText}" sélectionnée`);
            await delay(5000);

            const claimBtnCoords = await page.evaluate(() => {
                const btn = document.querySelector('#process_claim_hourly_faucet');
                if (!btn) return null;
                const rect = btn.getBoundingClientRect();
                return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            });
            if (!claimBtnCoords) throw new Error('Bouton Claim introuvable');

            const turnstileClickX = claimBtnCoords.x;
            const turnstileClickY = claimBtnCoords.y - 70;
            console.log(`🎯 Clic Turnstile à (${turnstileClickX.toFixed(0)}, ${turnstileClickY.toFixed(0)})`);

            await humanClickAt(page, { x: turnstileClickX, y: turnstileClickY });

            const startToken = Date.now();
            const maxTokenWait = 30000;
            let tokenValidated = false;
            while (Date.now() - startToken < maxTokenWait) {
                const tokenValue = await page.evaluate(() => {
                    const input = document.querySelector('[name="cf-turnstile-response"]');
                    return input ? input.value : null;
                });
                if (tokenValue && tokenValue.trim().length > 0) {
                    console.log('✅ Token Turnstile détecté, attente 2 secondes...');
                    await delay(2000);
                    tokenValidated = true;
                    break;
                }
                await delay(2000);
            }
            if (!tokenValidated) throw new Error('Token Turnstile non apparu après 30 secondes');

            console.log('🖱️ Clic sur le bouton Claim');
            await humanClickAt(page, { x: claimBtnCoords.x, y: claimBtnCoords.y });
            await page.waitForNetworkIdle({ timeout: 20000 }).catch(() => {});
            await delay(5000);
            await page.screenshot({ path: path.join(screenshotsDir, `07_after_claim_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

            const messages = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('[class*="toast"], [class*="alert"], [role="alert"], .alert, .message, .notification'))
                    .map(el => el.textContent.trim()).filter(t => t);
            });
            const btnDisabled = await page.evaluate(() => {
                const btn = document.querySelector('#process_claim_hourly_faucet');
                return btn ? btn.disabled : false;
            });

            const success = btnDisabled || messages.some(m => /success|claimed|reward|sent|received|thanks/i.test(m));
            const resultMessage = messages[0] || (btnDisabled ? 'Bouton désactivé (succès présumé)' : 'Aucune réaction');
            console.log(`📢 Messages détectés : ${messages.join(' | ')}`);
            console.log(`🔘 Bouton désactivé : ${btnDisabled}`);

            let nextTimerMinutes;
            const allText = messages.join(' ').toLowerCase();
            if (allText.includes('error') && allText.includes('try again in 10 minutes')) {
                nextTimerMinutes = 120;
                console.log('⏳ Erreur avec pénalité → prochain claim dans 120 minutes');
            } else if (success || messages.length === 0) {
                nextTimerMinutes = 62;
                console.log('✅ Succès ou pas de message → prochain claim dans 62 minutes');
            } else {
                nextTimerMinutes = 62;
                console.log('⚠️ Aucune réaction → prochain claim dans 62 minutes');
            }
            console.log(`⏱️ Prochain claim dans ${nextTimerMinutes} minutes`);

            return { success, message: resultMessage, siteTimer: nextTimerMinutes, cookies };

        } catch (error) {
            console.error(`❌ Erreur tentative ${attempt} : ${error.message}`);
            if (attempt < maxAttempts && error.message.includes('timeout')) {
                console.warn(`⚠️ Timeout navigation, nouvelle tentative...`);
                if (browser) await browser.close().catch(() => {});
                await delay(5000);
                continue;
            }
            return { success: false, message: error.message, siteTimer: 62, cookies };
        } finally {
            if (browser) await browser.close().catch(() => {});
        }
    }

    return { success: false, message: 'Échec après plusieurs tentatives', siteTimer: 62, cookies };
}

// ─── Sauvegarde de l'historique ─────────────────────────────────────────────
async function saveHistory(account, success, message) {
    const historyFile = `history_${USER_ID}.json`;
    const octokitHist = new Octokit({ auth: GH_TOKEN });

    let bonus = 0;
    if (success && message) {
        const match = message.match(/([\d]+(\.[\d]+)?)/);
        if (match) bonus = parseFloat(match[1]) || 0;
    }

    const entry = {
        email: account.email,
        platform: account.platform,
        timestamp: Date.now(),
        success,
        message: message || '',
        bonus
    };

    try {
        let history = [];
        let sha = null;
        try {
            const res = await octokitHist.repos.getContent({
                owner: GH_USERNAME, repo: GH_REPO, path: historyFile, ref: GH_BRANCH
            });
            sha = res.data.sha;
            history = JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8'));
        } catch (e) {}

        history.push(entry);
        const content = Buffer.from(JSON.stringify(history, null, 2)).toString('base64');
        await octokitHist.repos.createOrUpdateFileContents({
            owner: GH_USERNAME, repo: GH_REPO, path: historyFile,
            message: 'Ajout historique claim', content, branch: GH_BRANCH, sha
        });
        console.log('📜 Historique sauvegardé.');
    } catch (e) {
        if (e.status === 409) {
            console.warn('⚠️ Conflit historique, on ignore.');
        } else {
            console.error('❌ Erreur sauvegarde historique :', e.message);
        }
    }
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
    console.log(`🚀 Démarrage claim pour ${CLAIM_EMAIL} sur ${CLAIM_PLATFORM}`);
    const accounts = await loadAccounts();
    let account = accounts[0];
    if (!account) {
        const password = process.env.CLAIM_PASSWORD;
        if (!password) {
            console.error('❌ CLAIM_PASSWORD manquant pour le premier lancement');
            process.exit(1);
        }
        account = {
            email: CLAIM_EMAIL,
            platform: CLAIM_PLATFORM,
            password: encryptNew(password),
            cookies: null,
            cookiesStatus: 'none'
        };
        await saveAccounts([account]);
        console.log('✅ Nouveau compte créé. Relancez pour le premier login.');
        return;
    }

    if (!account.cookies || account.cookiesStatus !== 'valid') {
        console.log('🔑 Cookies absents ou invalides, connexion...');
        try {
            account.cookies = await performLoginAndCaptureCookies(account);
            account.cookiesStatus = 'valid';
            await saveAccounts([account], { 
                cookies: account.cookies, 
                cookiesStatus: 'valid',
                nextClaimTime: account.nextClaimTime 
            });
        } catch (err) {
            console.error('❌ Échec login initial :', err.message);
            process.exit(1);
        }
    }

    const result = await claimWithCookies(account);
    if (result.cookies) account.cookies = result.cookies;
    if (result.siteTimer !== null) {
        account.lastClaim = Date.now();
        account.timer = result.siteTimer;
        account.nextClaimTime = Date.now() + (result.siteTimer * 60000);
    }
    await saveAccounts([account], { 
        cookies: account.cookies, 
        cookiesStatus: 'valid',
        nextClaimTime: account.nextClaimTime,
        lastClaim: account.lastClaim,
        timer: account.timer
    });
    await saveHistory(account, result.success, result.message);
    console.log('🏁 Terminé. Succès:', result.success, '-', result.message);
}

main().catch(err => {
    console.error('💥 Erreur fatale:', err);
    process.exit(1);
});
