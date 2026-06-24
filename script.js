// script.js – Claim avec cookies (3 tentatives Turnstile, timer 2 min si échec)
const { connect } = require('puppeteer-real-browser');
const { Octokit } = require('@octokit/rest');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

try { require('dotenv').config(); } catch (e) {}

// ---------- Configuration ----------
const GH_TOKEN = process.env.GH_TOKEN;
const GH_USERNAME = process.env.GH_USERNAME;
const GH_REPO = process.env.GH_REPO;
const GH_BRANCH = process.env.GH_BRANCH || 'main';
const USER_ID = process.env.USER_ID;
const CLAIM_EMAIL = process.env.CLAIM_EMAIL;
const CLAIM_PLATFORM = process.env.CLAIM_PLATFORM;
const CRYPTO_SECRET = process.env.CRYPTO_SECRET;

if (!CRYPTO_SECRET || !USER_ID || !CLAIM_EMAIL || !CLAIM_PLATFORM) {
    console.error('❌ Variables manquantes');
    process.exit(1);
}

const KEY = crypto.scryptSync(CRYPTO_SECRET, 'salt', 32);
function decrypt(encryptedText) {
    if (typeof encryptedText !== 'string') return encryptedText;
    try { return JSON.parse(encryptedText); } catch (e) {}
    const parts = encryptedText.split(':');
    if (parts.length !== 2) return encryptedText;
    try {
        const iv = Buffer.from(parts[0], 'hex');
        const encrypted = parts[1];
        const decipher = crypto.createDecipheriv('aes-256-cbc', KEY, iv);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) { return encryptedText; }
}

const USER_FILE = `account_${USER_ID}_${CLAIM_PLATFORM}_${CLAIM_EMAIL}.json`;
const octokit = new Octokit({ auth: GH_TOKEN });

const JP_PROXY_LIST = (process.env.JP_PROXY_LIST || '').split(',').filter(p => p.trim() !== '');
if (JP_PROXY_LIST.length === 0) process.exit(1);
let DEDICATED_PROXY = JP_PROXY_LIST[0];

const screenshotsDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function parseProxyUrl(proxyUrl) {
    if (!proxyUrl) return null;
    proxyUrl = proxyUrl.trim();
    try {
        const url = new URL(proxyUrl);
        return {
            server: `${url.protocol.replace(':', '')}://${url.hostname}:${url.port}`,
            username: url.username || null,
            password: url.password || null
        };
    } catch (e) { return null; }
}

async function humanClickAt(page, coords) {
    const start = await page.evaluate(() => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 }));
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const cp = { x: start.x + (Math.random() - 0.5) * 100, y: start.y + (Math.random() - 0.5) * 100 };
        const x = Math.pow(1 - t, 2) * start.x + 2 * (1 - t) * t * cp.x + Math.pow(t, 2) * coords.x;
        const y = Math.pow(1 - t, 2) * start.y + 2 * (1 - t) * t * cp.y + Math.pow(t, 2) * coords.y;
        await page.mouse.move(x, y);
        await delay(15);
    }
    await page.mouse.click(coords.x, coords.y);
    console.log(`🖱️ Clic à (${Math.round(coords.x)}, ${Math.round(coords.y)})`);
}

async function extractTimer(page) {
    return await page.evaluate(() => {
        const timerEl = document.querySelector('#next_claim_timer, .countdown, [id*="timer"], [class*="timer"]');
        if (timerEl) {
            const txt = timerEl.textContent.trim();
            const mmss = txt.match(/(\d+):(\d+)/);
            if (mmss) return parseInt(mmss[1]) + parseInt(mmss[2]) / 60;
        }
        const cells = document.querySelectorAll('td, th');
        for (const cell of cells) {
            const txt = cell.textContent.trim();
            const mmss = txt.match(/(\d+):(\d+)/);
            if (mmss && txt.length <= 8) return parseInt(mmss[1]) + parseInt(mmss[2]) / 60;
        }
        const errorMsg = document.querySelector('.alert-danger, .error, [class*="error"]');
        if (errorMsg) {
            const msg = errorMsg.textContent.trim();
            const match = msg.match(/(\d+)\s*(minutes?|mins?)/i);
            if (match) return parseInt(match[1]);
        }
        return null;
    });
}

async function loadAccount() {
    try {
        const res = await octokit.repos.getContent({
            owner: GH_USERNAME, repo: GH_REPO, path: USER_FILE, ref: GH_BRANCH
        });
        const account = JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8'));
        const proxyIndex = account.proxyIndex || 0;
        DEDICATED_PROXY = JP_PROXY_LIST[proxyIndex] || JP_PROXY_LIST[0];
        console.log(`🔒 Proxy dédié : ${DEDICATED_PROXY}`);
        return account;
    } catch (e) {
        if (e.status === 404) return null;
        throw e;
    }
}

