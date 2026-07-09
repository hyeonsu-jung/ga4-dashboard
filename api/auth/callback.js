// api/auth/callback.js — Google OAuth 콜백
const {
  isOAuthConfigured,
  getOAuthState,
  clearOAuthState,
  setSession,
} = require('../_session');
const { exchangeCode } = require('../_oauth');

function redirect(res, path) {
  res.writeHead(302, { Location: path });
  res.end();
}

module.exports = async (req, res) => {
  try {
    if (!isOAuthConfigured()) {
      return redirect(res, '/?auth_error=oauth_not_configured');
    }

    const { code, state, error } = req.query || {};
    if (error) {
      return redirect(res, `/?auth_error=${encodeURIComponent(error)}`);
    }
    if (!code || !state) {
      return redirect(res, '/?auth_error=missing_code');
    }
    if (state !== getOAuthState(req)) {
      return redirect(res, '/?auth_error=invalid_state');
    }

    clearOAuthState(res);
    const tokens = await exchangeCode(req, code);
    setSession(res, {
      ...tokens,
      propertyId: null,
      propertyName: null,
    });

    redirect(res, '/?auth=success');
  } catch (err) {
    console.error('[api/auth/callback]', err);
    redirect(res, `/?auth_error=${encodeURIComponent(err.message || 'callback_failed')}`);
  }
};
