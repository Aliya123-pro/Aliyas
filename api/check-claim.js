// api/check-claim.js – FICHIERS INDIVIDUELS + PAUSE DE 5 MIN
export default async function handler(req, res) {
    const SECRET = process.env.CRON_SECRET;
    const headerSecret = req.headers['x-cron-secret'];
    const querySecret = req.query.secret;
    if ((!headerSecret || headerSecret !== SECRET) && (!querySecret || querySecret !== SECRET)) {
        return res.status(403).json({ error: 'Accès refusé' });
    }

    const GH_TOKEN = process.env.GH_TOKEN;
    const GH_USERNAME = process.env.GH_USERNAME;
    const GH_REPO = process.env.GH_REPO;
    const GH_BRANCH = process.env.GH_BRANCH || 'main';
    const CLAIM_WORKFLOW_ID = 'claim.yml';

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        return res.status(500).json({ error: 'Configuration Supabase manquante' });
    }

    try {
        const profilesRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
            headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }
        });
        if (!profilesRes.ok) throw new Error('Erreur profils');
        const profiles = await profilesRes.json();

        const triggered = [];

        for (const profile of profiles) {
            const userId = profile.id;
            const listUrl = `https://api.github.com/repos/${GH_USERNAME}/${GH_REPO}/contents/?ref=${GH_BRANCH}`;
            const listRes = await fetch(listUrl, {
                headers: { Authorization: `token ${GH_TOKEN}`, Accept: 'application/vnd.github.v3+json' }
            });
            if (!listRes.ok) continue;
            const files = await listRes.json();
            const userFiles = files.filter(f => f.name.startsWith(`account_${userId}_`));

            for (const file of userFiles) {
                const fileUrl = file.url;
                const fileRes = await fetch(fileUrl, {
                    headers: { Authorization: `token ${GH_TOKEN}`, Accept: 'application/vnd.github.v3+json' }
                });
                if (!fileRes.ok) continue;
                const fileData = await fileRes.json();
                const content = decodeURIComponent(
                    Array.from(atob(fileData.content), c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
                );
                const account = JSON.parse(content);
                const now = Date.now();
                const EXPIRATION_MS = 5 * 60 * 1000;   // ← 5 minutes exactement

                // Nettoyage des flags expirés (plus de 5 min)
                if (account.pendingClaim === true && account.pendingClaimSince && (now - account.pendingClaimSince >= EXPIRATION_MS)) {
                    account.pendingClaim = false;
                    delete account.pendingClaimSince;
                }

                // Ignorer si le compte est en cours (flag actif depuis moins de 5 min)
                if (account.enabled === false) continue;
                if (account.pendingLogout === true) continue;
                if (account.pendingClaim === true) continue;
                const last = account.lastClaim || 0;
                const intervalMs = (account.timer || 60) * 60 * 1000;
                if ((now - last) < intervalMs) continue;

                // Poser le flag et sauvegarder
                account.pendingClaim = true;
                account.pendingClaimSince = now;
                await updateIndividualFile(file.name, account, GH_USERNAME, GH_REPO, GH_BRANCH, GH_TOKEN);

                // Déclencher le workflow
                const dispatchUrl = `https://api.github.com/repos/${GH_USERNAME}/${GH_REPO}/actions/workflows/${CLAIM_WORKFLOW_ID}/dispatches`;
                const dispatchRes = await fetch(dispatchUrl, {
                    method: 'POST',
                    headers: {
                        Authorization: `token ${GH_TOKEN}`,
                        Accept: 'application/vnd.github.v3+json',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        ref: GH_BRANCH,
                        inputs: {
                            email: account.email,
                            platform: account.platform,
                            userId: userId
                        }
                    })
                });

                if (dispatchRes.ok) {
                    triggered.push(`${account.email} (${account.platform})`);
                } else {
                    // Retirer le flag en cas d'échec
                    account.pendingClaim = false;
                    delete account.pendingClaimSince;
                    await updateIndividualFile(file.name, account, GH_USERNAME, GH_REPO, GH_BRANCH, GH_TOKEN);
                }
            }
        }

        return res.json({ status: 'ok', triggered: triggered.join(', ') });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
}

async function updateIndividualFile(fileName, data, owner, repo, branch, token) {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${fileName}?ref=${branch}`;
    const getRes = await fetch(url, {
        headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' }
    });
    if (!getRes.ok) return;
    const fileData = await getRes.json();
    const sha = fileData.sha;
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
    await fetch(url, {
        method: 'PUT',
        headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ message: 'Mise à jour compte individuel', content, branch, sha })
    });
}
