// api/_ga4.js — GA4 Data API 공용 모듈
// 인증: GOOGLE_SERVICE_ACCOUNT_KEY 환경변수 (서비스 계정 JSON 원문 또는 base64)
// 속성: GA4_PROPERTY_ID 환경변수 (예: 503025816)
// 환경변수가 없으면 데모 데이터 모드로 동작합니다.

const { BetaAnalyticsDataClient } = require('@google-analytics/data');

let _client = null;

function getCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) return null;
  try {
    // JSON 원문 시도
    return JSON.parse(raw);
  } catch (e) {
    // base64 시도
    try {
      return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch (e2) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY 파싱 실패: JSON 원문 또는 base64 인코딩 JSON이어야 합니다.');
    }
  }
}

function isConfigured() {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_KEY && process.env.GA4_PROPERTY_ID);
}

function getClient() {
  if (_client) return _client;
  const credentials = getCredentials();
  _client = new BetaAnalyticsDataClient({
    credentials: {
      client_email: credentials.client_email,
      private_key: credentials.private_key,
    },
    projectId: credentials.project_id,
  });
  return _client;
}

function getProperty() {
  return `properties/${process.env.GA4_PROPERTY_ID}`;
}

// ---------- 데모 데이터 (환경변수 미설정 시) ----------

// 날짜 문자열 기반 결정적 의사난수 → 새로고침해도 같은 값
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
    range: { startDate, endDate },
    compareRange: { startDate: prevStart, endDate: prevEnd },
    kpis: kpiFrom(daily),
    prevKpis: kpiFrom(prevDaily),
    daily,
    channels,
    pages,
  };
}

module.exports = { getClient, getProperty, isConfigured, demoDashboard, eachDate };