async function saveAccount(account) {
    const maxRetries = 30;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            let sha = null;
            try {
                const res = await octokit.repos.getContent({
                    owner: GH_USERNAME, repo: GH_REPO, path: USER_FILE, ref: GH_BRANCH
                });
                sha = res.data.sha;
            } catch (e) {}
            const content = Buffer.from(JSON.stringify(account, null, 2)).toString('base64');
            await octokit.repos.createOrUpdateFileContents({
                owner: GH_USERNAME, repo: GH_REPO, path: USER_FILE,
                message: `Mise à jour compte ${CLAIM_EMAIL}`,
                content, branch: GH_BRANCH, sha
            });
            console.log('💾 Sauvegarde réussie');
            return;
        } catch (err) {
            if (err.status === 409) {
                console.warn(`⚠️ Conflit 409, tentative ${attempt}/${maxRetries}`);
                await delay(1000 * attempt + Math.random() * 3000);
            } else throw err;
        }
    }
}

async function addHistoryEntry(userId, email, platform, success, bonus = 0) {
    const historyFile = `history_${userId}.json`;
    const entry = { email, platform, timestamp: Date.now(), success, bonus };
    try {
        let history = [];
        let sha = null;
        try {
            const res = await octokit.repos.getContent({
                owner: GH_USERNAME, repo: GH_REPO, path: historyFile, ref: GH_BRANCH
            });
            sha = res.data.sha;
            history = JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8'));
        } catch (e) {}
        history.push(entry);
        const content = Buffer.from(JSON.stringify(history, null, 2)).toString('base64');
        await octokit.repos.createOrUpdateFileContents({
            owner: GH_USERNAME, repo: GH_REPO, path: historyFile,
            message: `Historique claim ${email}`,
            content, branch: GH_BRANCH, sha
        });
        console.log('📜 Historique sauvegardé.');
    } catch (e) {
        console.warn('⚠️ Impossible d\'enregistrer l\'historique :', e.message);
    }
}

