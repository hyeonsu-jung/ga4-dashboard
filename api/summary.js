// api/summary.js — 대시보드 지표 한 줄 요약
// POST { metrics: {...} }
// GEMINI_API_KEY 설정 시 Google AI Studio(Gemini) 무료 API로 요약을 생성하고,
// 미설정·속도 제한(429)·타임아웃·응답 이상 시 룰 베이스 요약으로 자동 폴백합니다.

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_TIMEOUT_MS = 6000;

function pctChange(now, prev) {
  if (!prev) return null;
  return ((now - prev) / prev) * 100;
}

function fmtPct(v) {
  const abs = Math.abs(v).toFixed(1);
  return v > 0.05 ? `${abs}% 증가` : v < -0.05 ? `${abs}% 감소` : '보합';
}

function fmtNum(n) {
  return new Intl.NumberFormat('ko-KR').format(Math.round(n));
}

// ---------- 고도화된 룰 베이스 요약 ----------
function ruleBasedSummary(m) {
  const parts = [];
  const days = m.spanDays ? `최근 ${m.spanDays}일간 ` : '';

  // 1. 종합 성과 분석 (사용자 및 전환 결합)
  const userDelta = pctChange(m.kpis.activeUsers, m.prevKpis?.activeUsers);
  const convDelta = m.kpis.keyEvents != null && m.prevKpis?.keyEvents
    ? pctChange(m.kpis.keyEvents, m.prevKpis?.keyEvents)
    : null;

  let performanceTrend = '';
  if (userDelta > 5 && (convDelta === null || convDelta > 5)) {
    performanceTrend = '📈 전반적인 웹사이트 성과가 상승 흐름을 보이고 있습니다.';
  } else if (userDelta < -5 && (convDelta === null || convDelta < -5)) {
    performanceTrend = '📉 전반적인 주요 지표가 감소하며 둔화 추세를 보이고 있습니다.';
  } else {
    performanceTrend = '📊 현재 웹사이트 트래픽은 큰 변동 없이 안정적인 보합세를 유지 중입니다.';
  }
  parts.push(performanceTrend);

  // 2. 세부 트래픽 분석 문장 생성
  let trafficText = `${days}활성 사용자는 **${fmtNum(m.kpis.activeUsers)}명**`;
  if (userDelta !== null) {
    trafficText += `으로, 이전 기간 대비 **${fmtPct(userDelta)}**했습니다.`;
  } else {
    trafficText += '을 기록했습니다.';
  }

  // 주 유입 채널 결합
  if (m.topChannel) {
    trafficText += ` 이때 유입 기여도가 가장 높은 채널은 **${m.topChannel}**였습니다.`;
  }
  parts.push(trafficText);

  // 3. 전환(주요 이벤트) 성과 문장 생성
  if (m.kpis.keyEvents != null) {
    let convText = `비즈니스 핵심인 주요 이벤트(전환) 건수는 총 **${fmtNum(m.kpis.keyEvents)}건**입니다.`;
    if (convDelta !== null) {
      const linkWord = convDelta * (userDelta ?? 0) > 0 ? '흐름을 같이하며' : '흐름과 다르게';
      convText = `주요 이벤트(전환)는 총 **${fmtNum(m.kpis.keyEvents)}건**으로, 사용자 유입 ${linkWord} 이전 대비 **${fmtPct(convDelta)}**한 상태입니다.`;
    }
    parts.push(convText);
  }

  // 4. 리스크 관리 (이상 신호 Alert)
  if (m.anomalies?.length) {
    const a = m.anomalies[0];
    const directionText = a.direction === 'up' ? '🚨 급증' : '⚠️ 급락';
    parts.push(`\n[특이사항] ${a.date}에 ${a.metricLabel || '특정 지표'}가 평소 범위를 벗어나 **${directionText}**하는 이상 신호가 감지되어 모니터링이 필요합니다.`);
  }

  return parts.join('\n');
}

// ---------- Meta Ads 룰 베이스 요약 ----------
function fmtKrw(n) {
  return `${fmtNum(n)}원`;
}

