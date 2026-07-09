// api/_oauth.js — Google OAuth2 클라이언트 및 Admin API 호출

const { OAuth2Client } = require('google-auth-library');
const { getRedirectUri, getSession, setSession } = require('./_session');

const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/analytics.readonly',
];

function createOAuth2Client(req) {
  return new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    getRedirectUri(req)
  );
}

function getAuthUrl(req, state) {
  const client = createOAuth2Client(req);
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
  });
}

async function exchangeCode(req, code) {
  const client = createOAuth2Client(req);
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expiry_date || Date.now() + 3600 * 1000,
    email: payload?.email || '',
    name: payload?.name || payload?.email || '',
  };
}

async function refreshSessionTokens(req, session) {
  if (!session.refreshToken) return session;
  if (session.expiresAt > Date.now() + 60_000) return session;

  const client = createOAuth2Client(req);
  client.setCredentials({
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
    expiry_date: session.expiresAt,
  });

  const { credentials } = await client.refreshAccessToken();
  return {
    ...session,
    accessToken: credentials.access_token,
    expiresAt: credentials.expiry_date || Date.now() + 3600 * 1000,
    refreshToken: credentials.refresh_token || session.refreshToken,
  };
}

async function getAuthenticatedClient(req, res) {
  let session = getSession(req);
  if (!session?.accessToken) return null;

  const refreshed = await refreshSessionTokens(req, session);
  if (refreshed.accessToken !== session.accessToken || refreshed.expiresAt !== session.expiresAt) {
    setSession(res, refreshed);
  }
  session = refreshed;

  const client = createOAuth2Client(req);
  client.setCredentials({
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
    expiry_date: session.expiresAt,
  });
  return { client, session };
}

async function listGa4Properties(accessToken) {
  const properties = [];
  let pageToken = '';

  do {
    const url = new URL('https://analyticsadmin.googleapis.com/v1beta/accountSummaries');
    url.searchParams.set('pageSize', '200');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await r.json();
    if (!r.ok) {
      const detail = data.error?.message || data.detail || '';
      if (detail.includes('insufficient authentication scopes')) {
        throw Object.assign(
          new Error('Google Analytics 접근 권한(스코프)이 부족합니다.'),
          { code: 'INSUFFICIENT_SCOPES', detail }
        );
      }
      throw new Error(detail || data.error || data.message || '목록 조회 실패');
    }

    for (const account of data.accountSummaries || []) {
      for (const prop of account.propertySummaries || []) {
        if (!prop.property) continue;
        const id = prop.property.replace('properties/', '');
        properties.push({
          propertyId: id,
          propertyName: prop.displayName || id,
          accountName: account.displayName || account.account || '',
        });
      }
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return properties.sort((a, b) => a.propertyName.localeCompare(b.propertyName, 'ko'));
}

module.exports = {
  SCOPES,
  createOAuth2Client,
  getAuthUrl,
  exchangeCode,
  getAuthenticatedClient,
  listGa4Properties,
};
