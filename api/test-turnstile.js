const puppeteer = require('puppeteer-core');

const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;

// ⏱ SAFE delay
const delay = (min, max) =>
    new Promise(res => setTimeout(res, Math.random() * (max - min) + min));

// 🧠 SAFE wrapper (anti crash global)
async function safe(fn, fallback = null) {
    try {
        return await fn();
    } catch (e) {
        console.log("⚠️ Safe error:", e.message);
        return fallback;
    }
}

// 📸 SAFE screenshot
async function screenshot(page, label, screenshots) {
    return safe(async () => {
        if (!page || page.isClosed()) return;
        screenshots.push({
            label,
            base64: await page.screenshot({ encoding: 'base64', fullPage: false })
        });
    });
}

// 🎯 Turnstile check
async function isSolved(page) {
    return safe(async () => {
        return await page.evaluate(() => {
            const el = document.querySelector('[name="cf-turnstile-response"]');
            return el && el.value && el.value.length > 0;
        }, false);
    }, false);
}

// 🖱 Click safe iframe
async function clickTurnstile(page) {
    const frames = page.frames();

    const frame = frames.find(f =>
        f.url().includes("challenges.cloudflare.com")
    );

    if (!frame) throw new Error("Iframe missing");

    const checkbox = await frame.waitForSelector('input[type="checkbox"]', {
        timeout: 6000
    });

    const box = await checkbox.boundingBox();
    if (!box) throw new Error("No bounding box");

    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    await page.mouse.move(x, y, { steps: 8 });
    await delay(200, 600);

    await page.mouse.click(x, y);
}

export default async function handler(req, res) {
    let browser = null;
    const screenshots = [];

    // 🧯 GLOBAL TIMEOUT (Vercel safety)
    const timeout = setTimeout(() => {
        console.log("⛔ GLOBAL TIMEOUT");
        if (browser) browser.close().catch(() => {});
    }, 25000); // 25s max

    try {
        if (!BROWSERLESS_TOKEN) {
            return res.status(500).json({ error: "Missing token" });
        }

        browser = await puppeteer.connect({
            browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_TOKEN}`
        });

        const page = await browser.newPage();

        // ⏱ STRICT limits
        await page.setDefaultNavigationTimeout(15000);
        await page.setDefaultTimeout(15000);

        await page.setViewport({ width: 1280, height: 720 });

        await safe(() =>
            page.goto("https://tronpick.io/login.php", {
                waitUntil: "domcontentloaded",
                timeout: 15000
            })
        );

        await screenshot(page, "01_loaded", screenshots);

        let solved = false;

        // 🔁 MAX 3 tries (anti freeze)
        for (let i = 0; i < 3; i++) {
            console.log("🔁 Try", i + 1);

            await delay(1500, 4000);

            await safe(() => clickTurnstile(page));

            await delay(2000, 4000);

            await screenshot(page, `try_${i + 1}`, screenshots);

            solved = await isSolved(page);

            if (solved) break;
        }

        clearTimeout(timeout);

        return res.status(200).json({
            success: solved,
            screenshots
        });

    } catch (error) {
        console.error("❌ CRASH PROTECTED:", error.message);

        clearTimeout(timeout);

        return res.status(200).json({
            success: false,
            error: error.message,
            screenshots
        });

    } finally {
        // 🧯 ALWAYS CLOSE CLEANLY
        if (browser) {
            await browser.close().catch(() => {});
        }
    }
}
