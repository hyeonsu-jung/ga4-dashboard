// server.js — 로컬 개발용 (Vercel 배포 시에는 사용되지 않음)
// 실행: npm run dev  →  http://localhost:3000
const express = require('express');
const app = express();

app.use(express.static('public'));
app.get('/api/dashboard', require('./api/dashboard'));
app.get('/api/realtime', require('./api/realtime'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`대시보드 로컬 서버: http://localhost:${PORT}`));
