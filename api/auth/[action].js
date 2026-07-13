// api/auth/[action].js — 인증 엔드포인트 통합 (Vercel Hobby 함수 개수 제한 대응)
// /api/auth/login | callback | logout | me | meta-login | meta-callback | meta-logout
// 기존 개별 파일 7개를 동적 라우트 1개로 통합했으며 URL은 동일하게 유지됩니다.

const crypto = require('crypto');
const {
  isOAuthConfigured,
  isMetaOAuthConfigured,
  setOAuthState,
  getOAuthState,
  clearOAuthState,
  setMetaOAuthState,
  getMetaOAuthState,
  clearMetaOAuthState,
  setSession,
  updateSession,
  clearSession,
  publicAuthState,
  getMetaRedirectUri,
} = require('../_session');
const { getAuthUrl, exchangeCode } = require('../_oauth');

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0';
const META_SCOPES = 'public_profile,ads_read';

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

// ---------- Google ----------

async function login(req, res) {
  if (!isOAuthConfigured()) {
    return res.status(503).json({ error: 'OAuth가 설정되지 않았습니다.' });
  }
  const state = crypto.randomBytes(16).toString('hex');
  setOAuthState(res, state);
  redirect(res, getAuthUrl(req, state));
}

async function callback(req, res) {
  try {
    if (!isOAuthConfigured()) {
      return redirect(res, '/?auth_error=oauth_not_configured');
    }
    const { code, state, error } = req.query || {};
    if (error) return redirect(res, `/?auth_error=${encodeURIComponent(error)}`);
    if (!code || !state) return redirect(res, '/?auth_error=missing_code');
    if (state !== getOAuthState(req)) return redirect(res, '/?auth_error=invalid_state');

    clearOAuthState(res);
    const tokens = await exchangeCode(req, code);
    // 기존 세션(Meta 로그인 등)을 유지한 채 Google 필드 병합
    updateSession(req, res, {
      ...tokens,
      propertyId: null,
      propertyName: null,
    });
    redirect(res, '/?auth=success');
  } catch (err) {
    console.error('[api/auth/callback]', err);
    redirect(res, `/?auth_error=${encodeURIComponent(err.message || 'callback_failed')}`);
  }
}

async function logout(req, res) {
  clearSession(res);
  if (req.method === 'GET') return redirect(res, '/');
  res.status(200).json({ ok: true });
}

async function me(req, res) {
  res.status(200).json(publicAuthState(req));
}

// ---------- Meta ----------

async function metaLogin(req, res) {
  if (!isMetaOAuthConfigured()) {
    return res.status(503).json({ error: 'Meta OAuth가 설정되지 않았습니다. (META_APP_ID, META_APP_SECRET)' });
  }
  const state = crypto.randomBytes(16).toString('hex');
  setMetaOAuthState(res, state);

  const url = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
  url.searchParams.set('client_id', process.env.META_APP_ID);
  url.searchParams.set('redirect_uri', getMetaRedirectUri(req));
  url.searchParams.set('state', state);
  url.searchParams.set('scope', META_SCOPES);
  url.searchParams.set('response_type', 'code');
  redirect(res, url.toString());
}

async function metaCallback(req, res) {
  try {
    if (!isMetaOAuthConfigured()) {
      return redirect(res, '/meta.html?meta_auth_error=oauth_not_configured');
    }
    const { code, state, error, error_description } = req.query || {};
    if (error) {
      return redirect(res, `/meta.html?meta_auth_error=${encodeURIComponent(error_description || error)}`);
    }
    if (!code || !state) return redirect(res, '/meta.html?meta_auth_error=missing_code');
    if (state !== getMetaOAuthState(req)) return redirect(res, '/meta.html?meta_auth_error=invalid_state');
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
    const profile = await graphGet('me', { fields: 'id,name', access_token: accessToken });

    // 4. 기존 세션(Google 로그인 등)을 유지한 채 Meta 필드만 병합
    updateSession(req, res, {
      metaAccessToken: accessToken,
      metaUserId: profile.id,
      metaName: profile.name || null,
      metaTokenExpiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null,
    });
    redirect(res, '/meta.html?meta_auth=success');
  } catch (err) {
    console.error('[api/auth/meta-callback]', err);
    redirect(res, `/meta.html?meta_auth_error=${encodeURIComponent(err.message || 'callback_failed')}`);
  }
}

async function metaLogout(req, res) {
  updateSession(req, res, {
    metaAccessToken: undefined,
    metaUserId: undefined,
    metaName: undefined,
    metaTokenExpiresAt: undefined,
  });
  if (req.method === 'GET') return redirect(res, '/meta.html');
  res.status(200).json({ ok: true });
}

// ---------- 디스패치 ----------

const HANDLERS = {
  login,
  callback,
  logout,
  me,
  'meta-login': metaLogin,
  'meta-callback': metaCallback,
  'meta-logout': metaLogout,
};

module.exports = async (req, res) => {
  const handler = HANDLERS[req.query?.action];
  if (!handler) {
    return res.status(404).json({ error: '알 수 없는 인증 경로입니다.' });
  }
  return handler(req, res);
};
