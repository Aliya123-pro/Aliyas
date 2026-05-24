// api/config.js
export default function handler(req, res) {
    res.status(200).json({
        supabaseUrl: process.env.SUPABASE_URL,
        supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
        ghUsername: process.env.GH_USERNAME,
        ghRepo: process.env.GH_REPO,
        ghBranch: process.env.GH_BRANCH || 'main'
    });
}
