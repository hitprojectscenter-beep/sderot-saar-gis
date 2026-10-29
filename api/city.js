// GET  /api/city?f=manifest   → list of stored parts (public)
// GET  /api/city?f=<chunk>    → one part of the city map, GeoJSON (public)
// POST /api/city              → (re)build the city map and the base layers from OpenStreetMap.
//                               GIS officer; any editor may run the very first import.
import { requireUser } from './_lib/auth.js';
import { readObject, writeObject, BASE_PATH } from './_lib/store.js';
import { fetchOverpass, buildCityMap } from './_lib/citymap.js';

const MANIFEST = 'city/manifest.json';
const CHUNK_BYTES = 3_000_000; // stay well below the 4.5 MB function response limit

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') return await serve(req, res);
    if (req.method === 'POST') return await importCity(req, res);
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'שגיאת שרת' });
  }
}

async function serve(req, res) {
  const f = String(req.query?.f || 'manifest');
  if (!/^[a-z]+(-\d+)?$/.test(f)) return res.status(400).json({ error: 'bad part' });
  const obj = await readObject(f === 'manifest' ? MANIFEST : `city/${f}.json`, { ifNoneMatch: req.headers['if-none-match'] });
  res.setHeader('Cache-Control', 'public, no-cache');
  if (!obj) return f === 'manifest' ? res.status(200).json({ missing: true }) : res.status(404).json({ error: 'not found' });
  res.setHeader('ETag', obj.etag);
  if (obj.status === 304) return res.status(304).end();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(200).send(obj.body);
}

async function importCity(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const existing = await readObject(MANIFEST);
  if (existing && user.role !== 'gis') return res.status(403).json({ error: 'רק אחראי GIS יכול לעדכן את מפת העיר' });

  const { json, source } = await fetchOverpass(240000); // the function may run 300 s (vercel.json); keep time to save and answer
  const { parts, base, stats } = buildCityMap(json);

  const manifest = { importedAt: new Date().toISOString(), importedBy: user.username, source: `OpenStreetMap (${source})`, stats, parts: {} };
  for (const [name, fc] of Object.entries(parts)) {
    const chunks = splitCollection(fc);
    manifest.parts[name] = [];
    for (let i = 0; i < chunks.length; i++) {
      const id = `${name}-${i}`;
      await writeObject(`city/${id}.json`, chunks[i]);
      manifest.parts[name].push(id);
    }
  }
  await writeObject(BASE_PATH, JSON.stringify({ ...base, importedAt: manifest.importedAt, importedBy: user.username, source: manifest.source }));
  await writeObject(MANIFEST, JSON.stringify(manifest));
  return res.status(200).json({ ok: true, stats, base: base.features.length });
}

/** Serialize a FeatureCollection into one or more JSON strings under CHUNK_BYTES each. */
function splitCollection(fc) {
  const whole = JSON.stringify(fc);
  if (whole.length <= CHUNK_BYTES) return [whole];
  const out = [];
  let batch = [];
  let size = 0;
  for (const f of fc.features) {
    const s = JSON.stringify(f);
    if (size + s.length > CHUNK_BYTES && batch.length) {
      out.push(`{"type":"FeatureCollection","features":[${batch.join(',')}]}`);
      batch = [];
      size = 0;
    }
    batch.push(s);
    size += s.length + 1;
  }
  if (batch.length) out.push(`{"type":"FeatureCollection","features":[${batch.join(',')}]}`);
  return out;
}
