# GA4 웹 분석 대시보드

GA4 Data API(v1)를 연동해 웹에서 실시간으로 분석 데이터를 모니터링하는 대시보드입니다. PPT 수동 보고서를 대체하는 것이 목적입니다.

## 구성

```
ga4-dashboard/
├── api/
│   ├── _ga4.js           # GA4 Data API 클라이언트 (OAuth 세션)
│   ├── _ga4-match.js     # GA4 매칭 조건 → Data API 필터 / 집계
│   ├── _match-store.js   # Meta 객체 ↔ GA4 매칭 설정 저장소
│   ├── _oauth.js         # Google OAuth2 + Admin API
│   ├── _session.js       # 서명된 세션 쿠키
│   ├── auth/             # 로그인/콜백/로그아웃 (동적 라우트)
│   ├── ga4-match/        # GA4 차원 값 목록 + 매칭 설정 CRUD
│   ├── dashboard.js      # 대시보드 데이터 일괄 조회
│   ├── meta-accounts.js  # Meta 광고계정 목록
│   ├── meta-dashboard.js # Meta 광고 성과 + GA4 매칭 집계
│   ├── properties.js     # GA4 속성 목록
│   ├── select-property.js
│   ├── summary.js        # 지표 한 줄 요약
│   └── realtime.js       # 실시간 활성 사용자
├── public/
│   ├── index.html        # GA4 대시보드 프론트엔드 (Chart.js)
│   └── meta.html         # Meta Ads 성과 대시보드
├── server.js             # 로컬 개발 서버 (Express)
└── vercel.json           # Vercel 배포 설정
```

## 제공 기능

- **Google OAuth 로그인** — 사용자 Google 계정으로 인증
- **GA4 속성 직접 선택** — 계정에 연결된 Analytics 속성 목록에서 선택
- **KPI 카드 6종**: 활성 사용자, 신규 사용자, 세션, 이벤트 수, 주요 이벤트(전환), 평균 참여 시간
- **일별 추이 차트**, **채널별 유입**, **인기 페이지** 테이블
- **실시간 활성 사용자** (60초 주기 갱신)
- **Meta 광고 성과 ↔ GA4 매칭** — Meta 캠페인/광고 세트/광고 소재별로 GA4 조건을 직접 지정
- **일별 데이터 CSV 내려받기**
- OAuth 미설정 시 **데모 데이터 모드**로 동작

## GA4 ↔ Meta 광고 성과 매칭

Meta 캠페인명과 GA4 캠페인명이 같지 않은 경우가 많아, **Meta 객체별로 어떤 GA4 데이터를
합산할지 사용자가 직접 지정**합니다.

`Meta Ads` 페이지 → **메타 광고 성과 상세** 테이블의 각 행 **[설정]** 버튼에서
아래 4개 조건을 고르면, 선택된 GA4 속성·조회 기간 기준으로 세션/전환/매출을 집계해
`GA4 세션`, `GA4 전환`, `CAC / ROAS` 컬럼에 표시합니다.

| 매칭 조건 | GA4 Data API dimension |
|---|---|
| GA4 캠페인 | `sessionCampaignName` |
| GA4 소스 | `sessionSource` |
| GA4 매체 | `sessionMedium` |
| GA4 광고 콘텐츠 | `sessionManualAdContent` |

- 한 항목 안의 여러 값은 **OR**, 항목 간에는 **AND**로 적용되며, 선택하지 않은 항목은 제약이 없습니다.
- 매칭 상태는 테이블에서 **● 매칭완료 / ◐ 자동 / ○ 미설정** 으로 표시됩니다.
  `◐ 자동`은 설정이 없는 캠페인에 대해 `campaign_name` = `sessionCampaignName` 완전 일치로 자동 매칭한 경우입니다.
- 설정은 **Meta 객체 ID + GA4 Property ID** 기준으로 저장하므로, 캠페인명이 바뀌어도 유지되고
  조회 기간을 바꾸면 같은 조건으로 재조회합니다. 캠페인뿐 아니라 광고 세트·광고 소재 단위로도 동일하게 설정할 수 있습니다.

### 저장 위치

