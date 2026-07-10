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

const DEVICE_VALUES = ['mobile', 'desktop', 'tablet'];

module.exports = async (req, res) => {
  try {
    const { startDate, endDate, device, channel, keyEvent } = req.query || {};
    if (!DATE_RE.test(startDate || '') || !DATE_RE.test(endDate || '')) {
      return res.status(400).json({ error: 'startDate, endDate는 YYYY-MM-DD 형식이어야 합니다.' });
    }
    if (startDate > endDate) {
      return res.status(400).json({ error: 'startDate가 endDate보다 늦을 수 없습니다.' });
    }
    if (device && !DEVICE_VALUES.includes(device)) {
      return res.status(400).json({ error: 'device는 mobile, desktop, tablet 중 하나여야 합니다.' });
    }
    if ((channel && channel.length > 100) || (keyEvent && keyEvent.length > 100)) {
      return res.status(400).json({ error: '필터 값이 너무 깁니다.' });
    }

    // 이전 동기간 계산 (같은 일수만큼 직전 구간)
    const spanDays =
      Math.round((new Date(endDate) - new Date(startDate)) / 86400000) + 1;
    const prevEnd = shiftDate(startDate, -1);
    const prevStart = shiftDate(prevEnd, -(spanDays - 1));

    if (!isOAuthConfigured()) {
      return res.status(200).json(demoDashboard(startDate, endDate, prevStart, prevEnd, { device, channel, keyEvent }));
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
    const prevRange = [{ startDate: prevStart, endDate: prevEnd }];

    // 전역 필터 (기기 / 채널) — 모든 리포트에 공통 적용
    const filterExprs = [];
    if (device) {
      filterExprs.push({ filter: { fieldName: 'deviceCategory', stringFilter: { value: device } } });
    }
    if (channel) {
      filterExprs.push({ filter: { fieldName: 'sessionDefaultChannelGroup', stringFilter: { value: channel } } });
    }
    const combine = (exprs) =>
      exprs.length === 0 ? undefined : exprs.length === 1 ? exprs[0] : { andGroup: { expressions: exprs } };
    const globalFilter = combine(filterExprs);
    const withFilter = (r) => (globalFilter ? { ...r, dimensionFilter: globalFilter } : r);
    const eventNameFilter = (name) =>
      combine([...filterExprs, { filter: { fieldName: 'eventName', stringFilter: { value: name } } }]);

    // batchRunReports는 배치당 최대 5개 요청 → 여러 배치로 분리, 병렬 실행
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
      ].map(withFilter),
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
      ].map(withFilter),
    });

    // 이전 기간 추이 + 랜딩 페이지 + (선택 시) 전환 지정 이벤트
    const batchDRequests = [
      // 11. 이전 기간 일별 추이
      {
        dateRanges: prevRange,
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
      // 12. 랜딩 페이지 성과
      {
        dateRanges: range,
        dimensions: [{ name: 'landingPage' }],
        metrics: [
          { name: 'sessions' },
          { name: 'totalUsers' },
          { name: 'keyEvents' },
          { name: 'engagementRate' },
        ],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: 10,
      },
    ].map(withFilter);
    if (keyEvent) {
      batchDRequests.push(
        // 13. 선택 이벤트 일별 추이 (현재 기간)
        {
          dateRanges: range,
          dimensions: [{ name: 'date' }],
          metrics: [{ name: 'eventCount' }],
          dimensionFilter: eventNameFilter(keyEvent),
          orderBys: [{ dimension: { dimensionName: 'date' } }],
          limit: 400,
        },
        // 14. 선택 이벤트 합계 (이전 기간)
        {
          dateRanges: prevRange,
          metrics: [{ name: 'eventCount' }],
          dimensionFilter: eventNameFilter(keyEvent),
        }
      );
    }
    const batchD = client.batchRunReports({ property, requests: batchDRequests });

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
        ].map(withFilter),
      })
      .catch((err) => {
        console.warn('[api/dashboard] demographics unavailable:', err.message || err);
        return null;
      });

    const [[resA], [resB], resC, [resD]] = await Promise.all([batchA, batchB, batchC, batchD]);

    const [kpiNow, kpiPrev, trend, channels, pages] = resA.reports;
    const [sourceMedium, campaigns, events, devices, countries] = resB.reports;
    const [prevTrend, landingPages, evDaily, evPrevTotal] = resD.reports;

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

    const isoDate = (r) => ({
      ...r,
      date: `${r.date.slice(0, 4)}-${r.date.slice(4, 6)}-${r.date.slice(6, 8)}`,
    });
    const TREND_KEYS = ['activeUsers', 'sessions', 'eventCount', 'keyEvents'];
    const daily = rowsToObjects(trend, ['date'], TREND_KEYS).map(isoDate);
    const prevDaily = rowsToObjects(prevTrend, ['date'], TREND_KEYS).map(isoDate);

    let selectedEvent = null;
    if (keyEvent) {
      const evRows = rowsToObjects(evDaily, ['date'], ['eventCount']).map(isoDate);
      selectedEvent = {
        name: keyEvent,
        eventCount: evRows.reduce((a, r) => a + r.eventCount, 0),
        prevEventCount: totalsFrom(evPrevTotal, ['eventCount']).eventCount,
        daily: evRows,
      };
    }

    res.status(200).json({
      demo: false,
      propertyId: meta.propertyId,
      propertyName: meta.propertyName,
      range: { startDate, endDate },
      compareRange: { startDate: prevStart, endDate: prevEnd },
      filters: { device: device || null, channel: channel || null },
      kpis: toKpi(kpiNow),
      prevKpis: toKpi(kpiPrev),
      daily,
      prevDaily,
      landingPages: rowsToObjects(landingPages, ['landingPage'], ['sessions', 'totalUsers', 'keyEvents', 'engagementRate']),
      selectedEvent,
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
