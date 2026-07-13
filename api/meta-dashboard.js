// api/meta-dashboard.js — Meta Ads 성과 + GA4 캠페인 매핑 대시보드
// GET /api/meta-dashboard?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&level=campaign|adset|ad
//
// Meta Marketing Insights API (Graph API) 사용.
//   환경변수: META_ACCESS_TOKEN (시스템 사용자 토큰 권장), META_AD_ACCOUNT_ID (act_ 접두어 유무 무관)
// 미설정 시 데모 데이터로 동작합니다.
// GA4 로그인·속성 선택이 되어 있으면 sessionCampaignName 기준으로 세션/전환/매출을 매핑합니다.

const { getClient, getProperty, isOAuthConfigured } = require('./_ga4');
const { getSession } = require('./_session');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LEVELS = ['campaign', 'adset', 'ad'];
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0';

function shiftDate(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function normalizeCampaign(name) {
  return String(name || '').trim().toLowerCase();
}

function isMetaConfigured() {
  return Boolean(process.env.META_ACCESS_TOKEN && process.env.META_AD_ACCOUNT_ID);
}

// ---------- Meta Graph API ----------

async function metaInsights(params) {
  const accountId = String(process.env.META_AD_ACCOUNT_ID).replace(/^act_/, '');
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/act_${accountId}/insights`);
  url.searchParams.set('access_token', process.env.META_ACCESS_TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const r = await fetch(url);
  const data = await r.json();
  if (!r.ok || data.error) {
    throw new Error(data.error?.message || `Meta API HTTP ${r.status}`);
  }
  return data.data || [];
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function fetchMeta(startDate, endDate, prevStart, prevEnd, level) {
  const timeRange = JSON.stringify({ since: startDate, until: endDate });
  const levelFields = {
    campaign: 'campaign_name',
    adset: 'campaign_name,adset_name',
    ad: 'campaign_name,adset_name,ad_name',
  }[level];

  const [rows, daily, prevTotals] = await Promise.all([
    metaInsights({
      level,
      fields: `${levelFields},spend,impressions,clicks`,
      time_range: timeRange,
      limit: '200',
    }),
    metaInsights({
      level: 'account',
      fields: 'spend,impressions,clicks',
      time_range: timeRange,
      time_increment: '1',
      limit: '400',
    }),
    metaInsights({
      level: 'account',
      fields: 'spend,impressions,clicks',
      time_range: JSON.stringify({ since: prevStart, until: prevEnd }),
    }),
  ]);

  return {
    rows: rows.map((r) => ({
      campaign: r.campaign_name || '(이름 없음)',
      adset: r.adset_name || null,
      ad: r.ad_name || null,
      spend: num(r.spend),
      impressions: num(r.impressions),
      clicks: num(r.clicks),
    })),
    daily: daily
      .map((r) => ({
        date: r.date_start,
        spend: num(r.spend),
        impressions: num(r.impressions),
        clicks: num(r.clicks),
      }))
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
    prevTotals: prevTotals[0]
      ? { spend: num(prevTotals[0].spend), impressions: num(prevTotals[0].impressions), clicks: num(prevTotals[0].clicks) }
      : { spend: 0, impressions: 0, clicks: 0 },
  };
}

// ---------- GA4 캠페인 매핑 ----------

async function fetchGa4Mapping(req, res, startDate, endDate, prevStart, prevEnd) {
  const session = getSession(req);
  if (!isOAuthConfigured() || !session?.accessToken || !session.propertyId) return null;

  try {
    const client = await getClient(req, res);
    const property = getProperty(req);
    const [batch] = await client.batchRunReports({
      property,
      requests: [
        // 캠페인별 세션/전환/매출
        {
          dateRanges: [{ startDate, endDate }],
          dimensions: [{ name: 'sessionCampaignName' }],
          metrics: [{ name: 'sessions' }, { name: 'keyEvents' }, { name: 'totalRevenue' }],
          limit: 250,
        },
        // 일별 세션/전환
        {
          dateRanges: [{ startDate, endDate }],
          dimensions: [{ name: 'date' }],
          metrics: [{ name: 'sessions' }, { name: 'keyEvents' }],
          orderBys: [{ dimension: { dimensionName: 'date' } }],
          limit: 400,
        },
        // 이전 기간 합계 (전환 델타용)
        {
          dateRanges: [{ startDate: prevStart, endDate: prevEnd }],
          metrics: [{ name: 'sessions' }, { name: 'keyEvents' }],
        },
      ],
    });

    const [byCampaign, byDate, prevTot] = batch.reports;
    const campaigns = {};
    for (const row of byCampaign.rows || []) {
      campaigns[normalizeCampaign(row.dimensionValues[0].value)] = {
        sessions: num(row.metricValues[0].value),
        keyEvents: num(row.metricValues[1].value),
        revenue: num(row.metricValues[2].value),
      };
    }
    const daily = {};
    for (const row of byDate.rows || []) {
      const d = row.dimensionValues[0].value;
      daily[`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`] = {
        sessions: num(row.metricValues[0].value),
        keyEvents: num(row.metricValues[1].value),
      };
    }
    const prevRow = (prevTot.rows || [])[0];
    return {
      campaigns,
      daily,
      prevTotals: prevRow
        ? { sessions: num(prevRow.metricValues[0].value), keyEvents: num(prevRow.metricValues[1].value) }
        : { sessions: 0, keyEvents: 0 },
    };
  } catch (err) {
    console.warn('[api/meta-dashboard] GA4 매핑 실패:', err.message || err);
    return null;
  }
}

// ---------- 데모 데이터 ----------

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

const DEMO_CAMPAIGNS = [
  { campaign: '2026_summer_sale', adsets: ['잠재고객_확장', '리타겟_장바구니'], weight: 1.6 },
  { campaign: 'brand_search_always_on', adsets: ['브랜드_핵심'], weight: 0.7 },
  { campaign: 'retargeting_july', adsets: ['최근30일_방문', '구매이력_제외'], weight: 1.1 },
  { campaign: 'launch_teaser', adsets: ['영상_조회', '이미지_도달'], weight: 0.9 },
];

function demoMeta(startDate, endDate, prevStart, prevEnd, level) {
  const r = seededRandom(`meta:${startDate}:${endDate}:${level}`);
  const dates = eachDate(startDate, endDate);

  const rows = [];
  for (const c of DEMO_CAMPAIGNS) {
    const units = level === 'campaign' ? [null] : level === 'adset' ? c.adsets : c.adsets.flatMap((a) => [`${a}_소재A`, `${a}_소재B`]);
    for (const unit of units) {
      const spend = Math.round((80000 + r() * 400000) * c.weight / units.length);
      const impressions = Math.round((spend / (3000 + r() * 4000)) * 1000); // CPM 3~7천원
      const clicks = Math.round(impressions * (0.008 + r() * 0.017)); // CTR 0.8~2.5%
      rows.push({
        campaign: c.campaign,
        adset: level === 'campaign' ? null : (level === 'adset' ? unit : unit.replace(/_소재[AB]$/, '')),
        ad: level === 'ad' ? unit : null,
        spend, impressions, clicks,
      });
    }
  }

  const daily = dates.map((date) => {
    const dr = seededRandom('meta' + date);
    const dow = new Date(date + 'T00:00:00Z').getUTCDay();
    const weekendFactor = dow === 0 || dow === 6 ? 0.7 : 1;
    const spend = Math.round((120000 + dr() * 180000) * weekendFactor);
    const impressions = Math.round((spend / (3500 + dr() * 3000)) * 1000);
    const clicks = Math.round(impressions * (0.01 + dr() * 0.012));
    return { date, spend, impressions, clicks };
  });

  const prevScale = 0.85 + r() * 0.3;
  const totalSpend = daily.reduce((a, x) => a + x.spend, 0);
  const totalImp = daily.reduce((a, x) => a + x.impressions, 0);
  const totalClicks = daily.reduce((a, x) => a + x.clicks, 0);

  // GA4 데모 매핑 (캠페인명 일치)
  const campaigns = {};
  for (const row of rows) {
    const key = normalizeCampaign(row.campaign);
    if (!campaigns[key]) {
      const cr = seededRandom('ga4' + row.campaign + startDate);
      const sessions = Math.round(500 + cr() * 3000);
      const keyEvents = Math.round(sessions * (0.015 + cr() * 0.03));
      campaigns[key] = {
        sessions,
        keyEvents,
        revenue: Math.round(keyEvents * (15000 + cr() * 35000)), // ROAS 대략 1~5배
      };
    }
  }
  const ga4Daily = {};
  dates.forEach((date) => {
    const dr = seededRandom('ga4d' + date);
    const sessions = Math.round(900 + dr() * 700);
    ga4Daily[date] = { sessions, keyEvents: Math.round(sessions * (0.02 + dr() * 0.015)) };
  });

  return {
    meta: {
      rows,
      daily,
      prevTotals: {
        spend: Math.round(totalSpend * prevScale),
        impressions: Math.round(totalImp * prevScale),
        clicks: Math.round(totalClicks * prevScale),
      },
    },
    ga4: {
      campaigns,
      daily: ga4Daily,
      prevTotals: {
        sessions: Math.round(Object.values(ga4Daily).reduce((a, x) => a + x.sessions, 0) * prevScale),
        keyEvents: Math.round(Object.values(ga4Daily).reduce((a, x) => a + x.keyEvents, 0) * prevScale),
      },
    },
  };
}

// ---------- 조립 ----------

function assemble({ demo, level, startDate, endDate, prevStart, prevEnd, meta, ga4 }) {
  const totals = meta.rows.reduce(
    (a, r) => ({ spend: a.spend + r.spend, impressions: a.impressions + r.impressions, clicks: a.clicks + r.clicks }),
    { spend: 0, impressions: 0, clicks: 0 }
  );

  const rows = meta.rows
    .map((r) => {
      const g = ga4?.campaigns?.[normalizeCampaign(r.campaign)] || null;
      // 광고 세트/소재 레벨은 캠페인 GA4 수치를 지출 비중으로 배분하지 않고 캠페인 단위로만 표기
      const isCampaignLevel = level === 'campaign';
      return {
        ...r,
        cpc: r.clicks ? r.spend / r.clicks : null,
        ctr: r.impressions ? r.clicks / r.impressions : null,
        ga4Sessions: isCampaignLevel && g ? g.sessions : null,
        ga4KeyEvents: isCampaignLevel && g ? g.keyEvents : null,
        ga4Revenue: isCampaignLevel && g ? g.revenue : null,
        cac: isCampaignLevel && g && g.keyEvents ? r.spend / g.keyEvents : null,
        roas: isCampaignLevel && g && g.revenue && r.spend ? g.revenue / r.spend : null,
      };
    })
    .sort((a, b) => b.spend - a.spend);

  const ga4TotalKeyEvents = ga4
    ? Object.values(ga4.campaigns).reduce((a, g) => a + g.keyEvents, 0)
    : null;
  const ga4TotalRevenue = ga4
    ? Object.values(ga4.campaigns).reduce((a, g) => a + g.revenue, 0)
    : null;
  // 통합 지표는 "매핑된 캠페인" 기준이 아닌 전체 GA4 전환 기준이 아니라,
  // 메타 캠페인명과 매칭된 GA4 수치 합으로 계산
  const matchedKeyEvents = rows.reduce((a, r) => a + (r.ga4KeyEvents || 0), 0);
  const matchedRevenue = rows.reduce((a, r) => a + (r.ga4Revenue || 0), 0);
  const matchedSessions = rows.reduce((a, r) => a + (r.ga4Sessions || 0), 0);

  const daily = meta.daily.map((d) => ({
    ...d,
    ga4Sessions: ga4?.daily?.[d.date]?.sessions ?? null,
    ga4KeyEvents: ga4?.daily?.[d.date]?.keyEvents ?? null,
  }));

  return {
    demo,
    level,
    ga4Linked: Boolean(ga4),
    range: { startDate, endDate },
    compareRange: { startDate: prevStart, endDate: prevEnd },
    kpis: {
      spend: totals.spend,
      impressions: totals.impressions,
      clicks: totals.clicks,
      cpc: totals.clicks ? totals.spend / totals.clicks : 0,
      cpm: totals.impressions ? (totals.spend / totals.impressions) * 1000 : 0,
      ctr: totals.impressions ? totals.clicks / totals.impressions : 0,
      ga4Sessions: ga4 ? matchedSessions : null,
      ga4KeyEvents: ga4 ? matchedKeyEvents : null,
      cac: ga4 && matchedKeyEvents ? totals.spend / matchedKeyEvents : null,
      roas: ga4 && matchedRevenue && totals.spend ? matchedRevenue / totals.spend : null,
    },
    prevKpis: {
      spend: meta.prevTotals.spend,
      impressions: meta.prevTotals.impressions,
      clicks: meta.prevTotals.clicks,
      cpc: meta.prevTotals.clicks ? meta.prevTotals.spend / meta.prevTotals.clicks : 0,
      cpm: meta.prevTotals.impressions ? (meta.prevTotals.spend / meta.prevTotals.impressions) * 1000 : 0,
      ga4KeyEvents: ga4 ? ga4.prevTotals.keyEvents : null,
    },
    rows,
    daily,
  };
}

// ---------- 핸들러 ----------

module.exports = async (req, res) => {
  try {
    const { startDate, endDate } = req.query || {};
    const level = LEVELS.includes(req.query?.level) ? req.query.level : 'campaign';
    if (!DATE_RE.test(startDate || '') || !DATE_RE.test(endDate || '')) {
      return res.status(400).json({ error: 'startDate, endDate는 YYYY-MM-DD 형식이어야 합니다.' });
    }
    if (startDate > endDate) {
      return res.status(400).json({ error: 'startDate가 endDate보다 늦을 수 없습니다.' });
    }

    const spanDays = Math.round((new Date(endDate) - new Date(startDate)) / 86400000) + 1;
    const prevEnd = shiftDate(startDate, -1);
    const prevStart = shiftDate(prevEnd, -(spanDays - 1));

    if (!isMetaConfigured()) {
      const { meta, ga4 } = demoMeta(startDate, endDate, prevStart, prevEnd, level);
      return res.status(200).json(
        assemble({ demo: true, level, startDate, endDate, prevStart, prevEnd, meta, ga4 })
      );
    }

    const [meta, ga4] = await Promise.all([
      fetchMeta(startDate, endDate, prevStart, prevEnd, level),
      fetchGa4Mapping(req, res, startDate, endDate, prevStart, prevEnd),
    ]);

    res.status(200).json(
      assemble({ demo: false, level, startDate, endDate, prevStart, prevEnd, meta, ga4 })
    );
  } catch (err) {
    console.error('[api/meta-dashboard]', err);
    res.status(500).json({ error: 'Meta 광고 데이터 조회에 실패했습니다.', detail: String(err.message || err) });
  }
};
