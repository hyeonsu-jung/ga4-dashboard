// api/_match-store.js — Meta 객체 ↔ GA4 매칭 조건 저장소
//
// 저장 Key: GA4 Property ID + Meta 객체 레벨 + Meta 객체 ID
//   (캠페인명은 변경될 수 있으므로 Key로 쓰지 않는다. 광고 세트/소재로 확장 가능)
//
// 백엔드 우선순위
//   1) Vercel KV / Upstash Redis REST  — KV_REST_API_URL + KV_REST_API_TOKEN 설정 시 (영구)
//   2) 파일                            — 로컬 개발은 .data/, Vercel은 /tmp (인스턴스 한정)
//   3) 메모리                          — 파일 쓰기 실패 시 최후 폴백
//
// 주의: Vercel에서는 API 라우트마다 별도 함수(별도 /tmp·메모리)로 실행되므로,
// KV가 없으면 ga4-match에 저장한 설정을 meta-dashboard가 읽을 수 없다.
// 그래서 영구 백엔드가 없으면 persistent: false 를 반환하고, 프론트가 보관 중인
// localStorage 사본을 요청에 함께 실어 보내 mergeClientMappings()로 보충한다.

const fs = require('fs');
const path = require('path');

const LEVELS = ['campaign', 'adset', 'ad'];
const DIMENSION_KEYS = ['campaign', 'source', 'medium', 'content'];
const KV_KEY = 'ga4-meta-match';
const MAX_VALUES_PER_DIMENSION = 50;
const MAX_MAPPINGS_PER_PROPERTY = 500;

const memoryStore = { data: null };

function kvConfigured() {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

function filePath() {
  if (process.env.GA4_MATCH_STORE_PATH) return process.env.GA4_MATCH_STORE_PATH;
  if (process.env.VERCEL) return path.join('/tmp', 'ga4-meta-match.json');
  return path.join(process.cwd(), '.data', 'ga4-meta-match.json');
}

function backendName() {
  if (kvConfigured()) return 'kv';
  return memoryStore.fileBroken ? 'memory' : 'file';
}

function isPersistent() {
  // 파일 백엔드는 로컬 개발에서만 영구적이다 (Vercel은 /tmp = 인스턴스 한정)
  return kvConfigured() || (backendName() === 'file' && !process.env.VERCEL);
}

// ---------- 정규화 ----------

function normalizeValues(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const v = String(raw ?? '').trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= MAX_VALUES_PER_DIMENSION) break;
  }
  return out;
}

function normalizeConditions(conditions) {
  const out = {};
  for (const key of DIMENSION_KEYS) out[key] = normalizeValues(conditions?.[key]);
  return out;
}

function hasAnyCondition(conditions) {
  return DIMENSION_KEYS.some((k) => (conditions?.[k] || []).length > 0);
}

function mappingKey(level, objectId) {
  return `${level}:${objectId}`;
}

function normalizeMapping(input) {
  const level = LEVELS.includes(input?.level) ? input.level : 'campaign';
  const objectId = String(input?.objectId ?? '').trim();
  if (!objectId || !/^[\w.-]{1,64}$/.test(objectId)) return null;
  const conditions = normalizeConditions(input?.conditions);
  if (!hasAnyCondition(conditions)) return null;
  return {
    level,
    objectId,
    objectName: String(input?.objectName ?? '').trim().slice(0, 300) || null,
    conditions,
    updatedAt: new Date().toISOString(),
  };
}

// ---------- 백엔드 I/O ----------

