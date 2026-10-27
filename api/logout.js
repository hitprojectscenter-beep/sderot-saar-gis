// POST /api/logout → clears the session cookie
import { clearCookie } from './_lib/auth.js';

export default function handler(req, res) {
  res.setHeader('Set-Cookie', clearCookie());
  return res.status(200).json({ ok: true });
}
