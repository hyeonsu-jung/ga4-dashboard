// api/auth/meta-logout.js — Meta 로그아웃 (Google 세션은 유지)
const { updateSession } = require('../_session');

module.exports = async (req, res) => {
  updateSession(req, res, {
    metaAccessToken: undefined,
    metaUserId: undefined,
    metaName: undefined,
    metaTokenExpiresAt: undefined,
  });
  if (req.method === 'GET') {
    res.writeHead(302, { Location: '/meta.html' });
    res.end();
    return;
  }
  res.status(200).json({ ok: true });
};
