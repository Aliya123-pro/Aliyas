// script.js – Claim avec cookies (version robuste avec délai anti-ECONNREFUSED)
const { connect } = require('puppeteer-real-browser');
const { Octokit } = require('@octokit/rest');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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
const randomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

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

async function claimWithCookies(account) {
    const faucetUrls = {
        tronpick: 'https://tronpick.io/faucet.php',
        litepick: 'https://litepick.io/faucet.php',
        dogepick: 'https://dogepick.io/faucet.php',
        solpick: 'https://solpick.io/faucet.php',
        bnbpick: 'https://bnbpick.io/faucet.php',
        suipick: 'https://suipick.io/faucet.php'
    };
    const faucetUrl = faucetUrls[CLAIM_PLATFORM] || 'https://tronpick.io/faucet.php';

    let browser;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const proxyConfig = parseProxyUrl(DEDICATED_PROXY);
            const options = {
                headless: false,
                turnstile: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
            };
            if (proxyConfig.username && proxyConfig.password) {
                options.proxy = { server: proxyConfig.server, username: proxyConfig.username, password: proxyConfig.password };
            } else {
                options.proxy = { server: proxyConfig.server };
            }
            const { browser: br, page } = await connect(options);
            browser = br;
            // ⭐ Délai de 10 secondes pour que le navigateur soit complètement prêt
            console.log('⏳ Attente 10s pour stabilisation du navigateur...');
            await delay(10000);
            await page.setViewport({ width: 1280, height: 720 });

            // Injection des cookies (toujours, même si le statut est "expired")
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
            if (!cookiesInjected) {
                console.warn('⚠️ Aucun cookie injecté');
            }

            console.log(`🌐 Accès à ${faucetUrl}`);
            await page.goto(faucetUrl, { waitUntil: 'networkidle2', timeout: 90000 });
            await delay(5000);

            if (page.url().includes('login.php')) {
                console.error('❌ Cookies expirés – reconnexion automatique désactivée.');
                account.cookiesStatus = 'expired';
                await saveAccount(account);
                return { success: false, message: 'Cookies expirés' };
            }

            console.log('✅ Session valide, statut remis à valid');
            account.cookiesStatus = 'valid';

            // --- Suite du claim ---
            const claimBtnPresent = await page.evaluate(() => {
                const btn = document.querySelector('#process_claim_hourly_faucet');
                return btn !== null && btn.offsetParent !== null;
            });
            if (!claimBtnPresent) {
                console.log('⏳ Bouton Claim absent, lecture du timer...');
                let minutesLeft = null;
                try { minutesLeft = await extractTimer(page); } catch (e) {}
                const waitTime = minutesLeft || 62;
                console.log(`⏱️ Timer restant : ${waitTime.toFixed(1)} minutes`);
                account.timer = waitTime;
                account.lastClaim = Date.now();
                await saveAccount(account);
                return { success: false, message: `Claim déjà fait, dispo dans ${waitTime.toFixed(1)} min`, siteTimer: waitTime };
            }

            // Scroll et Turnstile
            await page.evaluate(() => {
                const btn = document.querySelector('#process_claim_hourly_faucet');
                if (btn) btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            });
            await delay(3000);

            const selectSelector = 'select';
            await page.waitForSelector(selectSelector, { visible: true, timeout: 10000 });
            const availableOptions = await page.$$eval(`${selectSelector} option`, opts =>
                opts.map(o => ({ text: o.textContent.trim(), value: o.value }))
            );
            const targetOption = availableOptions.find(o => o.text === 'Cloudflare Turnstile');
            if (!targetOption) throw new Error('Option Turnstile introuvable');
            await page.select(selectSelector, targetOption.value);
            console.log('✅ Turnstile sélectionné');
            await delay(5000);

            const claimCoords = await page.evaluate(() => {
                const btn = document.querySelector('#process_claim_hourly_faucet');
                if (!btn) return null;
                const rect = btn.getBoundingClientRect();
                return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            });
            if (!claimCoords) throw new Error('Bouton Claim introuvable');

            await humanClickAt(page, { x: claimCoords.x, y: claimCoords.y - 70 });
            console.log('⏳ Attente du token Turnstile...');
            await delay(3000);

            const tokenStart = Date.now();
            let tokenFound = false;
            while (Date.now() - tokenStart < 30000) {
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
            if (!tokenFound) throw new Error('Token Turnstile non apparu');

            // Clic Claim + détection améliorée du succès
            await humanClickAt(page, claimCoords);
            console.log('🖱️ Clic sur le bouton Claim effectué');

            const claimResult = await Promise.race([
                page.waitForFunction(() => {
                    const btn = document.querySelector('#process_claim_hourly_faucet');
                    return btn && btn.disabled;
                }, { timeout: 20000 }),
                page.waitForFunction(() => {
                    const messages = document.querySelectorAll('.alert-success, .success, [class*="success"]');
                    for (const msg of messages) {
                        if (msg.textContent.trim().length > 0) return true;
                    }
                    return false;
                }, { timeout: 20000 })
            ]).catch(() => 'timeout');

            await page.waitForNetworkIdle({ timeout: 10000 }).catch(() => {});
            await delay(3000);

            let success = false;
            if (claimResult !== 'timeout') {
                success = true;
                console.log('✅ Succès détecté (bouton désactivé ou message)');
            } else {
                const btnDisabledNow = await page.evaluate(() => {
                    const btn = document.querySelector('#process_claim_hourly_faucet');
                    return btn ? btn.disabled : false;
                });
                success = btnDisabledNow;
                if (success) console.log('✅ Succès détecté après délai');
                else console.log('⚠️ Statut incertain après délai');
            }

            account.lastClaim = Date.now();
            if (!success) {
                const timerVal = await extractTimer(page);
                if (timerVal) account.timer = timerVal;
            }
            await saveAccount(account);
            return { success, message: success ? 'Claim OK' : 'Statut incertain' };

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
        console.log(`📋 Compte chargé : ${account.email} (${account.platform})`);

        const result = await claimWithCookies(account);

        console.log(`🏁 Terminé. Succès: ${result.success} - ${result.message}`);
        process.exit(0);
    } catch (err) {
        console.error('❌ Erreur fatale :', err.message);
        process.exit(1);
    }
})();
