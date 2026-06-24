const { connect } = require('puppeteer-real-browser');
const { Octokit } = require('@octokit/rest');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
try { require('dotenv').config(); } catch (e) {}

// ---------- Variables d'environnement ----------
const email = process.env.TEST_EMAIL;
const password = process.env.TEST_PASSWORD;
const platform = process.env.TEST_PLATFORM;
const proxyIndex = process.env.TEST_PROXY_INDEX !== '' ? parseInt(process.env.TEST_PROXY_INDEX) : 0;
const initialTimerStr = process.env.TEST_INITIAL_TIMER || '60:00';
const GH_TOKEN = process.env.GH_TOKEN;
const GH_USERNAME = process.env.GH_USERNAME;
const GH_REPO = process.env.GH_REPO;
const GH_BRANCH = process.env.GH_BRANCH || 'main';
const USER_ID = process.env.USER_ID;
const CRYPTO_SECRET = process.env.CRYPTO_SECRET;

if (!CRYPTO_SECRET) {
    console.error('❌ CRYPTO_SECRET est obligatoire');
    process.exit(1);
}

const USER_FILE = USER_ID
    ? `account_${USER_ID}_${platform}_${email}.json`
    : `account_${email}_${platform}.json`;

const GLOBAL_FILE = 'global_accounts.json';

const JP_PROXY_LIST = (process.env.JP_PROXY_LIST || '').split(',').filter(p => p.trim() !== '');
if (JP_PROXY_LIST.length === 0) {
    console.error('❌ JP_PROXY_LIST doit contenir au moins 1 proxy');
    process.exit(1);
}

const videosDir = path.join(__dirname, 'videos');
if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir, { recursive: true });

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = (min, max) => delay(Math.floor(Math.random() * (max - min + 1) + min));

// --- Chiffrement / Déchiffrement (avec CRYPTO_SECRET) ---
const ALGORITHM = 'aes-256-cbc';

