// Builds the USERS_JSON value for the Vercel environment from a local, git-ignored file.
//
//   1. Create users.local.json (never commit it):
//      [{ "username": "GIS_Admin", "password": "…", "role": "gis" },
//       { "username": "GROUP1_Admin", "password": "…", "role": "team", "team": 1 }, …]
//      roles: gis | commander | deputy | team
//   2. node scripts/hash-users.mjs users.local.json > users.hashed.json
//   3. Paste the output into the USERS_JSON environment variable in Vercel and redeploy.
import { readFileSync } from 'node:fs';
import { hashPassword, ROLE_LABELS } from '../api/_lib/auth.js';

const file = process.argv[2] || 'users.local.json';
const list = JSON.parse(readFileSync(file, 'utf8'));
const out = {};
for (const u of list) {
  if (!u.username || !u.password || !ROLE_LABELS[u.role]) throw new Error(`invalid user entry: ${u.username}`);
  const { salt, hash } = hashPassword(u.password);
  const label = u.label || (u.role === 'team' ? `${ROLE_LABELS.team} ${u.team}` : ROLE_LABELS[u.role]);
  out[u.username] = { role: u.role, ...(u.team ? { team: u.team } : {}), label, salt, hash };
}
process.stdout.write(JSON.stringify(out));
