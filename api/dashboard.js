// api/dashboard.js — 대시보드 데이터 일괄 조회
// GET /api/dashboard?startDate=2026-06-01&endDate=2026-06-30
// 이전 동기간(같은 일수) 비교 데이터를 함께 반환합니다.

const {
  getClient,
  getProperty,
  getPropertyMeta,
  isConfigured,
  isOAuthConfigured,
  demoDashboard,
  authErrorResponse,
} = require('./_ga4');
const { getSession } = require('./_session');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function shiftDate(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function rowsToObjects(report, dimNames, metricNames) {
  return (report.rows || []).map((row) => {
    const o = {};
    dimNames.forEach((n, i) => (o[n] = row.dimensionValues[i].value));
    metricNames.forEach((n, i) => (o[n] = Number(row.metricValues[i].value)));
    return o;
  });
}

function totalsFrom(report, metricNames) {
  const row = (report.rows || [])[0];
  const o = {};
  metricNames.forEach((n, i) => (o[n] = row ? Number(row.metricValues[i].value) : 0));
  return o;
}

module.exports = async (req, res) => {
  try {
    const { startDate, endDate } = req.query || {};
    if (!DATE_RE.test(startDate || '') || !DATE_RE.test(endDate || '')) {
      return res.status(400).json({ error: 'startDate, endDate는 YYYY-MM-DD 형식이어야 합니다.' });
    }
    if (startDate > endDate) {
      return res.status(400).json({ error: 'startDate가 endDate보다 늦을 수 없습니다.' });
    }

    // 이전 동기간 계산 (같은 일수만큼 직전 구간)
    const spanDays =
      Math.round((new Date(endDate) - new Date(startDate)) / 86400000) + 1;
    const prevEnd = shiftDate(startDate, -1);
    const prevStart = shiftDate(prevEnd, -(spanDays - 1));

    if (!isOAuthConfigured()) {
      return res.status(200).json(demoDashboard(startDate, endDate, prevStart, prevEnd));
    }

    const session = getSession(req);
    if (!session?.accessToken) {
      return authErrorResponse(res, 'LOGIN_REQUIRED');
    }
    if (!session.propertyId) {
      return authErrorResponse(res, 'PROPERTY_REQUIRED');
    }

    const client = await getClient(req, res);
    const property = getProperty(req);
    const meta = getPropertyMeta(req);

    const KPI_METRICS = [
      'activeUsers',
      'newUsers',
      'sessions',
      'eventCount',
      'keyEvents',
      'engagementRate',
      'userEngagementDuration',
    ];

    const range = [{ startDate, endDate }];

    // batchRunReports는 배치당 최대 5개 요청 → 3개 배치로 분리, 병렬 실행
    const batchA = client.batchRunReports({
      property,
      requests: [
        // 1. 현재 기간 KPI 합계
        {
          dateRanges: range,
          metrics: KPI_METRICS.map((name) => ({ name })),
        },
        // 2. 이전 기간 KPI 합계
        {
          dateRanges: [{ startDate: prevStart, endDate: prevEnd }],
          metrics: KPI_METRICS.map((name) => ({ name })),
        },
        // 3. 일별 추이
        {
          dateRanges: range,
          dimensions: [{ name: 'date' }],
          metrics: [
            { name: 'activeUsers' },
            { name: 'sessions' },
            { name: 'eventCount' },
            { name: 'keyEvents' },
          ],
          orderBys: [{ dimension: { dimensionName: 'date' } }],
          limit: 400,
        },
        // 4. 채널별 유입
        {
          dateRanges: range,
          dimensions: [{ name: 'sessionDefaultChannelGroup' }],
          metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'keyEvents' }],
          orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
          limit: 10,
        },
        // 5. 인기 페이지
        {
          dateRanges: range,
          dimensions: [{ name: 'pagePath' }],
          metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }],
          orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
          limit: 10,
        },
      ],
    });

    const batchB = client.batchRunReports({
      property,
      requests: [
        // 6. 소스/매체
        {
          dateRanges: range,
          dimensions: [{ name: 'sessionSourceMedium' }],
          metrics: [{ name: 'totalUsers' }, { name: 'sessions' }, { name: 'keyEvents' }],
          orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
          limit: 15,
        },
        // 7. 캠페인
        {
          dateRanges: range,
          dimensions: [{ name: 'sessionCampaignName' }],
          metrics: [{ name: 'totalUsers' }, { name: 'sessions' }, { name: 'keyEvents' }],
          orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
          limit: 15,
        },
        // 8. 이벤트별 현황
        {
          dateRanges: range,
          dimensions: [{ name: 'eventName' }],
          metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
          orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
          limit: 15,
        },
        // 9. 기기 카테고리
        {
          dateRanges: range,
          dimensions: [{ name: 'deviceCategory' }],
          metrics: [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'engagementRate' }],
          orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
        },
        // 10. 국가별 유입
        {
          dateRanges: range,
          dimensions: [{ name: 'country' }],
          metrics: [{ name: 'activeUsers' }, { name: 'sessions' }],
          orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
          limit: 10,
        },
      ],
    });

    // 인구통계(연령/성별/관심사)는 Google Signals 미활성화 시 실패·빈값 가능 → 별도 배치로 격리
    const batchC = client
      .batchRunReports({
        property,
        requests: [
          {
            dateRanges: range,
            dimensions: [{ name: 'userAgeBracket' }],
            metrics: [{ name: 'totalUsers' }, { name: 'engagementRate' }],
            orderBys: [{ dimension: { dimensionName: 'userAgeBracket' } }],
          },
          {
            dateRanges: range,
            dimensions: [{ name: 'userGender' }],
            metrics: [{ name: 'totalUsers' }],
            orderBys: [{ metric: { metricName: 'totalUsers' }, desc: true }],
          },
          {
            dateRanges: range,
            dimensions: [{ name: 'brandingInterest' }],
            metrics: [{ name: 'totalUsers' }],
            orderBys: [{ metric: { metricName: 'totalUsers' }, desc: true }],
            limit: 10,
          },
        ],
      })
      .catch((err) => {
        console.warn('[api/dashboard] demographics unavailable:', err.message || err);
        return null;
      });

    const [[resA], [resB], resC] = await Promise.all([batchA, batchB, batchC]);

    const [kpiNow, kpiPrev, trend, channels, pages] = resA.reports;
    const [sourceMedium, campaigns, events, devices, countries] = resB.reports;

    const demoReports = resC && resC[0] ? resC[0].reports : null;
    const demographics = demoReports
      ? {
          available: true,
          ageBrackets: rowsToObjects(demoReports[0], ['bracket'], ['totalUsers', 'engagementRate']),
          genders: rowsToObjects(demoReports[1], ['gender'], ['totalUsers']),
          interests: rowsToObjects(demoReports[2], ['interest'], ['totalUsers']),
        }
      : { available: false, ageBrackets: [], genders: [], interests: [] };

    const toKpi = (report) => {
      const t = totalsFrom(report, KPI_METRICS);
      return {
        activeUsers: t.activeUsers,
        newUsers: t.newUsers,
        sessions: t.sessions,
        eventCount: t.eventCount,
        keyEvents: t.keyEvents,
        engagementRate: t.engagementRate,
        avgEngagementSeconds: t.activeUsers ? t.userEngagementDuration / t.activeUsers : 0,
      };
    };

    const daily = rowsToObjects(trend, ['date'], [
      'activeUsers',
      'sessions',
      'eventCount',
      'keyEvents',
    ]).map((r) => ({
      ...r,
      date: `${r.date.slice(0, 4)}-${r.date.slice(4, 6)}-${r.date.slice(6, 8)}`,
    }));

    res.status(200).json({
      demo: false,
      propertyId: meta.propertyId,
      propertyName: meta.propertyName,
      range: { startDate, endDate },
      compareRange: { startDate: prevStart, endDate: prevEnd },
      kpis: toKpi(kpiNow),
      prevKpis: toKpi(kpiPrev),
      daily,
      channels: rowsToObjects(channels, ['channel'], ['sessions', 'activeUsers', 'keyEvents']),
      pages: rowsToObjects(pages, ['pagePath'], ['screenPageViews', 'activeUsers']),
      sourceMedium: rowsToObjects(sourceMedium, ['sourceMedium'], ['totalUsers', 'sessions', 'keyEvents']),
      campaigns: rowsToObjects(campaigns, ['campaign'], ['totalUsers', 'sessions', 'keyEvents']),
      events: rowsToObjects(events, ['eventName'], ['eventCount', 'totalUsers']),
      devices: rowsToObjects(devices, ['device'], ['activeUsers', 'sessions', 'engagementRate']),
      countries: rowsToObjects(countries, ['country'], ['activeUsers', 'sessions']),
      demographics,
    });
  } catch (err) {
    console.error('[api/dashboard]', err);
    res.status(500).json({ error: 'GA4 데이터 조회에 실패했습니다.', detail: String(err.message || err) });
  }
};
