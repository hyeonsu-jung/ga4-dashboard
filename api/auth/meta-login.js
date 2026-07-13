// api/auth/meta-login.js — Meta(Facebook) OAuth 로그인 시작
const crypto = require('crypto');
const { isMetaOAuthConfigured, setMetaOAuthState, getMetaRedirectUri } = require('../_session');

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0';
const SCOPES = 'public_profile,ads_read';

module.exports = async (req, res) => {
  if (!isMetaOAuthConfigured()) {
    return res.status(503).json({ error: 'Meta OAuth가 설정되지 않았습니다. (META_APP_ID, META_APP_SECRET)' });
  }

  const state = crypto.randomBytes(16).toString('hex');
  setMetaOAuthState(res, state);

  const url = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
  url.searchParams.set('client_id', process.env.META_APP_ID);
  url.searchParams.set('redirect_uri', getMetaRedirectUri(req));
  url.searchParams.set('state', state);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('response_type', 'code');

  res.writeHead(302, { Location: url.toString() });
  res.end();
};
