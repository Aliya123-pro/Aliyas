// api/check-account.js
export default async function handler(req, res) {
    const { email, platform } = req.query || {};
    if (!email || !platform) {
        return res.status(400).json({ error: 'email et platform requis' });
    }

    const GH_TOKEN = process.env.GH_TOKEN;
    const GH_USERNAME = process.env.GH_USERNAME;
    const GH_REPO = process.env.GH_REPO;
    const GH_BRANCH = process.env.GH_BRANCH || 'main';
    const GLOBAL_FILE = 'global_accounts.json';

    const url = `https://api.github.com/repos/${GH_USERNAME}/${GH_REPO}/contents/${GLOBAL_FILE}?ref=${GH_BRANCH}`;

    try {
        const response = await fetch(url, {
            headers: {
                Authorization: `token ${GH_TOKEN}`,
                Accept: 'application/vnd.github.v3+json'
            }
        });

        if (response.status === 404) {
            return res.status(200).json({ available: true });
        }

        if (!response.ok) {
            throw new Error(`GitHub API error: ${response.status}`);
        }

        const data = await response.json();
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        const entries = JSON.parse(content);

        const exists = entries.some(entry => entry.email === email && entry.platform === platform);
        return res.status(200).json({ available: !exists });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
}
