// api/meta-accounts.js — 토큰이 접근 가능한 Meta 광고계정 목록
// GET /api/meta-accounts
// META_ACCESS_TOKEN 미설정 시 { configured: false } 반환 (프론트는 데모 모드로 동작)

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0';

module.exports = async (req, res) => {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) {
    return res.status(200).json({ configured: false, accounts: [] });
  }

  try {
    const accounts = [];
    let url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/me/adaccounts`);
    url.searchParams.set('access_token', token);
    url.searchParams.set('fields', 'name,account_id,account_status');
    // 주의: /me/adaccounts 엣지는 account_status에 대한 filtering 파라미터를
    // 지원하지 않으므로(#100), 전체를 받아 서버 함수에서 활성만 걸러 응답한다.
    url.searchParams.set('limit', '200');

    // 전체 페이지 순회 (무한 루프 방지용 안전 상한 200페이지 = 4만 개)
    for (let page = 0; page < 200 && url; page++) {
      const r = await fetch(url);
      const data = await r.json();
      if (!r.ok || data.error) {
        throw new Error(data.error?.message || `Meta API HTTP ${r.status}`);
      }
      for (const a of data.data || []) {
        if (a.account_status !== 1) continue; // 활성 계정만 응답에 포함
        accounts.push({
          accountId: a.account_id,             // 숫자 ID (act_ 제외)
          name: a.name || `계정 ${a.account_id}`,
        });
      }
      url = data.paging?.next ? new URL(data.paging.next) : null;
    }

    accounts.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    res.status(200).json({ configured: true, accounts });
  } catch (err) {
    console.error('[api/meta-accounts]', err);
    res.status(500).json({ error: '광고계정 목록 조회에 실패했습니다.', detail: String(err.message || err) });
  }
};
