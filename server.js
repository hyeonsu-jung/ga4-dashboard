// server.js — 로컬 개발용 (Vercel 배포 시에는 사용되지 않음)
// 실행: npm run dev  →  http://localhost:3000
const express = require('express');
const app = express();

app.use(express.json());
app.use(express.static('public'));

// Vercel 동적 라우트([action].js)를 Express에서 그대로 재사용하기 위한 어댑터.
// Express 5의 req.query는 getter라 직접 대입할 수 없으므로 재정의한다.
function dynamicRoute(handler) {
  return (req, res, next) => {
    Object.defineProperty(req, 'query', {
      value: { ...req.query, action: req.params.action },
      writable: true,
      configurable: true,
    });
    Promise.resolve(handler(req, res)).catch(next);
  };
}

const authHandler = require('./api/auth/[action].js');
app.get('/api/auth/:action', dynamicRoute(authHandler));

const ga4MatchHandler = require('./api/ga4-match/[action].js');
app.get('/api/ga4-match/:action', dynamicRoute(ga4MatchHandler));
app.post('/api/ga4-match/:action', dynamicRoute(ga4MatchHandler));

app.get('/api/dashboard', require('./api/dashboard'));
app.get('/api/realtime', require('./api/realtime'));
app.get('/api/properties', require('./api/properties'));
app.post('/api/select-property', require('./api/select-property'));
app.get('/api/meta-accounts', require('./api/meta-accounts'));
const metaDashboardHandler = require('./api/meta-dashboard');
app.get('/api/meta-dashboard', metaDashboardHandler);
app.post('/api/meta-dashboard', metaDashboardHandler);
app.post('/api/summary', require('./api/summary'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`대시보드 로컬 서버: http://localhost:${PORT}`));
