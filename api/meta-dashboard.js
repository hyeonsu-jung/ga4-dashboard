// api/meta-dashboard.js — Meta Ads 성과 + GA4 캠페인 매핑 대시보드
// GET /api/meta-dashboard?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&level=campaign|adset|ad
//
// Meta Marketing Insights API (Graph API) 사용.
//   환경변수: META_ACCESS_TOKEN (시스템 사용자 토큰 권장), META_AD_ACCOUNT_ID (act_ 접두어 유무 무관)
// 미설정 시 데모 데이터로 동작합니다.
// GA4 로그인·속성 선택이 되어 있으면 sessionCampaignName 기준으로 세션/전환/매출을 매핑합니다.

const { getClient, getProperty, isOAuthConfigured } = require('./_ga4');
const { getSession, getMetaUserToken, isMetaOAuthConfigured } = require('./_session');

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

// 권한 분리 원칙: 오직 Meta 로그인한 사용자의 세션 토큰만 사용
// (공용 환경변수 토큰 폴백은 로그인 없이 데이터가 노출되는 문제로 제거됨)
function resolveMetaToken(req) {
  return getMetaUserToken(req);
}

// ---------- Meta Graph API ----------

async function metaInsights(token, accountId, params) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/act_${accountId}/insights`);
  url.searchParams.set('access_token', token);
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

async function fetchMeta(token, accountId, startDate, endDate, prevStart, prevEnd, level) {
  const timeRange = JSON.stringify({ since: startDate, until: endDate });
  const levelFields = {
    campaign: 'campaign_name',
    adset: 'campaign_name,adset_name',
    ad: 'campaign_name,adset_name,ad_name',
  }[level];

  const [rows, daily, prevTotals, placements] = await Promise.all([
    metaInsights(token, accountId, {
      level,
      fields: `${levelFields},spend,impressions,clicks`,
      time_range: timeRange,
      limit: '200',
    }),
    metaInsights(token, accountId, {
      level: 'account',
      fields: 'spend,impressions,clicks',
      time_range: timeRange,
      time_increment: '1',
      limit: '400',
    }),
    metaInsights(token, accountId, {
      level: 'account',
      fields: 'spend,impressions,clicks',
      time_range: JSON.stringify({ since: prevStart, until: prevEnd }),
    }),
    // 지면(플랫폼)별 노출 — breakdown 미지원/오류 시에도 나머지는 유지
    metaInsights(token, accountId, {
      level: 'account',
      fields: 'impressions',
      breakdowns: 'publisher_platform,platform_position',
      time_range: timeRange,
      limit: '50',
    }).catch((e) => {
      console.warn('[api/meta-dashboard] placements unavailable:', e.message || e);
      return [];
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
    placements: aggregatePlacements(placements),
  };
}

// 지면 라벨 조합 (publisher_platform + platform_position) 및 상위 6개 집계
const PLATFORM_LABEL = {
  facebook: 'Facebook', instagram: 'Instagram',
  audience_network: 'Audience Network', messenger: 'Messenger',
};
const POSITION_LABEL = {
  feed: 'Feed', story: 'Stories', reels: 'Reels', explore: 'Explore',
  video_feeds: 'Video Feeds', marketplace: 'Marketplace', search: 'Search',
  instream_video: 'In-stream', right_hand_column: 'Right Column',
};

function aggregatePlacements(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const plat = PLATFORM_LABEL[r.publisher_platform] || r.publisher_platform || '기타';
    const pos = r.platform_position ? (POSITION_LABEL[r.platform_position] || r.platform_position) : '';
    const label = pos ? `${plat} ${pos}` : plat;
    map.set(label, (map.get(label) || 0) + num(r.impressions));
  }
  return [...map.entries()]
    .map(([label, impressions]) => ({ label, impressions }))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 6);
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

  // 지면별 노출 데모 (Meta 대표 플랫폼)
  const placements = [
    { label: 'Facebook Feed', share: 0.42 },
    { label: 'Instagram Feed', share: 0.28 },
    { label: 'Instagram Stories', share: 0.16 },
    { label: 'Audience Network', share: 0.09 },
    { label: 'Messenger', share: 0.05 },
  ].map((p) => ({ label: p.label, impressions: Math.round(totalImp * p.share) }));

  return {
    meta: {
      rows,
      daily,
      placements,
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
    placements: meta.placements || [],
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

    const token = resolveMetaToken(req);
    if (!token) {
      // Meta OAuth가 설정된 환경에서는 로그인 필수 (데모 데이터도 노출하지 않음)
      if (isMetaOAuthConfigured()) {
        return res.status(401).json({ error: 'META_LOGIN_REQUIRED', message: 'Meta 계정으로 로그인해 주세요.' });
      }
      const { meta, ga4 } = demoMeta(startDate, endDate, prevStart, prevEnd, level);
      return res.status(200).json(
        assemble({ demo: true, level, startDate, endDate, prevStart, prevEnd, meta, ga4 })
      );
    }

    // 광고계정 ID: 쿼리 파라미터(사이트에서 선택) 우선, 없으면 환경변수 폴백
    const rawAccount = req.query?.accountId || process.env.META_AD_ACCOUNT_ID || '';
    const accountId = String(rawAccount).replace(/^act_/, '');
    if (!accountId) {
      return res.status(400).json({ error: 'ACCOUNT_REQUIRED', message: 'Meta 광고계정을 선택해 주세요.' });
    }
    if (!/^\d{1,20}$/.test(accountId)) {
      return res.status(400).json({ error: '광고계정 ID 형식이 올바르지 않습니다.' });
    }

    const [meta, ga4] = await Promise.all([
      fetchMeta(token, accountId, startDate, endDate, prevStart, prevEnd, level),
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
