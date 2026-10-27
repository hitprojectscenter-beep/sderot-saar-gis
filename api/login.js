// POST /api/login {username, password} → sets the session cookie
import { verifyCredentials, signSession, sessionCookie } from './_lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  let user;
  try {
    user = verifyCredentials(body.username, body.password);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'המערכת עדיין לא הוגדרה: חסרים משתני הסביבה USERS_JSON / AUTH_SECRET ב-Vercel' });
  }
  if (!process.env.AUTH_SECRET) return res.status(500).json({ error: 'המערכת עדיין לא הוגדרה: חסר משתנה הסביבה AUTH_SECRET ב-Vercel' });
  if (!user) {
    await new Promise((r) => setTimeout(r, 600)); // slow down guessing
    return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });
  }
  const token = signSession(user);
  res.setHeader('Set-Cookie', sessionCookie(token, req));
  return res.status(200).json({ user });
}
