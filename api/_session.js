// api/_session.js — 서명된 세션 쿠키 (OAuth 토큰 + 선택된 GA4 속성)

const crypto = require('crypto');

const SESSION_COOKIE = 'ga4_session';
const STATE_COOKIE = 'oauth_state';
const META_STATE_COOKIE = 'meta_oauth_state';
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30일

function sessionSecret() {
  return process.env.SESSION_SECRET || '';
}

function isOAuthConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      sessionSecret()
  );
}

function isMetaOAuthConfigured() {
  return Boolean(
    process.env.META_APP_ID &&
      process.env.META_APP_SECRET &&
      sessionSecret()
  );
}

function getMetaRedirectUri(req) {
  if (process.env.META_REDIRECT_URI) return process.env.META_REDIRECT_URI;
  const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host;
  const proto = req?.headers?.['x-forwarded-proto'] || 'http';
  if (host) return `${proto}://${host}/api/auth/meta-callback`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}/api/auth/meta-callback`;
  return 'http://localhost:3000/api/auth/meta-callback';
}

function getRedirectUri(req) {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host;
  const proto = req?.headers?.['x-forwarded-proto'] || 'http';
  if (host) return `${proto}://${host}/api/auth/callback`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}/api/auth/callback`;
  return 'http://localhost:3000/api/auth/callback';
}

function parseCookies(req) {
  const header = req.headers?.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1);
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

function signPayload(data) {
  const secret = sessionSecret();
  if (!secret) throw new Error('SESSION_SECRET이 설정되지 않았습니다.');
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyPayload(token) {
  const secret = sessionSecret();
  if (!secret || !token) return null;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function appendCookie(res, cookieStr) {
  const prev = res.getHeader('Set-Cookie');
  const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  res.setHeader('Set-Cookie', [...list, cookieStr]);
}

function buildCookie(name, value, { maxAge, httpOnly = true, clear = false } = {}) {
  const parts = [`${name}=${clear ? '' : encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
  if (httpOnly) parts.push('HttpOnly');
  if (clear) {
    parts.push('Max-Age=0');
  } else if (maxAge != null) {
    parts.push(`Max-Age=${maxAge}`);
  }
  if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
    parts.push('Secure');
  }
  return parts.join('; ');
}

function getSession(req) {
  const cookies = parseCookies(req);
  return verifyPayload(cookies[SESSION_COOKIE]);
}

function setSession(res, session) {
  appendCookie(
    res,
    buildCookie(SESSION_COOKIE, signPayload(session), { maxAge: SESSION_MAX_AGE })
  );
}

function clearSession(res) {
  appendCookie(res, buildCookie(SESSION_COOKIE, '', { clear: true }));
}

function setOAuthState(res, state) {
  appendCookie(res, buildCookie(STATE_COOKIE, state, { maxAge: 600 }));
}

function getOAuthState(req) {
  return parseCookies(req)[STATE_COOKIE] || null;
}

function clearOAuthState(res) {
  appendCookie(res, buildCookie(STATE_COOKIE, '', { clear: true }));
}

function setMetaOAuthState(res, state) {
  appendCookie(res, buildCookie(META_STATE_COOKIE, state, { maxAge: 600 }));
}

function getMetaOAuthState(req) {
  return parseCookies(req)[META_STATE_COOKIE] || null;
}

function clearMetaOAuthState(res) {
  appendCookie(res, buildCookie(META_STATE_COOKIE, '', { clear: true }));
}

// 기존 세션(Google 토큰 등)을 유지한 채 일부 필드만 갱신
function updateSession(req, res, patch) {
  const current = getSession(req) || {};
  const next = { ...current, ...patch };
  for (const key of Object.keys(next)) {
    if (next[key] === undefined) delete next[key];
  }
  setSession(res, next);
  return next;
}

// 유효한(만료 전) Meta 사용자 토큰
function getMetaUserToken(req) {
  const session = getSession(req);
  if (!session?.metaAccessToken) return null;
  if (session.metaTokenExpiresAt && session.metaTokenExpiresAt <= Date.now()) return null;
  return session.metaAccessToken;
}

function publicAuthState(req) {
  const session = getSession(req);
  return {
    oauthConfigured: isOAuthConfigured(),
    loggedIn: Boolean(session?.accessToken),
    email: session?.email || null,
    name: session?.name || null,
    propertyId: session?.propertyId || null,
    propertyName: session?.propertyName || null,
    metaOauthConfigured: isMetaOAuthConfigured(),
    metaLoggedIn: Boolean(getMetaUserToken(req)),
    metaName: session?.metaName || null,
  };
}

module.exports = {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  isOAuthConfigured,
  isMetaOAuthConfigured,
  getRedirectUri,
  getMetaRedirectUri,
  parseCookies,
  getSession,
  setSession,
  updateSession,
  clearSession,
  setOAuthState,
  getOAuthState,
  clearOAuthState,
  setMetaOAuthState,
  getMetaOAuthState,
  clearMetaOAuthState,
  getMetaUserToken,
  publicAuthState,
};
