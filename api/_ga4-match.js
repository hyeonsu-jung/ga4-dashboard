// api/_ga4-match.js — GA4 매칭 조건 → Data API 필터 / 집계 공용 로직
//
// 조건 해석: 한 차원 안의 여러 값은 OR, 차원 간에는 AND, 값이 없는 차원은 제약 없음.
//   예) campaign=[9월_트래픽] AND source=[facebook] AND medium=[paid_social]

const { DIMENSION_KEYS } = require('./_match-store');

// 매칭 조건 키 → GA4 Data API dimension
const DIMENSION_API_NAMES = {
  campaign: 'sessionCampaignName',
  source: 'sessionSource',
  medium: 'sessionMedium',
  content: 'sessionManualAdContent',
};

// 집계 리포트에서 사용하는 dimension 순서 (행 파싱 순서와 동일)
const MATCH_DIMENSIONS = DIMENSION_KEYS.map((key) => DIMENSION_API_NAMES[key]);

function lower(v) {
  return String(v ?? '').trim().toLowerCase();
}

// 매핑 1건 → andGroup FilterExpression
function mappingFilter(mapping) {
  const expressions = [];
  for (const key of DIMENSION_KEYS) {
    const values = mapping.conditions?.[key] || [];
    if (!values.length) continue;
    expressions.push({
      filter: {
        fieldName: DIMENSION_API_NAMES[key],
        inListFilter: { values, caseSensitive: false },
      },
    });
  }
  if (!expressions.length) return null;
  if (expressions.length === 1) return expressions[0];
  return { andGroup: { expressions } };
}

// 매핑 목록 전체 → orGroup FilterExpression (조회 행 수를 매칭 대상으로 한정)
function buildMatchFilter(mappings) {
  const expressions = mappings.map(mappingFilter).filter(Boolean);
  if (!expressions.length) return null;
  if (expressions.length === 1) return expressions[0];
  return { orGroup: { expressions } };
}

// GA4 행 dimension 값 배열이 매칭 조건을 만족하는지
function rowMatches(values, conditions) {
  return DIMENSION_KEYS.every((key, i) => {
    const allowed = conditions?.[key] || [];
    if (!allowed.length) return true;
    return allowed.some((v) => lower(v) === lower(values[i]));
  });
}

// 매칭 리포트 행 → { '<level>:<objectId>': {sessions, keyEvents, revenue} }
// 한 GA4 행이 여러 매핑에 해당하면 각 매핑에 모두 합산된다 (조건 중복은 사용자 설정 책임).
function aggregateMatched(reportRows, mappings) {
  const totals = new Map();
  for (const m of mappings) totals.set(`${m.level}:${m.objectId}`, { sessions: 0, keyEvents: 0, revenue: 0 });

  for (const row of reportRows || []) {
    const values = MATCH_DIMENSIONS.map((_, i) => row.dimensionValues?.[i]?.value ?? '');
    const sessions = Number(row.metricValues?.[0]?.value) || 0;
    const keyEvents = Number(row.metricValues?.[1]?.value) || 0;
    const revenue = Number(row.metricValues?.[2]?.value) || 0;
    for (const m of mappings) {
      if (!rowMatches(values, m.conditions)) continue;
      const t = totals.get(`${m.level}:${m.objectId}`);
      t.sessions += sessions;
      t.keyEvents += keyEvents;
      t.revenue += revenue;
    }
  }
  return totals;
}

// 매칭 조건 요약 문자열 (테이블 툴팁/상태 표시용)
function describeConditions(conditions) {
  const labels = { campaign: '캠페인', source: '소스', medium: '매체', content: '콘텐츠' };
  return DIMENSION_KEYS
    .filter((key) => (conditions?.[key] || []).length)
    .map((key) => `${labels[key]}: ${conditions[key].join(', ')}`)
    .join(' · ');
}

module.exports = {
  DIMENSION_API_NAMES,
  MATCH_DIMENSIONS,
  buildMatchFilter,
  rowMatches,
  aggregateMatched,
  describeConditions,
};

// ---------- 데모 데이터 ----------
// OAuth 미설정/미로그인 시에도 매칭 UI를 그대로 시험해 볼 수 있도록
// GA4 리포트와 동일한 형태(dimensionValues/metricValues)의 행을 생성한다.

const DEMO_SOURCES = ['facebook', 'instagram', 'google', 'naver', '(direct)'];
const DEMO_MEDIUMS = ['paid_social', 'cpc', 'organic', 'email', '(none)'];
const DEMO_CONTENTS = ['피드', '릴스', '스토리', '캐러셀', '(not set)'];
const DEMO_CAMPAIGN_NAMES = [
  '2026_summer_sale', 'brand_search_always_on', 'retargeting_july',
  'launch_teaser', 'newsletter_weekly', '(not set)',
];

function seeded(seed) {
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

function demoGa4Rows(startDate, endDate) {
  const rows = [];
  for (const campaign of DEMO_CAMPAIGN_NAMES) {
    for (let i = 0; i < 4; i++) {
      const r = seeded(`${campaign}|${i}|${startDate}|${endDate}`);
      const source = DEMO_SOURCES[Math.floor(r() * DEMO_SOURCES.length)];
      const medium = DEMO_MEDIUMS[Math.floor(r() * DEMO_MEDIUMS.length)];
      const content = DEMO_CONTENTS[Math.floor(r() * DEMO_CONTENTS.length)];
      const sessions = Math.round(120 + r() * 1400);
      const keyEvents = Math.round(sessions * (0.012 + r() * 0.03));
      rows.push({
        dimensionValues: [{ value: campaign }, { value: source }, { value: medium }, { value: content }],
        metricValues: [
          { value: String(sessions) },
          { value: String(keyEvents) },
          { value: String(Math.round(keyEvents * (15000 + r() * 35000))) },
        ],
      });
    }
  }
  return rows;
}

// 데모 차원 목록 (세션 수 내림차순)
function demoDimensionValues(startDate, endDate) {
  const out = { campaign: new Map(), source: new Map(), medium: new Map(), content: new Map() };
  for (const row of demoGa4Rows(startDate, endDate)) {
    const sessions = Number(row.metricValues[0].value) || 0;
    DIMENSION_KEYS.forEach((key, i) => {
      const v = row.dimensionValues[i].value;
      out[key].set(v, (out[key].get(v) || 0) + sessions);
    });
  }
  const toList = (m) => [...m.entries()]
    .map(([value, sessions]) => ({ value, sessions }))
    .sort((a, b) => b.sessions - a.sessions);
  return {
    campaign: toList(out.campaign),
    source: toList(out.source),
    medium: toList(out.medium),
    content: toList(out.content),
  };
}

module.exports.demoGa4Rows = demoGa4Rows;
module.exports.demoDimensionValues = demoDimensionValues;
