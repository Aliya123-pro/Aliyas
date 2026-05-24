// api/history.js
export default async function handler(req, res) {
    const GH_TOKEN = process.env.GH_TOKEN;
    const GH_USERNAME = process.env.GH_USERNAME;
    const GH_REPO = process.env.GH_REPO;
    const GH_BRANCH = process.env.GH_BRANCH || 'main';
    const userId = req.query.userId;
    const periodStart = req.query.periodStart ? parseInt(req.query.periodStart) : null; // optionnel

    if (!userId) return res.status(400).json({ error: 'userId manquant' });

    const historyFile = `history_${userId}.json`;
    const url = `https://api.github.com/repos/${GH_USERNAME}/${GH_REPO}/contents/${historyFile}?ref=${GH_BRANCH}`;

    try {
        const response = await fetch(url, {
            headers: {
                Authorization: `token ${GH_TOKEN}`,
                Accept: 'application/vnd.github.v3+json'
            }
        });

        if (response.status === 404) {
            return res.status(200).json({ entries: [], totalSuccess: 0, totalBonus: 0, periodStart: periodStart });
        }
        if (!response.ok) throw new Error(`Erreur API GitHub : ${response.status}`);

        const data = await response.json();
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        const history = JSON.parse(content);

        let filtered;
        if (periodStart) {
            // Filtrer entre periodStart et periodStart + 24h
            const periodEnd = periodStart + 24 * 60 * 60 * 1000;
            filtered = history.filter(entry => entry.timestamp >= periodStart && entry.timestamp <= periodEnd);
        } else {
            // Comportement par défaut : fenêtre glissante de 24h
            const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
            filtered = history.filter(entry => entry.timestamp >= twentyFourHoursAgo);
        }

        const totalSuccess = filtered.filter(e => e.success).length;
        const totalBonus = filtered.reduce((sum, e) => sum + (e.bonus || 0), 0);

        return res.status(200).json({ entries: filtered, totalSuccess, totalBonus, periodStart });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
