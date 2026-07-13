// api/auth/meta-callback.js — Meta OAuth 콜백
// 단기 토큰 교환 → 장기 토큰(60일) 교환 → 프로필 조회 → 세션에 병합 저장
const {
  isMetaOAuthConfigured,
  getMetaOAuthState,
  clearMetaOAuthState,
  updateSession,
  getMetaRedirectUri,
} = require('../_session');

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0';

function redirect(res, path) {
  res.writeHead(302, { Location: path });
  res.end();
}

async function graphGet(path, params) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url);
  const data = await r.json();
  if (!r.ok || data.error) {
    throw new Error(data.error?.message || `Meta API HTTP ${r.status}`);
  }
  return data;
}

module.exports = async (req, res) => {
  try {
    if (!isMetaOAuthConfigured()) {
      return redirect(res, '/meta.html?meta_auth_error=oauth_not_configured');
    }

    const { code, state, error, error_description } = req.query || {};
    if (error) {
      return redirect(res, `/meta.html?meta_auth_error=${encodeURIComponent(error_description || error)}`);
    }
    if (!code || !state) {
      return redirect(res, '/meta.html?meta_auth_error=missing_code');
    }
    if (state !== getMetaOAuthState(req)) {
      return redirect(res, '/meta.html?meta_auth_error=invalid_state');
    }
    clearMetaOAuthState(res);

    // 1. 인가 코드 → 단기 사용자 토큰
    const short = await graphGet('oauth/access_token', {
      client_id: process.env.META_APP_ID,
      client_secret: process.env.META_APP_SECRET,
      redirect_uri: getMetaRedirectUri(req),
      code,
    });

    // 2. 단기 토큰 → 장기 토큰 (약 60일)
    const long = await graphGet('oauth/access_token', {
      grant_type: 'fb_exchange_token',
      client_id: process.env.META_APP_ID,
      client_secret: process.env.META_APP_SECRET,
      fb_exchange_token: short.access_token,
    });
    const accessToken = long.access_token || short.access_token;
    const expiresIn = Number(long.expires_in || short.expires_in || 0);

    // 3. 프로필
    const me = await graphGet('me', { fields: 'id,name', access_token: accessToken });

    // 4. 기존 세션(Google 로그인 등)을 유지한 채 Meta 필드만 병합
    updateSession(req, res, {
      metaAccessToken: accessToken,
      metaUserId: me.id,
      metaName: me.name || null,
      metaTokenExpiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null,
    });

    redirect(res, '/meta.html?meta_auth=success');
  } catch (err) {
    console.error('[api/auth/meta-callback]', err);
    redirect(res, `/meta.html?meta_auth_error=${encodeURIComponent(err.message || 'callback_failed')}`);
  }
};
