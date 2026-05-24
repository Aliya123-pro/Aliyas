// api/data.js
export default async function handler(req, res) {
    const GH_TOKEN = process.env.GH_TOKEN;
    const GH_USERNAME = process.env.GH_USERNAME;
    const GH_REPO = process.env.GH_REPO;
    const GH_BRANCH = process.env.GH_BRANCH || 'main';

    const userId = req.query.userId;
    const platform = req.query.platform;
    const email = req.query.email;
    const ghPath = req.query.path;

    if (!ghPath) return res.status(400).json({ error: 'path manquant' });

    const isWorkflowDispatch = ghPath.includes('/actions/workflows/');
    const isListRequest = (req.method === 'GET' && ghPath === '/' && userId);
    const isFileAccess = userId && ghPath.includes(`/account_${userId}_`);

    let url;
    if (isWorkflowDispatch) {
        url = `https://api.github.com${ghPath}`;
    } else if (isListRequest) {
        url = `https://api.github.com/repos/${GH_USERNAME}/${GH_REPO}/contents/?ref=${GH_BRANCH}`;
    } else if (isFileAccess) {
        const fileName = ghPath.split('/').pop().split('?')[0];
        url = `https://api.github.com/repos/${GH_USERNAME}/${GH_REPO}/contents/${fileName}?ref=${GH_BRANCH}`;
    } else if (userId && platform && email) {
        const filePath = `account_${userId}_${platform}_${email}.json`;
        url = `https://api.github.com/repos/${GH_USERNAME}/${GH_REPO}/contents/${filePath}?ref=${GH_BRANCH}`;
    } else {
        return res.status(400).json({ error: 'Paramètres insuffisants' });
    }

    const options = {
        method: req.method,
        headers: {
            Authorization: `token ${GH_TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
        }
    };

    if (req.method === 'PUT' || req.method === 'POST') {
        options.body = JSON.stringify(req.body);
    }

    try {
        const response = await fetch(url, options);
        const status = response.status;
        if (status === 204) return res.status(204).end();

        if (isListRequest) {
            const files = await response.json();
            if (!response.ok) throw new Error(files.message || `HTTP ${status}`);
            const userFiles = files.filter(f => f.name.startsWith(`account_${userId}_`));
            return res.status(200).json(userFiles);
        } else {
            const data = await response.json();
            if (!response.ok) throw new Error(data.message || `HTTP ${status}`);
            return res.status(status).json(data);
        }
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
