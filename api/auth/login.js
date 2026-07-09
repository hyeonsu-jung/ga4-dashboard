// api/auth/login.js — Google OAuth 로그인 시작
const crypto = require('crypto');
const { isOAuthConfigured, setOAuthState } = require('../_session');
const { getAuthUrl } = require('../_oauth');

module.exports = async (req, res) => {
  if (!isOAuthConfigured()) {
    return res.status(503).json({ error: 'OAuth가 설정되지 않았습니다.' });
  }

  const state = crypto.randomBytes(16).toString('hex');
  setOAuthState(res, state);
  res.writeHead(302, { Location: getAuthUrl(req, state) });
  res.end();
};
