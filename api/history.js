// api/history.js – Historique enrichi avec les soldes et le total des claims
export default async function handler(req, res) {
    const GH_TOKEN = process.env.GH_TOKEN;
    const GH_USERNAME = process.env.GH_USERNAME;
    const GH_REPO = process.env.GH_REPO;
    const GH_BRANCH = process.env.GH_BRANCH || 'main';
    const userId = req.query.userId;
    const periodStart = req.query.periodStart ? parseInt(req.query.periodStart) : null;

    if (!userId) {
        return res.status(400).json({ error: 'userId manquant' });
    }

    const historyFile = `history_${userId}.json`;
    const url = `https://api.github.com/repos/${GH_USERNAME}/${GH_REPO}/contents/${historyFile}?ref=${GH_BRANCH}`;

    try {
        // 1. Récupérer l'historique chronologique des claims
        let history = [];
        try {
            const response = await fetch(url, {
                headers: {
                    Authorization: `token ${GH_TOKEN}`,
                    Accept: 'application/vnd.github.v3+json'
                }
            });
            if (response.ok) {
                const data = await response.json();
                history = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
            }
        } catch (e) {
            // Pas encore d'historique, on continue avec un tableau vide
        }

        // 2. Filtrer par période
        let filtered;
        if (periodStart) {
            const periodEnd = periodStart + 24 * 60 * 60 * 1000;
            filtered = history.filter(entry => entry.timestamp >= periodStart && entry.timestamp <= periodEnd);
        } else {
            // Fenêtre glissante de 24h
            const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
            filtered = history.filter(entry => entry.timestamp >= twentyFourHoursAgo);
        }

        const totalSuccess = filtered.filter(e => e.success).length;
        const totalBonus = filtered.reduce((sum, e) => sum + (e.bonus || 0), 0);

        // 3. Récupérer les indicateurs globaux depuis le fichier de compte
        let initialBalance = 0;
        let totalClaims = 0;
        let finalBalance = 0;
        try {
            const listUrl = `https://api.github.com/repos/${GH_USERNAME}/${GH_REPO}/contents/?ref=${GH_BRANCH}`;
            const listRes = await fetch(listUrl, {
                headers: {
                    Authorization: `token ${GH_TOKEN}`,
                    Accept: 'application/vnd.github.v3+json'
                }
            });
            if (listRes.ok) {
                const files = await listRes.json();
                const accountFile = files.find(f => f.name.startsWith(`account_${userId}_`) && f.name.endsWith('.json'));
                if (accountFile) {
                    const fileRes = await fetch(accountFile.url, {
                        headers: {
                            Authorization: `token ${GH_TOKEN}`,
                            Accept: 'application/vnd.github.v3+json'
                        }
                    });
                    if (fileRes.ok) {
                        const fileData = await fileRes.json();
                        const account = JSON.parse(Buffer.from(fileData.content, 'base64').toString('utf8'));
                        initialBalance = account.initialBalance || 0;
                        totalClaims = account.totalClaims || 0;
                        finalBalance = account.finalBalance || 0;
                    }
                }
            }
        } catch (e) {
            // Aucun fichier de compte trouvé, les valeurs restent à 0
        }

        // 4. Réponse complète
        return res.status(200).json({
            entries: filtered,
            totalSuccess,
            totalBonus,
            periodStart,
            initialBalance,
            totalClaims,
            finalBalance
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
}
