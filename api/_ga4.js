// api/_ga4.js — GA4 Data API 공용 모듈
// 인증: Google OAuth (세션 쿠키) — 사용자가 직접 GA4 속성 선택
// OAuth 미설정 시 데모 데이터 모드로 동작합니다.

const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const { isOAuthConfigured, getSession } = require('./_session');
const { getAuthenticatedClient } = require('./_oauth');

function hasSelectedProperty(req) {
  const session = getSession(req);
  return Boolean(session?.accessToken && session?.propertyId);
}

function isConfigured(req) {
  return isOAuthConfigured() && hasSelectedProperty(req);
}

async function getClient(req, res) {
  const auth = await getAuthenticatedClient(req, res);
  if (!auth) throw new Error('LOGIN_REQUIRED');
  return new BetaAnalyticsDataClient({ authClient: auth.client });
}

function getProperty(req) {
  const session = getSession(req);
  if (!session?.propertyId) throw new Error('PROPERTY_REQUIRED');
  return `properties/${session.propertyId}`;
}

function getPropertyMeta(req) {
  const session = getSession(req);
  return {
    propertyId: session?.propertyId || 'DEMO',
    propertyName: session?.propertyName || null,
  };
}

// ---------- 데모 데이터 (OAuth 미설정 또는 미로그인 시) ----------

function seededRandom(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function eachDate(startDate, endDate) {
  const out = [];
  const d = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function demoDaily(startDate, endDate) {
  return eachDate(startDate, endDate).map((date) => {
    const r = seededRandom(date);
    const dow = new Date(date + 'T00:00:00Z').getUTCDay();
    const weekendFactor = dow === 0 || dow === 6 ? 0.55 : 1;
    const users = Math.round((900 + r() * 500) * weekendFactor);
    const sessions = Math.round(users * (1.25 + r() * 0.2));
    const events = Math.round(sessions * (6 + r() * 3));
    const keyEvents = Math.round(sessions * (0.02 + r() * 0.015));
    return { date, activeUsers: users, sessions, eventCount: events, keyEvents };
  });
}

function sum(rows, key) {
  return rows.reduce((a, r) => a + r[key], 0);
}

function demoDashboard(startDate, endDate, prevStart, prevEnd) {
  const daily = demoDaily(startDate, endDate);
  const prevDaily = demoDaily(prevStart, prevEnd);
  const kpiFrom = (rows) => {
    const sessions = sum(rows, 'sessions');
    return {
      activeUsers: sum(rows, 'activeUsers'),
      newUsers: Math.round(sum(rows, 'activeUsers') * 0.42),
      sessions,
      eventCount: sum(rows, 'eventCount'),
      keyEvents: sum(rows, 'keyEvents'),
      engagementRate: 0.58 + seededRandom(rows[0]?.date || 'x')() * 0.1,
      avgEngagementSeconds: 95 + Math.round(seededRandom(rows.at(-1)?.date || 'y')() * 60),
    };
  };
  const r = seededRandom(startDate + endDate);
  const channels = ['Organic Search', 'Direct', 'Paid Search', 'Referral', 'Organic Social', 'Email']
    .map((ch) => {
      const sessions = Math.round(500 + r() * 6000);
      return {
        channel: ch,
        sessions,
        activeUsers: Math.round(sessions * 0.8),
        keyEvents: Math.round(sessions * (0.015 + r() * 0.02)),
      };
    })
    .sort((a, b) => b.sessions - a.sessions);
  const pages = ['/', '/products', '/pricing', '/blog/ga4-guide', '/contact', '/event/2026-summer', '/login', '/help']
    .map((p) => {
      const views = Math.round(300 + r() * 9000);
      return { pagePath: p, screenPageViews: views, activeUsers: Math.round(views * 0.6) };
    })
    .sort((a, b) => b.screenPageViews - a.screenPageViews);

  return {
    demo: true,
    propertyId: 'DEMO',
    propertyName: '데모 데이터',
    range: { startDate, endDate },
    compareRange: { startDate: prevStart, endDate: prevEnd },
    kpis: kpiFrom(daily),
    prevKpis: kpiFrom(prevDaily),
    daily,
    channels,
    pages,
  };
}

function authErrorResponse(res, code) {
  const messages = {
    LOGIN_REQUIRED: 'Google 계정으로 로그인해 주세요.',
    PROPERTY_REQUIRED: 'GA4 속성을 선택해 주세요.',
  };
  return res.status(401).json({ error: code, message: messages[code] || code });
}

module.exports = {
  isOAuthConfigured,
  hasSelectedProperty,
  isConfigured,
  getClient,
  getProperty,
  getPropertyMeta,
  demoDashboard,
  eachDate,
  authErrorResponse,
};
