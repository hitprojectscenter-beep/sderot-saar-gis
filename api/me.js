// GET /api/me → the logged-in user, or 401
import { requireUser } from './_lib/auth.js';

export default function handler(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json({ user, storage: process.env.BLOB_READ_WRITE_TOKEN ? 'blob' : 'local' });
}
