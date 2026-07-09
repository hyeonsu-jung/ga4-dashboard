# GA4 웹 분석 대시보드

GA4 Data API(v1)를 연동해 웹에서 실시간으로 분석 데이터를 모니터링하는 대시보드입니다. PPT 수동 보고서를 대체하는 것이 목적입니다.

## 구성

```
ga4-dashboard/
├── api/
│   ├── _ga4.js        # GA4 클라이언트 공용 모듈 (인증, 데모 폴백)
│   ├── dashboard.js   # 대시보드 데이터 일괄 조회 (batchRunReports 5종)
│   └── realtime.js    # 실시간 활성 사용자 (runRealtimeReport)
├── public/
│   └── index.html     # 대시보드 프론트엔드 (Chart.js)
├── server.js          # 로컬 개발 서버 (Express)
└── vercel.json        # Vercel 배포 설정
```

## 제공 기능

- **KPI 카드 6종**: 활성 사용자, 신규 사용자, 세션, 이벤트 수, 주요 이벤트(전환), 평균 참여 시간 — 각 카드에 이전 동기간 대비 증감률 + 미니 스파크라인
- **일별 추이 차트**: 지표 토글 (사용자/세션/이벤트/주요 이벤트)
- **채널별 유입 / 인기 페이지** 테이블
- **조회 기간**: 오늘 · 최근 7일 · 최근 30일 · 이번 달 · 커스텀 범위, 이전 동기간 자동 비교
- **실시간 활성 사용자** (60초 주기 갱신)
- **일별 데이터 CSV 내려받기**
- 환경변수 미설정 시 **데모 데이터 모드**로 동작 (UI 먼저 검토 가능)

## 사전 준비 — 서비스 계정

GA4 MCP 연동 때 만든 서비스 계정을 그대로 재사용할 수 있습니다. 새로 만들 경우:

1. Google Cloud Console → IAM 및 관리자 → 서비스 계정 생성
2. 키(JSON) 발급
3. **Google Analytics Data API 활성화** (API 및 서비스 → 라이브러리)
4. GA4 관리 → 속성 액세스 관리 → 서비스 계정 이메일을 **뷰어(Viewer)** 권한으로 추가

## 로컬 실행

```bash
npm install
cp .env.example .env   # 값 입력 (비워두면 데모 모드)
npm run dev            # http://localhost:3000
```

로컬에서 환경변수를 쓰려면 `node --env-file=.env server.js`로 실행하거나 dotenv를 추가하세요.

## Vercel 배포

```bash
vercel
```

배포 후 Vercel 프로젝트 → Settings → Environment Variables에 아래 두 값을 등록하고 재배포합니다.

| 변수 | 값 |
|---|---|
| `GA4_PROPERTY_ID` | GA4 속성 ID (숫자, 예: 503025816) |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | 서비스 계정 키 JSON 원문, 또는 base64 인코딩 값 (`base64 -w0 key.json`) |

> 서비스 계정 키는 서버(서버리스 함수)에서만 사용되며 프론트엔드로 노출되지 않습니다. 키 파일을 저장소에 커밋하지 마세요 (.gitignore에 포함되어 있음).

## 주의사항 및 확장 포인트

- **GA4 API 할당량**: 속성당 시간당 토큰 제한이 있습니다. 사용자가 늘어나면 서버 측 캐시(예: 5분 TTL) 추가를 권장합니다.
- **KPI 목록 변경**: `api/dashboard.js`의 `KPI_METRICS`와 `public/index.html`의 `KPI_DEFS`를 함께 수정하면 됩니다. 지표/차원 이름은 [GA4 API Dimensions & Metrics] 문서 기준입니다.
- **내부 전용 접근 제어**: 현재 인증이 없으므로 사내 공개 전에 Vercel Password Protection, IP 제한, 또는 간단한 로그인(예: Supabase Auth)을 붙이는 것을 권장합니다.
- **배치 수집 파이프라인**: 현재는 조회 시점에 API를 호출하는 방식입니다. 이력 축적·가공이 필요해지면 n8n 스케줄 워크플로로 Supabase에 일별 적재하는 구조로 확장할 수 있습니다.