function ruleBasedMetaSummary(m) {
  const parts = [];
  const days = m.spanDays ? `최근 ${m.spanDays}일간 ` : '';

  const spendDelta = pctChange(m.kpis.spend, m.prevKpis?.spend);
  const convDelta = m.kpis.ga4KeyEvents != null && m.prevKpis?.ga4KeyEvents
    ? pctChange(m.kpis.ga4KeyEvents, m.prevKpis.ga4KeyEvents)
    : null;

  // 1. 집행 효율 종합 판정
  let verdict = '📊 광고 집행 규모와 성과가 큰 변동 없이 유지되고 있습니다.';
  if (spendDelta !== null && convDelta !== null) {
    if (convDelta > 5 && convDelta >= spendDelta) verdict = '📈 광고비 대비 전환이 효율적으로 증가하며 집행 효율이 개선되고 있습니다.';
    else if (spendDelta > 5 && convDelta < 0) verdict = '⚠️ 광고비는 늘었지만 전환은 감소해 집행 효율 점검이 필요합니다.';
    else if (spendDelta < -5 && convDelta > 0) verdict = '📈 광고비를 줄였음에도 전환이 유지·증가해 효율이 좋아졌습니다.';
    else if (spendDelta < -5 && convDelta < -5) verdict = '📉 광고비 축소와 함께 전환도 감소한 추세입니다.';
  }
  parts.push(verdict);

  // 2. 집행 규모
  let spendText = `${days}메타 광고비는 총 **${fmtKrw(m.kpis.spend)}**`;
  spendText += spendDelta === null ? '이 집행되었습니다.' : `으로, 이전 기간 대비 **${fmtPct(spendDelta)}**했습니다.`;
  if (m.kpis.cpc) spendText += ` 평균 CPC는 **${fmtKrw(m.kpis.cpc)}**입니다.`;
  parts.push(spendText);

  // 3. 전환 성과 (GA4 매핑)
  if (m.kpis.ga4KeyEvents != null) {
    let convText = `GA4 매핑 기준 전환은 총 **${fmtNum(m.kpis.ga4KeyEvents)}건**`;
    convText += convDelta === null ? '입니다.' : `으로 이전 대비 **${fmtPct(convDelta)}**했습니다.`;
    if (m.kpis.cac) convText += ` 전환당 비용(CAC)은 **${fmtKrw(m.kpis.cac)}**입니다.`;
    if (m.kpis.roas) convText += ` ROAS는 **${(m.kpis.roas * 100).toFixed(0)}%**입니다.`;
    parts.push(convText);
  }

  // 4. 최고 지출 캠페인
  if (m.topCampaign) {
    parts.push(`지출 비중이 가장 큰 캠페인은 **${m.topCampaign}**입니다.`);
  }

  return parts.join('\n');
}

// ---------- Gemini 요약 ----------
async function geminiSummary(metrics, apiKey) {
  const domain = metrics.type === 'meta' ? 'Meta 광고 성과' : 'GA4 웹 분석';
  const prompt = [
    `당신은 ${domain} 대시보드의 요약 도우미입니다.`,
    `아래 ${domain} 지표 JSON을 보고, 마케터가 한눈에 파악할 수 있는 한국어 요약을 정확히 1~2문장으로 작성하세요.`,
    '수치는 JSON에 있는 값만 사용하고, 추측이나 조언은 하지 마세요. 존댓말(-습니다)로 끝내세요.',
    '',
    JSON.stringify(metrics),
  ].join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 1024,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      }
    );
    if (!r.ok) throw new Error(`Gemini HTTP ${r.status}`);
    const data = await r.json();
    const text = (data.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || '')
      .join('')
      .trim();
    if (!text) throw new Error('Gemini 응답이 비어 있습니다');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 핸들러 ----------
async function readBody(req) {
  if (req.body !== undefined) {
    return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST만 지원합니다.' });
  }

  let metrics;
  try {
    const body = await readBody(req);
    metrics = body?.metrics;
  } catch {
    return res.status(400).json({ error: '잘못된 JSON 본문입니다.' });
  }
  const isMeta = metrics?.type === 'meta';
  const requiredKey = isMeta ? 'spend' : 'activeUsers';
  if (!metrics?.kpis || typeof metrics.kpis[requiredKey] !== 'number') {
    return res.status(400).json({ error: `metrics.kpis.${requiredKey}가 필요합니다.` });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (apiKey) {
    try {
      const summary = await geminiSummary(metrics, apiKey);
      return res.status(200).json({ summary, source: 'gemini' });
    } catch (err) {
      // 속도 제한(429)·타임아웃·응답 이상 → 룰 베이스 폴백
      console.warn('[api/summary] Gemini 실패, 룰 베이스로 폴백:', err.message || err);
    }
  }

  const summary = isMeta ? ruleBasedMetaSummary(metrics) : ruleBasedSummary(metrics);
  return res.status(200).json({ summary, source: 'rule' });
};
