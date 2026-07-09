// api/realtime.js — 실시간 활성 사용자 (최근 30분)
// GET /api/realtime

const {
  getClient,
  getProperty,
  isOAuthConfigured,
  authErrorResponse,
} = require('./_ga4');
const { getSession } = require('./_session');

module.exports = async (req, res) => {
  try {
    if (!isOAuthConfigured()) {
      const n = 40 + (new Date().getMinutes() % 17) * 3;
      return res.status(200).json({ demo: true, activeUsers: n });
    }

    const session = getSession(req);
    if (!session?.accessToken) {
      return authErrorResponse(res, 'LOGIN_REQUIRED');
    }
    if (!session.propertyId) {
      return authErrorResponse(res, 'PROPERTY_REQUIRED');
    }

    const client = await getClient(req, res);
    const [report] = await client.runRealtimeReport({
      property: getProperty(req),
      metrics: [{ name: 'activeUsers' }],
    });
    const activeUsers = Number(report.rows?.[0]?.metricValues?.[0]?.value || 0);
    res.status(200).json({ demo: false, activeUsers });
  } catch (err) {
    console.error('[api/realtime]', err);
    res.status(500).json({ error: '실시간 데이터 조회에 실패했습니다.', detail: String(err.message || err) });
  }
};
