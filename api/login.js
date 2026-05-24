// api/login.js
const puppeteer = require('puppeteer-core');

const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
const PROXY_USERNAME = process.env.PROXY_USERNAME || '';
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || '';

const TURNSTILE_COORDS = { x: 640, y: 615 };

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

    if (!BROWSERLESS_TOKEN) return res.status(500).json({ error: 'BROWSERLESS_TOKEN manquant' });

    const { email, password, platform, proxy } = req.body;
    if (!email || !password || !platform) return res.status(400).json({ error: 'Champs manquants' });

    const siteUrls = {
        tronpick: 'https://tronpick.io/login.php',
        litepick: 'https://litepick.io/login.php',
        dogepick: 'https://dogepick.io/login.php',
        solpick: 'https://solpick.io/login.php',
        binpick: 'https://binpick.io/login.php'
    };
    const loginUrl = siteUrls[platform];
    if (!loginUrl) return res.status(400).json({ error: 'Plateforme inconnue' });

    let proxyAuth = null;
    if (proxy) {
        const parts = proxy.split(':');
        if (parts.length === 4) proxyAuth = { username: parts[2], password: parts[3] };
    } else if (PROXY_USERNAME) {
        proxyAuth = { username: PROXY_USERNAME, password: PROXY_PASSWORD };
    }

    let browser;
    try {
        // Connexion rapide
        browser = await puppeteer.connect({ browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_TOKEN}` });
        const page = await browser.newPage();
        if (proxyAuth) await page.authenticate(proxyAuth);
        await page.setViewport({ width: 1280, height: 720 });

        // Navigation avec 'commit' pour gagner du temps
        await page.goto(loginUrl, { waitUntil: 'commit', timeout: 10000 });

        // Remplissage ultra-rapide
        await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 3000 });
        await page.click('input[type="email"], input[name="email"]', { clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.type('input[type="email"], input[name="email"]', email, { delay: 5 });

        await page.waitForSelector('input[type="password"]', { timeout: 3000 });
        await page.click('input[type="password"]', { clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.type('input[type="password"]', password, { delay: 5 });

        // Scroll rapide (1s)
        await page.evaluate(() => window.scrollBy(0, 300));
        await delay(1000);

        // Double clic Turnstile avec 5s d'intervalle
        await page.mouse.click(TURNSTILE_COORDS.x, TURNSTILE_COORDS.y);
        await delay(5000);
        await page.mouse.click(TURNSTILE_COORDS.x, TURNSTILE_COORDS.y);
        await delay(5000);

        // Clic sur "Log in"
        const loginBtn = await page.waitForXPath("//button[contains(text(), 'Log in')]", { timeout: 3000 });
        await loginBtn.click();

        await page.waitForNavigation({ waitUntil: 'commit', timeout: 8000 }).catch(() => {});
        await delay(1000);

        const currentUrl = page.url();
        if (currentUrl.includes('login.php')) {
            const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true });
            const errorMsg = await page.evaluate(() => {
                const el = document.querySelector('.alert-danger, .error');
                return el ? el.textContent.trim() : null;
            });
            throw Object.assign(new Error(errorMsg || 'Échec connexion'), { screenshot });
        }

        const cookies = await page.cookies();
        await browser.close();
        res.status(200).json({ success: true, cookies });

    } catch (error) {
        console.error('❌ Erreur:', error);
        if (browser) {
            try {
                const pages = await browser.pages();
                if (pages.length > 0 && !error.screenshot) {
                    error.screenshot = await pages[0].screenshot({ encoding: 'base64', fullPage: true });
                }
            } catch (e) {}
            await browser.close();
        }
        res.status(500).json({ error: error.message, screenshot: error.screenshot });
    }
}
