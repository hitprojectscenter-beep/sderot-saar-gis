// GET /api/base → base layers imported from OpenStreetMap (streets, neighborhoods, hydrants, …)
// PUT /api/base → replace them (GIS officer only)
import { requireUser } from './_lib/auth.js';
import { readObject, writeObject, BASE_PATH } from './_lib/store.js';

export default async function handler(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  try {
    if (req.method === 'GET') {
      const obj = await readObject(BASE_PATH, { ifNoneMatch: req.headers['if-none-match'] });
      res.setHeader('Cache-Control', 'private, no-cache');
      if (!obj) return res.status(200).json({ type: 'FeatureCollection', features: [], importedAt: null });
      res.setHeader('ETag', obj.etag);
      if (obj.status === 304) return res.status(304).end();
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(200).send(obj.body);
    }
    if (req.method === 'PUT') {
      if (user.role !== 'gis') return res.status(403).json({ error: 'רק אחראי GIS יכול לעדכן שכבות בסיס' });
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if (body?.type !== 'FeatureCollection' || !Array.isArray(body.features)) {
        return res.status(400).json({ error: 'נדרש GeoJSON FeatureCollection' });
      }
      const doc = { type: 'FeatureCollection', features: body.features, importedAt: new Date().toISOString(), importedBy: user.username, source: body.source || 'OpenStreetMap' };
      await writeObject(BASE_PATH, JSON.stringify(doc));
      return res.status(200).json({ ok: true, count: doc.features.length });
    }
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'שגיאת שרת' });
  }
}
