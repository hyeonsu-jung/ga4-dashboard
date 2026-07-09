# GA4 웹 분석 대시보드

GA4 Data API(v1)를 연동해 웹에서 실시간으로 분석 데이터를 모니터링하는 대시보드입니다. PPT 수동 보고서를 대체하는 것이 목적입니다.

## 구성

```
ga4-dashboard/
├── api/
│   ├── _ga4.js           # GA4 Data API 클라이언트 (OAuth 세션)
│   ├── _oauth.js         # Google OAuth2 + Admin API
│   ├── _session.js       # 서명된 세션 쿠키
│   ├── auth/             # 로그인/콜백/로그아웃
│   ├── dashboard.js      # 대시보드 데이터 일괄 조회
│   ├── properties.js     # GA4 속성 목록
│   ├── select-property.js
│   └── realtime.js       # 실시간 활성 사용자
├── public/
│   └── index.html        # 대시보드 프론트엔드 (Chart.js)
├── server.js             # 로컬 개발 서버 (Express)
└── vercel.json           # Vercel 배포 설정
```

## 제공 기능

- **Google OAuth 로그인** — 사용자 Google 계정으로 인증
- **GA4 속성 직접 선택** — 계정에 연결된 Analytics 속성 목록에서 선택
- **KPI 카드 6종**: 활성 사용자, 신규 사용자, 세션, 이벤트 수, 주요 이벤트(전환), 평균 참여 시간
- **일별 추이 차트**, **채널별 유입**, **인기 페이지** 테이블
- **실시간 활성 사용자** (60초 주기 갱신)
- **일별 데이터 CSV 내려받기**
- OAuth 미설정 시 **데모 데이터 모드**로 동작

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