| 환경 | 저장소 |
|---|---|
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` 설정 | Vercel KV / Upstash Redis (영구, 팀 공유) |
| 로컬 개발 | `.data/ga4-meta-match.json` 파일 |
| Vercel (KV 미설정) | `/tmp` (인스턴스 한정) + 브라우저 `localStorage` 사본으로 자동 복원 |

운영 환경에서는 **KV 설정을 권장**합니다. 미설정 시 설정한 브라우저에서만 매칭이 유지됩니다.

### 관련 엔드포인트

```
GET  /api/ga4-match/dimensions?startDate=&endDate=   GA4 캠페인/소스/매체/광고 콘텐츠 목록
GET  /api/ga4-match/mappings                         저장된 매칭 설정
POST /api/ga4-match/save     { level, objectId, objectName, conditions }
POST /api/ga4-match/delete   { level, objectId }
POST /api/ga4-match/restore  { mappings: [...] }
```

## 사전 준비 — Google OAuth

1. [Google Cloud Console](https://console.cloud.google.com/) → 프로젝트 선택/생성
2. **API 및 서비스 → 라이브러리**에서 아래 API 활성화:
   - Google Analytics Data API
   - Google Analytics Admin API
3. **API 및 서비스 → OAuth 동의 화면** 구성 (외부/내부, 테스트 사용자 등록)
4. **OAuth 동의 화면 → 데이터 액세스(Scopes)** 에 아래 스코프 추가:
   - `https://www.googleapis.com/auth/analytics.readonly` (Google Analytics 읽기)
   - 스코프를 추가·변경한 뒤에는 **반드시 로그아웃 후 재로그인**해야 적용됩니다.
5. **API 및 서비스 → 사용자 인증 정보** → **OAuth 2.0 클라이언트 ID** 생성
   - 유형: **웹 애플리케이션**
   - 승인된 리디렉션 URI:
     - 로컬: `http://localhost:3000/api/auth/callback`
     - Vercel: `https://<your-domain>.vercel.app/api/auth/callback`

## 로컬 실행

```bash
npm install
cp .env.example .env   # OAuth 값 입력 (비워두면 데모 모드)
node --env-file=.env server.js
# 또는: npm run dev (환경변수는 .env 파일을 직접 로드하도록 설정 필요)
```

`.env` 예시:

| 변수 | 값 |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth 클라이언트 ID |
| `GOOGLE_CLIENT_SECRET` | OAuth 클라이언트 시크릿 |
| `GOOGLE_REDIRECT_URI` | `http://localhost:3000/api/auth/callback` |
| `SESSION_SECRET` | 임의의 긴 랜덤 문자열 |

## Vercel 배포

```bash
vercel
```

Vercel 프로젝트 → **Settings → Environment Variables**:

| 변수 | 값 |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth 클라이언트 ID |
| `GOOGLE_CLIENT_SECRET` | OAuth 클라이언트 시크릿 |
| `SESSION_SECRET` | 임의의 긴 랜덤 문자열 |

`GOOGLE_REDIRECT_URI`는 Vercel 도메인 기준으로 자동 설정됩니다. 커스텀 도메인을 쓰면 `https://<도메인>/api/auth/callback`을 Google Cloud 리디렉션 URI와 Vercel 환경변수에 모두 등록하세요.

## 사용 흐름

1. 대시보드 접속 → **Google로 로그인**
2. 로그인 후 **GA4 속성 선택** 모달에서 속성 선택
3. 선택한 속성의 데이터가 대시보드에 표시됨
4. 헤더의 **속성 변경**으로 다른 속성으로 전환 가능

## 주의사항

- **GA4 API 할당량**: 속성당 시간당 토큰 제한이 있습니다.
- **OAuth 동의 화면**: 프로덕션 공개 전에 Google 검증이 필요할 수 있습니다. 개발 중에는 테스트 사용자로 등록된 계정만 로그인 가능합니다.
- **KPI 목록 변경**: `api/dashboard.js`의 `KPI_METRICS`와 `public/index.html`의 `KPI_DEFS`를 함께 수정하세요.
- **GA4 매칭 설정 저장**: 운영 환경에서 매칭을 팀 단위로 공유하려면 `KV_REST_API_URL`·`KV_REST_API_TOKEN`을 설정하세요.
