// Input validation for features coming from the field apps.
import { classify, isValidLayer, baseGeomType, EVENT_TYPES } from '../../public/js/layers.js';

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_VERTICES = 5000;

export class ValidationError extends Error {}

function checkPosition(p) {
  if (!Array.isArray(p) || p.length < 2) throw new ValidationError('קואורדינטה לא תקינה');
  const [lon, lat] = p;
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) {
    throw new ValidationError('קואורדינטה מחוץ לטווח');
  }
  return [Math.round(lon * 1e7) / 1e7, Math.round(lat * 1e7) / 1e7];
}

export function cleanGeometry(g) {
  if (!g || typeof g !== 'object') throw new ValidationError('חסרה גאומטריה');
  let count = 0;
  const pos = (p) => { count++; return checkPosition(p); };
  let coordinates;
  switch (g.type) {
    case 'Point':
      coordinates = pos(g.coordinates);
      break;
    case 'LineString':
      if (!Array.isArray(g.coordinates) || g.coordinates.length < 2) throw new ValidationError('קו חייב לפחות 2 נקודות');
      coordinates = g.coordinates.map(pos);
      break;
    case 'Polygon':
      if (!Array.isArray(g.coordinates) || !g.coordinates.length) throw new ValidationError('פוליגון לא תקין');
      coordinates = g.coordinates.map((ring) => {
        if (!Array.isArray(ring) || ring.length < 4) throw new ValidationError('פוליגון חייב לפחות 3 נקודות');
        return ring.map(pos);
      });
      break;
    default:
      throw new ValidationError('סוג גאומטריה לא נתמך (נקודה, קו או פוליגון)');
  }
  if (count > MAX_VERTICES) throw new ValidationError('יותר מדי נקודות בגאומטריה');
  return { type: g.type, coordinates };
}

const str = (v, max) => String(v ?? '').trim().slice(0, max);

/** Returns the editable part of a feature, cleaned. Server-owned fields are ignored. */
export function cleanFeatureInput(input) {
  if (!input || typeof input !== 'object') throw new ValidationError('נתון חסר');
  if (!ID_RE.test(input.id || '')) throw new ValidationError('מזהה לא תקין');
  const geometry = cleanGeometry(input.geometry);
  const name = str(input.name, 120);
  if (!name) throw new ValidationError('יש להזין שם לנתון');
  const description = str(input.description, 3000);
  const photos = (Array.isArray(input.photos) ? input.photos : [])
    .filter((p) => typeof p === 'string' && ID_RE.test(p))
    .slice(0, 10);
  let layer = input.layer;
  let autoLayer = false;
  if (!isValidLayer(layer, geometry.type)) {
    layer = classify({ name, description, geometryType: geometry.type }).layerId;
    autoLayer = true;
  }
  const eventId = ID_RE.test(input.eventId || '') ? input.eventId : null;
  return { id: input.id, geometry, geomType: baseGeomType(geometry.type), name, description, photos, layer, autoLayer, eventId, observedAt: cleanTime(input.observedAt) };
}

/**
 * The time something was seen in the field, as the device recorded it. A report made offline
 * reaches the server later, so the server keeps this time for the event timeline.
 * Accepted up to 7 days back and 5 minutes ahead (clock skew); otherwise null.
 */
export function cleanTime(t) {
  const ms = Date.parse(t || '');
  if (!Number.isFinite(ms)) return null;
  const now = Date.now();
  if (ms < now - 7 * 864e5 || ms > now + 5 * 60e3) return null;
  return new Date(Math.min(ms, now)).toISOString();
}

/** An incident in the event repository. */
export function cleanEventInput(input) {
  if (!input || typeof input !== 'object') throw new ValidationError('אירוע חסר');
  if (!ID_RE.test(input.id || '')) throw new ValidationError('מזהה אירוע לא תקין');
  const action = input.action || 'open';
  if (!['open', 'update', 'close', 'reopen'].includes(action)) throw new ValidationError('פעולת אירוע לא מוכרת');
  const name = str(input.name, 120);
  if (action === 'open' && !name) throw new ValidationError('יש להזין שם לאירוע');
  const type = EVENT_TYPES.includes(input.type) ? input.type : 'אחר';
  return { id: input.id, action, name, type, description: str(input.description, 2000), at: cleanTime(input.at) };
}

export { ID_RE };
