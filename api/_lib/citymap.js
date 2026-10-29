// Builds the "city map" of Sderot from OpenStreetMap, styled after the municipal paper map:
// land use (urban area, parks, industry, public-institution plots), buildings colored by use,
// roads with names, railway, points of interest, neighborhood names and the city boundary.
// Runs on the server (Vercel function) so the browser never has to talk to Overpass.
import { overpassToGeoJSON } from '../../public/js/osm.js';

// A little wider than the city itself: covers the eastern industrial park and road 232/34.
export const CITY_BBOX = [31.494, 34.563, 31.556, 34.642]; // south, west, north, east

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

function query([s, w, n, e]) {
  const b = `${s},${w},${n},${e}`;
  return `[out:json][timeout:110][maxsize:268435456];
(
  nwr["landuse"](${b});
  nwr["leisure"](${b});
  nwr["natural"~"^(wood|scrub|grassland|water|heath|sand)$"](${b});
  nwr["amenity"](${b});
  nwr["shop"](${b});
  nwr["office"](${b});
  nwr["tourism"](${b});
  nwr["healthcare"](${b});
  nwr["emergency"](${b});
  nwr["historic"](${b});
  nwr["place"](${b});
  nwr["building"](${b});
  nwr["military"="bunker"](${b});
  nwr["man_made"](${b});
  nwr["power"~"^(substation|transformer)$"](${b});
  way["highway"](${b});
  way["railway"~"^(rail|light_rail|construction)$"](${b});
  node["railway"~"^(station|halt)$"](${b});
  rel["boundary"="administrative"]["name"~"שדרות|Sderot"];
);
out geom qt;`;
}

/**
 * Download the city from the first Overpass mirror that answers.
 * `budgetMs` is the time left for downloading: each mirror gets a share of it, and the
 * function gives up in time to answer the user with a clear message (instead of the
 * function being killed by the platform's time limit).
 */
