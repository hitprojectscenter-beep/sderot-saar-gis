// One-click import of base layers for Sderot from OpenStreetMap (Overpass API).
// Runs in the GIS officer's browser; the result is saved on the server once,
// and every other device downloads it from there (and keeps it for offline use).

export const SDEROT_BBOX = [31.503, 34.568, 31.552, 34.628]; // south, west, north, east

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const NON_PROTECTIVE_SHELTERS = new Set(['public_transport', 'picnic_shelter', 'weather_shelter', 'field_shelter', 'lean_to', 'sun_shelter', 'gazebo', 'rock_shelter']);

function query([s, w, n, e]) {
  const b = `${s},${w},${n},${e}`;
  return `[out:json][timeout:120];
(
  way["highway"]["name"](${b});
  nwr["place"~"^(neighbourhood|suburb|quarter)$"](${b});
  nwr["emergency"~"^(fire_hydrant|defibrillator|fire_extinguisher|fire_water_pond|suction_point|assembly_point)$"](${b});
  nwr["amenity"~"^(shelter|police|fire_station|hospital|clinic|doctors|pharmacy|school|kindergarten|childcare|social_facility|nursing_home|townhall|community_centre|fuel)$"](${b});
  nwr["building"="bunker"](${b});
  nwr["military"="bunker"](${b});
  nwr["man_made"~"^(water_tower|reservoir_covered)$"](${b});
  nwr["power"~"^(substation|transformer)$"](${b});
);
out geom;`;
}

/** Which app layer an OSM element belongs to, or null to skip it. */
export function layerForTags(t) {
  const name = t['name:he'] || t.name || '';
  if (t.highway && name) return 'streets';
  if (['neighbourhood', 'suburb', 'quarter'].includes(t.place)) return 'neighborhoods';
  if (t.emergency === 'fire_hydrant' || t.emergency === 'suction_point' || t.emergency === 'fire_water_pond') return 'hydrants';
  if (t.emergency === 'fire_extinguisher') return 'fire_equipment';
  if (t.emergency === 'defibrillator') return 'aed';
  if (t.emergency === 'assembly_point') return 'gathering';
  if (t.building === 'bunker' || t.military === 'bunker' || /מקלט/.test(name)) return 'shelters';
  if (t.amenity === 'shelter') return NON_PROTECTIVE_SHELTERS.has(t.shelter_type) ? null : 'shelters';
  if (['police', 'fire_station'].includes(t.amenity)) return 'emergency_services';
  if (['hospital', 'clinic', 'doctors', 'pharmacy'].includes(t.amenity)) return 'medical_sites';
  if (['school', 'kindergarten', 'childcare', 'social_facility', 'nursing_home'].includes(t.amenity)) return 'special_pop';
  if (['townhall', 'community_centre'].includes(t.amenity)) return 'public_sites';
  if (t.amenity === 'fuel' || t.power) return 'hazards_infra';
  if (t.man_made) return 'water_sources';
  return null;
}

const DEFAULT_NAMES = {
  hydrants: 'ברז כיבוי', aed: 'דפיברילטור', shelters: 'מקלט', fire_equipment: 'מטף',
  hazards_infra: 'תשתית', water_sources: 'מקור מים', gathering: 'נקודת כינוס',
};

const r6 = (n) => Math.round(n * 1e6) / 1e6;
const pt = (p) => [r6(p.lon), r6(p.lat)];
const same = (a, b) => a[0] === b[0] && a[1] === b[1];

/** Join way segments into closed rings (for multipolygon relations). */
function joinRings(segments) {
  const rings = [];
  const pool = segments.map((s) => s.slice());
  while (pool.length) {
    let ring = pool.shift();
    let grew = true;
    while (!same(ring[0], ring.at(-1)) && grew) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const s = pool[i];
        if (same(ring.at(-1), s[0])) ring = ring.concat(s.slice(1));
        else if (same(ring.at(-1), s.at(-1))) ring = ring.concat(s.slice(0, -1).reverse());
        else continue;
        pool.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (same(ring[0], ring.at(-1)) && ring.length >= 4) rings.push(ring);
  }
  return rings;
}

function geometryOf(el, layer) {
  if (el.type === 'node') return { type: 'Point', coordinates: pt(el) };
  if (el.type === 'way' && el.geometry) {
    const coords = el.geometry.map(pt);
    const closed = coords.length >= 4 && same(coords[0], coords.at(-1));
    if (layer === 'streets' || !closed) return { type: 'LineString', coordinates: coords };
    return { type: 'Polygon', coordinates: [coords] };
  }
  if (el.type === 'relation' && el.members) {
    const outer = el.members.filter((m) => m.type === 'way' && m.geometry && m.role !== 'inner').map((m) => m.geometry.map(pt));
    const rings = joinRings(outer);
    if (rings.length === 1) return { type: 'Polygon', coordinates: rings };
    if (rings.length > 1) return { type: 'MultiPolygon', coordinates: rings.map((r) => [r]) };
  }
  return null;
}

/** Convert an Overpass response to a GeoJSON FeatureCollection tagged with app layers. */
export function overpassToGeoJSON(json) {
  const features = [];
  for (const el of json.elements || []) {
    const t = el.tags || {};
    const layer = layerForTags(t);
    if (!layer) continue;
    const geometry = geometryOf(el, layer);
    if (!geometry) continue;
    const name = t['name:he'] || t.name || DEFAULT_NAMES[layer] || '';
    const props = { layer, name, osm: `${el.type}/${el.id}` };
    for (const k of ['addr:street', 'addr:housenumber', 'description', 'note', 'opening_hours', 'indoor', 'level', 'capacity', 'operator', 'phone', 'highway']) {
      if (t[k]) props[k] = t[k];
    }
    features.push({ type: 'Feature', geometry, properties: props });
  }
  return mergeStreets(features);
}

/** Streets come as many short ways; merge ways with the same name into one MultiLineString. */
function mergeStreets(features) {
  const streets = new Map();
  const rest = [];
  for (const f of features) {
    if (f.properties.layer !== 'streets') { rest.push(f); continue; }
    const key = f.properties.name;
    if (!streets.has(key)) streets.set(key, { type: 'Feature', properties: { layer: 'streets', name: key }, geometry: { type: 'MultiLineString', coordinates: [] } });
    streets.get(key).geometry.coordinates.push(f.geometry.coordinates);
  }
  return { type: 'FeatureCollection', features: [...streets.values(), ...rest] };
}

export async function fetchSderotFromOSM(onProgress = () => {}) {
  const body = `data=${encodeURIComponent(query(SDEROT_BBOX))}`;
  let lastError;
  for (const url of ENDPOINTS) {
    onProgress(`מוריד מ-${new URL(url).host}…`);
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 90000);
      const res = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const geojson = overpassToGeoJSON(await res.json());
      geojson.source = `OpenStreetMap via ${new URL(url).host}`;
      return geojson;
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`הורדה מ-OpenStreetMap נכשלה (${lastError?.message || 'שגיאה'})`);
}
