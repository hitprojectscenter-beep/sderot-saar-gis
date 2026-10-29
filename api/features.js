// GET  /api/features            → { features: [...], events: [...], updatedAt }  (public; ETag / If-None-Match → 304)
// POST /api/features {ops:[…]}  → apply all operations in one atomic write (editors only)
//   op: { op: 'upsert', feature: {id, geometry, name, description, photos, layer, eventId?, observedAt?} }
//   op: { op: 'delete', id }
//   op: { op: 'event', event: {id, action: open|update|close|reopen, name, type, description, at?} }
//
// Items of the event layers belong to one incident (eventId). They are never erased: a delete marks
// them deleted, and every change keeps a snapshot in the history, so an incident can be replayed
// on the map from its first report to its end.
import { requireUser, canDelete, currentUser } from './_lib/auth.js';
import { readObject, updateFeatures, FEATURES_PATH } from './_lib/store.js';
import { cleanFeatureInput, cleanEventInput, ValidationError, ID_RE } from './_lib/validate.js';
import { isEventLayer, isEditorOnlyLayer } from '../public/js/layers.js';
import { readJson } from './_lib/body.js';

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
  // Viewers and editors get different bodies (the "general" layers are for editors only),
  // so each gets its own ETag variant.
  const editor = !!currentUser(req);
  const variant = editor ? 'e' : 'v';
  const tagged = (etag) => `${etag.replace(/"$/, '')}-${variant}"`;
  const inm = req.headers['if-none-match'] || '';
  const sameVariant = inm.endsWith(`-${variant}"`);
  const obj = await readObject(FEATURES_PATH, { ifNoneMatch: sameVariant ? inm.replace(`-${variant}"`, '"') : undefined });
  res.setHeader('Cache-Control', 'private, no-cache');
  res.setHeader('Vary', 'Cookie');
  if (!obj) return res.status(200).json({ features: [], events: [], updatedAt: null });
  res.setHeader('ETag', tagged(obj.etag));
  if (obj.status === 304) return res.status(304).end();
  const doc = JSON.parse(obj.body.toString('utf8'));
  let features = Object.values(doc.features || {});
  if (!editor) features = features.filter((f) => !isEditorOnlyLayer(f.layer));
  return res.status(200).json({ features, events: Object.values(doc.events || {}), updatedAt: doc.updatedAt });
}

async function apply(req, res, user) {
  const body = readJson(req);
  if (!body) throw new ValidationError('גוף הבקשה אינו JSON תקין');
  const ops = Array.isArray(body.ops) ? body.ops : [];
  if (!ops.length) throw new ValidationError('אין פעולות לביצוע');
  if (ops.length > MAX_OPS) throw new ValidationError('יותר מדי פעולות בבקשה אחת');
  // Validate everything before touching storage, so one bad item fails fast.
  const cleaned = ops.map((op) => {
    if (op.op === 'upsert') return { op: 'upsert', input: cleanFeatureInput(op.feature) };
    if (op.op === 'delete' && ID_RE.test(op.id || '')) return { op: 'delete', id: op.id, at: op.at };
    if (op.op === 'event') return { op: 'event', input: cleanEventInput(op.event) };
    throw new ValidationError('פעולה לא מוכרת');
  });

  const by = { username: user.username, label: user.label };
  const isManager = ['gis', 'commander', 'deputy'].includes(user.role);
  const { result, etag } = await updateFeatures((doc) => {
    doc.features ||= {};
    doc.events ||= {};
    const now = new Date().toISOString();
    return cleaned.map((c) => {
      if (c.op === 'event') return applyEvent(doc, c.input, by, isManager, now);

      if (c.op === 'delete') {
        const existing = doc.features[c.id];
        if (!existing || existing.deletedAt) return { id: c.id, ok: true }; // already gone
        if (!canDelete(user, existing)) return { id: c.id, ok: false, error: 'אין הרשאה למחוק נתון של משתמש אחר' };
        if (existing.eventId) {
          // Keep it for the replay: the item disappears from the map at this moment.
          const t = cleanTimeOr(c.at, now);
          existing.deletedAt = t;
          existing.deletedBy = by;
          existing.history = [...(existing.history || []), { at: now, t, by, action: 'מחיקה', state: null }].slice(-HISTORY_LIMIT);
        } else {
          delete doc.features[c.id];
        }
        return { id: c.id, ok: true, deleted: true };
      }

      const { input } = c;
      const existing = doc.features[input.id];
      let eventId = null;
      if (isEventLayer(input.layer)) {
        eventId = input.eventId || existing?.eventId || null;
        if (!eventId || !doc.events[eventId]) return { id: input.id, ok: false, error: `„${input.name}”: נתון בשכבת אירוע חייב להיות משויך לאירוע` };
      }
      const t = input.observedAt || now;
      const state = eventId ? { layer: input.layer, name: input.name, description: input.description.slice(0, 300), geometry: input.geometry } : undefined;
      const entry = { at: now, t, by, action: existing && !existing.deletedAt ? 'עדכון' : 'יצירה', ...(state ? { state } : {}) };
      const history = [...(existing?.history || []), entry].slice(-HISTORY_LIMIT);
      const feature = {
        id: input.id,
        layer: input.layer,
        autoLayer: input.autoLayer,
        name: input.name,
        description: input.description,
        photos: input.photos,
        geometry: input.geometry,
        ...(eventId ? { eventId } : {}),
        createdBy: existing?.createdBy || by,
        createdAt: existing?.createdAt || now,
        observedAt: existing?.observedAt || t,
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

const cleanTimeOr = (t, fallback) => {
  const ms = Date.parse(t || '');
  return Number.isFinite(ms) && ms <= Date.now() + 5 * 60e3 && ms > Date.now() - 7 * 864e5 ? new Date(Math.min(ms, Date.now())).toISOString() : fallback;
};

/** Open, update, close or reopen an incident. Anyone in the unit may open one (the first to see it raises the alarm). */
function applyEvent(doc, input, by, isManager, now) {
  const existing = doc.events[input.id];
  const t = input.at || now;
  if (input.action === 'open') {
    if (existing) return { id: input.id, ok: true, event: existing };
    const event = { id: input.id, name: input.name, type: input.type, description: input.description, status: 'active', startedAt: t, createdBy: by, createdAt: now };
    doc.events[input.id] = event;
    return { id: input.id, ok: true, event };
  }
  if (!existing) return { id: input.id, ok: false, error: 'האירוע לא נמצא' };
  if (!isManager && existing.createdBy?.username !== by.username) return { id: input.id, ok: false, error: 'רק מפקד, סגן או אחראי GIS יכולים לשנות אירוע שפתח מישהו אחר' };
  if (input.action === 'update') {
    if (input.name) existing.name = input.name;
    existing.type = input.type || existing.type;
    existing.description = input.description;
  } else if (input.action === 'close') {
    existing.status = 'closed';
    existing.endedAt = t;
    existing.closedBy = by;
  } else if (input.action === 'reopen') {
    existing.status = 'active';
    delete existing.endedAt;
    delete existing.closedBy;
  }
  existing.updatedAt = now;
  existing.updatedBy = by;
  return { id: input.id, ok: true, event: existing };
}
