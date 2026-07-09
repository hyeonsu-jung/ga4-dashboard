// server.js — 로컬 개발용 (Vercel 배포 시에는 사용되지 않음)
// 실행: npm run dev  →  http://localhost:3000
const express = require('express');
const app = express();

app.use(express.json());
app.use(express.static('public'));

app.get('/api/dashboard', require('./api/dashboard'));
app.get('/api/realtime', require('./api/realtime'));
app.get('/api/auth/login', require('./api/auth/login'));
app.get('/api/auth/callback', require('./api/auth/callback'));
app.get('/api/auth/logout', require('./api/auth/logout'));
app.get('/api/auth/me', require('./api/auth/me'));
app.get('/api/properties', require('./api/properties'));
app.post('/api/select-property', require('./api/select-property'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`대시보드 로컬 서버: http://localhost:${PORT}`));
