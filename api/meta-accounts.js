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
    url.searchParams.set('limit', '100');

    // 페이지네이션 (최대 5페이지 = 500개)
    for (let page = 0; page < 5 && url; page++) {
      const r = await fetch(url);
      const data = await r.json();
      if (!r.ok || data.error) {
        throw new Error(data.error?.message || `Meta API HTTP ${r.status}`);
      }
      for (const a of data.data || []) {
        accounts.push({
          accountId: a.account_id,             // 숫자 ID (act_ 제외)
          name: a.name || `계정 ${a.account_id}`,
          active: a.account_status === 1,
        });
      }
      url = data.paging?.next ? new URL(data.paging.next) : null;
    }

    // 활성 계정 우선, 이름순
    accounts.sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name, 'ko'));
    res.status(200).json({ configured: true, accounts });
  } catch (err) {
    console.error('[api/meta-accounts]', err);
    res.status(500).json({ error: '광고계정 목록 조회에 실패했습니다.', detail: String(err.message || err) });
  }
};