function encrypt(text) {
    const key = crypto.scryptSync(CRYPTO_SECRET, 'salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decrypt(encryptedText) {
    const key = crypto.scryptSync(CRYPTO_SECRET, 'salt', 32);
    const parts = encryptedText.split(':');
    const iv = Buffer.from(parts.shift(), 'hex');
    const encrypted = parts.join(':');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

// --------------------------

function parseProxyUrl(proxyUrl) {
    if (!proxyUrl) return null;
    proxyUrl = proxyUrl.trim();
    const isSocks = proxyUrl.startsWith('socks5://') || proxyUrl.startsWith('socks://');
    const protocol = isSocks ? 'socks5' : 'http';
    const match = proxyUrl.match(/^(socks5?:\/\/)?(?:([^:]+):([^@]+)@)?([^:]+):(\d+)$/);
    if (!match) { console.error('❌ Format HTTP invalide'); return null; }
    return {
        server: `${protocol}://${match[4]}:${match[5]}`,
        username: match[2] || null,
        password: match[3] || null
    };
}

function timeStrToMinutes(str) {
    if (!str || !str.includes(':')) return 60;
    const parts = str.split(':');
    const mins = parseInt(parts[0]) || 0;
    const secs = parseInt(parts[1]) || 0;
    return mins + secs / 60;
}

// --- Remplissage humain ---
async function fillFieldHuman(page, selector, value, fieldName) {
    console.log(`⌨️ Remplissage humain de ${fieldName}...`);
    await page.waitForSelector(selector, { visible: true, timeout: 15000 });
    await page.click(selector, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await randomDelay(100, 200);
    for (const char of value) {
        await page.keyboard.type(char, { delay: Math.floor(Math.random() * 70) + 30 });
    }
    await randomDelay(200, 500);
    let actual = await page.$eval(selector, el => el.value);
    if (actual !== value) {
        console.warn(`⚠️ Correction du champ ${fieldName}, nouvelle tentative`);
        await page.click(selector, { clickCount: 3 });
        await page.keyboard.press('Backspace');
        for (const char of value) await page.keyboard.type(char, { delay: Math.floor(Math.random() * 50) + 40 });
    }
}

// --- Point rouge ---
async function addRedDot(page, x, y) {
    await page.evaluate((x, y) => {
        const dot = document.createElement('div');
        dot.style.position = 'fixed';
        dot.style.left = (x - 5) + 'px';
        dot.style.top = (y - 5) + 'px';
        dot.style.width = '10px';
        dot.style.height = '10px';
        dot.style.borderRadius = '50%';
        dot.style.backgroundColor = 'red';
        dot.style.zIndex = '99999';
        dot.style.pointerEvents = 'none';
        dot.id = 'click-dot';
        document.body.appendChild(dot);
        setTimeout(() => dot.remove(), 5000);
    }, x, y);
}

// --- Clic humain avec trajectoire courbe ---
async function humanClickAt(page, coords) {
    await addRedDot(page, coords.x, coords.y);
    await randomDelay(150, 300);
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
    console.log(`🖱️ Clic à (${coords.x}, ${coords.y})`);
}

// --- Connexion proxy ---
async function connectWithProxy(proxyUrl) {
    const proxyConfig = parseProxyUrl(proxyUrl);
    if (!proxyConfig) throw new Error('Proxy invalide');
    console.log(`🔄 Connexion avec proxy : ${proxyConfig.server}`);
    const options = {
        headless: false,
        turnstile: true,
        proxy: proxyConfig,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    };
    const { browser, page } = await connect(options);
    return { browser, page };
}

// --- Sauvegarde individuelle avec chiffrement + retry SHA ---
async function saveAccount(accountData) {
    const octokit = new Octokit({ auth: GH_TOKEN });
    const secureAccount = {
        ...accountData,
        password: encrypt(accountData.password),
        cookies: encrypt(JSON.stringify(accountData.cookies))
    };

    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            let sha = null;
            try {
                const res = await octokit.repos.getContent({
                    owner: GH_USERNAME, repo: GH_REPO, path: USER_FILE, ref: GH_BRANCH
                });
                sha = res.data.sha;
            } catch (e) {}

            const content = Buffer.from(JSON.stringify(secureAccount, null, 2)).toString('base64');
            await octokit.repos.createOrUpdateFileContents({
                owner: GH_USERNAME,
                repo: GH_REPO,
                path: USER_FILE,
                message: `Mise à jour du compte ${email}`,
                content,
                branch: GH_BRANCH,
                sha
            });
            console.log(`💾 Compte individuel sauvegardé (chiffré) dans ${USER_FILE}`);
            return;
        } catch (err) {
            if (err.status === 409 && attempt < maxRetries) {
                console.warn(`⚠️ Conflit de version sur ${USER_FILE}, tentative ${attempt}/${maxRetries}...`);
                await delay(1000 * attempt);
            } else {
                throw err;
            }
        }
    }
}

// --- Mise à jour du fichier global (pas de données sensibles) ---
async function updateGlobalAccounts(newEntry) {
    const octokit = new Octokit({ auth: GH_TOKEN });
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            let sha = null;
            let currentAccounts = [];
            try {
                const res = await octokit.repos.getContent({
                    owner: GH_USERNAME, repo: GH_REPO, path: GLOBAL_FILE, ref: GH_BRANCH
                });
                sha = res.data.sha;
                const content = Buffer.from(res.data.content, 'base64').toString('utf-8');
                currentAccounts = JSON.parse(content);
            } catch (e) {}

            const index = currentAccounts.findIndex(acc => acc.email === newEntry.email && acc.platform === newEntry.platform);
            if (index !== -1) {
                currentAccounts[index].lastLogin = newEntry.addedAt;
                console.log(`🔄 Compte déjà présent dans ${GLOBAL_FILE}, mise à jour du timestamp.`);
            } else {
                currentAccounts.push(newEntry);
                console.log(`🌍 Compte ajouté à ${GLOBAL_FILE} : ${newEntry.email} (${newEntry.platform})`);
            }

            const content = Buffer.from(JSON.stringify(currentAccounts, null, 2)).toString('base64');
            await octokit.repos.createOrUpdateFileContents({
                owner: GH_USERNAME,
                repo: GH_REPO,
                path: GLOBAL_FILE,
                message: `Mise à jour de ${newEntry.email}`,
                content,
                branch: GH_BRANCH,
                sha
            });
            return;
        } catch (err) {
            if (err.status === 409 && attempt < maxRetries) {
                console.warn(`⚠️ Conflit de version sur ${GLOBAL_FILE}, tentative ${attempt}/${maxRetries}...`);
                await delay(1000 * attempt);
            } else {
                throw err;
            }
        }
    }
}

// --- Récupération des coordonnées du bouton "Log in" ---
async function getLoginButtonCoords(page) {
    return await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        const loginBtn = btns.find(b => b.textContent.trim() === 'Log in');
        if (!loginBtn) return null;
        const rect = loginBtn.getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    });
}