async function kvFetch(command) {
  const r = await fetch(process.env.KV_REST_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  const data = await r.json();
  if (!r.ok || data.error) throw new Error(data.error || `KV HTTP ${r.status}`);
  return data.result;
}

async function readAll() {
  if (kvConfigured()) {
    try {
      const raw = await kvFetch(['GET', KV_KEY]);
      return raw ? JSON.parse(raw) : {};
    } catch (err) {
      console.warn('[api/_match-store] KV 읽기 실패:', err.message || err);
      return {};
    }
  }
  if (memoryStore.data) return memoryStore.data;
  try {
    const raw = fs.readFileSync(filePath(), 'utf8');
    memoryStore.data = JSON.parse(raw) || {};
  } catch {
    memoryStore.data = {};
  }
  return memoryStore.data;
}

async function writeAll(all) {
  if (kvConfigured()) {
    await kvFetch(['SET', KV_KEY, JSON.stringify(all)]);
    return;
  }
  memoryStore.data = all;
  try {
    const file = filePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(all, null, 2), 'utf8');
    memoryStore.fileBroken = false;
  } catch (err) {
    memoryStore.fileBroken = true;
    console.warn('[api/_match-store] 파일 저장 실패, 메모리로 유지:', err.message || err);
  }
}

// ---------- 공개 API ----------

async function listMappings(propertyId) {
  if (!propertyId) return [];
  const all = await readAll();
  return Object.values(all[String(propertyId)] || {});
}

// 레벨별 objectId → mapping 조회용 Map
async function mappingIndex(propertyId, level) {
  const map = new Map();
  for (const m of await listMappings(propertyId)) {
    if (m.level === level) map.set(String(m.objectId), m);
  }
  return map;
}

async function saveMapping(propertyId, input) {
  const mapping = normalizeMapping(input);
  if (!mapping) return null;
  const all = await readAll();
  const key = String(propertyId);
  const bucket = { ...(all[key] || {}) };
  if (!bucket[mappingKey(mapping.level, mapping.objectId)] && Object.keys(bucket).length >= MAX_MAPPINGS_PER_PROPERTY) {
    throw new Error(`속성당 매칭 설정은 최대 ${MAX_MAPPINGS_PER_PROPERTY}개까지 저장할 수 있습니다.`);
  }
  bucket[mappingKey(mapping.level, mapping.objectId)] = mapping;
  await writeAll({ ...all, [key]: bucket });
  return mapping;
}

async function deleteMapping(propertyId, level, objectId) {
  const all = await readAll();
  const key = String(propertyId);
  const bucket = { ...(all[key] || {}) };
  const k = mappingKey(level, String(objectId));
  if (!bucket[k]) return false;
  delete bucket[k];
  await writeAll({ ...all, [key]: bucket });
  return true;
}

// 프론트가 보낸 매칭 설정으로 서버 인덱스를 보충한다 (서버에 있는 값이 우선).
// 영구 저장소가 없어 서버 인덱스가 비어 있는 환경에서 실제 매칭을 담당한다.
function mergeClientMappings(index, clientMappings, level) {
  let added = 0;
  const list = Array.isArray(clientMappings) ? clientMappings.slice(0, MAX_MAPPINGS_PER_PROPERTY) : [];
  for (const input of list) {
    const mapping = normalizeMapping(input);
    if (!mapping || mapping.level !== level) continue;
    if (index.has(mapping.objectId)) continue;
    index.set(mapping.objectId, { ...mapping, updatedAt: input.updatedAt || mapping.updatedAt });
    added++;
  }
  return added;
}

// 서버 저장소가 비휘발성이 아닐 때 프론트 localStorage 사본으로 복원
async function restoreMappings(propertyId, mappings) {
  const all = await readAll();
  const key = String(propertyId);
  const bucket = { ...(all[key] || {}) };
  let restored = 0;
  for (const input of Array.isArray(mappings) ? mappings.slice(0, MAX_MAPPINGS_PER_PROPERTY) : []) {
    const mapping = normalizeMapping(input);
    if (!mapping) continue;
    const k = mappingKey(mapping.level, mapping.objectId);
    if (bucket[k]) continue; // 서버 값이 우선
    // 복원 시각이 아니라 원본 저장 시각을 유지
    bucket[k] = { ...mapping, updatedAt: input.updatedAt || mapping.updatedAt };
    restored++;
  }
  if (restored) await writeAll({ ...all, [key]: bucket });
  return restored;
}

module.exports = {
  LEVELS,
  DIMENSION_KEYS,
  backendName,
  isPersistent,
  normalizeConditions,
  hasAnyCondition,
  listMappings,
  mappingIndex,
  mergeClientMappings,
  saveMapping,
  deleteMapping,
  restoreMappings,
};