async function claimWithCookies(account) {
    const faucetUrls = {
        tronpick: 'https://tronpick.io/faucet.php',
        litepick: 'https://litepick.io/faucet.php',
        dogepick: 'https://dogepick.io/faucet.php',
        solpick: 'https://solpick.io/faucet.php',
        bnbpick: 'https://bnbpick.io/faucet.php',
        tonpick: 'https://tonpick.game/faucet.php',
        suipick: 'https://suipick.io/faucet.php',
        polpick: 'https://polpick.io/faucet.php'
    };
    const faucetUrl = faucetUrls[CLAIM_PLATFORM] || 'https://tronpick.io/faucet.php';

    let browser;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const proxyConfig = parseProxyUrl(DEDICATED_PROXY);
            const options = {
                headless: false,
                turnstile: true,
                args: ['--no-sandbox']
            };
            if (proxyConfig.username && proxyConfig.password) {
                options.proxy = { server: proxyConfig.server, username: proxyConfig.username, password: proxyConfig.password };
            } else {
                options.proxy = { server: proxyConfig.server };
            }
            const { browser: br, page } = await connect(options);
            browser = br;
            console.log('⏳ Attente 10s pour stabilisation du navigateur...');
            await delay(10000);
            await page.setViewport({ width: 1280, height: 720 });
            await page.screenshot({ path: path.join(screenshotsDir, '01_navigateur_ouvert.png') });

            // Injection des cookies
            let cookiesInjected = false;
            if (account.cookies) {
                try {
                    let decryptedCookies = decrypt(account.cookies);
                    if (typeof decryptedCookies === 'string') {
                        decryptedCookies = JSON.parse(decryptedCookies);
                    }
                    if (Array.isArray(decryptedCookies) && decryptedCookies.length > 0) {
                        const validCookies = decryptedCookies.filter(c => c.name && c.value);
                        await page.setCookie(...validCookies);
                        cookiesInjected = true;
                        console.log(`🍪 ${validCookies.length} cookies injectés`);
                    }
                } catch (e) {
                    console.warn('⚠️ Erreur parsing cookies, on continue sans');
                }
            }

            console.log(`🌐 Accès à ${faucetUrl}`);
            await page.goto(faucetUrl, { waitUntil: 'networkidle2', timeout: 90000 });
            console.log('⏳ Pause de 20s pour chargement complet de la page...');
            await delay(20000);
            await page.screenshot({ path: path.join(screenshotsDir, '02_page_faucet.png') });

            if (page.url().includes('login.php')) {
                console.error('❌ Cookies expirés');
                account.cookiesStatus = 'expired';
                account.lastClaim = Date.now();
                account.timer = 120;
                await saveAccount(account);
                await addHistoryEntry(USER_ID, CLAIM_EMAIL, CLAIM_PLATFORM, false, 0);
                return { success: false, message: 'Cookies expirés' };
            }

            console.log('✅ Session valide');
            account.cookiesStatus = 'valid';

            // Vérifier la présence du bouton Claim
            const claimBtnSelector = '#process_claim_hourly_faucet';
            let claimBtn = await page.$(claimBtnSelector);
            if (!claimBtn) {
                console.log('⏳ Bouton Claim absent, lecture du timer...');
                let minutesLeft = await extractTimer(page);
                if (minutesLeft !== null && minutesLeft < 60) minutesLeft = 60;
                const waitTime = minutesLeft !== null ? minutesLeft : 62;
                console.log(`⏱️ Timer restant : ${waitTime.toFixed(1)} minutes`);
                account.timer = waitTime;
                account.lastClaim = Date.now();
                await saveAccount(account);
                await addHistoryEntry(USER_ID, CLAIM_EMAIL, CLAIM_PLATFORM, false, 0);
                return { success: false, message: `Claim déjà fait, dispo dans ${waitTime.toFixed(1)} min`, siteTimer: waitTime };
            }

            // Scroll jusqu'au bouton et forcer sa visibilité
            console.log('📜 Défilement jusqu\'au bouton Claim...');
            await page.evaluate((sel) => {
                const btn = document.querySelector(sel);
                if (btn) {
                    btn.style.display = 'inline-block';
                    btn.style.visibility = 'visible';
                    btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }, claimBtnSelector);
            await delay(3000);
            const isVisible = await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                return rect.top >= 0 && rect.bottom <= window.innerHeight;
            }, claimBtnSelector);
            if (!isVisible) {
                console.log('⚠️ Bouton pas entièrement visible, défilement supplémentaire...');
                await page.evaluate(() => window.scrollBy(0, 300));
                await delay(1000);
            }
            await page.screenshot({ path: path.join(screenshotsDir, '03_avant_turnstile.png') });

            // Récupérer les coordonnées APRÈS avoir forcé la visibilité
            const claimCoords = await page.evaluate(() => {
                const btn = document.querySelector('#process_claim_hourly_faucet');
                if (!btn) return null;
                const rect = btn.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) return null;
                return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
            });
            if (!claimCoords || claimCoords.x === 0 || claimCoords.y === 0) {
                throw new Error('❌ Impossible d\'obtenir les coordonnées du bouton Claim');
            }
            console.log(`📍 Bouton Claim visible à (${Math.round(claimCoords.x)}, ${Math.round(claimCoords.y)})`);

            // --- RÉSOLUTION DU TURNSTILE (max 3 tentatives, 30s par tentative) ---
            const TURNSTILE_RETRIES = 3;
            let tokenFound = false;

            for (let retry = 1; retry <= TURNSTILE_RETRIES; retry++) {
                // Vérifier / sélectionner Turnstile si un select existe
                const selectNow = await page.$('select');
                if (selectNow) {
                    const opts = await page.$$eval('select option', els => els.map(o => ({ text: o.textContent.trim(), value: o.value })));
                    const turnstileOpt = opts.find(o => o.text === 'Cloudflare Turnstile');
                    if (turnstileOpt) {
                        await page.select('select', turnstileOpt.value);
                        console.log('🔁 Turnstile resélectionné');
                        await delay(2000);
                    } else {
                        console.log('⚠️ Option Turnstile non trouvée dans le select');
                    }
                }

                // Clic sur la zone Turnstile (70px au‑dessus du bouton Claim)
                console.log(`🖱️ Clic Turnstile (tentative ${retry}/${TURNSTILE_RETRIES}) à (${Math.round(claimCoords.x)}, ${Math.round(claimCoords.y - 70)})`);
                await humanClickAt(page, { x: claimCoords.x, y: claimCoords.y - 70 });
                await delay(3000);

                const start = Date.now();
                while (Date.now() - start < 30000) {
                    const token = await page.evaluate(() => {
                        const input = document.querySelector('[name="cf-turnstile-response"]');
                        return input ? input.value : null;
                    });
                    if (token && token.trim().length > 0) {
                        console.log('✅ Token Turnstile détecté');
                        await delay(2000);
                        tokenFound = true;
                        break;
                    }
                    await delay(2000);
                }
                if (tokenFound) break;
                console.warn(`⚠️ Token non apparu après tentative ${retry}/${TURNSTILE_RETRIES}`);
            }

            if (!tokenFound) {
                // Aucun token après 3 tentatives → abandon avec timer court
                console.error('❌ Token Turnstile non résolu après 3 tentatives');
                account.lastClaim = Date.now();
                account.timer = 2;   // timer de 2 minutes
                await saveAccount(account);
                await addHistoryEntry(USER_ID, CLAIM_EMAIL, CLAIM_PLATFORM, false, 0);
                return { success: false, message: 'Échec Turnstile (3 essais)' };
            }

            await page.screenshot({ path: path.join(screenshotsDir, '05_token_detecte.png') });

            // ⏳ Attendre 3 secondes avant de cliquer sur le bouton Claim
            console.log('⏳ Attente 3s avant clic Claim...');
            await delay(3000);

            // Clic Claim
            await humanClickAt(page, claimCoords);
            console.log('🖱️ Clic sur le bouton Claim effectué');
            await page.screenshot({ path: path.join(screenshotsDir, '06_apres_clic_claim.png') });

            

            // Détection du résultat
            const claimResult = await Promise.race([
                page.waitForFunction(() => {
                    const btn = document.querySelector('#process_claim_hourly_faucet');
                    return btn && btn.disabled;
                }, { timeout: 20000 }),
                page.waitForFunction(() => {
                    const messages = document.querySelectorAll('.alert-success, .alert-danger, .error, [class*="error"], .success, [class*="success"]');
                    for (const msg of messages) {
                        if (msg.textContent.trim().length > 0) return true;
                    }
                    return false;
                }, { timeout: 20000 })
            ]).catch(() => 'timeout');

            await page.waitForNetworkIdle({ timeout: 10000 }).catch(() => {});
            await delay(3000);
            await page.screenshot({ path: path.join(screenshotsDir, '07_resultat.png') });

            const messages = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('.alert-success, .alert-danger, .success, [class*="success"], .error, [class*="error"]'))
                    .map(el => el.textContent.trim()).filter(t => t);
            });
            const resultMessage = messages[0] || '';
            if (resultMessage) console.log(`📢 Message du site : ${resultMessage}`);

            let success = false;
            const isError = /error|something went wrong|try again/i.test(resultMessage);
            const btnDisabledNow = await page.evaluate(() => {
                const btn = document.querySelector('#process_claim_hourly_faucet');
                return btn ? btn.disabled : false;
            });

            if (!isError && (claimResult !== 'timeout' || btnDisabledNow)) {
                success = true;
                console.log('✅ Claim réussi');
            } else if (isError) {
                console.log('❌ Erreur détectée');
            } else {
                console.log('⚠️ Statut incertain');
            }

            // ⭐ Lire le solde après le claim (indispensable pour l'historique)
            let balance = 0;
            try {
                balance = await page.$eval('[class*="balance"]', el => parseFloat(el.textContent.replace(/[^0-9.]/g, '')));
                console.log(`💰 Solde après claim : ${balance}`);
            } catch (e) {
                console.warn('⚠️ Impossible de lire le solde après le claim');
            }

            // Règle de timer FORCÉE
            if (success || (!isError && !success)) {
                let newTimer = await extractTimer(page);
                if (newTimer !== null && newTimer < 60) newTimer = 60;
                account.timer = newTimer !== null ? newTimer : 62;
            } else {
                account.timer = 120;
            }
            account.lastClaim = Date.now();

            // ✅ Mise à jour de l'historique simplifié
            if (success) {
                account.totalClaims = (account.totalClaims || 0) + 1;
            }
            account.finalBalance = balance;

            await saveAccount(account);
    
            return { success, message: resultMessage || (success ? 'Claim OK' : 'Échec') };

        } catch (err) {
            console.error(`❌ Erreur tentative ${attempt}: ${err.message}`);
            if (attempt >= 3) throw err;
        } finally {
            if (browser) await browser.close().catch(() => {});
        }
    }
    throw new Error('Échec du claim après plusieurs tentatives');
}

// ---------- MAIN ----------
(async () => {
    try {
        const account = await loadAccount();
if (!account) {
    console.error('❌ Compte introuvable');
    process.exit(1);
}

// 🔄 Initialiser les champs d'historique s'ils n'existent pas (anciens comptes)
if (account.totalClaims === undefined) account.totalClaims = 0;
if (account.initialBalance === undefined) account.initialBalance = 0;
if (account.finalBalance === undefined) account.finalBalance = 0;

        console.log(`📋 Compte chargé : ${account.email} (${account.platform})`);

        const result = await claimWithCookies(account);

        console.log(`🏁 Terminé. Succès: ${result.success} - ${result.message}`);
        process.exit(0);
    } catch (err) {
        console.error('❌ Erreur fatale :', err.message);
        process.exit(1);
    }
})();