// --- Vérification résolution Turnstile ---
async function waitForTurnstileToBeSolved(page, timeout = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const isSolved = await page.evaluate(() => {
            const frames = document.querySelectorAll('iframe[src*="turnstile"]');
            for (const frame of frames) {
                try {
                    const doc = frame.contentDocument || frame.contentWindow.document;
                    const checkbox = doc.querySelector('input[type="checkbox"]');
                    if (checkbox && checkbox.checked) return true;
                } catch (e) {}
            }
            const tokenInput = document.querySelector('input[name="cf-turnstile-response"]');
            if (tokenInput && tokenInput.value.length > 0) return true;
            return false;
        });
        if (isSolved) {
            console.log('✅ Turnstile résolu');
            return true;
        }
        await delay(1000);
    }
    return false;
}

// --- Vérification succès connexion ---
async function checkLoginSuccess(page) {
    return await page.evaluate(() => {
        if (window.location.href.includes('login.php')) return false;
        const errorSelectors = ['.alert-danger', '.error', '[class*="error"]'];
        for (const sel of errorSelectors) {
            const el = document.querySelector(sel);
            if (el && el.textContent.trim().length > 0) return false;
        }
        const positiveTexts = ['Dashboard', 'Logout', 'Log out', 'My account', 'Account'];
        for (const txt of positiveTexts) {
            if (document.body.innerText.includes(txt)) return true;
        }
        return true;
    });
}

// --- Capture vidéo ---
function startFFmpeg(videoPath) {
    const display = process.env.DISPLAY || ':99';
    const args = [
        '-f', 'x11grab',
        '-video_size', '1280x720',
        '-i', display,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '0',
        '-pix_fmt', 'yuv420p',
        '-y',
        videoPath
    ];
    const ffmpeg = spawn('ffmpeg', args, { stdio: 'inherit' });
    console.log(`🎥 FFmpeg démarré sur ${display}, vidéo → ${videoPath}`);
    return ffmpeg;
}

function stopFFmpeg(ffmpeg) {
    return new Promise((resolve) => {
        ffmpeg.on('close', resolve);
        ffmpeg.kill('SIGINT');
    });
}

// --- Séquence de login ---
async function performLoginWithCaptcha(page, email, password) {
    await fillFieldHuman(page, 'input[type="email"], input[name="email"]', email, 'email');
    await fillFieldHuman(page, 'input[type="password"]', password, 'password');
    await randomDelay(500, 1000);

    console.log('📜 Scroll jusqu’au bouton Log in...');
    await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        const loginBtn = btns.find(b => b.textContent.trim() === 'Log in');
        if (loginBtn) loginBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    await delay(3000);

    console.log('🔍 Sélection du type de captcha...');
    const selectSelector = 'select';
    await page.waitForSelector(selectSelector, { visible: true, timeout: 10000 });
    const availableOptions = await page.$$eval(`${selectSelector} option`, opts =>
        opts.map(o => ({ text: o.textContent.trim(), value: o.value }))
    );
    const targetOptionText = 'Cloudflare Turnstile';
    const target = availableOptions.find(o => o.text === targetOptionText);
    if (!target) throw new Error(`Option "${targetOptionText}" introuvable`);
    await page.select(selectSelector, target.value);
    console.log(`✅ Option "${targetOptionText}" sélectionnée`);
    await delay(6000);

    let loginCoords = await getLoginButtonCoords(page);
    if (!loginCoords) {
        console.warn('⚠️ Bouton Log in non trouvé, fallback (640,615)');
        loginCoords = { x: 640, y: 615 };
    }
    const verifyCoords = { x: loginCoords.x, y: loginCoords.y - 70 };
    console.log(`📍 Bouton Log in à (${loginCoords.x}, ${loginCoords.y})`);

    let solved = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
        console.log(`🖱️ Clic d'activation sur "Verify you are human" (tentative ${attempt}) à (${verifyCoords.x}, ${verifyCoords.y})`);
        await humanClickAt(page, verifyCoords);
        console.log(`⏳ Attente de la résolution automatique (max 30s)...`);
        if (await waitForTurnstileToBeSolved(page, 30000)) {
            solved = true;
            break;
        } else {
            console.warn(`⚠️ Délai expiré sans résolution, tentative suivante...`);
        }
    }
    if (!solved) throw new Error('❌ Impossible de résoudre le Turnstile après 2 tentatives.');

    // Ajout d'une pause de 3 secondes avant de cliquer sur Log in
    console.log('⏳ Pause de 3 secondes avant de cliquer sur le bouton Log in...');
    await delay(3000);

    console.log(`🖱️ Clic sur le bouton "Log in" à (${loginCoords.x}, ${loginCoords.y})`);
    await humanClickAt(page, loginCoords);
    await randomDelay(2000, 3000);

    try {
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 40000 });
    } catch (navError) {
        console.warn('⚠️ Navigation non détectée, vérification manuelle...');
        await delay(5000);
    }

    const success = await checkLoginSuccess(page);
    if (!success) {
        const errorMsg = await page.evaluate(() => {
            const el = document.querySelector('.alert-danger, .error');
            return el ? el.textContent.trim() : 'Aucun message explicite';
        });
        throw new Error(`Échec de connexion : ${errorMsg}`);
    }
    console.log('✅ Connexion réussie');
}

