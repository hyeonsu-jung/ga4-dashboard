// api/select-property.js — GA4 속성 선택 (POST)
const { getAuthenticatedClient, listGa4Properties } = require('./_oauth');
const { isOAuthConfigured, setSession } = require('./_session');

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

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'POST만 허용됩니다.' });
    }
    if (!isOAuthConfigured()) {
      return res.status(503).json({ error: 'OAuth가 설정되지 않았습니다.' });
    }

    const auth = await getAuthenticatedClient(req, res);
    if (!auth) {
      return res.status(401).json({ error: 'LOGIN_REQUIRED' });
    }

    const body = await readBody(req);
    const propertyId = String(body.propertyId || '').replace(/\D/g, '');
    if (!propertyId) {
      return res.status(400).json({ error: 'propertyId가 필요합니다.' });
    }

    const properties = await listGa4Properties(auth.session.accessToken);
    const selected = properties.find((p) => p.propertyId === propertyId);
    if (!selected) {
      return res.status(403).json({ error: '접근 권한이 없는 속성입니다.' });
    }

    const session = {
      ...auth.session,
      propertyId: selected.propertyId,
      propertyName: selected.propertyName,
    };
    setSession(res, session);

    res.status(200).json({
      ok: true,
      propertyId: session.propertyId,
      propertyName: session.propertyName,
    });
  } catch (err) {
    console.error('[api/select-property]', err);
    res.status(500).json({ error: '속성 선택에 실패했습니다.', detail: String(err.message || err) });
  }
};
