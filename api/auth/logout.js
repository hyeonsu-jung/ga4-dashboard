// api/auth/logout.js — 로그아웃
const { clearSession } = require('../_session');

module.exports = async (req, res) => {
  clearSession(res);
  if (req.method === 'GET') {
    res.writeHead(302, { Location: '/' });
    res.end();
    return;
  }
  res.status(200).json({ ok: true });
};