// --- Main ---
async function run() {
    const normalizedEmail = email.trim().toLowerCase();
    const videoPath = path.join(videosDir, `login_${normalizedEmail.replace(/[^a-zA-Z0-9]/g, '_')}.mp4`);
    let ffmpegProcess;
    let browser;

    try {
        const proxyUrl = JP_PROXY_LIST[proxyIndex] || JP_PROXY_LIST[0];
        if (!proxyUrl) throw new Error('Proxy indisponible');
        console.log(`🔄 Proxy utilisé : ${proxyUrl}`);

        const { browser: br, page } = await connectWithProxy(proxyUrl);
        browser = br;
        await page.setViewport({ width: 1280, height: 720 });

        ffmpegProcess = startFFmpeg(videoPath);
        await delay(1000);

        

        // Remplacer la ligne :
// const loginUrl = `https://${platform}.io/login.php`;

// Par ce bloc (juste avant la ligne `console.log('🌐 Connexion à ${loginUrl}');`) :

const loginUrls = {
    tronpick: 'https://tronpick.io/login.php',
    '1xbet': 'https://1x-bet.mobi/fr/virtualsports',
    litepick: 'https://litepick.io/login.php',
    dogepick: 'https://dogepick.io/login.php',
    solpick: 'https://solpick.io/login.php',
    bnbpick: 'https://bnbpick.io/login.php',
    tonpick: 'https://tonpick.game/login.php',   // ← spécifique
    suipick: 'https://suipick.io/login.php',
    polpick: 'https://polpick.io/login.php'
};
const loginUrl = loginUrls[platform] || `https://${platform}.io/login.php`;

        console.log(`🌐 Connexion à ${loginUrl}`);
        await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });

        await performLoginWithCaptcha(page, normalizedEmail, password);

        const cookies = await page.cookies();
        console.log(`🍪 Cookies récupérés : ${cookies.length}`);

        // Lire le solde après connexion
        let initialBalance = 0;
        try {
            initialBalance = await page.$eval('[class*="balance"]', el => parseFloat(el.textContent.replace(/[^0-9.]/g, '')));
        } catch (e) {
            try {
                await page.goto(`https://${platform}.io/faucet.php`, { waitUntil: 'networkidle2', timeout: 30000 });
                await delay(5000);
                initialBalance = await page.$eval('[class*="balance"]', el => parseFloat(el.textContent.replace(/[^0-9.]/g, '')));
            } catch (e2) {
                console.warn('⚠️ Impossible de lire le solde initial');
            }
        }

        await stopFFmpeg(ffmpegProcess);
        await browser.close();

        // Charger le compte existant (pour conserver createdAt, initialBalance, etc.)
        let existingAccount = null;
        try {
            if (USER_ID) {
                const existingRes = await octokit.repos.getContent({
                    owner: GH_USERNAME, repo: GH_REPO, path: USER_FILE, ref: GH_BRANCH
                });
                existingAccount = JSON.parse(Buffer.from(existingRes.data.content, 'base64').toString('utf8'));
            }
        } catch (e) {
            // Le fichier n'existe pas encore
        }

        const createdAt = existingAccount?.createdAt || Date.now();
        const savedInitialBalance = existingAccount?.initialBalance ?? initialBalance;
        const savedTotalClaims = existingAccount?.totalClaims ?? 0;

        const timerValue = timeStrToMinutes(initialTimerStr);
        const account = {
            email: normalizedEmail,
            password,
            platform,
            proxyIndex,
            enabled: true,
            cookies,
            cookiesStatus: 'valid',
            lastClaim: Date.now(),
            timer: timerValue,
            createdAt,
            initialBalance: savedInitialBalance,
            totalClaims: savedTotalClaims,
            finalBalance: initialBalance
        };

        await saveAccount(account);
        await updateGlobalAccounts({
            email: normalizedEmail,
            platform,
            addedAt: new Date().toISOString()
        });

        console.log('🎉 Script terminé avec succès.');
        process.exit(0);
    } catch (err) {
        console.error('❌ Erreur fatale :', err.message);
        if (ffmpegProcess) await stopFFmpeg(ffmpegProcess);
        if (browser) await browser.close();
        process.exit(1);
    }
}

run();
