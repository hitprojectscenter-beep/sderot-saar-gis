// POST /api/photo {data: "data:image/jpeg;base64,…"} → { id }
// GET  /api/photo?id=…                               → the image (logged-in users only)
import { randomUUID } from 'node:crypto';
import { requireUser } from './_lib/auth.js';
import { readObject, writeObject } from './_lib/store.js';
import { ID_RE } from './_lib/validate.js';

const MAX_BYTES = 3 * 1024 * 1024;
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export default async function handler(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  try {
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
      const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(body.data || '');
      if (!m) return res.status(400).json({ error: 'קובץ תמונה לא תקין' });
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > MAX_BYTES) return res.status(413).json({ error: 'התמונה גדולה מדי' });
      const id = ID_RE.test(body.id || '') ? body.id : randomUUID();
      await writeObject(`photos/${id}.${TYPES[m[1]]}`, buf, { contentType: m[1] });
      return res.status(200).json({ id: `${id}.${TYPES[m[1]]}`.replace(/\./g, '_') });
    }
    if (req.method === 'GET') {
      const id = String(req.query?.id || new URL(req.url, 'http://x').searchParams.get('id') || '');
      const m = /^([A-Za-z0-9-]{8,64})_(jpg|png|webp)$/.exec(id);
      if (!m) return res.status(400).json({ error: 'מזהה תמונה לא תקין' });
      const obj = await readObject(`photos/${m[1]}.${m[2]}`);
      if (!obj) return res.status(404).json({ error: 'התמונה לא נמצאה' });
      res.setHeader('Content-Type', obj.contentType || 'image/jpeg');
      res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
      return res.status(200).send(obj.body);
    }
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'שגיאת שרת' });
  }
}
