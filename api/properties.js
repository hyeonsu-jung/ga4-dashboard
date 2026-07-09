// api/properties.js — 로그인한 사용자의 GA4 속성 목록
const { getAuthenticatedClient, listGa4Properties } = require('./_oauth');
const { isOAuthConfigured } = require('./_session');

module.exports = async (req, res) => {
  try {
    if (!isOAuthConfigured()) {
      return res.status(503).json({ error: 'OAuth가 설정되지 않았습니다.' });
    }

    const auth = await getAuthenticatedClient(req, res);
    if (!auth) {
      return res.status(401).json({ error: 'LOGIN_REQUIRED' });
    }

    const properties = await listGa4Properties(auth.session.accessToken);
    res.status(200).json({ properties });
  } catch (err) {
    console.error('[api/properties]', err);
    const detail = String(err.message || err);
    if (detail.includes('insufficient authentication scopes')) {
      return res.status(403).json({
        error: 'INSUFFICIENT_SCOPES',
        message: 'Google Analytics 접근 권한(스코프)이 부족합니다. 로그아웃 후 다시 로그인해 주세요.',
        detail,
      });
    }
    res.status(500).json({ error: 'GA4 속성 목록 조회에 실패했습니다.', detail });
  }
};
