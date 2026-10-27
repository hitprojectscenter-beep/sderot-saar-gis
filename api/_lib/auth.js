// Session auth for the API.
// Users live in the USERS_JSON environment variable as scrypt hashes (never in the repo).
// A login sets an HttpOnly cookie holding an HMAC-signed token.
import { createHmac, scryptSync, timingSafeEqual, randomBytes } from 'node:crypto';

const COOKIE = 'saar_session';
const SESSION_DAYS = 30; // long sessions: volunteers must not get logged out mid-event

export const ROLE_LABELS = {
  gis: 'אחראי GIS',
  commander: 'מפקד היחידה',
  deputy: 'סגן מפקד היחידה',
  team: 'מפקד צוות',
};

let usersCache;
function users() {
  if (usersCache) return usersCache;
  const raw = process.env.USERS_JSON;
  if (!raw) throw new Error('USERS_JSON is not configured');
  usersCache = JSON.parse(raw);
  return usersCache;
}

function secret() {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) throw new Error('AUTH_SECRET must be set (32+ chars)');
  return s;
}

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, 32).toString('hex');
  return { salt, hash };
}

/** Returns the public user record, or null when the credentials are wrong. */
export function verifyCredentials(username, password) {
  const all = users();
  // Usernames are matched case-insensitively ("gis_admin" works on a phone keyboard).
  const key = Object.keys(all).find((k) => k.toLowerCase() === String(username || '').trim().toLowerCase());
  const rec = key && all[key];
  // Always run scrypt so a wrong username takes as long as a wrong password.
  const { hash } = hashPassword(String(password || ''), rec ? rec.salt : 'no-such-user-salt');
  if (!rec) return null;
  const ok = timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(rec.hash, 'hex'));
  return ok ? publicUser(key, rec) : null;
}

function publicUser(username, rec) {
  return {
    username,
    role: rec.role,
    team: rec.team || null,
    label: rec.label || ROLE_LABELS[rec.role] || rec.role,
  };
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function signSession(user) {
  const payload = b64url(JSON.stringify({ u: user.username, exp: Date.now() + SESSION_DAYS * 864e5 }));
  const sig = b64url(createHmac('sha256', secret()).update(payload).digest());
  return `${payload}.${sig}`;
}

function readToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = b64url(createHmac('sha256', secret()).update(payload).digest());
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  if (!data.exp || data.exp < Date.now()) return null;
  const rec = users()[data.u];
  return rec ? publicUser(data.u, rec) : null; // a user removed from USERS_JSON loses access at once
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((p) => p.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]),
  );
}

export function currentUser(req) {
  const fromCookie = parseCookies(req.headers.cookie)[COOKIE];
  const auth = req.headers.authorization || '';
  const fromHeader = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  try {
    return readToken(fromCookie || fromHeader);
  } catch {
    return null;
  }
}

export function sessionCookie(token, req) {
  const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Sends 401 and returns null when the request has no valid session. */
export function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) {
    res.status(401).json({ error: 'נדרשת התחברות' });
    return null;
  }
  return user;
}

/** Commanders, the deputy and the GIS officer may delete anything; team commanders only their own items. */
export function canDelete(user, feature) {
  if (['gis', 'commander', 'deputy'].includes(user.role)) return true;
  return feature?.createdBy?.username === user.username;
}
