// GET  /api/features            → { features: [...], updatedAt }  (public; ETag / If-None-Match → 304)
// POST /api/features {ops:[…]}  → apply upserts and deletes in one atomic write (editors only)
//   op: { op: 'upsert', feature: {id, geometry, name, description, photos, layer} }
//   op: { op: 'delete', id }
import { requireUser, canDelete } from './_lib/auth.js';
import { readObject, updateFeatures, FEATURES_PATH } from './_lib/store.js';
import { cleanFeatureInput, ValidationError, ID_RE } from './_lib/validate.js';

const MAX_OPS = 200;
const HISTORY_LIMIT = 30;

export default async function handler(req, res) {
  try {
    // Viewing is open to everyone; only the unit's editors may change data.
    if (req.method === 'GET') return await list(req, res);
    if (req.method === 'POST') {
      const user = requireUser(req, res);
      if (!user) return;
      return await apply(req, res, user);
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: e.message || 'שגיאת שרת' });
  }
}

async function list(req, res) {
  const obj = await readObject(FEATURES_PATH, { ifNoneMatch: req.headers['if-none-match'] });
  res.setHeader('Cache-Control', 'private, no-cache');
  if (!obj) return res.status(200).json({ features: [], updatedAt: null });
  res.setHeader('ETag', obj.etag);
  if (obj.status === 304) return res.status(304).end();
  const doc = JSON.parse(obj.body.toString('utf8'));
  return res.status(200).json({ features: Object.values(doc.features || {}), updatedAt: doc.updatedAt });
}

async function apply(req, res, user) {
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
  const ops = Array.isArray(body.ops) ? body.ops : [];
  if (!ops.length) throw new ValidationError('אין פעולות לביצוע');
  if (ops.length > MAX_OPS) throw new ValidationError('יותר מדי פעולות בבקשה אחת');
  // Validate everything before touching storage, so one bad item fails fast.
  const cleaned = ops.map((op) => {
    if (op.op === 'upsert') return { op: 'upsert', input: cleanFeatureInput(op.feature) };
    if (op.op === 'delete' && ID_RE.test(op.id || '')) return { op: 'delete', id: op.id };
    throw new ValidationError('פעולה לא מוכרת');
  });

  const by = { username: user.username, label: user.label };
  const { result, etag } = await updateFeatures((doc) => {
    doc.features ||= {};
    const now = new Date().toISOString();
    return cleaned.map((c) => {
      if (c.op === 'delete') {
        const existing = doc.features[c.id];
        if (!existing) return { id: c.id, ok: true }; // already gone
        if (!canDelete(user, existing)) return { id: c.id, ok: false, error: 'אין הרשאה למחוק נתון של משתמש אחר' };
        delete doc.features[c.id];
        return { id: c.id, ok: true, deleted: true };
      }
      const { input } = c;
      const existing = doc.features[input.id];
      const history = [...(existing?.history || []), { at: now, by, action: existing ? 'עדכון' : 'יצירה' }].slice(-HISTORY_LIMIT);
      const feature = {
        id: input.id,
        layer: input.layer,
        autoLayer: input.autoLayer,
        name: input.name,
        description: input.description,
        photos: input.photos,
        geometry: input.geometry,
        createdBy: existing?.createdBy || by,
        createdAt: existing?.createdAt || now,
        updatedBy: by,
        updatedAt: now,
        history,
      };
      doc.features[input.id] = feature;
      return { id: input.id, ok: true, feature };
    });
  });
  res.setHeader('ETag', etag);
  return res.status(200).json({ results: result });
}