export async function fetchOverpass(budgetMs = 240000) {
  const body = `data=${encodeURIComponent(query(CITY_BBOX))}`;
  const deadline = Date.now() + budgetMs;
  const errors = [];
  for (const url of ENDPOINTS) {
    const left = deadline - Date.now();
    if (left < 15000) break;
    const host = new URL(url).host;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(left, 120000));
    try {
      const res = await fetch(url, {
        method: 'POST', body, signal: ctrl.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'sderot-saar-gis/0.2 (emergency volunteers map)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { json: await res.json(), source: host };
    } catch (e) {
      errors.push(`${host}: ${e.name === 'AbortError' ? 'לא ענה בזמן' : e.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`שרתי OpenStreetMap עמוסים כרגע – נסו שוב בעוד כמה דקות (${errors.join('; ') || 'אין מענה'})`);
}

// ───────── geometry helpers ─────────
const r6 = (n) => Math.round(n * 1e6) / 1e6;
const pt = (p) => [r6(p.lon), r6(p.lat)];
const same = (a, b) => a[0] === b[0] && a[1] === b[1];

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

/** Area geometry of a way or multipolygon relation, or null. */
function areaOf(el) {
  if (el.type === 'way' && el.geometry) {
    const c = el.geometry.map(pt);
    return c.length >= 4 && same(c[0], c.at(-1)) ? { type: 'Polygon', coordinates: [c] } : null;
  }
  if (el.type === 'relation' && el.members) {
    const outer = joinRings(el.members.filter((m) => m.type === 'way' && m.geometry && m.role !== 'inner').map((m) => m.geometry.map(pt)));
    const inner = joinRings(el.members.filter((m) => m.type === 'way' && m.geometry && m.role === 'inner').map((m) => m.geometry.map(pt)));
    if (!outer.length) return null;
    if (outer.length === 1) return { type: 'Polygon', coordinates: [outer[0], ...inner] };
    return { type: 'MultiPolygon', coordinates: outer.map((r) => [r]) };
  }
  return null;
}

function centerOf(el) {
  if (el.type === 'node') return pt(el);
  if (el.center) return pt(el.center);
  if (el.bounds) return [r6((el.bounds.minlon + el.bounds.maxlon) / 2), r6((el.bounds.minlat + el.bounds.maxlat) / 2)];
  if (el.geometry?.length) {
    const g = el.geometry.filter(Boolean);
    return [r6(g.reduce((a, p) => a + p.lon, 0) / g.length), r6(g.reduce((a, p) => a + p.lat, 0) / g.length)];
  }
  return null;
}

function bbox(ring) {
  let a = Infinity; let b = Infinity; let c = -Infinity; let d = -Infinity;
  for (const [x, y] of ring) { if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; }
  return [a, b, c, d];
}
function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ───────── classification (mirrors the paper map's legend) ─────────
// Land use classes → colors are applied in the browser (js/citymap.js).
function landuseClass(t) {
  const lu = t.landuse; const le = t.leisure; const am = t.amenity; const na = t.natural;
  if (['park', 'garden', 'recreation_ground', 'dog_park', 'nature_reserve'].includes(le) || ['grass', 'recreation_ground', 'village_green', 'forest', 'flowerbed'].includes(lu)) return 'park';
  if (['pitch', 'sports_centre', 'stadium', 'track', 'playground', 'fitness_station'].includes(le)) return 'sport';
  if (le === 'swimming_pool' || na === 'water' || lu === 'reservoir' || lu === 'basin') return 'water';
  if (['wood', 'scrub', 'grassland', 'heath'].includes(na) || ['farmland', 'meadow', 'orchard', 'vineyard', 'plant_nursery', 'greenhouse_horticulture'].includes(lu)) return 'open';
  if (lu === 'industrial' || lu === 'railway' || lu === 'depot') return 'industrial';
  if (lu === 'commercial' || lu === 'retail') return 'commercial';
  if (lu === 'cemetery' || am === 'grave_yard') return 'cemetery';
  if (['construction', 'brownfield', 'greenfield', 'landfill'].includes(lu)) return 'planned';
  if (['school', 'kindergarten', 'college', 'university', 'hospital', 'clinic', 'place_of_worship', 'community_centre', 'townhall', 'police', 'fire_station', 'library', 'social_facility', 'childcare', 'courthouse', 'arts_centre'].includes(am)
    || ['education', 'religious', 'institutional', 'civic', 'military'].includes(lu)) return 'institution';
  if (am === 'parking') return 'parking';
  if (lu === 'residential') return 'residential';
  return null;
}

const RESIDENTIAL = new Set(['residential', 'apartments', 'house', 'detached', 'semidetached_house', 'terrace', 'bungalow', 'dormitory']);
const INDUSTRIAL = new Set(['industrial', 'warehouse', 'factory', 'manufacture', 'hangar', 'storage_tank', 'service', 'transformer_tower']);
const COMMERCIAL = new Set(['commercial', 'retail', 'office', 'supermarket', 'kiosk', 'hotel', 'mall']);
const PUBLIC = new Set(['school', 'kindergarten', 'public', 'civic', 'government', 'hospital', 'synagogue', 'religious', 'university', 'college', 'sports_hall', 'train_station', 'fire_station', 'police', 'community_centre', 'bunker', 'library', 'clinic', 'mosque', 'transportation']);

function buildingClass(t) {
  const b = t.building;
  if (PUBLIC.has(b) || t.amenity && ['school', 'kindergarten', 'place_of_worship', 'townhall', 'community_centre', 'library', 'clinic', 'hospital', 'police', 'fire_station'].includes(t.amenity)) return 'public';
  if (INDUSTRIAL.has(b)) return 'industrial';
  if (COMMERCIAL.has(b) || t.shop) return 'commercial';
  if (RESIDENTIAL.has(b)) return 'residential';
  return null; // decided by the land use around it
}

function roadClass(hw) {
  if (['motorway', 'trunk', 'motorway_link', 'trunk_link'].includes(hw)) return 'major';
  if (['primary', 'primary_link'].includes(hw)) return 'primary';
  if (['secondary', 'tertiary', 'secondary_link', 'tertiary_link'].includes(hw)) return 'secondary';
  if (['residential', 'unclassified', 'living_street', 'road'].includes(hw)) return 'street';
  if (hw === 'service') return 'service';
  if (['pedestrian', 'footway', 'path', 'cycleway', 'steps', 'track', 'bridleway'].includes(hw)) return 'path';
  if (hw === 'construction' || hw === 'proposed') return 'planned';
  return null;
}

// Points of interest, like the symbols of the paper map's legend.
const POI = [
  [(t) => t.amenity === 'police', 'police'],
  [(t) => t.amenity === 'fire_station', 'fire'],
  [(t) => t.emergency === 'ambulance_station' || /מד"?א|מגן דוד/.test(t.name || ''), 'ambulance'],
  [(t) => ['hospital', 'clinic', 'doctors'].includes(t.amenity) || t.healthcare, 'clinic'],
  [(t) => t.amenity === 'pharmacy', 'pharmacy'],
  [(t) => t.amenity === 'townhall' || t.office === 'government', 'townhall'],
  [(t) => ['school', 'college', 'university'].includes(t.amenity), 'school'],
  [(t) => ['kindergarten', 'childcare'].includes(t.amenity), 'kindergarten'],
  [(t) => t.amenity === 'place_of_worship', 'synagogue'],
  [(t) => t.amenity === 'mikveh' || t.leisure === 'mikveh' || /מקווה/.test(t.name || ''), 'mikveh'],
  [(t) => t.amenity === 'community_centre' || t.amenity === 'social_centre' || t.amenity === 'arts_centre', 'community'],
  [(t) => t.amenity === 'library', 'library'],
  [(t) => t.amenity === 'bank' || t.amenity === 'atm', 'bank'],
  [(t) => t.amenity === 'post_office', 'post'],
  [(t) => t.amenity === 'fuel', 'fuel'],
  [(t) => t.shop === 'mall' || t.shop === 'supermarket' || t.amenity === 'marketplace', 'shopping'],
  [(t) => ['sports_centre', 'stadium', 'pitch'].includes(t.leisure) && t.name, 'sport'],
  [(t) => t.leisure === 'swimming_pool' && t.name, 'pool'],
  [(t) => t.leisure === 'playground', 'playground'],
  [(t) => t.leisure === 'fitness_station', 'fitness'],
  [(t) => t.amenity === 'grave_yard' || t.landuse === 'cemetery', 'cemetery'],
  [(t) => t.historic === 'memorial' || t.historic === 'monument', 'memorial'],
  [(t) => t.railway === 'station' || t.railway === 'halt', 'train'],
  [(t) => t.amenity === 'bus_station', 'bus'],
  [(t) => t.amenity === 'social_facility' || /מרכז יום/.test(t.name || ''), 'elderly'],
  [(t) => t.tourism === 'museum' || t.tourism === 'attraction', 'attraction'],
];

/**
 * Convert an Overpass response into the city map parts.
 * Returns { parts: { landuse, buildings, roads, rail, pois, labels, boundary }, base, stats }.
 */
export function buildCityMap(json) {
  const landuse = [];
  const buildings = [];
  const roads = [];
  const rail = [];
  const pois = [];
  const labels = [];
  let boundary = null;

  // Land use first: buildings without a clear use take the color of the area they stand in.
  const zones = [];
  for (const el of json.elements || []) {
    const t = el.tags || {};
    if (el.type === 'relation' && t.boundary === 'administrative' && /שדרות|Sderot/.test(t.name || '') && !boundary) {
      const g = areaOf(el);
      if (g) boundary = { type: 'Feature', geometry: g, properties: { name: t['name:he'] || t.name } };
      continue;
    }
    if (t.building) continue;
    const cls = landuseClass(t);
    if (!cls) continue;
    const g = areaOf(el);
    if (!g) continue;
    landuse.push({ type: 'Feature', geometry: g, properties: { c: cls, ...(t.name ? { n: t['name:he'] || t.name } : {}) } });
    if (['industrial', 'commercial', 'institution'].includes(cls) && g.type === 'Polygon') zones.push({ cls, ring: g.coordinates[0], bb: bbox(g.coordinates[0]) });
  }
  const zoneBuildingClass = { industrial: 'industrial', commercial: 'commercial', institution: 'public' };

  for (const el of json.elements || []) {
    const t = el.tags || {};
    const name = t['name:he'] || t.name || '';

    if (t.building && t.building !== 'roof') {
      const g = areaOf(el);
      if (g) {
        let c = buildingClass(t);
        if (!c) {
          const p = centerOf(el) || g.coordinates[0][0];
          const z = zones.find((zz) => p[0] >= zz.bb[0] && p[0] <= zz.bb[2] && p[1] >= zz.bb[1] && p[1] <= zz.bb[3] && inRing(p, zz.ring));
          c = z ? zoneBuildingClass[z.cls] : 'residential';
        }
        const props = { c };
        if (name) props.n = name;
        if (t['building:levels']) props.l = Number(t['building:levels']) || undefined;
        if (t['addr:street']) props.s = `${t['addr:street']} ${t['addr:housenumber'] || ''}`.trim();
        buildings.push({ type: 'Feature', geometry: g, properties: props });
      }
    }

    if (el.type === 'way' && t.highway && el.geometry) {
      const c = roadClass(t.highway);
      if (c) {
        const props = { c };
        if (name) props.n = name;
        if (t.ref) props.r = t.ref;
        if (t.bridge) props.b = 1;
        roads.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: el.geometry.map(pt) }, properties: props });
      }
    }

    if (el.type === 'way' && t.railway && el.geometry) {
      rail.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: el.geometry.map(pt) }, properties: { c: t.railway === 'construction' ? 'planned' : 'rail' } });
    }

    if (['neighbourhood', 'suburb', 'quarter', 'village', 'hamlet', 'locality', 'town', 'city'].includes(t.place) && name) {
      const p = centerOf(el);
      if (p) labels.push({ type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: { n: name, k: t.place } });
    }

    const poi = POI.find(([test]) => test(t));
    if (poi && !t.highway) {
      const p = centerOf(el);
      if (p) pois.push({ type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: { k: poi[1], ...(name ? { n: name } : {}) } });
    }
  }

  const fc = (features) => ({ type: 'FeatureCollection', features });
  return {
    parts: {
      landuse: fc(landuse),
      buildings: fc(buildings),
      roads: fc(roads),
      rail: fc(rail),
      pois: fc(pois),
      labels: fc(labels),
      boundary: fc(boundary ? [boundary] : []),
    },
    base: overpassToGeoJSON(json), // thematic layers: hydrants, defibrillators, shelters, streets, …
    stats: { landuse: landuse.length, buildings: buildings.length, roads: roads.length, pois: pois.length, labels: labels.length, boundary: !!boundary },
  };
}
