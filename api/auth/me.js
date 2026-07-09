// api/auth/me.js — 현재 인증 상태
const { publicAuthState } = require('../_session');

module.exports = async (req, res) => {
  res.status(200).json(publicAuthState(req));
};
