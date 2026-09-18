// api/ga4-match/[action].js — GA4 매칭 설정 엔드포인트
//   GET  /api/ga4-match/dimensions?startDate=&endDate=  GA4 캠페인/소스/매체/광고 콘텐츠 목록
//   GET  /api/ga4-match/mappings                        저장된 매칭 설정 목록
//   POST /api/ga4-match/save     { level, objectId, objectName, conditions }
//   POST /api/ga4-match/delete   { level, objectId }
//   POST /api/ga4-match/restore  { mappings: [...] }    localStorage 사본 → 서버 복원
//
// 매칭 대상 GA4 속성은 세션에 선택된 속성을 따른다 (미선택/미설정 시 DEMO).

const { getClient, getProperty, isOAuthConfigured, hasSelectedProperty } = require('../_ga4');
const { getSession } = require('../_session');
const {
  DIMENSION_KEYS, LEVELS, backendName, isPersistent,
  listMappings, saveMapping, deleteMapping, restoreMappings,
} = require('../_match-store');
const { DIMENSION_API_NAMES, demoDimensionValues, describeConditions } = require('../_ga4-match');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALUE_LIMIT = 300;

function resolvePropertyId(req) {
  if (!isOAuthConfigured() || !hasSelectedProperty(req)) return 'DEMO';
  return String(getSession(req).propertyId);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) reject(new Error('요청 본문이 너무 큽니다.'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('JSON 파싱 실패'));
      }
    });
    req.on('error', reject);
  });
}

function withDescriptions(mappings) {
  return mappings.map((m) => ({ ...m, summary: describeConditions(m.conditions) }));
}

// ---------- GA4 차원 값 목록 ----------

async function dimensions(req, res) {
  const { startDate, endDate } = req.query || {};
  if (!DATE_RE.test(startDate || '') || !DATE_RE.test(endDate || '')) {
    return res.status(400).json({ error: 'startDate, endDate는 YYYY-MM-DD 형식이어야 합니다.' });
  }
  const propertyId = resolvePropertyId(req);
  if (propertyId === 'DEMO') {
    return res.status(200).json({
      demo: true, propertyId, range: { startDate, endDate },
      values: demoDimensionValues(startDate, endDate),
    });
  }

  const client = await getClient(req, res);
  // 차원별로 개별 요청 — 속성에 따라 지원되지 않는 차원이 있어도 나머지는 유지된다
  const [batch] = await client.batchRunReports({
    property: getProperty(req),
    requests: DIMENSION_KEYS.map((key) => ({
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: DIMENSION_API_NAMES[key] }],
      metrics: [{ name: 'sessions' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: VALUE_LIMIT,
    })),
  });

  const values = {};
  DIMENSION_KEYS.forEach((key, i) => {
    values[key] = (batch.reports[i]?.rows || []).map((row) => ({
      value: row.dimensionValues[0].value,
      sessions: Number(row.metricValues[0].value) || 0,
    }));
  });

  res.status(200).json({ demo: false, propertyId, range: { startDate, endDate }, values });
}

// ---------- 매칭 설정 CRUD ----------

async function mappings(req, res) {
  const propertyId = resolvePropertyId(req);
  res.status(200).json({
    propertyId,
    persistent: isPersistent(),
    backend: backendName(),
    mappings: withDescriptions(await listMappings(propertyId)),
  });
}

async function save(req, res) {
  const propertyId = resolvePropertyId(req);
  const body = await readBody(req);
  if (body.level && !LEVELS.includes(body.level)) {
    return res.status(400).json({ error: `level은 ${LEVELS.join(', ')} 중 하나여야 합니다.` });
  }
  const saved = await saveMapping(propertyId, body);
  if (!saved) {
    return res.status(400).json({
      error: 'INVALID_MAPPING',
      message: 'Meta 객체 ID와 하나 이상의 GA4 매칭 조건이 필요합니다.',
    });
  }
  res.status(200).json({
    ok: true, propertyId, persistent: isPersistent(),
    mapping: { ...saved, summary: describeConditions(saved.conditions) },
  });
}

async function remove(req, res) {
  const propertyId = resolvePropertyId(req);
  const body = await readBody(req);
  const level = LEVELS.includes(body.level) ? body.level : 'campaign';
  const objectId = String(body.objectId || '').trim();
  if (!objectId) return res.status(400).json({ error: 'objectId가 필요합니다.' });
  const deleted = await deleteMapping(propertyId, level, objectId);
  res.status(200).json({ ok: true, deleted, propertyId });
}

async function restore(req, res) {
  const propertyId = resolvePropertyId(req);
  const body = await readBody(req);
  const restored = await restoreMappings(propertyId, body.mappings);
  res.status(200).json({
    ok: true, propertyId, restored,
    mappings: withDescriptions(await listMappings(propertyId)),
  });
}

// ---------- 라우팅 ----------

const GET_ACTIONS = { dimensions, mappings };
const POST_ACTIONS = { save, delete: remove, restore };

module.exports = async (req, res) => {
  const action = String(req.query?.action || '');
  try {
    const handler = req.method === 'POST' ? POST_ACTIONS[action] : GET_ACTIONS[action];
    if (!handler) {
      const allowed = req.method === 'POST' ? Object.keys(POST_ACTIONS) : Object.keys(GET_ACTIONS);
      return res.status(404).json({ error: `알 수 없는 요청입니다. (${req.method} ${action}) 가능: ${allowed.join(', ')}` });
    }
    await handler(req, res);
  } catch (err) {
    const detail = String(err.message || err);
    if (detail.includes('LOGIN_REQUIRED') || detail.includes('PROPERTY_REQUIRED')) {
      return res.status(401).json({ error: detail.trim(), message: 'GA4 로그인 후 속성을 선택해 주세요.' });
    }
    console.error('[api/ga4-match]', err);
    res.status(500).json({ error: 'GA4 매칭 요청에 실패했습니다.', detail });
  }
};
